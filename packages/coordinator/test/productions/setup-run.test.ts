import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { newId, ulid, type ConversationId, type HarnessAdapter, type WorldChatMessage } from "@arke-studio/contracts";
import { WorldChatRunner } from "../../src/world-chat/run.js";
import { WorldChatService } from "../../src/world-chat/service.js";
import { ProductionSetupService } from "../../src/productions/setup.js";
import { ProductionSetupConversationStore } from "../../src/productions/setup-store.js";
import { productionSetupBrief } from "../../src/productions/setup-brief.js";
import { guardProductionSetupAuthority } from "../../src/productions/setup-authority.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

const AT = "2026-09-08T10:00:00Z";
async function setup(answer: () => string | Promise<string>) {
  const world = await WorldStore.open(await makeTempWorld(), { clock: () => AT });
  closeOnCleanup(() => world.close());
  const service = new ProductionSetupService(world);
  const id = newId("cv") as ConversationId;
  await service.start(id);
  const log = new ProductionSetupConversationStore(world, id);
  const prompts: string[] = [];
  const adapter = {
    id: "fake", capabilities: () => new Set(["events"]), readiness: () => ({ ready: true }),
    createSession: async () => ({ sessionId: "s1" }),
    dispatchAsync: async (input: { parts: Array<{ text?: string }> }) => { prompts.push(input.parts.map(part => part.text ?? "").join("")); return { ok: true }; },
    streamEvents: () => (async function* () { yield { type: "message.completed", sessionId: "s1", text: await answer() }; })(),
  } as unknown as HarnessAdapter;
  const runner = new WorldChatRunner({
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
    await assert.rejects(productionSetupBrief(bundle, draft, async () => ({ result: {}, receipt: { status: "complete" } }) as never, 100), /larger writing-model context/);
  });
});
