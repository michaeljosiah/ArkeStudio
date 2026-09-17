import assert from "node:assert/strict";
import { appendFile, open, readFile, writeFile, unlink } from "node:fs/promises";
import { describe, it } from "node:test";
import {
  newId, WorldChatInputRequestSchema, WORLD_CHAT_INPUT_SCHEMA_VERSION, WORLD_CHAT_INPUT_BOUNDS,
  type WorldChatInputAttempt, type WorldChatInputRequest, type WorldChatRun,
} from "@arke-studio/contracts";
import { join } from "node:path";
import { WorldChatAttachmentStore, attachmentDir } from "../../src/world-chat/attachments.js";
import { recoverWorldChatInputs } from "../../src/world-chat/input-recovery.js";
import { WorldChatInputJournal } from "../../src/world-chat/input-journal.js";
import { foldWorldChatInputs } from "../../src/world-chat/input-fold.js";
import { foldConversation } from "../../src/world-chat/fold.js";
import { recoverConversations } from "../../src/world-chat/recovery.js";
import { WorldChatStore } from "../../src/world-chat/store.js";
import { WorldChatService } from "../../src/world-chat/service.js";
import { refreshConversationSummary } from "../../src/world-chat/summarisation.js";
import { readCheckpoint, writeCheckpoint } from "../../src/world-chat/checkpoint.js";
import { WorldStore } from "../../src/world/store.js";
import { readWorldMeta } from "../../src/world/scan.js";
import { makeTempWorld } from "../world/helpers.js";
import { tempDir } from "../tmp.js";

const AT = "2026-09-13T10:00:00Z";
const DIGEST = `sha256:${"a".repeat(64)}`;
const ROUTING = { adapter: "fake", modelId: "test-model", fingerprint: DIGEST };
const CAPTURE = { routing: ROUTING, constraints: { replyOnly: false } };

function request(text = "Make the scene quieter", overrides: Partial<WorldChatInputRequest> = {}): WorldChatInputRequest {
  return { submissionId: newId("msg"), text, attachmentIds: [], delivery: "next", expectedRunId: null, ...overrides };
}

function run(): WorldChatRun {
  return { id: newId("run"), turnId: newId("turn"), basedOnConversationSeq: 1, status: "running", adapter: ROUTING.adapter,
    model: ROUTING.modelId, harnessCleanup: "pending", contextDigest: DIGEST, startedAt: AT };
}

async function preparedRun(journal: WorldChatInputJournal, overrides: Partial<WorldChatRun> = {}): Promise<WorldChatRun> {
  return { ...run(), ...overrides, basedOnConversationSeq: (await journal.log.read()).events.at(-1)!.seq };
}

async function setup() {
  const dir = await tempDir("arke-input-journal-");
  const closing = new AbortController();
  let boundary = 22;
  const world = { dir, closingSignal: closing.signal,
    async raiseSchemaBoundary(version: number) { boundary = Math.max(boundary, version); },
    async ownedWrite<T>(fn: () => Promise<T>): Promise<T> {
      if (closing.signal.aborted) throw new Error("world closed");
      return fn();
    },
  };
  const id = newId("cv");
  const journal = new WorldChatInputJournal(world, id, () => AT);
  await journal.log.create(id, AT);
  await journal.log.append({ type: "conversation.created", title: "Direction", entryContext: { kind: "world" } }, { at: AT });
  return { journal, world, closing, id, get boundary() { return boundary; }, other: () => new WorldChatInputJournal(world, id, () => AT) };
}

async function active() {
  const state = await setup();
  const primary = run();
  await state.journal.log.append({ type: "turn.started", run: primary, message: { id: newId("msg"), turnId: primary.turnId,
    role: "user", text: "Draft the scene", attachmentIds: [], createdAt: AT } }, { at: AT });
  await state.journal.log.append({ type: "run.session-created", runId: primary.id, harnessSessionId: "native-session" }, { at: AT });
  const admitted = await state.journal.record(request("Keep her motivation", { delivery: "current", expectedRunId: primary.id }), CAPTURE);
  assert.equal(admitted.event.type, "input.recorded");
  if (admitted.event.type !== "input.recorded") throw new Error("missing input");
  const messageId = admitted.event.input.messageId;
  const attempt: WorldChatInputAttempt = { runId: primary.id, turnId: primary.turnId, ordinal: 1,
    sessionId: "native-session", executionId: "native-turn", inputId: "native-input", directionRevision: 1 };
  return { ...state, primary, messageId, attempt, revision: admitted.queue.revision };
}

describe("durable additional conversation inputs (SPEC-045)", () => {
  it("records one input for concurrent duplicate submissions without inventing a transcript turn", async t => {
    const state = await setup();
    const { journal, other, id } = state;
    const append = WorldChatStore.prototype.append;
    t.mock.method(WorldChatStore.prototype, "append", function (this: WorldChatStore, ...args: Parameters<typeof append>) {
      if (this.dir === journal.log.dir) assert.equal(state.boundary, WORLD_CHAT_INPUT_SCHEMA_VERSION, "compatibility fence precedes journal writes");
      return append.apply(this, args);
    });
    const input = request();
    const results = await Promise.all([journal, other(), other()].map(one => one.record(input, CAPTURE)));
    assert.equal(results.filter(one => !one.deduplicated).length, 1);
    assert.equal(new Set(results.map(one => one.sequence)).size, 1);
    const { events } = await journal.log.read();
    const folded = foldConversation(id, AT, events).view;
    assert.equal(folded.messages.length, 0);
    assert.equal(folded.activeRun, null);
    assert.equal(folded.inputQueue?.inputs.length, 1);
    assert.equal(folded.inputQueue?.inputs[0]?.input.request.text, input.text);
    assert.equal(folded.inputQueue?.inputs[0]?.turnId, undefined);
    assert.equal(folded.deletionBlock, "pending-inputs");
  });

  it("refuses changed text or constraints under an existing identity, including a racing duplicate", async () => {
    const { journal, other } = await setup();
    const input = request();
    const results = await Promise.allSettled([journal.record(input, CAPTURE), other().record({ ...input, text: "Different" }, CAPTURE)]);
    assert.equal(results.filter(one => one.status === "fulfilled").length, 1);
    assert.equal((await journal.read()).inputs.length, 1);
    const held = (await journal.read()).inputs[0]!.input.request;
    await assert.rejects(journal.record({ ...held, replyOnly: true }, { ...CAPTURE, constraints: { replyOnly: true } }), /different content/);
  });

  it("keeps deduplication scoped to one conversation", async () => {
    const a = await setup();
    const b = await setup();
    const input = request();
    const first = await a.journal.record(input, CAPTURE);
    const second = await b.journal.record(input, CAPTURE);
    assert.notEqual(first.queue.inputs[0]!.input.messageId, second.queue.inputs[0]!.input.messageId);
  });

  it("caps concurrent admissions at ten without dropping accepted messages", async () => {
    const { journal, other } = await setup();
    const results = await Promise.allSettled(Array.from({ length: 14 }, (_, i) => other().record(request(`direction ${i}`), CAPTURE)));
    assert.equal(results.filter(one => one.status === "fulfilled").length, 10);
    assert.equal((await journal.read()).inputs.length, 10);
    assert.equal(WorldChatInputRequestSchema.safeParse(request("x".repeat(16_001))).success, false);
    assert.equal(WorldChatInputRequestSchema.safeParse(request("   ")).success, false);
  });

  it("does not raise compatibility for an input refused during preflight", async () => {
    for (const condition of ["archived", "deleted", "corrupted", "full", "missing", "closed"] as const) {
      const state = await setup();
      const service = new WorldChatService(state.world.dir, () => AT);
      if (condition === "archived") await service.archive(state.id);
      if (condition === "deleted") await state.journal.log.append({ type: "deletion.intent-recorded", requestId: "delete" }, { at: AT });
      if (condition === "corrupted") await appendFile(state.journal.log.eventsPath, "{invalid event}\n", "utf8");
      if (condition === "full") for (let index = 0; index < WORLD_CHAT_INPUT_BOUNDS.unresolved; index++) {
        await state.journal.record(request(`Waiting ${index}`), CAPTURE);
      }
      if (condition === "closed") state.closing.abort();
      const journal = condition === "missing" ? new WorldChatInputJournal(state.world, newId("cv"), () => AT) : state.journal;
      const before = await readFile(state.journal.log.eventsPath, "utf8");
      let boundaries = 0;
      state.world.raiseSchemaBoundary = async () => { boundaries++; };
      await assert.rejects(journal.record(request(), CAPTURE));
      assert.equal(boundaries, 0, `${condition} admission must not upgrade the world`);
      assert.equal(await readFile(state.journal.log.eventsPath, "utf8"), before);
    }
  });

  it("rechecks admission after the compatibility commit allows another lifecycle operation", async () => {
    const state = await setup();
    const raise = state.world.raiseSchemaBoundary;
    state.world.raiseSchemaBoundary = async version => {
      await raise(version);
      await new WorldChatService(state.world.dir, () => AT).archive(state.id);
    };
    await assert.rejects(state.journal.record(request(), CAPTURE), /Restore or reopen/);
    assert.equal((await state.journal.read()).inputs.length, 0);
    assert.equal(state.boundary, WORLD_CHAT_INPUT_SCHEMA_VERSION);
  });

  it("rejects an explicit model that differs from captured routing before admission", async () => {
    const state = await setup();
    const input = request("Use this model", { modelId: ROUTING.modelId });
    for (const modelId of [null, "different-model"]) {
      await assert.rejects(state.journal.record(input, { ...CAPTURE, routing: { ...ROUTING, modelId } }), /captured model does not match/);
    }
    assert.equal(state.boundary, 22);
    assert.equal((await state.journal.read()).inputs.length, 0);
    const accepted = await state.journal.record(input, CAPTURE);
    assert.equal(accepted.queue.inputs[0]?.input.routing.modelId, input.modelId);
  });

  it("preserves a Stop pause across new admissions and revision-checks Remove and Continue", async () => {
    const { journal } = await setup();
    const admitted = await journal.record(request(), CAPTURE);
    const id = admitted.queue.inputs[0]!.input.messageId;
    const paused = await journal.pause("stopped", "stop-1");
    const after = await journal.record(request("And keep the bell"), CAPTURE);
    assert.equal(after.queue.pauseReason, "stopped");
    await assert.rejects(journal.remove(id, paused.queue.revision, "remove-stale"), /changed/);
    await assert.rejects(journal.continue(paused.queue.revision, ROUTING, "continue-stale"), /changed/);
    const removed = await journal.remove(id, after.queue.revision, "remove-1");
    assert.equal(removed.queue.inputs[0]?.status, "removed");
    const resumed = await journal.continue(removed.queue.revision, ROUTING, "continue-1");
    assert.equal(resumed.queue.pauseReason, null);
    assert.equal((await journal.continue(removed.queue.revision, ROUTING, "continue-1")).deduplicated, true);
    assert.equal((await journal.pause("stopped", "stop-1")).deduplicated, true);
    assert.equal((await journal.read()).pauseReason, null, "replaying the old Stop receipt does not stop a newer queue");
    await assert.rejects(journal.pause("failed", "stop-1"), /different content/);
  });

  it("promotes FIFO with the original identity and constraints in the same event as the primary run", async () => {
    const { journal, id } = await setup();
    await journal.record(request("first", { replyOnly: true }), { ...CAPTURE, constraints: { replyOnly: true } });
    const second = await journal.record(request("second"), CAPTURE);
    const [head, tail] = second.queue.inputs;
    await assert.rejects(journal.promote(tail!.input.messageId, second.queue.revision, await preparedRun(journal), ROUTING, "skip"), /oldest/);
    const primary = await preparedRun(journal);
    const promoted = await journal.promote(head!.input.messageId, second.queue.revision, primary, ROUTING, "start-1");
    assert.equal(promoted.event.type, "input.promoted");
    assert.equal(promoted.queue.inputs[0]?.status, "promoted");
    assert.equal(promoted.queue.inputs[1]?.status, "queued");
    const events = (await journal.log.read()).events;
    const view = foldConversation(id, AT, events).view;
    assert.equal(view.messages.length, 1);
    assert.equal(view.messages[0]?.id, head!.input.messageId);
    assert.equal(view.activeRun?.id, primary.id);
    if (promoted.event.type === "input.promoted") assert.equal(promoted.event.constraints.replyOnly, true);
    assert.equal((await journal.promote(head!.input.messageId, second.queue.revision, primary, ROUTING, "start-1")).deduplicated, true);
    await assert.rejects(journal.promote(tail!.input.messageId, promoted.queue.revision, await preparedRun(journal), ROUTING, "overlap"), /still active/);
  });

  it("serializes promotion against Stop without losing the waiting input", async () => {
    const { journal, other } = await setup();
    const queued = await journal.record(request(), CAPTURE);
    const messageId = queued.queue.inputs[0]!.input.messageId;
    const primary = await preparedRun(journal);
    const outcomes = await Promise.allSettled([
      journal.pause("stopped", "stop"), other().promote(messageId, queued.queue.revision, primary, ROUTING, "start"),
    ]);
    assert.equal(outcomes[0]!.status, "fulfilled");
    const queue = await journal.read();
    assert.equal(queue.pauseReason, "stopped");
    assert.equal(queue.inputs.length, 1);
    assert.ok(["queued", "promoted"].includes(queue.inputs[0]!.status));
    assert.equal((await journal.log.read()).events.filter(one => one.event.type === "input.promoted").length,
      queue.inputs[0]!.status === "promoted" ? 1 : 0);
  });

  it("cannot promote another input under a completed turn or run identity", async () => {
    const { journal } = await setup();
    const first = await journal.record(request("first"), CAPTURE);
    const primary = await preparedRun(journal);
    await journal.promote(first.queue.inputs[0]!.input.messageId, first.queue.revision, primary, ROUTING, "first");
    await journal.log.append({ type: "run.finished", run: { ...primary, status: "completed", endedAt: AT } }, { at: AT });
    const queued = await journal.record(request("second"), CAPTURE);
    const messageId = queued.queue.inputs[1]!.input.messageId;
    await assert.rejects(journal.promote(messageId, queued.queue.revision, await preparedRun(journal, primary), ROUTING, "reuse-run"), /new primary turn/);
    await assert.rejects(journal.promote(messageId, queued.queue.revision, await preparedRun(journal, { turnId: primary.turnId }), ROUTING, "reuse-turn"), /new primary turn/);
  });

  it("requires context rebuilt from the full log when an ordinary event overtakes promotion", async () => {
    const { journal } = await setup();
    const queued = await journal.record(request(), CAPTURE);
    const primary = await preparedRun(journal);
    await journal.log.append({ type: "conversation.metadata-updated", title: "Changed context" }, { at: AT });
    assert.equal((await journal.read()).revision, queued.queue.revision);
    const messageId = queued.queue.inputs[0]!.input.messageId;
    await assert.rejects(journal.promote(messageId, queued.queue.revision, primary, ROUTING, "stale-context"), /Rebuild/);
    const promoted = await journal.promote(messageId, queued.queue.revision, await preparedRun(journal), ROUTING, "rebuilt");
    assert.equal(promoted.queue.inputs[0]?.status, "promoted");
  });

  it("requires explicit Continue to approve a changed route", async () => {
    const { journal } = await setup();
    const queued = await journal.record(request(), CAPTURE);
    const messageId = queued.queue.inputs[0]!.input.messageId;
    const routing = { ...ROUTING, modelId: "second-model", fingerprint: `sha256:${"b".repeat(64)}` };
    const primary = { ...run(), model: routing.modelId };
    await assert.rejects(journal.promote(messageId, queued.queue.revision, primary, routing, "changed"), /engine or model changed/);
    const paused = await journal.pause("routing-changed", "route-pause");
    const resumed = await journal.continue(paused.queue.revision, routing, "route-continue");
    const promoted = await journal.promote(messageId, resumed.queue.revision, await preparedRun(journal, primary), routing, "reviewed-route");
    assert.equal(promoted.queue.inputs[0]!.input.routing.modelId, ROUTING.modelId, "the original routing record stays immutable");
  });

  it("captures attachments and constraints immutably and refuses changed attachments at promotion", async () => {
    const { journal, id } = await setup();
    const attachment = { id: newId("wca"), conversationId: id, fileName: "notes.txt", kind: "document" as const,
      contentHash: DIGEST, byteLength: 5, readability: "text-readable" as const, linkedMessageIds: [], createdAt: AT };
    await journal.log.append({ type: "attachment.created", attachment }, { at: AT });
    const input = request("Use these notes", { attachmentIds: [attachment.id], replyOnly: true });
    const capture = { routing: { ...ROUTING }, constraints: { replyOnly: true } };
    const waiting = journal.record(input, capture);
    capture.constraints.replyOnly = false;
    capture.routing.modelId = "mutated-after-submission";
    const receipt = await waiting;
    const row = receipt.queue.inputs[0]!;
    assert.equal(row.input.constraints.replyOnly, true);
    assert.equal(row.input.routing.modelId, ROUTING.modelId);
    assert.deepEqual(row.input.attachments, [{ id: attachment.id, contentHash: DIGEST }]);
    await assert.rejects(journal.record(request("Foreign attachment", { attachmentIds: [newId("wca")] }), CAPTURE), /no longer in this conversation/);
    await journal.log.append({ type: "attachment.created", attachment: { ...attachment, contentHash: `sha256:${"c".repeat(64)}` } }, { at: AT });
    await assert.rejects(journal.promote(row.input.messageId, receipt.queue.revision, await preparedRun(journal), ROUTING, "changed-attachment"), /attachment changed/);
    assert.equal((await journal.read()).inputs[0]?.status, "queued");
  });

  it("preserves input state through checkpoints without granting queued text evidence status", async () => {
    const { journal, id } = await setup();
    await journal.record(request("Queue only"), CAPTURE);
    const view = foldConversation(id, AT, (await journal.log.read()).events).view;
    await writeCheckpoint(journal.log.dir, view);
    const saved = await readCheckpoint(journal.log.dir, view.seq);
    assert.deepEqual(saved.checkpoint?.view.inputQueue, view.inputQueue);
    assert.deepEqual(saved.checkpoint?.view.messages, []);
    assert.equal(saved.checkpoint?.view.deletionBlock, "pending-inputs");
  });

  it("distinguishes native acceptance from inclusion and excludes native ids from snapshots", async () => {
    const state = await active();
    const { journal, messageId, attempt, id } = state;
    await journal.offer(messageId, state.revision, attempt, "offer");
    await journal.settle({ messageId, attempt, status: "accepted", operationId: "accept" });
    let view = foldConversation(id, AT, (await journal.log.read()).events).view;
    assert.equal(view.messages.length, 1, "only the primary input is evidence before inclusion");
    assert.equal(view.inputQueue?.inputs[0]?.status, "accepted");
    assert.equal(JSON.stringify(view.inputQueue).includes("native-turn"), false);
    await journal.settle({ messageId, attempt, status: "included", boundary: "model-input-2", operationId: "include" });
    view = foldConversation(id, AT, (await journal.log.read()).events).view;
    assert.equal(view.messages.length, 2);
    assert.equal(view.messages[1]?.id, messageId);
    assert.equal(view.inputQueue?.inputs[0]?.status, "included");
  });

  it("bounds settled snapshot and checkpoint rows while retaining all unresolved input and journal history", async () => {
    const { journal, id } = await setup();
    for (let index = 0; index < WORLD_CHAT_INPUT_BOUNDS.settled + 3; index++) {
      const queued = await journal.record(request(`Past message ${index}`), CAPTURE);
      await journal.remove(queued.queue.inputs.at(-1)!.input.messageId, queued.queue.revision, `remove-${index}`);
    }
    const waiting = await journal.record(request("Still waiting"), CAPTURE);
    const view = foldConversation(id, AT, (await journal.log.read()).events).view;
    assert.equal(waiting.queue.inputs.length, WORLD_CHAT_INPUT_BOUNDS.settled + 4);
    assert.equal(view.inputQueue?.inputs.length, WORLD_CHAT_INPUT_BOUNDS.settled + 1);
    assert.equal(view.inputQueue?.inputs[0]?.input.request.text, "Past message 3");
    assert.equal(view.inputQueue?.inputs.at(-1)?.input.request.text, "Still waiting");
    await writeCheckpoint(journal.log.dir, view);
    assert.equal((await readCheckpoint(journal.log.dir, view.seq)).checkpoint?.view.inputQueue?.inputs.length,
      WORLD_CHAT_INPUT_BOUNDS.settled + 1);
  });

  it("rejects stale native identities, prevents overtaking and only queues proven non-delivery", async () => {
    const state = await active();
    const { journal, messageId, attempt } = state;
    await assert.rejects(journal.offer(messageId, state.revision, { ...attempt, sessionId: "wrong" }, "wrong-session"), /active run/);
    await assert.rejects(journal.offer(messageId, state.revision, { ...attempt, ordinal: 2 }, "repair"), /repair attempt/);
    await journal.offer(messageId, state.revision, attempt, "offer");
    await assert.rejects(journal.settle({ messageId, attempt: { ...attempt, ordinal: 2 }, status: "included", boundary: "b", operationId: "late-repair" }), /does not belong/);
    await journal.settle({ messageId, attempt, status: "delivery-unknown", operationId: "lost-receipt" });
    let queue = await journal.read();
    assert.equal(queue.inputs[0]?.status, "uncertain");
    assert.equal(queue.pauseReason, "delivery-unknown");
    await assert.rejects(journal.remove(messageId, queue.revision, "remove"), /never-offered/);
    await assert.rejects(journal.offer(messageId, queue.revision, attempt, "retry-native"), /never-offered/);
    await journal.log.append({ type: "run.finished", run: { ...state.primary, status: "cancelled", endedAt: AT } }, { at: AT });
    queue = await journal.read();
    await assert.rejects(journal.continue(queue.revision, ROUTING, "continue-unknown"), /settled/);
    await journal.settle({ messageId, attempt, status: "not-delivered", operationId: "reconcile-original" });
    queue = await journal.read();
    assert.equal(queue.inputs[0]?.status, "queued");
    assert.equal(queue.pauseReason, "delivery-unknown", "reconciliation does not silently resume work");
    await assert.rejects(journal.remove(messageId, queue.revision, "remove-offered"), /never-offered/);
  });

  it("retains an older input that settles after newer inputs were removed", async () => {
    const { journal, id } = await setup();
    const first = await journal.record(request("Oldest input, latest delivery"), CAPTURE);
    const firstId = first.queue.inputs[0]!.input.messageId;
    let firstRemovalId: string | undefined;
    for (let index = 0; index < WORLD_CHAT_INPUT_BOUNDS.settled; index++) {
      const queued = await journal.record(request(`Removed later input ${index}`), CAPTURE);
      const messageId = queued.queue.inputs.at(-1)!.input.messageId;
      firstRemovalId ??= messageId;
      await journal.remove(messageId, queued.queue.revision, `remove-later-${index}`);
    }
    const promoted = await journal.promote(firstId, (await journal.read()).revision, await preparedRun(journal), ROUTING, "oldest-settles-last");
    assert.equal(promoted.queue.inputs[0]?.settledSequence, promoted.sequence);
    const view = foldConversation(id, AT, (await journal.log.read()).events).view;
    assert.equal(view.inputQueue?.inputs.length, WORLD_CHAT_INPUT_BOUNDS.settled);
    assert.equal(view.inputQueue?.inputs.find(row => row.input.messageId === firstId)?.status, "promoted");
    assert.equal(view.inputQueue?.inputs.some(row => row.input.messageId === firstRemovalId), false);
    await writeCheckpoint(journal.log.dir, view);
    const saved = await readCheckpoint(journal.log.dir, view.seq);
    assert.equal(saved.checkpoint?.view.inputQueue?.inputs.find(row => row.input.messageId === firstId)?.status, "promoted");
  });

  it("prevents a later current-reply input from overtaking a next-reply input", async () => {
    const state = await active();
    await state.journal.remove(state.messageId, state.revision, "remove-first");
    await state.journal.record(request("Next reply first"), CAPTURE);
    const later = await state.journal.record(request("Later correction", { delivery: "current", expectedRunId: state.primary.id }), CAPTURE);
    const messageId = later.queue.inputs.at(-1)!.input.messageId;
    await assert.rejects(state.journal.offer(messageId, later.queue.revision, state.attempt, "overtake"), /oldest/);
  });

  it("summarises confirmed corrections once, in order, and excludes queued directions", async () => {
    const state = await active();
    await state.journal.offer(state.messageId, state.revision, state.attempt, "offer");
    await state.journal.settle({ messageId: state.messageId, attempt: state.attempt, status: "included", boundary: "model-input", operationId: "include" });
    await state.journal.record(request("Unsent direction"), CAPTURE);
    await state.journal.log.append({ type: "turn.completed", run: { ...state.primary, status: "completed", endedAt: AT },
      message: { id: newId("msg"), turnId: state.primary.turnId, role: "studio", text: "s".repeat(60_000), attachmentIds: [], createdAt: AT },
      receipts: [], candidates: [], groups: [], tombstones: [] }, { at: AT });
    assert.equal(await refreshConversationSummary(state.journal.log, async input => {
      assert.equal(input.messages.length, 3);
      assert.equal(input.messages[1]?.id, state.messageId);
      assert.equal(input.messages[1]?.text, "Keep her motivation");
      assert.equal(input.messages.some(one => one.text === "Unsent direction"), false);
      return "Summary retaining the correction";
    }), true);
    assert.equal(await refreshConversationSummary(state.journal.log, async () => { throw new Error("must not summarise twice"); }), false);
  });

  it("pauses on recovery and turns a lost offer into uncertainty without replaying it", async () => {
    const state = await active();
    await state.journal.offer(state.messageId, state.revision, state.attempt, "offer");
    const first = await recoverConversations(state.world.dir, () => AT);
    const recovered = await state.journal.read();
    assert.deepEqual(first.repaired, [state.id]);
    assert.deepEqual(first.inputQueues, [state.id]);
    assert.equal(recovered.inputs[0]?.status, "uncertain");
    assert.equal(recovered.pauseReason, "delivery-unknown");
    const bytes = await readFile(state.journal.log.eventsPath, "utf8");
    assert.deepEqual((await recoverConversations(state.world.dir, () => AT)).repaired, []);
    assert.equal(await readFile(state.journal.log.eventsPath, "utf8"), bytes);
    const parked = await setup();
    await parked.journal.record(request(), CAPTURE);
    const parkedRecovery = await recoverConversations(parked.world.dir, () => AT);
    assert.deepEqual(parkedRecovery.repaired, [], "pausing waiting input does not repair a run");
    assert.deepEqual(parkedRecovery.inputQueues, [parked.id]);
    assert.deepEqual((await recoverConversations(parked.world.dir, () => AT)).inputQueues, []);
    assert.equal((await parked.journal.read()).pauseReason, "restart");
  });

  it("summarises a late inclusion once without consuming a newer unfinished turn", async () => {
    const state = await active();
    const { journal, messageId, attempt } = state;
    await journal.offer(messageId, state.revision, attempt, "offer");
    await journal.settle({ messageId, attempt, status: "accepted", operationId: "accept" });
    const complete = await journal.log.append({ type: "turn.completed", run: { ...state.primary, status: "completed", endedAt: AT },
      message: { id: newId("msg"), turnId: state.primary.turnId, role: "studio", text: "s".repeat(60_000), attachmentIds: [], createdAt: AT },
      receipts: [], candidates: [], groups: [], tombstones: [] }, { at: AT });
    assert.equal(await refreshConversationSummary(journal.log, async () => "First summary"), true);
    const later = run();
    const laterMessage = { id: newId("msg"), turnId: later.turnId, role: "user" as const, text: "Next turn", attachmentIds: [], createdAt: AT };
    await journal.log.append({ type: "turn.started", run: later, message: laterMessage }, { at: AT });
    await journal.settle({ messageId, attempt, status: "delivery-unknown", operationId: "lost-receipt" });
    await journal.settle({ messageId, attempt, status: "included", boundary: "confirmed-after-completion", operationId: "reconcile" });
    assert.equal(await refreshConversationSummary(journal.log, async input => {
      assert.equal(input.previousSummary, "First summary");
      assert.deepEqual(input.messages.map(one => one.id), [messageId]);
      assert.equal(input.messages[0]?.replyMessageId, complete.envelope.event.type === "turn.completed" ? complete.envelope.event.message.id : null);
      return "Summary with the confirmed correction";
    }), true);
    const reconciled = (await journal.log.read()).events.at(-1)!.event;
    assert.equal(reconciled.type === "summary.updated" ? reconciled.throughSeq : null, complete.envelope.seq);
    assert.equal(await refreshConversationSummary(journal.log, async () => { throw new Error("correction already summarised"); }), false);
    const answerId = newId("msg");
    await journal.log.append({ type: "turn.completed", run: { ...later, status: "completed", endedAt: AT },
      message: { id: answerId, turnId: later.turnId, role: "studio", text: "s".repeat(60_000), attachmentIds: [], createdAt: AT },
      receipts: [], candidates: [], groups: [], tombstones: [] }, { at: AT });
    assert.equal(await refreshConversationSummary(journal.log, async input => {
      assert.deepEqual(input.messages.map(one => one.id), [laterMessage.id, answerId]);
      return "Both turns and the correction";
    }), true);
  });

  it("orders late reconciliation before its own reply even after another turn completes", async () => {
    const state = await active();
    const { journal, id, messageId, attempt } = state;
    const firstUserId = foldConversation(id, AT, (await journal.log.read()).events).view.messages[0]!.id;
    await journal.offer(messageId, state.revision, attempt, "offer");
    await journal.settle({ messageId, attempt, status: "accepted", operationId: "accept" });
    const firstAnswerId = newId("msg");
    const firstCompletion = await journal.log.append({ type: "turn.completed", run: { ...state.primary, status: "completed", endedAt: AT },
      message: { id: firstAnswerId, turnId: state.primary.turnId, role: "studio", text: "Reply using the correction", attachmentIds: [], createdAt: AT },
      receipts: [], candidates: [], groups: [], tombstones: [] }, { at: AT });
    const later = run(), laterUserId = newId("msg"), laterAnswerId = newId("msg");
    await journal.log.append({ type: "turn.started", run: later,
      message: { id: laterUserId, turnId: later.turnId, role: "user", text: "An unrelated next turn", attachmentIds: [], createdAt: AT } }, { at: AT });
    await journal.log.append({ type: "turn.completed", run: { ...later, status: "completed", endedAt: AT },
      message: { id: laterAnswerId, turnId: later.turnId, role: "studio", text: "The later reply", attachmentIds: [], createdAt: AT },
      receipts: [], candidates: [], groups: [], tombstones: [] }, { at: AT });
    await journal.settle({ messageId, attempt, status: "included", boundary: "confirmed-later", operationId: "reconcile" });
    const events = (await journal.log.read()).events;
    const expected = [firstUserId, messageId, firstAnswerId, laterUserId, laterAnswerId];
    const full = foldConversation(id, AT, events).view;
    assert.deepEqual(full.messages.map(one => one.id), expected);
    const latest = foldConversation(id, AT, events, { messageLimit: 3 }).view;
    assert.deepEqual(latest.messages.map(one => one.id), [firstAnswerId, laterUserId, laterAnswerId]);
    assert.equal(latest.hasMore, true);
    const older = foldConversation(id, AT, events, { messageLimit: 3, before: firstCompletion.envelope.seq }).view;
    assert.deepEqual(older.messages.map(one => one.id), [firstUserId, messageId]);
    assert.equal(older.hasMore, false);
    await writeCheckpoint(journal.log.dir, full);
    assert.deepEqual((await readCheckpoint(journal.log.dir, full.seq)).checkpoint?.view.messages.map(one => one.id), expected);
    assert.equal(await refreshConversationSummary(journal.log, async input => {
      assert.equal(input.previousSummary, undefined);
      assert.deepEqual(input.messages.map(one => one.id), expected);
      assert.equal(input.messages[1]?.replyMessageId, firstAnswerId);
      assert.equal(input.messages[1]?.text, "Keep her motivation");
      return "Both replies with the correction attributed to the first";
    }), true);
    assert.equal(await refreshConversationSummary(journal.log, async () => { throw new Error("already included"); }), false);
  });

  it("refuses new admission during wrap-up and permits it again after a failed wrap-up", async () => {
    const { journal } = await setup();
    await journal.log.append({ type: "wrapup.intent-recorded", requestId: "wrap", expectedConversationSeq: 1, plannedProposalIds: [] }, { at: AT });
    await assert.rejects(journal.record(request(), CAPTURE), /wrap-up/);
    assert.equal((await journal.read()).inputs.length, 0);
    await journal.log.append({ type: "wrapup.failed", requestId: "wrap", safeDetail: "No proposals staged" }, { at: AT });
    assert.equal((await journal.record(request(), CAPTURE)).queue.inputs.length, 1);
  });

  it("refuses both fresh admission and an older in-flight admission once deletion commits its intent", async t => {
    const { journal, world, id } = await setup();
    let admissionEntered!: () => void, releaseAdmission!: () => void;
    const admissionAtAppend = new Promise<void>(resolve => { admissionEntered = resolve; });
    const admissionHeld = new Promise<void>(resolve => { releaseAdmission = resolve; });
    const append = journal.log.append.bind(journal.log);
    t.mock.method(journal.log, "append", async (...args: Parameters<typeof append>) => {
      if (args[0].type === "input.recorded") { admissionEntered(); await admissionHeld; }
      return append(...args);
    });
    let deletionEntered!: () => void, releaseDeletion!: () => void;
    const deletionAtDrain = new Promise<void>(resolve => { deletionEntered = resolve; });
    const deletionHeld = new Promise<void>(resolve => { releaseDeletion = resolve; });
    const drain = WorldChatStore.prototype.drain;
    t.mock.method(WorldChatStore.prototype, "drain", async function (this: WorldChatStore) {
      if (this.dir === journal.log.dir) { deletionEntered(); await deletionHeld; }
      return drain.call(this);
    });
    const pending = journal.record(request("Already checked the open conversation"), CAPTURE);
    await admissionAtAppend;
    const deleting = new WorldChatService(world.dir, () => AT).delete(id, "delete-wins");
    try {
      await deletionAtDrain;
      await assert.rejects(new WorldChatInputJournal(world, id, () => AT).record(request("After intent"), CAPTURE), /being deleted/);
      releaseAdmission();
      await assert.rejects(pending, /being deleted/);
      assert.equal((await journal.read()).inputs.length, 0);
    } finally { releaseAdmission(); releaseDeletion(); await deleting; }
    assert.equal(await journal.log.readMeta(), null);
  });

  it("rechecks deletion when an input commits after its preflight", async t => {
    const { journal, world, id } = await setup();
    const append = WorldChatStore.prototype.append;
    let admitted = false;
    t.mock.method(WorldChatStore.prototype, "append", async function (this: WorldChatStore, ...args: Parameters<typeof append>) {
      if (this.dir === journal.log.dir && args[0].type === "deletion.intent-recorded" && !admitted) {
        admitted = true;
        await journal.record(request("Input wins"), CAPTURE);
      }
      return append.apply(this, args);
    });
    await assert.rejects(new WorldChatService(world.dir, () => AT).delete(id, "input-wins"), /waiting for delivery/);
    assert.equal((await journal.read()).inputs.length, 1);
    assert.equal((await journal.log.read()).events.some(one => one.event.type === "deletion.intent-recorded"), false);
    assert.ok(await journal.log.readMeta());
  });

  it("replays archive/failure as a pause and refuses deletion while input is unresolved", async () => {
    const { journal, world, id } = await setup();
    await journal.record(request(), CAPTURE);
    const service = new WorldChatService(world.dir, () => AT);
    await assert.rejects(service.delete(id, "delete"), /waiting for delivery/);
    await service.archive(id);
    await service.unarchive(id);
    assert.equal((await journal.read()).pauseReason, "archived");
    const state = await active();
    await state.journal.log.append({ type: "run.finished", run: { ...state.primary, status: "failed", endedAt: AT } }, { at: AT });
    assert.equal((await state.journal.read()).pauseReason, "failed");
  });

  it("allows new input after restoring a conversation whose earlier inputs were all settled", async () => {
    for (const status of ["included", "promoted", "removed"] as const) {
      const { journal, world, id, primary, messageId, attempt, revision } = await active();
      if (status === "included") {
        await journal.offer(messageId, revision, attempt, "offer");
        await journal.settle({ messageId, attempt, status: "included", boundary: "model-input-2", operationId: "include" });
      }
      await journal.log.append({ type: "run.finished", run: { ...primary, status: "completed", endedAt: AT } }, { at: AT });
      if (status === "removed") await journal.remove(messageId, revision, "remove");
      if (status === "promoted") {
        const next = await preparedRun(journal);
        await journal.promote(messageId, revision, next, ROUTING, "promote");
        await journal.log.append({ type: "run.finished", run: { ...next, status: "completed", endedAt: AT } }, { at: AT });
      }
      assert.equal((await journal.read()).inputs[0]?.status, status);
      const service = new WorldChatService(world.dir, () => AT);
      await service.archive(id);
      await service.unarchive(id);
      const added = await journal.record(request("A new direction after restoring"), CAPTURE);
      assert.equal(added.queue.pauseReason, null, `${status} history needs no Continue`);
      const started = await journal.promote(added.queue.inputs.at(-1)!.input.messageId, added.queue.revision,
        await preparedRun(journal), ROUTING, "after-restore");
      assert.equal(started.event.type, "input.promoted");
    }
  });

  it("invalidates an old Continue even if the queue was already paused when archived", async () => {
    const { journal, world, id } = await setup();
    await journal.record(request(), CAPTURE);
    const stopped = await journal.pause("stopped", "stop");
    const service = new WorldChatService(world.dir, () => AT);
    await service.archive(id);
    await service.unarchive(id);
    await assert.rejects(journal.continue(stopped.queue.revision, ROUTING, "delayed-continue"), /changed/);
    assert.equal((await journal.read()).pauseReason, "stopped");
  });

  it("repairs a partial append on the first explicit retry, including when read repairs it first", async () => {
    for (const readFirst of [false, true]) {
      const { journal } = await setup();
      const input = request();
      const probe = await open(journal.log.eventsPath, "r");
      const handles = Object.getPrototypeOf(probe) as { appendFile: (data: string) => Promise<void> };
      await probe.close();
      const real = handles.appendFile;
      handles.appendFile = async function (this: unknown, data: string) {
        await real.call(this, data.slice(0, 30));
        throw new Error("device write stopped part-way");
      };
      try {
        await assert.rejects(journal.record(input, CAPTURE), /device write stopped/);
      } finally { handles.appendFile = real; }
      assert.equal((await readFile(journal.log.eventsPath, "utf8")).endsWith("\n"), false);
      if (readFirst) assert.equal((await journal.read()).inputs.length, 0);
      const retried = await journal.record(input, CAPTURE);
      assert.equal(retried.deduplicated, false);
      assert.equal(retried.queue.inputs.length, 1);
      assert.equal(retried.queue.inputs[0]?.input.request.submissionId, input.submissionId);
      assert.equal((await journal.record(input, CAPTURE)).deduplicated, true);
      const { events, problems } = await new WorldChatStore(journal.log.dir).read();
      assert.deepEqual(problems, []);
      assert.deepEqual(events.map(one => one.seq), [1, 2]);
    }
  });

  it("still refuses input when the repaired tail contains interior corruption", async () => {
    const { journal, other } = await setup();
    await appendFile(journal.log.eventsPath, '{not a complete event}\n{"partial', "utf8");
    const reopened = other();
    await assert.rejects(reopened.record(request(), CAPTURE), /input history needs repair/);
    await assert.rejects(reopened.read(), /input history needs repair/);
    const { events, problems } = await reopened.log.read();
    assert.equal(events.length, 1);
    assert.equal(problems[0]?.kind, "interior-corruption");
  });

  it("does not acknowledge a readable event until a retry successfully flushes it", async () => {
    const { journal } = await setup();
    const input = request();
    const probe = await open(journal.log.eventsPath, "r");
    const handles = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
    await probe.close();
    const real = handles.sync;
    let syncs = 0;
    handles.sync = async function () { syncs++; throw new Error("device sync failed"); };
    try {
      await assert.rejects(journal.record(input, CAPTURE), /device sync failed/);
      assert.equal((await journal.read()).inputs.length, 1, "the failed flush may leave a whole line");
      await assert.rejects(journal.record(input, CAPTURE), /device sync failed/);
      assert.equal(syncs, 2, "reading a duplicate cannot stand in for flushing it");
    } finally { handles.sync = real; }
    assert.equal((await journal.record(input, CAPTURE)).deduplicated, true);
    assert.equal((await journal.read()).inputs.length, 1);
  });

  it("refuses admission after world close and never writes past a failed compatibility boundary", async () => {
    const state = await setup();
    assert.throws(() => new WorldChatInputJournal(state.world, "../outside"));
    state.world.raiseSchemaBoundary = async () => { throw new Error("boundary failed"); };
    await assert.rejects(state.journal.record(request(), CAPTURE), /boundary failed/);
    assert.equal((await state.journal.read()).inputs.length, 0);
    state.closing.abort();
    await assert.rejects(state.journal.record(request(), CAPTURE), /world closed/);
  });

  it("fences real worlds before new input events so a version-22 reader refuses them", async () => {
    const dir = await makeTempWorld();
    const world = await WorldStore.open(dir);
    try {
      const service = new WorldChatService(dir, () => AT);
      const created = await world.ownedWrite(() => service.create({ title: "Queued input" }));
      const journal = new WorldChatInputJournal(world, created.id, () => AT);
      const receipt = await journal.record(request(), CAPTURE);
      assert.equal(receipt.deduplicated, false);
      assert.equal((await readWorldMeta(dir)).schemaVersion, WORLD_CHAT_INPUT_SCHEMA_VERSION);
      await assert.rejects(readWorldMeta(dir, { supports: 22 }), /newer|version/i);
      assert.equal(foldWorldChatInputs((await new WorldChatStore(journal.log.dir).read()).events).problems.length, 0);
    } finally { await world.close(); }
  });
});


it("input and interrupted-run recovery leave corrupt journal bytes untouched", async () => {
  const state = await active();
  await state.journal.offer(state.messageId, state.revision, state.attempt, "offer-before-corruption");
  const last = (await state.journal.log.read()).events.at(-1)!;
  await appendFile(state.journal.log.eventsPath, JSON.stringify({ ...last, seq: last.seq + 1,
    eventId: newId("wce"), event: { type: "unreadable-event" } }) + "\n", "utf8");
  const before = await readFile(state.journal.log.eventsPath, "utf8");
  assert.equal(await recoverWorldChatInputs(state.journal.log, () => AT), false);
  const recovery = await recoverConversations(state.world.dir, () => AT);
  assert.deepEqual(recovery.inputQueues, []);
  assert.deepEqual(recovery.repaired, []);
  assert.equal(await readFile(state.journal.log.eventsPath, "utf8"), before);
});

it("promotion verifies the queued attachment's actual bytes after restart", async () => {
  for (const missing of [false, true]) {
    const state = await setup();
    const files = new WorldChatAttachmentStore(state.world.dir, () => AT);
    const attachment = await files.ingestText(state.id, "Original content", "notes.txt");
    const receipt = await state.journal.record(request("Read this", { attachmentIds: [attachment.id] }), CAPTURE);
    const input = receipt.queue.inputs[0]!.input;
    const path = join(attachmentDir(state.world.dir, state.id, attachment.id), attachment.fileName);
    if (missing) await unlink(path); else await writeFile(path, "Modified content", "utf8");
    const reopened = state.other();
    const before = await readFile(reopened.log.eventsPath, "utf8");
    await assert.rejects(reopened.promote(input.messageId, receipt.queue.revision, await preparedRun(reopened), ROUTING, "changed-file"), /changed or is missing/);
    assert.equal(await readFile(reopened.log.eventsPath, "utf8"), before);
    assert.equal((await reopened.read()).inputs[0]!.status, "queued");
    await writeFile(path, "Original content", "utf8");
    assert.equal((await reopened.promote(input.messageId, receipt.queue.revision, await preparedRun(reopened), ROUTING, "restored-file")).event.type, "input.promoted");
  }
});


it("rechecks attachment bytes after the compatibility commit yields", async t => {
  const state = await setup();
  const files = new WorldChatAttachmentStore(state.world.dir, () => AT);
  const attachment = await files.ingestText(state.id, "Original", "notes.txt");
  const receipt = await state.journal.record(request("Read this", { attachmentIds: [attachment.id] }), CAPTURE);
  const path = join(attachmentDir(state.world.dir, state.id, attachment.id), attachment.fileName);
  t.mock.method(state.world, "raiseSchemaBoundary", async () => { await writeFile(path, "Changed", "utf8"); });
  await assert.rejects(state.journal.promote(receipt.queue.inputs[0]!.input.messageId, receipt.queue.revision,
    await preparedRun(state.journal), ROUTING, "file-changed-during-boundary"), /changed or is missing/);
  assert.equal((await state.journal.read()).inputs[0]!.status, "queued");
  assert.equal((await state.journal.log.read()).events.some(one => one.event.type === "input.promoted"), false);
});
