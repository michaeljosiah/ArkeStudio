import assert from "node:assert/strict";
import { it } from "node:test";
import { STUDIO_ASSISTANT_LIMITS, type HarnessEvent } from "@arke-studio/contracts";
import { OpenCodeV2Adapter } from "../src/v2/opencode-v2-adapter.js";
import { StubOpenCodeV2, STUB_V2_PASSWORD } from "./helpers/stub-server-v2.js";
import { until } from "./wait.js";

async function fixture() {
  const stub = new StubOpenCodeV2(); await stub.start(); const shared: HarnessEvent[] = [], traces: unknown[] = [], stop = new AbortController();
  const adapter = new OpenCodeV2Adapter({ baseUrl: () => stub.baseUrl(), password: () => STUB_V2_PASSWORD, onTrace: value => traces.push(value) });
  await adapter.init(); assert(adapter.readiness().ready);
  const sharedDone = (async () => { for await (const event of adapter.streamEvents(stop.signal)) shared.push(event); })();
  adapter.prepareSession({ preparationId: "payload", agent: "studio-assistant", model: "ollama/test" });
  const ref = await adapter.createSession({ purpose: "ask", agent: "studio-assistant", visibility: "private", cwd: "/private/payload", preparationId: "payload" });
  const privateStop = new AbortController(), observation = ref.privateEvents!(privateStop.signal);
  const events: HarnessEvent[] = [];
  const observe = async () => { for await (const event of observation) { events.push(event); if (event.type === "message.completed" || event.type === "session.error" || event.type === "session.ended") break; } };
  const send = () => adapter.sendMessage({ sessionId: ref.sessionId, parts: [{ type: "text", text: "PRIVATE_BOUNDED_REQUEST" }] });
  const submitted = () => until(() => stub.requests.some(request => request.path.endsWith("/prompt")), "the private native prompt");
  return { stub, adapter, ref, events, shared, traces, observe, send, submitted,
    close: async () => { privateStop.abort(); stop.abort(); await adapter.dispose(); await sharedDone; await stub.stop(); } };
}

for (const frame of ["delta", "ended"]) it(`refuses oversized private ${frame} before accumulation and keeps completion unknown until native success`, async () => {
  const h = await fixture();
  try {
    let confirmed = false; void h.ref.privateTurnSettled!.then(() => { confirmed = true; });
    const observing = h.observe(), sent = h.send(); await h.submitted();
    h.stub.emit({ type: `session.text.${frame}`, data: { sessionID: h.ref.sessionId, assistantMessageID: "private", [frame === "delta" ? "delta" : "text"]: "x".repeat(STUDIO_ASSISTANT_LIMITS.responseBytes + 1) } });
    await observing; await sent; assert.equal(confirmed, false); assert.equal(await h.ref.privateRetire!(new AbortController().signal), false);
    assert(h.events.some(event => event.type === "session.error")); assert(!h.events.some(event => event.type === "message.completed"));
    h.stub.emit({ type: "session.execution.succeeded", data: { sessionID: h.ref.sessionId } }); await h.ref.privateTurnSettled;
    assert.equal(await h.ref.privateRetire!(new AbortController().signal), true); assert(!JSON.stringify(h.shared).includes("PRIVATE_"));
  } finally { await h.close(); }
});

it("accounts for UTF-8 surrogate pairs split across deltas and coalesces private observations", async () => {
  const h = await fixture();
  try {
    const sent = h.send(); await h.submitted();
    const prefix = "x".repeat(STUDIO_ASSISTANT_LIMITS.responseBytes - 4);
    const deltas: string[] = []; for (let offset = 0; offset < prefix.length; offset += 2048) deltas.push(prefix.slice(offset, offset + 2048)); deltas.push("\uD83D", "\uDE42");
    for (const delta of deltas) h.stub.emit({ type: "session.text.delta", data: { sessionID: h.ref.sessionId, assistantMessageID: "private", delta } });
    const text = prefix + "🙂";
    h.stub.emit({ type: "session.text.ended", data: { sessionID: h.ref.sessionId, assistantMessageID: "private", text } });
    h.stub.messagesBySession.set(h.ref.sessionId, [{ id: "private", type: "assistant", time: { completed: 1 }, content: [{ type: "text", text }] }]);
    h.stub.emit({ type: "session.execution.succeeded", data: { sessionID: h.ref.sessionId } });
    await sent; await h.observe();
    assert.equal(h.events.filter(event => event.type === "message.delta").length, 1);
    assert(h.events.some(event => event.type === "message.completed" && event.text === text));
    assert(!h.events.some(event => event.type === "session.error")); assert.equal(Buffer.byteLength(text), STUDIO_ASSISTANT_LIMITS.responseBytes);
  } finally { await h.close(); }
});

it("oversized native error bodies become a bounded private refusal without settling inference", async () => {
  const h = await fixture();
  try {
    h.stub.failNextPrompt = "PRIVATE_LARGE_ERROR" + "x".repeat(3 * 1024 ** 2);
    const observing = h.observe(); await h.send(); await observing;
    assert(h.events.some(event => event.type === "session.error"));
    assert(Buffer.byteLength(JSON.stringify(h.events)) < 1024); assert(!JSON.stringify(h.events).includes("PRIVATE_LARGE_ERROR"));
    assert.equal(await h.ref.privateRetire!(new AbortController().signal), false);
  } finally { await h.close(); }
});

it("never falls back to partial private text after an oversized native retrieval", async () => {
  const h = await fixture();
  try {
    const observing = h.observe(), sent = h.send(); await h.submitted();
    h.stub.emit({ type: "session.text.delta", data: { sessionID: h.ref.sessionId, assistantMessageID: "private", delta: "partial private output" } });
    h.stub.messagesBySession.set(h.ref.sessionId, [{ id: "large", type: "assistant", time: { completed: 1 }, content: [{ type: "text", text: "x".repeat(4 * 1024 ** 2) }] }]);
    h.stub.emit({ type: "session.execution.succeeded", data: { sessionID: h.ref.sessionId } }); await observing; await sent;
    assert(h.events.some(event => event.type === "session.error")); assert(!h.events.some(event => event.type === "message.completed"));
    await h.ref.privateTurnSettled; assert.equal(await h.ref.privateRetire!(new AbortController().signal), true);
  } finally { await h.close(); }
});

it("an empty completion retrieval cannot promote a valid-looking partial private answer", async () => {
  const h = await fixture();
  try {
    const observing = h.observe(), sent = h.send(); await h.submitted();
    h.stub.emit({ type: "session.text.delta", data: { sessionID: h.ref.sessionId, assistantMessageID: "private", delta: '{"kind":"reply","text":"Only a partial observation"}' } });
    h.stub.messagesBySession.set(h.ref.sessionId, []);
    h.stub.emit({ type: "session.execution.succeeded", data: { sessionID: h.ref.sessionId } });
    await observing; await sent; await h.ref.privateTurnSettled;
    assert(!h.events.some(event => event.type === "message.completed")); assert(h.events.some(event => event.type === "session.error"));
  } finally { await h.close(); }
});

it("oversized private identifiers refuse before normalization or native permission replies", async () => {
  const h = await fixture();
  try {
    const observing = h.observe(), sent = h.send(); await h.submitted();
    h.stub.emit({ type: "permission.asked", data: { sessionID: h.ref.sessionId, id: "x".repeat(257), action: "read", resources: ["PRIVATE_RESOURCE"] } });
    await observing; await sent;
    assert(h.events.some(event => event.type === "session.error")); assert(!h.events.some(event => event.type === "permission.requested"));
    assert(!h.stub.requests.some(request => request.path.includes("/permission/") && request.path.endsWith("/reply")));
    assert.equal(await h.ref.privateRetire!(new AbortController().signal), false);
  } finally { await h.close(); }
});

it("bounds repeated private permission backstops even when its observer drains promptly", async () => {
  const h = await fixture();
  try {
    const observing = h.observe(), sent = h.send(); await h.submitted();
    for (let n = 0; n < 100; n++) h.stub.emit({ type: "permission.asked", data: { sessionID: h.ref.sessionId, id: `permission-${n}`, action: "read", resources: ["PRIVATE_RESOURCE"] } });
    h.stub.emitTurn(h.ref.sessionId, "must not accept a reply after the private control bound");
    await observing; await sent;
    assert(h.events.some(event => event.type === "session.error")); assert(!h.events.some(event => event.type === "message.completed"));
    assert(!JSON.stringify(h.events).includes("PRIVATE_RESOURCE"));
    const replies = h.stub.requests.filter(request => request.path.includes("/permission/") && request.path.endsWith("/reply"));
    assert(replies.length <= 64); assert(replies.every(request => (request.body as { decision: string }).decision === "reject"));
  } finally { await h.close(); }
});

it("bounds an unconsumed private event queue without settling inference", async () => {
  const h = await fixture();
  try {
    const sent = h.send(); await h.submitted();
    for (let n = 0; n < 100; n++) h.stub.emit({ type: "permission.replied", data: { sessionID: h.ref.sessionId, requestID: `permission-${n}`, reply: "reject" } });
    const ordinary = await h.adapter.createSession({ purpose: "ask" }); h.stub.emitTurn(ordinary.sessionId, "marker");
    await until(() => h.shared.some(event => event.type === "message.completed" && event.sessionId === ordinary.sessionId), "the marker after the private event burst");
    await h.observe(); await sent; assert(h.events.length <= 64); assert(h.events.some(event => event.type === "session.error"));
    assert(!JSON.stringify(h.shared).includes("PRIVATE_")); assert(!JSON.stringify(h.traces).includes("PRIVATE_"));
    assert.equal(await h.ref.privateRetire!(new AbortController().signal), false);
  } finally { await h.close(); }
});

it("unscoped native session errors cannot expose private content to shared observers", async () => {
  const h = await fixture();
  try {
    h.stub.emit({ type: "session.execution.failed", data: { error: { message: "PRIVATE_UNSCOPED_ERROR" } } });
    const ordinary = await h.adapter.createSession({ purpose: "ask" }); h.stub.emitTurn(ordinary.sessionId, "marker");
    await until(() => h.shared.some(event => event.type === "message.completed" && event.sessionId === ordinary.sessionId), "ordinary marker after unscoped private text");
    assert(!JSON.stringify(h.shared).includes("PRIVATE_")); assert(!JSON.stringify(h.traces).includes("PRIVATE_"));
  } finally { await h.close(); }
});

it("private unknown event types cannot enter the common dead-letter diagnostics buffer", async () => {
  const h = await fixture();
  try {
    const mark = h.adapter.deadLetters.length;
    h.stub.emit({ type: "PRIVATE_UNSUPPORTED_EVENT_NAME", data: { sessionID: h.ref.sessionId } });
    const ordinary = await h.adapter.createSession({ purpose: "ask" }); h.stub.emitTurn(ordinary.sessionId, "marker");
    await until(() => h.shared.some(event => event.type === "message.completed" && event.sessionId === ordinary.sessionId), "ordinary marker after private unsupported metadata");
    assert.equal(h.adapter.deadLetters.length, mark); assert(!JSON.stringify(h.traces).includes("PRIVATE_"));
  } finally { await h.close(); }
});

it("redacts private native interruption details without treating Stop as completion", async () => {
  const h = await fixture();
  try {
    const observing = h.observe(), sent = h.send(); await h.submitted();
    h.stub.emit({ type: "session.execution.interrupted", data: { sessionID: h.ref.sessionId, reason: "PRIVATE_END_ECHO" } });
    await observing; await sent;
    assert(h.events.some(event => event.type === "session.ended")); assert(!JSON.stringify(h.events).includes("PRIVATE_END_ECHO"));
    assert.equal(await h.ref.privateRetire!(new AbortController().signal), false);
  } finally { await h.close(); }
});

it("a cached assistant row after an unknown native error cannot become completion proof on reconnect", async () => {
  const h = await fixture();
  try {
    h.stub.failNextPrompt = "PRIVATE_UNKNOWN_ERROR"; const observing = h.observe(); await h.send(); await observing;
    let confirmed = false; void h.ref.privateTurnSettled!.then(() => { confirmed = true; });
    h.stub.messagesBySession.set(h.ref.sessionId, [{ id: "old-error-row", type: "assistant", time: { completed: 1 }, content: [{ type: "text", text: "cached partial bytes after an error" }] }]);
    const mark = h.stub.requests.filter(request => request.path === "/api/event").length; h.stub.disconnectEvents();
    await until(() => h.stub.requests.filter(request => request.path === "/api/event").length > mark && h.stub.streamCount > 0, "native reconnect after the unknown error");
    const ordinary = await h.adapter.createSession({ purpose: "ask" }); h.stub.emitTurn(ordinary.sessionId, "marker");
    await until(() => h.shared.some(event => event.type === "message.completed" && event.sessionId === ordinary.sessionId), "ordinary marker after reconnect reconciliation");
    assert.equal(confirmed, false); assert.equal(await h.ref.privateRetire!(new AbortController().signal), false);
    h.stub.emit({ type: "session.execution.succeeded", data: { sessionID: h.ref.sessionId } }); await h.ref.privateTurnSettled;
    assert.equal(await h.ref.privateRetire!(new AbortController().signal), true);
  } finally { await h.close(); }
});
