import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { newId, type WorldChatInputRequest, type WorldChatRun } from "@arke-studio/contracts";
import { ConversationInputs } from "../../src/application/conversation-inputs.js";
import { WorldChatService } from "../../src/world-chat/service.js";
import { WorldChatInputJournal } from "../../src/world-chat/input-journal.js";
import { recoverWorldChatInputs } from "../../src/world-chat/input-recovery.js";
import type { TurnOutcome } from "../../src/world-chat/run.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
async function until(test: () => boolean) { for (let i = 0; i < 300; i++) { if (test()) return; await new Promise(r => setTimeout(r, 10)); } assert.fail("queue did not settle"); }
const DONE: TurnOutcome = { status: "completed", reply: "Done." };

async function fixture() {
  const store = await WorldStore.open(await makeTempWorld()); closeOnCleanup(() => store.close());
  const conversation = await new WorldChatService(store.dir).create({ title: "Direction" });
  const id = conversation.id, journal = new WorldChatInputJournal(store, id);
  let running = false, route = { adapter: "fake", modelId: null, fingerprint: `sha256:${"a".repeat(64)}` };
  let pausedBeforeCancel = false, cancelled = false;
  const turns: { text: string; finish: ReturnType<typeof deferred<TurnOutcome>>; admitted: boolean; outcome: Promise<TurnOutcome> }[] = [];
  let current: ReturnType<typeof deferred<TurnOutcome>> | null = null;
  let changed = 0, stopping = false;
  const tracked: Promise<TurnOutcome>[] = [];
  const newRun = async (): Promise<WorldChatRun> => ({ id: newId("run"), turnId: newId("turn"), adapter: "fake", model: "default",
    basedOnConversationSeq: (await journal.log.read()).events.at(-1)!.seq, status: "running", harnessCleanup: "not-required",
    contextDigest: `sha256:${"b".repeat(64)}`, startedAt: store.now() });
  const finishRun = async (run: WorldChatRun, finish: ReturnType<typeof deferred<TurnOutcome>>) => {
    const outcome = await finish.promise;
    await journal.log.append({ type: "run.finished", run: { ...run, status: outcome.status === "unavailable" ? "failed" : outcome.status, endedAt: store.now() } }, { at: store.now() });
    running = false; return outcome;
  };
  const owner = new ConversationInputs(store, {
    stopping: () => stopping, track: completion => { tracked.push(completion); },
    routing: () => route, changed: async () => { changed++; },
    runner: () => ({ isRunning: () => running, cancel: () => {
      cancelled = true;
      const events = readFileSync(join(journal.log.dir, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
      pausedBeforeCancel = events.at(-1).event.type === "input-queue.paused";
      return running;
    }, sendQueued: (log, messageId, revision, routing, onAdmitted, beforePromote) => {
      assert.equal(running, false, "one native turn at a time"); running = true;
      const finish = deferred<TurnOutcome>(); current = finish;
      const row = { text: "", finish, admitted: false, outcome: Promise.resolve(DONE) };
      turns.push(row);
      row.outcome = (async () => {
        const input = (await log.read()).inputs.find(one => one.input.messageId === messageId)!;
        row.text = input.input.request.text;
        await beforePromote?.(); const run = await newRun();
        await log.promote(messageId, revision, run, routing, newId("wce"));
        row.admitted = true; onAdmitted?.(run.turnId);
        return finishRun(run, finish);
      })();
      return row.outcome;
    } }),
  });
  const primary = async () => {
    const run = await newRun(), finish = deferred<TurnOutcome>(); current = finish;
    const started = await owner.start(id, async () => {
      running = true;
      await journal.log.append({ type: "turn.started", run, message: { id: newId("msg"), turnId: run.turnId, role: "user", text: "Draft", attachmentIds: [], createdAt: store.now() } }, { at: store.now() });
      return { completion: finishRun(run, finish), naming: null };
    });
    assert.ok(started); return { run, finish, completion: started.completion };
  };
  const request = (text: string, expectedRunId: string | null = null): WorldChatInputRequest => ({ submissionId: newId("msg"), text, attachmentIds: [], expectedRunId: expectedRunId as never, delivery: "next" });
  return { store, id, journal, owner, turns, primary, request, route: () => route,
    beginShutdown: () => { stopping = true; }, tracked,
    changeRoute: () => { route = { ...route, fingerprint: `sha256:${"c".repeat(64)}` }; },
    cancelled: () => cancelled, pausedBeforeCancel: () => pausedBeforeCancel, finishCurrent: (outcome = DONE) => current!.resolve(outcome), changed: () => changed };
}

it("queues duplicate submissions once and promotes FIFO only after the primary reply settles", async () => {
  const h = await fixture(), primary = await h.primary();
  const first = h.request("First", primary.run.id), second = h.request("Second", primary.run.id);
  await Promise.all([h.owner.record(h.id, first), h.owner.record(h.id, first)]);
  await h.owner.record(h.id, second);
  assert.equal(h.turns.length, 0); assert.equal((await h.journal.read()).inputs.length, 2);
  assert.equal(await h.owner.start(h.id, async () => { assert.fail("ordinary Send cannot overtake queued words"); }), null);
  primary.finish.resolve(DONE); await primary.completion;
  await until(() => h.turns[0]?.admitted === true);
  assert.equal(h.turns[0]!.text, "First");
  h.turns[0]!.finish.resolve(DONE); await h.turns[0]!.outcome;
  await until(() => h.turns[1]?.admitted === true);
  assert.equal(h.turns[1]!.text, "Second");
  h.turns[1]!.finish.resolve(DONE); await h.turns[1]!.outcome;
  await until(() => h.changed() >= 3);
  assert.deepEqual((await h.journal.read()).inputs.map(row => row.status), ["promoted", "promoted"]);
  assert.equal((await h.owner.receipt(h.id, first.submissionId)).inputs.length, 2);
});

it("Stop flushes a pause before interruption; late input and completion cannot resume it", async () => {
  const h = await fixture(), primary = await h.primary();
  await h.owner.record(h.id, h.request("First", primary.run.id));
  await h.owner.stop(h.id); assert.equal(h.pausedBeforeCancel(), true);
  await h.owner.record(h.id, h.request("Second", primary.run.id));
  let queue = await h.journal.read();
  await assert.rejects(h.owner.resume(h.id, queue.revision, h.route(), "too-early"), /settle/);
  primary.finish.resolve({ status: "cancelled" }); await primary.completion;
  assert.equal(h.turns.length, 0); queue = await h.journal.read(); assert.equal(queue.pauseReason, "stopped");
  await h.owner.remove(h.id, queue.inputs[1]!.input.messageId, queue.revision, "remove-second");
  await assert.rejects(h.owner.resume(h.id, queue.revision, h.route(), "stale-continue"), /changed|revision/i);
  queue = await h.journal.read(); await h.owner.resume(h.id, queue.revision, h.route(), "continue");
  await until(() => h.turns[0]?.admitted === true); assert.equal(h.turns[0]!.text, "First");
  h.finishCurrent(); await h.turns[0]!.outcome;
});

it("a changed route pauses before dispatch and Continue rechecks the shown destination", async () => {
  const h = await fixture(), primary = await h.primary();
  await h.owner.record(h.id, h.request("Keep the motivation", primary.run.id));
  const oldRoute = h.route(); h.changeRoute(); primary.finish.resolve(DONE); await primary.completion;
  const queue = await h.journal.read(); assert.equal(queue.pauseReason, "routing-changed"); assert.equal(h.turns.length, 0);
  await assert.rejects(h.owner.resume(h.id, queue.revision, oldRoute, "old-route"), /destination changed/);
  await h.owner.resume(h.id, queue.revision, h.route(), "reviewed-route");
  await until(() => h.turns[0]?.admitted === true); h.finishCurrent(); await h.turns[0]!.outcome;
});

it("a failed Stop flush still interrupts and fences advancement until its pause can be saved", async t => {
  const h = await fixture(), primary = await h.primary();
  await h.owner.record(h.id, h.request("Retained", primary.run.id));
  const pause = t.mock.method(WorldChatInputJournal.prototype, "pause", async () => { throw Error("disk flush failed"); });
  await assert.rejects(h.owner.stop(h.id), /disk flush/);
  assert.equal(h.cancelled(), true);
  await h.owner.record(h.id, h.request("Also retained", primary.run.id));
  assert.equal(h.turns.length, 0);
  pause.mock.restore();
  primary.finish.resolve(DONE); await primary.completion;
  assert.equal(h.turns.length, 0);
  assert.equal((await h.journal.read()).pauseReason, "stopped");
});

it("recovery pauses retained words and a new owner never starts them on construction", async () => {
  const h = await fixture();
  await h.journal.record(h.request("Saved before restart"), { routing: h.route(), constraints: { replyOnly: false } });
  await recoverWorldChatInputs(h.journal.log, () => h.store.now());
  const queue = await h.journal.read(); assert.equal(queue.pauseReason, "restart"); assert.equal(h.turns.length, 0);
  await h.owner.record(h.id, h.request("A new message")); assert.equal(h.turns.length, 0);
  assert.equal((await h.journal.read()).pauseReason, "restart");
});

it("tracks every queued completion for shutdown and admits no successor after shutdown starts", async () => {
  const h = await fixture(), primary = await h.primary();
  await h.owner.record(h.id, h.request("First", primary.run.id));
  await h.owner.record(h.id, h.request("Second", primary.run.id));
  primary.finish.resolve(DONE); await primary.completion;
  await until(() => h.turns[0]?.admitted === true);
  assert.equal(h.tracked.length, 2, "primary and queued completions enter the coordinator drain");
  h.beginShutdown();
  await assert.rejects(h.owner.record(h.id, h.request("Too late")), /shutting down/);
  assert.equal(await h.owner.start(h.id, async () => { assert.fail("shutdown cannot start work"); }), null);
  let drained = false; const drain = Promise.allSettled(h.tracked).then(() => { drained = true; });
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(drained, false);
  h.finishCurrent(); await drain;
  assert.equal(h.turns.length, 1, "completion during shutdown cannot dispatch the next input");
  assert.equal((await h.journal.read()).inputs[1]!.status, "queued");
});
