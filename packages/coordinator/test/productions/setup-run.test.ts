import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { newId, ulid, type ConversationId, type HarnessAdapter, type WorldChatMessage } from "@arke-studio/contracts";
import { WorldChatRunner, type RunDeps } from "../../src/world-chat/run.js";
import { WorldChatRunnerCache } from "../../src/world-chat/runner-cache.js";
import { WorldChatService } from "../../src/world-chat/service.js";
import { recoverConversations } from "../../src/world-chat/recovery.js";
import { foldConversation } from "../../src/world-chat/fold.js";
import { checkpointPath } from "../../src/world-chat/checkpoint.js";
import { ProductionSetupService } from "../../src/productions/setup.js";
import { ProductionSetupConversationStore } from "../../src/productions/setup-store.js";
import { productionSetupBrief } from "../../src/productions/setup-brief.js";
import { guardProductionSetupAuthority } from "../../src/productions/setup-authority.js";
import { handleProductionSetupCommand } from "../../src/productions/setup-command.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

const AT = "2026-09-08T10:00:00Z";
async function setup(answer: () => string | Promise<string>, existing?: { world: WorldStore; id: ConversationId }, resolveLanguageModel?: RunDeps["resolveLanguageModel"]) {
  const world = existing?.world ?? await WorldStore.open(await makeTempWorld(), { clock: () => AT });
  closeOnCleanup(() => world.close());
  const service = new ProductionSetupService(world);
  const id = existing?.id ?? newId("cv") as ConversationId;
  if (!existing) await service.start(id);
  const log = new ProductionSetupConversationStore(world, id);
  const prompts: string[] = [];
  const adapter = {
    id: "fake", capabilities: () => new Set(["events"]), readiness: () => ({ ready: true }),
    createSession: async () => ({ sessionId: "s1" }),
    dispatchAsync: async (input: { parts: Array<{ text?: string }> }) => { prompts.push(input.parts.map(part => part.text ?? "").join("")); return { ok: true }; },
    streamEvents: () => (async function* () { yield { type: "message.completed", sessionId: "s1", text: await answer() }; })(),
  } as unknown as HarnessAdapter;
  const runner = new WorldChatRunner({
    closingSignal: world.closingSignal,
    ...(resolveLanguageModel ? { resolveLanguageModel } : {}),
    adapter, prepare: async () => ({ cwd: world.dir, leaseToken: "test" }), release: async () => {},
    receiptsFor: () => [], runCheckPlan: async () => { throw new Error("Setup cannot check world mutations."); },
    evidenceSources: (messages: readonly WorldChatMessage[]) => ({ messages, bundle: world.getBundle(), attachments: [], attachmentText: new Map() }),
    prepareActions: turn => { assert.deepEqual(turn.actions, []); assert.deepEqual(turn.candidates, []); return []; },
    setupBrief: async ({ draft }) => `Production so far: ${JSON.stringify(draft)}`,
    now: () => AT,
  });
  const view = () => new WorldChatService(world.dir).load(id);
  return { world, service, id, log, runner, view, prompts, adapter };
}
const reply = (setupUpdate?: unknown) => JSON.stringify({
  reply: "The return becomes a departure. We can leave the ending open.",
  candidateOperations: [], groupOperations: [], ...(setupUpdate ? { setupUpdate } : {}),
});

describe("setup turns share conversation durability but no world-mutation authority", () => {
  it("recovers a world-close interruption as retryable and lets the retained draft be reviewed (#1030)", async () => {
    let respond!: (text: string) => void;
    let asked!: () => void;
    const requested = new Promise<void>(resolve => { asked = resolve; });
    const answer = new Promise<string>(resolve => { respond = resolve; });
    const h = await setup(() => { asked(); return answer; });
    const cache = new WorldChatRunnerCache<WorldChatRunner>();
    cache.remember(h.world.worldId, h.world, h.runner);
    await h.service.update(h.id, { expectedRevision: 1, fields: { title: "The crossing" } });
    const running = handleProductionSetupCommand(h.world, { kind: "production-setup", worldId: h.world.worldId,
      setupId: h.id, requestId: ulid(), action: { operation: "send", text: "Develop the crossing." } },
    () => h.runner, async () => {});
    const refused = assert.rejects(running, /world closed.*saved conversation.*continuing/i);
    await requested;
    await assert.rejects(h.service.review(h.id, 2), /Wait for Arke/);
    await h.world.close();
    await refused;
    assert.equal(h.runner.isRunning(h.id), false);

    const reopened = await WorldStore.open(h.world.dir, { clock: () => AT });
    closeOnCleanup(() => reopened.close());
    assert.deepEqual((await reopened.ownedWrite(() => recoverConversations(reopened.dir))).repaired, [h.id]);
    assert.deepEqual((await reopened.ownedWrite(() => recoverConversations(reopened.dir))).repaired, []);
    const log = new ProductionSetupConversationStore(reopened, h.id);
    const recovered = foldConversation(h.id, AT, (await log.read()).events).view;
    await reopened.ownedWrite(() => writeFile(checkpointPath(log.dir), JSON.stringify({
      schemaVersion: 1, throughSeq: recovered.seq,
      view: { ...recovered, activeRun: recovered.lastFailedRun, lastFailedRun: null },
    })));
    const view = (await h.view())!;
    assert.equal(view.activeRun, null, "a same-tail checkpoint from the old fold must be rebuilt");
    assert.equal(view.lastFailedRun?.status, "interrupted");
    assert.equal(view.messages.length, 1, "the original message survives without a fabricated reply");
    assert.equal(view.productionSetup!.draft.title, "The crossing", "a late result cannot write through the closed owner");
    const service = new ProductionSetupService(reopened);
    const review = await service.review(h.id, 2);
    assert.equal(review.status, "reviewed");

    assert.equal(cache.runnerFor(reopened.worldId, reopened, h.id), undefined, "a closed runner cannot serve Retry");
    let retryAsked!: () => void;
    let retryRespond!: (text: string) => void;
    const retryRequested = new Promise<void>(resolve => { retryAsked = resolve; });
    const retryAnswer = new Promise<string>(resolve => { retryRespond = resolve; });
    const fresh = await setup(() => { retryAsked(); return retryAnswer; }, { world: reopened, id: h.id });
    cache.remember(reopened.worldId, reopened, fresh.runner);
    const retry = fresh.runner.retry(fresh.log, h.id, view.lastFailedRun!.turnId);
    await retryRequested;
    assert.equal((await fresh.runner.retry(fresh.log, h.id, view.lastFailedRun!.turnId)).status, "unavailable", "a second Retry cannot replace the live controller");
    assert.equal((await h.runner.send(h.log, h.id, "Use the closed owner")).status, "unavailable");
    respond(reply({ expectedRevision: 2, fields: { title: "A late model title" } }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(cache.runnerFor(reopened.worldId, reopened, h.id), fresh.runner);
    assert.equal(fresh.runner.isRunning(h.id), true, "the old response cannot clear the retry's controller");
    await handleProductionSetupCommand(reopened, { kind: "production-setup", worldId: reopened.worldId,
      setupId: h.id, requestId: ulid(), action: { operation: "cancel" } }, () => fresh.runner, async () => {});
    assert.equal((await retry).status, "cancelled");
    assert.equal((await fresh.log.read()).events.filter(({ event }) => event.type === "run.finished" && event.run.status === "cancelled").length, 1,
      "the Stop command and runner cleanup share one terminal cancellation");
    retryRespond(reply());
    assert.equal((await fresh.view())!.productionSetup!.draft.title, "The crossing");
    assert.equal((await fresh.view())!.messages.length, 1, "Retry keeps the original user message");
    await reopened.close();
    const again = await WorldStore.open(h.world.dir, { clock: () => AT });
    closeOnCleanup(() => again.close());
    assert.deepEqual(await new ProductionSetupService(again).resume(h.id), review);
  });

  it("Stop survives an immediate world close and later turns keep Review available (#1030)", async () => {
    let respond!: (text: string) => void;
    let asked!: () => void;
    const requested = new Promise<void>(resolve => { asked = resolve; });
    const answer = new Promise<string>(resolve => { respond = resolve; });
    const h = await setup(() => { asked(); return answer; });
    await h.service.update(h.id, { expectedRevision: 1, fields: { title: "The crossing" } });
    const running = h.runner.send(h.log, h.id, "Develop the crossing.");
    const refused = assert.rejects(running, /world is closed/);
    await requested;
    const stopped = handleProductionSetupCommand(h.world, { kind: "production-setup", worldId: h.world.worldId,
      setupId: h.id, requestId: ulid(), action: { operation: "cancel" } }, () => h.runner, async () => {});
    const closed = h.world.close();
    await stopped;
    await closed;
    await refused;
    const reopened = await WorldStore.open(h.world.dir, { clock: () => AT });
    closeOnCleanup(() => reopened.close());
    assert.deepEqual((await reopened.ownedWrite(() => recoverConversations(reopened.dir))).repaired, []);
    const fresh = await setup(() => reply(), { world: reopened, id: h.id });
    assert.equal((await fresh.view())!.activeRun, null);
    assert.equal((await fresh.view())!.lastFailedRun, null, "Stop does not offer a failure retry after reopening");
    const terminals = (await fresh.log.read()).events.filter(({ event }) => event.type === "run.finished");
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0]!.event.type === "run.finished" && terminals[0]!.event.run.status, "cancelled");
    assert.equal((await fresh.service.review(h.id, 2)).status, "reviewed");
    respond(reply());
    assert.equal((await fresh.runner.send(fresh.log, h.id, "Keep the title.")).status, "completed");
    const view = (await fresh.view())!;
    assert.equal(view.activeRun, null);
    assert.equal(view.lastFailedRun, null);
    assert.equal((await fresh.service.review(h.id, 2)).status, "reviewed");
  });

  it("refuses a setup send closed during preflight without promising a saved message or Retry (#1030)", async () => {
    let h: Awaited<ReturnType<typeof setup>>;
    h = await setup(() => { throw new Error("The closed world must not ask the model"); }, undefined,
      async () => { await h.world.close(); return {}; });
    await assert.rejects(handleProductionSetupCommand(h.world, { kind: "production-setup", worldId: h.world.worldId,
      setupId: h.id, requestId: ulid(), action: { operation: "send", text: "A new idea" } },
    () => h.runner, async () => {}), /world closed before this message could be sent/i);
    const reopened = await WorldStore.open(h.world.dir, { clock: () => AT });
    closeOnCleanup(() => reopened.close());
    assert.deepEqual((await reopened.ownedWrite(() => recoverConversations(reopened.dir))).repaired, []);
    assert.equal((await h.view())!.messages.length, 0);
    assert.equal((await h.view())!.lastFailedRun, null);
  });

  it("carries conversational episode bounds and seeded delivery defaults into the created season (#1012)", async () => {
    const h = await setup(() => reply({ expectedRevision: 1, fields: {
      title: "The dead air", kind: "microdrama", aspect: "9:16",
      defaults: { episodeSecondsMin: 30, episodeSecondsMax: 45 },
    }, episodes: [{ key: "one", title: "One", scenes: [] }] }));
    assert.equal((await h.runner.send(h.log, h.id, "Micro drama: episodes forty seconds each, min thirty, max forty-five.")).status, "completed");
    const defaults = { episodeSecondsMin: 30, episodeSecondsMax: 45, hookWindowSec: 3, exportPreset: "social-1080x1920" };
    assert.deepEqual((await h.view())!.productionSetup!.draft.defaults, defaults);
    const review = await h.service.review(h.id, 2);
    assert.deepEqual(review.review!.plan.initialSeason!.defaults, defaults);
    const created = await h.service.create(h.id, 2, review.review!.id);
    const season = JSON.parse(await readFile(join(h.world.dir, "productions", created.productionId!, "season.json"), "utf8"));
    assert.deepEqual(season.defaults, defaults);
  });

  it("refuses a retry record that races with completed production creation", async () => {
    const h = await setup(() => reply({ expectedRevision: 1, fields: { title: "The crossing" } }));
    await h.runner.send(h.log, h.id, "Name this film.");
    const started = (await h.log.read()).events.find(envelope => envelope.event.type === "turn.started")!.event;
    assert.equal(started.type, "turn.started");
    if (started.type !== "turn.started") throw new Error("Expected a started turn");
    const review = await h.service.review(h.id, 2);
    await h.service.create(h.id, 2, review.review!.id);
    await assert.rejects(h.log.append({ type: "run.retry-started", run: started.run }, { at: AT }), /creation/);
  });

  it("publishes the terminal transcript and retryable failure before returning a failed setup command", async () => {
    const h = await setup(() => "malformed model output");
    const snapshots: Awaited<ReturnType<typeof h.view>>[] = [];
    await assert.rejects(handleProductionSetupCommand(h.world, { kind: "production-setup", worldId: h.world.worldId,
      setupId: h.id, requestId: ulid(), action: { operation: "send", text: "Develop the crossing." } },
    () => h.runner, async () => { snapshots.push(await h.view()); }), /answer could not be used/);
    assert.equal(snapshots.at(-1)!.messages.filter(message => message.role === "user").length, 1);
    assert.equal(snapshots.at(-1)!.lastFailedRun!.status, "failed");
    assert.equal(snapshots.at(-1)!.productionSetup!.draft.revision, 1);
  });

  it("keeps a draft when the configured harness is unavailable without dispatching a turn", async () => {
    const h = await setup(() => { throw new Error("Unavailable harness must not run"); });
    h.adapter.readiness = () => ({ ready: false, reason: "Sign in to the writing harness." });
    const before = await h.service.resume(h.id);
    const result = await h.runner.send(h.log, h.id, "Develop the crossing.");
    assert.equal(result.status, "unavailable");
    assert.deepEqual(await h.service.resume(h.id), before);
    assert.equal(h.prompts.length, 0);
  });

  it("persists the validated draft with its reply and keeps it available after a later malformed turn", async () => {
    let answer = reply({ expectedRevision: 1, fields: { title: "The crossing", narrative: { direction: "Return, then departure." } },
      scenes: [{ key: "arrival", title: "Arrival", synopsis: "A boat returns." }] });
    const h = await setup(() => answer);
    assert.equal((await h.runner.send(h.log, h.id, "Let's develop the return.")).status, "completed");
    let view = (await h.view())!;
    assert.equal(view.productionSetup!.draft.scenes[0]!.synopsis, "A boat returns.");
    assert.equal(view.messages.length, 2);
    assert.match(h.prompts[0]!, /Production so far/);
    answer = reply({ expectedRevision: 2, scenes: [{ key: "../../escape", title: "Bad path" }] });
    assert.equal((await h.runner.send(h.log, h.id, "Revise this.")).status, "failed");
    view = (await h.view())!;
    assert.equal(view.productionSetup!.draft.revision, 2);
    assert.equal(view.messages.filter(message => message.role === "studio").length, 1);
    assert.equal(view.messages.filter(message => message.role === "user").length, 2);
    answer = reply({ expectedRevision: 2, scenes: [{ key: "arrival", title: "A late arrival" }] });
    const failedTurn = view.messages.filter(message => message.role === "user").at(-1)!.turnId!;
    assert.equal((await h.runner.retry(h.log, h.id, failedTurn)).status, "completed");
    view = (await h.view())!;
    assert.equal(view.productionSetup!.draft.scenes[0]!.title, "A late arrival");
    assert.equal(view.messages.filter(message => message.role === "user").length, 2, "retry retains the original user turn");
  });

  it("refuses a late model result after another author edit", async () => {
    let edited = false;
    let h: Awaited<ReturnType<typeof setup>>;
    h = await setup(async () => {
      if (!edited) { edited = true; await h.service.update(h.id, { expectedRevision: 1, fields: { title: "The author's title" } }); }
      return reply({ expectedRevision: 1, fields: { title: "A stale model title" } });
    });
    assert.equal((await h.runner.send(h.log, h.id, "Find a title.")).status, "failed");
    assert.equal((await h.view())!.productionSetup!.draft.title, "The author's title");
  });

  it("enforces draft-only permissions independently of the prompt and rejects generic command bypasses", async () => {
    const h = await setup(() => JSON.stringify({
      reply: "Withdraw that world proposal.", groupOperations: [],
      candidateOperations: [{ op: "withdraw", candidateId: newId("cand"), expectedRevision: 1, reason: "Changed my mind." }],
    }));
    const result = await h.runner.send(h.log, h.id, "Change a world proposal.");
    assert.equal(result.status, "failed");
    const view = (await h.view())!;
    assert.equal(view.productionSetup!.draft.revision, 1);
    assert.equal(view.candidates.length, 0);
    assert.equal(view.actions.length, 0);
    await assert.rejects(guardProductionSetupAuthority(h.world, { kind: "world-chat-send", worldId: h.world.worldId,
      conversationId: h.id, requestId: ulid(), text: "Bypass the setup", attachmentIds: [] }), /Production setup/);
  });

  it("reads current canon and world sheets through receipts while excluding another production's guest", async () => {
    const h = await setup(() => reply());
    const bundle = structuredClone(h.world.getBundle());
    const character = bundle.sheets.find(sheet => sheet.type === "character")!;
    bundle.sheets.push({ ...character, id: "foreign-guest", name: "Foreign guest", production: "another-production" });
    const draft = (await h.service.resume(h.id)).draft;
    const reads: string[] = [];
    const brief = await productionSetupBrief(bundle, draft, async (tool, args) => {
      reads.push(String(args.id));
      return { result: { id: args.id }, receipt: {
        id: newId("check"), runId: newId("run"), tool: tool === "get_sheet" ? "get-sheet" : "get-entry",
        status: "complete", consulted: [], at: AT,
      } } as never;
    }, 100_000);
    assert.ok(reads.includes(character.id));
    assert.ok(reads.includes(bundle.canon[0]!.id));
    assert.ok(!reads.includes("foreign-guest"));
    assert.match(brief, /openQuestions/);
    assert.match(brief, /defaults\?:\{episodeSecondsMin\?,episodeSecondsMax\?,hookWindowSec\?,exportPreset\?\}/);
    await assert.rejects(productionSetupBrief(bundle, draft, async () => ({ result: {}, receipt: { status: "complete" } }) as never, 100), /larger writing-model context/);
  });
});
