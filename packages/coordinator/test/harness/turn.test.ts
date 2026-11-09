import assert from "node:assert/strict";
import { it } from "node:test";
import type { HarnessAdapter, HarnessEvent } from "@arke-studio/contracts";
import { runHarnessTurn } from "../../src/harness/turn.js";

/**
 * The one way a prepared session is asked something (issue 2801). Every ending is a value the
 * caller can tell apart, and every ending but an answer tells the session to stop.
 */

/** Plays back whatever `say` is given once a dispatch has arrived; records what was asked of it. */
function fakeAdapter(script: (say: (event: HarnessEvent) => void) => void = () => {}) {
  const listeners = new Set<(event: HarnessEvent) => void>();
  const record = { dispatched: 0, interrupted: 0, tokens: 0, interrupt: Promise.resolve() };
  const say = (event: HarnessEvent) => { for (const listener of listeners) listener(event); };
  const adapter = {
    async dispatchAsync() { record.dispatched++; setImmediate(() => script(say)); return { ok: true }; },
    async interrupt() { record.interrupted++; await record.interrupt; },
    usageTokens: () => record.tokens,
    streamEvents(signal?: AbortSignal): AsyncIterable<HarnessEvent> {
      const queue: HarnessEvent[] = [];
      let wake: (() => void) | undefined;
      const listener = (event: HarnessEvent) => { queue.push(event); wake?.(); };
      listeners.add(listener);
      signal?.addEventListener("abort", () => { listeners.delete(listener); wake?.(); }, { once: true });
      return (async function* () {
        while (!signal?.aborted) {
          if (queue.length === 0) await new Promise<void>((resolve) => { wake = resolve; });
          while (queue.length > 0) yield queue.shift()!;
        }
      })();
    },
  } as unknown as HarnessAdapter;
  return { adapter, record };
}

const PARTS = [{ type: "text" as const, text: "Name the lighthouse." }];

it("an answer is completed with its text, and nothing is interrupted", async () => {
  const { adapter, record } = fakeAdapter((say) => {
    say({ type: "message.completed", sessionId: "other", text: "Not ours." });
    say({ type: "message.delta", sessionId: "s1", text: "The Lantern" });
    say({ type: "message.completed", sessionId: "s1", text: "The Lantern of Maren" });
  });
  const seen: string[] = [];
  const outcome = await runHarnessTurn(adapter, { sessionId: "s1", parts: PARTS, timeoutMs: 5_000, onEvent: (event) => seen.push(event.type) });
  assert.deepEqual(outcome, { kind: "completed", text: "The Lantern of Maren" });
  assert.deepEqual(seen, ["message.delta", "message.completed"], "only this session's events");
  assert.equal(record.interrupted, 0);
});

it("a harness error is failed with its words, and the session is told to stop", async () => {
  const { adapter, record } = fakeAdapter((say) => say({ type: "session.error", sessionId: "s1", message: "model refused" }));
  assert.deepEqual(await runHarnessTurn(adapter, { sessionId: "s1", parts: PARTS, timeoutMs: 5_000 }), { kind: "failed", detail: "model refused" });
  assert.equal(record.interrupted, 1);
});

it("each way the harness ends a session is its own ending", async () => {
  const end = async (reason: "completed" | "cancelled" | "timeout" | "budget-exceeded" | "error", detail?: string) => {
    const { adapter } = fakeAdapter((say) => {
      say({ type: "message.delta", sessionId: "s1", text: "Half a name" });
      say({ type: "session.ended", sessionId: "s1", reason, ...(detail !== undefined ? { detail } : {}) });
    });
    return runHarnessTurn(adapter, { sessionId: "s1", parts: PARTS, timeoutMs: 5_000 });
  };
  assert.deepEqual(await end("completed"), { kind: "completed", text: "Half a name" }, "what was written is the answer");
  assert.deepEqual(await end("cancelled"), { kind: "cancelled" });
  assert.deepEqual(await end("timeout"), { kind: "timeout" });
  assert.deepEqual(await end("budget-exceeded", "length limit"), { kind: "over-budget", detail: "length limit" });
  assert.deepEqual(await end("error", "crashed"), { kind: "failed", detail: "crashed" });
});

it("a stream that ends with nothing said is unanswered, which is not a failure the harness reported", async () => {
  const { adapter, record } = fakeAdapter();
  const ending = new AbortController();
  const original = adapter.streamEvents.bind(adapter);
  adapter.streamEvents = (signal) => original(AbortSignal.any([ending.signal, ...(signal ? [signal] : [])]));
  const asking = runHarnessTurn(adapter, { sessionId: "s1", parts: PARTS, timeoutMs: 5_000 });
  while (record.dispatched === 0) await new Promise((resolve) => setImmediate(resolve));
  ending.abort();
  assert.deepEqual(await asking, { kind: "unanswered" });
  assert.equal(record.interrupted, 1);
});

it("the wall clock ends a silent turn as a timeout and stops the session", async () => {
  const { adapter, record } = fakeAdapter();
  assert.deepEqual(await runHarnessTurn(adapter, { sessionId: "s1", parts: PARTS, timeoutMs: 20 }), { kind: "timeout" });
  assert.equal(record.interrupted, 1);
});

it("a stop is cancelled rather than an empty answer, and one already made sends nothing", async () => {
  const { adapter, record } = fakeAdapter();
  const stop = new AbortController();
  const asking = runHarnessTurn(adapter, { sessionId: "s1", parts: PARTS, timeoutMs: 5_000, signal: stop.signal });
  while (record.dispatched === 0) await new Promise((resolve) => setImmediate(resolve));
  stop.abort();
  assert.deepEqual(await asking, { kind: "cancelled" });
  assert.equal(record.interrupted, 1);
  assert.deepEqual(await runHarnessTurn(adapter, { sessionId: "s1", parts: PARTS, timeoutMs: 5_000, signal: stop.signal }), { kind: "cancelled" });
  assert.equal(record.dispatched, 1, "the second ask was never sent");
});

it("a failed dispatch or preparation is failed, and preparation that fails sends nothing", async () => {
  const { adapter, record } = fakeAdapter();
  adapter.dispatchAsync = async () => { throw new Error("harness gone"); };
  assert.deepEqual(await runHarnessTurn(adapter, { sessionId: "s1", parts: PARTS, timeoutMs: 5_000 }), { kind: "failed", detail: "harness gone" });
  const second = fakeAdapter();
  assert.deepEqual(await runHarnessTurn(second.adapter, { sessionId: "s1", parts: PARTS, timeoutMs: 5_000,
    beforeDispatch: async () => { throw new Error("cloud review is off"); } }), { kind: "failed", detail: "cloud review is off" });
  assert.equal(second.record.dispatched, 0);
  assert.equal(record.interrupted, 1);
});

it("a session past its token budget is over budget and stopped", async () => {
  const { adapter, record } = fakeAdapter((say) => { record.tokens = 9_000; say({ type: "message.delta", sessionId: "s1", text: "and on" }); });
  assert.deepEqual(await runHarnessTurn(adapter, { sessionId: "s1", parts: PARTS, timeoutMs: 5_000, tokenBudget: 8_000 }),
    { kind: "over-budget", detail: "passed the 8,000-token budget" });
  assert.equal(record.interrupted, 1);
});

it("waits for the interruption to settle only when asked to", async () => {
  let release!: () => void;
  const { adapter, record } = fakeAdapter();
  record.interrupt = new Promise<void>((resolve) => { release = resolve; });
  assert.deepEqual(await runHarnessTurn(adapter, { sessionId: "s1", parts: PARTS, timeoutMs: 10 }), { kind: "timeout" }, "a one-off ask moves on");
  let answered = false;
  const waiting = runHarnessTurn(adapter, { sessionId: "s1", parts: PARTS, timeoutMs: 10, awaitInterruption: true }).then((outcome) => { answered = true; return outcome; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(answered, false, "a queued reply must not overtake the stop");
  release();
  assert.deepEqual(await waiting, { kind: "timeout" });
});
