import assert from "node:assert/strict";
import { test } from "node:test";
import { newId, type ConversationId, type RunId, type TurnId, type VoiceBackgroundOperation } from "@arke-studio/contracts";
import { VoiceBackgroundOwner, type VoiceBackgroundContext, type VoiceBackgroundResult } from "../../src/voice/background.js";
import { WorldChatStore, conversationDir } from "../../src/world-chat/store.js";
import { foldConversation } from "../../src/world-chat/fold.js";
import { WorldChatService, ConversationInUseError } from "../../src/world-chat/service.js";
import { WorldStore } from "../../src/world/store.js";
import { readWorldMeta } from "../../src/world/scan.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

const now = () => new Date().toISOString();
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function until(check: () => Promise<boolean>) {
  const end = Date.now() + 5000;
  while (!await check()) { assert(Date.now() < end, "Background state did not settle"); await new Promise(done => setTimeout(done, 5)); }
}
async function fixture() {
  const store = await WorldStore.open(await makeTempWorld()); closeOnCleanup(() => store.close());
  const id = newId("cv") as ConversationId, runId = newId("run") as RunId, turnId = newId("turn") as TurnId;
  const chat = new WorldChatStore(conversationDir(store.dir, id)); await chat.create(id, now());
  await chat.append({ type: "conversation.created", title: "Background", entryContext: { kind: "world" } }, { at: now() });
  await chat.append({ type: "turn.started", run: { id: runId, turnId, basedOnConversationSeq: 1, status: "running", adapter: "test", model: "cloud/chosen", startedAt: now(),
    harnessCleanup: "pending", contextDigest: `sha256:${"1".repeat(64)}` },
    message: { id: newId("msg"), turnId, role: "user", text: "Check canon while we talk.", attachmentIds: [], createdAt: now() } }, { at: now() });
  const context: VoiceBackgroundContext = { worldId: store.worldId, conversationId: id, runId, turnId, model: "cloud/chosen" };
  const view = async () => foldConversation(id, now(), (await chat.read()).events).view;
  return { store, chat, id, context, view, withStore: async <T>(_worldId: string, work: (held: WorldStore) => Promise<T>) => work(store) };
}

test("a flushed background intent returns promptly and records one outcome", async () => {
  const h = await fixture(), entered = deferred<void>(), release = deferred<VoiceBackgroundResult>(); let calls = 0;
  const owner = new VoiceBackgroundOwner({ withStore: h.withStore, execute: async (_store, operation) => {
    calls++; assert.equal((await h.view()).voiceOperations?.find(row => row.id === operation.id)?.status, "running");
    entered.resolve(); return release.promise;
  } });
  try {
    const operation = await owner.start(h.context, "Read the river canon");
    await entered.promise;
    await assert.rejects(readWorldMeta(h.store.dir, { supports: 126 }), /newer|schema|version/i);
    assert.equal((await readWorldMeta(h.store.dir, { supports: 127 })).schemaVersion, 127);
    assert.equal((await owner.start(h.context, "Read the river canon")).id, operation.id);
    assert.equal(calls, 1);
    assert.equal((await owner.list(h.context.worldId, h.id))[0]?.status, "running");
    release.resolve({ text: "The source describes the river.", receipts: [] });
    await until(async () => (await h.view()).voiceOperations?.[0]?.status === "completed");
    assert.equal((await h.view()).messages.filter(message => message.text.startsWith("Background lookup")).length, 1);
    const attempts = await Promise.all([owner.markSpeechAttempted(h.context.worldId, h.id, operation.id), owner.markSpeechAttempted(h.context.worldId, h.id, operation.id)]);
    assert.equal(attempts.filter(Boolean).length, 1);
    assert.equal(foldConversation(h.id, now(), (await h.chat.read()).events).problems.length, 0);
  } finally { release.resolve({ text: "The source describes the river.", receipts: [] }); await owner.stop(); }
});

test("explicit cancellation names one operation and remains requested until the worker actually exits", async () => {
  const h = await fixture(), release = deferred<VoiceBackgroundResult>();
  const observed: AbortSignal[] = [];
  const owner = new VoiceBackgroundOwner({ withStore: h.withStore, execute: async (_store, _operation, _context, signal) => { observed.push(signal); return release.promise; } });
  try {
    const first = await owner.start(h.context, "First read"), second = await owner.start(h.context, "Second read");
    await until(async () => observed.length === 2);
    const requested = await owner.cancel(h.context.worldId, h.id, first.id);
    assert.equal(requested?.status, "cancel-requested"); assert.equal(observed[0]?.aborted, true); assert.equal(observed[1]?.aborted, false);
    await assert.rejects(owner.cancel("another-world", h.id, first.id), /world changed/);
    assert.equal((await owner.list(h.context.worldId, h.id)).find(row => row.id === second.id)?.status, "running");
    release.resolve({ text: "Read finished.", receipts: [] });
    await until(async () => (await h.view()).voiceOperations?.every(row => ["completed", "cancelled"].includes(row.status)) === true);
    const rows = (await h.view()).voiceOperations!;
    assert.equal(rows.find(row => row.id === first.id)?.status, "cancelled");
    assert.equal(rows.find(row => row.id === second.id)?.status, "completed");
  } finally { release.resolve({ text: "Read finished.", receipts: [] }); await owner.stop(); }
});

test("a restarted owner retains uncertain operations as unknown and never replays their model request", async () => {
  const h = await fixture(); let calls = 0;
  const operation: VoiceBackgroundOperation = { id: newId("vop"), worldId: h.context.worldId, conversationId: h.id,
    initiatingRunId: h.context.runId, turnId: h.context.turnId, model: h.context.model, request: "Original read", status: "requested", createdAt: now(), updatedAt: now() };
  await h.chat.append({ type: "voice.operation", operation }, { at: now() });
  const owner = new VoiceBackgroundOwner({ withStore: h.withStore, execute: async () => { calls++; return { text: "Unexpected replay", receipts: [] }; } });
  try {
    assert.equal((await owner.list(h.context.worldId, h.id))[0]?.status, "unknown");
    assert.equal((await owner.start(h.context, "Original read")).id, operation.id);
    assert.equal(calls, 0);
    await Promise.all([owner.list(h.context.worldId, h.id), owner.list(h.context.worldId, h.id)]);
    assert.equal((await h.view()).messages.filter(message => message.text.startsWith("Background lookup")).length, 1);
  } finally { await owner.stop(); }
});


test("worker failure retains one written outcome without a spoken success", async () => {
  const h = await fixture();
  const owner = new VoiceBackgroundOwner({ withStore: h.withStore, execute: async () => { throw new Error("Untrusted native error content"); } });
  try {
    const operation = await owner.start(h.context, "Find a missing source");
    await until(async () => (await h.view()).voiceOperations?.[0]?.status === "failed");
    const view = await h.view(), reply = view.messages.find(message => message.role === "studio")!;
    assert.match(reply.text, /did not finish/); assert(!reply.text.includes("Untrusted native"));
    assert.equal(reply.replyDelivery, "live-voice");
    assert.equal(await owner.markSpeechAttempted(h.context.worldId, h.id, operation.id), null);
  } finally { await owner.stop(); }
});

test("ownership loss refuses a late worker result and recovery records unknown", async () => {
  const h = await fixture(), entered = deferred<void>(), release = deferred<VoiceBackgroundResult>();
  const owner = new VoiceBackgroundOwner({ withStore: h.withStore, execute: async () => { entered.resolve(); return release.promise; } });
  const original = h.store.assertOwnership.bind(h.store);
  try {
    await owner.start(h.context, "Read before ownership changes"); await entered.promise;
    h.store.assertOwnership = async () => { throw new Error("Ownership lost"); };
    release.resolve({ text: "Late answer must not land", receipts: [] });
    await owner.stop();
    assert.equal((await h.view()).messages.filter(message => message.role === "studio").length, 0);
    h.store.assertOwnership = original;
    const recovered = new VoiceBackgroundOwner({ withStore: h.withStore, execute: async () => { throw new Error("Must not replay"); } });
    try { assert.equal((await recovered.list(h.context.worldId, h.id))[0]?.status, "unknown"); }
    finally { await recovered.stop(); }
  } finally { h.store.assertOwnership = original; release.resolve({ text: "Late", receipts: [] }); await owner.stop(); }
});


test("a worker returning during cancellation flush records cancelled rather than unknown", async t => {
  const h = await fixture(), entered = deferred<void>(), release = deferred<VoiceBackgroundResult>();
  const append = WorldChatStore.prototype.append;
  t.mock.method(WorldChatStore.prototype, "append", async function (this: WorldChatStore, ...args: Parameters<WorldChatStore["append"]>) {
    const result = await append.apply(this, args);
    if (args[0].type === "voice.operation" && args[0].operation.status === "cancel-requested") {
      release.resolve({ text: "A result returning during cancellation", receipts: [] });
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    return result;
  });
  const owner = new VoiceBackgroundOwner({ withStore: h.withStore, execute: async () => { entered.resolve(); return release.promise; } });
  try {
    const operation = await owner.start(h.context, "A racing lookup"); await entered.promise;
    await owner.cancel(h.context.worldId, h.id, operation.id); await owner.stop();
    assert.equal((await h.view()).voiceOperations?.[0]?.status, "cancelled");
    assert.equal((await h.view()).messages.filter(message => message.role === "studio").length, 1);
    assert.equal(foldConversation(h.id, now(), (await h.chat.read()).events).problems.length, 0);
  } finally { release.resolve({ text: "Late", receipts: [] }); await owner.stop(); }
});

test("deletion retains a running lookup's journal until its terminal outcome", async () => {
  const h = await fixture(), entered = deferred<void>(), release = deferred<VoiceBackgroundResult>();
  const owner = new VoiceBackgroundOwner({ withStore: h.withStore, execute: async () => { entered.resolve(); return release.promise; } });
  try {
    await owner.start(h.context, "Retain this lookup"); await entered.promise;
    const started = (await h.chat.read()).events.find(row => row.event.type === "turn.started")!.event;
    assert(started.type === "turn.started");
    await h.chat.append({ type: "run.finished", run: { ...started.run, status: "completed", endedAt: now(), harnessCleanup: "confirmed" } }, { at: now() });
    assert.equal((await h.view()).deletionBlock, "background-lookups");
    const service = new WorldChatService(h.store.dir);
    await assert.rejects(service.delete(h.id, "delete-background"), error => error instanceof ConversationInUseError && error.reason === "background-lookups");
    release.resolve({ text: "Grounded retained result", receipts: [] });
    await until(async () => (await h.view()).voiceOperations?.[0]?.status === "completed");
    assert.equal((await h.view()).deletionBlock, null);
  } finally { release.resolve({ text: "Late", receipts: [] }); await owner.stop(); }
});
