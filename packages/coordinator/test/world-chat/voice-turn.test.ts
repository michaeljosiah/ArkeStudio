import assert from "node:assert/strict";
import { test } from "node:test";
import { newId, type ConversationId, type HarnessAdapter, type HarnessEvent, type RunId } from "@arke-studio/contracts";
import { WorldChatRunner, type RunDeps } from "../../src/world-chat/run.js";
import { WorldChatStore, conversationDir } from "../../src/world-chat/store.js";
import { foldConversation } from "../../src/world-chat/fold.js";
import { tempDir } from "../tmp.js";

const at = "2026-11-09T12:00:00Z";
async function setup(answer: string, delayed = false, streamedLength?: number) {
  const dir = await tempDir("arke-voice-turn-"), id = newId("cv") as ConversationId;
  const store = new WorldChatStore(conversationDir(dir, id));
  await store.create(id, at);
  await store.append({ type: "conversation.created", title: "Spoken ideas", entryContext: { kind: "world" } }, { at });
  let dispatch!: () => void, release!: () => void;
  const dispatched = new Promise<void>(resolve => { dispatch = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const released: RunId[] = [], roles: Array<string | undefined> = [];
  let owned = true, calls = 0;
  const adapter = {
    id: "voice-fake", readiness: () => ({ ready: true }),
    dispatchAsync: async () => {
      calls++;
      const view = foldConversation(id, at, (await store.read()).events).view;
      assert.equal(view.messages.at(-1)?.role, "user", "Recognized user text must be durable before model dispatch");
      dispatch(); return { ok: true };
    },
    interrupt: async () => {},
    streamEvents: (signal: AbortSignal) => (async function* (): AsyncGenerator<HarnessEvent> {
      await dispatched;
      if (delayed) await Promise.race([held, new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }))]);
      if (signal.aborted) return;
      yield { type: "message.delta", sessionId: "voice-session", text: answer.slice(0, 5) };
      if (signal.aborted) return;
      yield { type: "message.delta", sessionId: "voice-session", text: streamedLength ? answer.slice(0, streamedLength) : answer };
      if (signal.aborted) return;
      yield { type: "message.completed", sessionId: "voice-session", text: answer };
    })(),
  } as unknown as HarnessAdapter;
  const deps = {
    adapter, now: () => at, prepare: async () => ({ cwd: dir, leaseToken: "1".repeat(64) }),
    createSession: async ({ agent }: { agent?: string }) => { roles.push(agent); return { sessionId: "voice-session" }; },
    release: async ({ runId }: { runId: RunId }) => { released.push(runId); }, receiptsFor: () => [],
    resolveLanguageModel: async () => ({ modelId: "cloud/chosen", sessionModel: "cloud/chosen" }),
    assertVoiceOwnership: async () => { if (!owned) throw new Error("Ownership lost"); },
  } as unknown as RunDeps;
  return { runner: new WorldChatRunner(deps), store, id, dispatched, release, released, roles,
    view: async () => foldConversation(id, at, (await store.read()).events).view,
    loseOwnership: () => { owned = false; }, calls: () => calls };
}

test("spoken turns use one authoritative flushed history and convert cumulative deltas once", async () => {
  const h = await setup("Hello. Tell me more.");
  const binding = await h.runner.prepareVoice(h.store, h.id, new AbortController().signal);
  const chunks: string[] = [];
  const outcome = await h.runner.voice(h.store, h.id, "Let's talk.", binding, new AbortController().signal, chunk => chunks.push(chunk));
  assert.equal(outcome.status, "completed");
  assert.equal(chunks.join(""), "Hello. Tell me more.");
  assert.deepEqual(h.roles, ["voice-companion"]);
  const view = await h.view();
  assert.deepEqual(view.messages.map(message => [message.role, message.text]), [["user", "Let's talk."], ["studio", "Hello. Tell me more."]]);
  assert.equal(view.messages[0]!.turnId, view.messages[1]!.turnId);
  assert.equal(view.activeRun, null);
  assert.equal(h.released.length, 1);
});

test("structured proposal output never reaches speech and cannot create candidates", async () => {
  const h = await setup('{"reply":"Do not speak JSON"}');
  const binding = await h.runner.prepareVoice(h.store, h.id, new AbortController().signal), spoken: string[] = [];
  const outcome = await h.runner.voice(h.store, h.id, "Make a proposal.", binding, new AbortController().signal, text => spoken.push(text));
  assert.equal(outcome.status, "failed");
  assert.deepEqual(spoken, []);
  const view = await h.view();
  assert.equal(view.messages.length, 1);
  assert.equal(view.messages[0]?.role, "user");
  assert.equal(view.activeRun, null);
});

test("barge-in retains the words already streamed as a cancelled reply without proposals", async () => {
  const h = await setup("Hello. Tell me more.");
  const binding = await h.runner.prepareVoice(h.store, h.id, new AbortController().signal);
  const stop = new AbortController(), chunks: string[] = [];
  const outcome = await h.runner.voice(h.store, h.id, "Let's talk.", binding, stop.signal, text => { chunks.push(text); stop.abort(); });
  assert.equal(outcome.status, "cancelled");
  const view = await h.view();
  assert.equal(view.messages.at(-1)?.role, "studio");
  assert.equal(view.messages.at(-1)?.replyDelivery, "live-voice");
  assert.equal(view.messages.at(-1)?.text, chunks.join(""));
  assert.equal(view.candidates.length, 0);
  assert.equal(view.activeRun, null);
});

test("live and typed turns share admission; cancellation releases only after actual model stop", async () => {
  const h = await setup("Still here.", true);
  const binding = await h.runner.prepareVoice(h.store, h.id, new AbortController().signal), control = new AbortController();
  const running = h.runner.voice(h.store, h.id, "First request.", binding, control.signal, () => {});
  await h.dispatched;
  const overlap = await h.runner.voice(h.store, h.id, "Second request.", binding, new AbortController().signal, () => {});
  assert.equal(overlap.status, "unavailable");
  assert.equal(h.calls(), 1);
  control.abort();
  assert.equal((await running).status, "cancelled");
  assert.equal(h.runner.isRunning(h.id), false);
  assert.equal((await h.view()).messages.length, 1);
});

test("ownership loss refuses a late assistant append and releases its scoped resources", async () => {
  const h = await setup("A late response.", true);
  const binding = await h.runner.prepareVoice(h.store, h.id, new AbortController().signal);
  const running = h.runner.voice(h.store, h.id, "Original world.", binding, new AbortController().signal, () => {});
  await h.dispatched; h.loseOwnership(); h.release();
  await assert.rejects(running, /Ownership lost/);
  assert.equal((await h.view()).messages.length, 1);
  assert.equal(h.released.length, 1);
});

test("a final-only suffix is spoken and persisted after a streamed prefix", async () => {
  const h = await setup("Hello. This is the completed reply.", false, 10);
  const binding = await h.runner.prepareVoice(h.store, h.id, new AbortController().signal), chunks: string[] = [];
  const outcome = await h.runner.voice(h.store, h.id, "Continue.", binding, new AbortController().signal, text => chunks.push(text));
  assert.equal(outcome.status, "completed");
  assert.equal(chunks.join(""), "Hello. This is the completed reply.");
  assert.equal((await h.view()).messages.at(-1)?.text, chunks.join(""));
});
