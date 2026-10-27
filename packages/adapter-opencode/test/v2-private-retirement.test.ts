import assert from "node:assert/strict";
import { it } from "node:test";
import type { HarnessEvent } from "@arke-studio/contracts";
import { OpenCodeV2Adapter } from "../src/v2/opencode-v2-adapter.js";
import { StubOpenCodeV2, STUB_V2_PASSWORD } from "./helpers/stub-server-v2.js";
import { until } from "./wait.js";

async function fixture(limit?: number) {
  const stub = new StubOpenCodeV2(); await stub.start(); let endpoint = stub.baseUrl();
  const traces: unknown[] = [], shared: HarnessEvent[] = [], stop = new AbortController();
  const adapter = new OpenCodeV2Adapter({ baseUrl: () => endpoint, password: () => STUB_V2_PASSWORD, privateSessionLimit: limit, onTrace: value => traces.push(value) });
  await adapter.init(); assert(adapter.readiness().ready);
  const reading = (async () => { for await (const event of adapter.streamEvents(stop.signal)) shared.push(event); })();
  let serial = 0;
  const create = async () => { const preparationId = String(++serial); adapter.prepareSession({ preparationId, agent: "studio-assistant", model: "ollama/test" });
    return adapter.createSession({ purpose: "ask", agent: "studio-assistant", cwd: "/private/retirement", visibility: "private", preparationId }); };
  return { stub, adapter, traces, shared, create, endpoint: (value: string) => { endpoint = value; },
    close: async () => { stop.abort(); await adapter.dispose(); await reading; await stub.stop(); } };
}

it("retires only the completed ephemeral native session, discards its caches and suppresses late private callbacks/events", async () => {
  const h = await fixture();
  try {
    const ordinary = await h.adapter.createSession({ purpose: "authoring", agent: "world-builder" }), ref = await h.create();
    const sent = h.adapter.sendMessage({ sessionId: ref.sessionId, parts: [{ type: "text", text: "PRIVATE_RETIRED_REQUEST" }] });
    await until(() => h.stub.requests.some(request => request.path.endsWith("/prompt")), "the one private native turn");
    h.stub.emitTurn(ref.sessionId, "PRIVATE_RETIRED_REPLY"); await sent;
    assert.equal(await ref.privateRetire!(new AbortController().signal), true);
    assert.equal(await ref.privateRetire!(new AbortController().signal), true);
    assert(!h.stub.sessionStates.has(ref.sessionId)); assert(h.stub.sessionStates.has(ordinary.sessionId));
    assert(!h.stub.messagesBySession.has(ref.sessionId)); assert.equal(h.adapter.usageTokens(ref.sessionId), 0);
    assert.throws(() => ref.privateEvents!(new AbortController().signal), /retired/);
    await assert.rejects(h.adapter.dispatchAsync({ sessionId: ref.sessionId, parts: [{ type: "text", text: "MUST_NOT_REPLAY" }] }), /retired/);
    h.stub.emitTurn(ref.sessionId, "PRIVATE_LATE_RETIRED_REPLY");
    h.stub.emit({ type: "session.execution.failed", data: { sessionID: ref.sessionId, error: { message: "PRIVATE_LATE_ERROR" } } });
    h.stub.emitTurn(ordinary.sessionId, "Ordinary marker after the late private frames");
    await until(() => h.shared.some(event => event.type === "message.completed" && event.sessionId === ordinary.sessionId), "ordinary marker proves the stream processed the late frames");
    assert(!JSON.stringify(h.shared).includes("PRIVATE_")); assert(!JSON.stringify(h.traces).includes("PRIVATE_")); assert(!JSON.stringify(h.traces).includes(ref.sessionId));
    assert.equal(h.adapter.usageTokens(ref.sessionId), 0);
    assert.equal(h.stub.requests.filter(request => request.method === "DELETE" && request.path === `/api/session/${ref.sessionId}`).length, 1);
  } finally { await h.close(); }
});

it("unknown send/Stop outcomes cannot retire native evidence or settle backing inference", async () => {
  const h = await fixture();
  try {
    const ref = await h.create(); h.stub.failNextPrompt = "PRIVATE_UNCONFIRMED";
    await h.adapter.sendMessage({ sessionId: ref.sessionId, parts: [{ type: "text", text: "unknown work" }] });
    let settled = false; void ref.privateTurnSettled!.then(() => { settled = true; });
    await h.adapter.interrupt(ref.sessionId);
    assert.equal(await ref.privateRetire!(new AbortController().signal), false); assert.equal(settled, false);
    assert(!h.stub.requests.some(request => request.method === "DELETE"));
    ref.privateOwnerStopped!(); // trusted fixture confirms BOTH exact backing inference and writer cleanup
    assert.equal(await ref.privateRetire!(new AbortController().signal), true);
  } finally { await h.close(); }
});

it("preserves completion of explicitly admitted ordinary native sessions without admitting retired private traffic", async () => {
  const h = await fixture();
  try {
    const retired = await h.create(); assert.equal(await retired.privateRetire!(new AbortController().signal), true);
    const sessionId = "previous-world-session"; h.stub.sessionStates.set(sessionId, { id: sessionId, agent: "world-builder" });
    const sent = h.adapter.sendMessage({ sessionId, parts: [{ type: "text", text: "Explicit ordinary native turn" }] });
    await until(() => h.stub.requests.some(request => request.path === `/api/session/${sessionId}/prompt`), "explicit ordinary admission");
    h.stub.emitTurn(retired.sessionId, "PRIVATE_RETIRED_LATE"); h.stub.emitTurn(sessionId, "Ordinary resumed answer"); await sent;
    await until(() => h.shared.some(event => event.type === "message.completed" && event.sessionId === sessionId && event.text === "Ordinary resumed answer"), "the admitted ordinary answer reaches its shared observer");
    assert(!JSON.stringify(h.shared).includes("PRIVATE_")); assert(!JSON.stringify(h.traces).includes(retired.sessionId));
  } finally { await h.close(); }
});

for (const changed of ["role", "model", "variant", "directory"]) it(`does not delete a native session whose ${changed} no longer matches its private owner`, async () => {
  const h = await fixture();
  try {
    const ref = await h.create(), state = h.stub.sessionStates.get(ref.sessionId)!;
    if (changed === "role") state.agent = "world-builder";
    if (changed === "model") state.model!.id = "other";
    if (changed === "variant") state.model!.variant = "other";
    if (changed === "directory") state.location!.directory = "/world";
    assert.equal(await ref.privateRetire!(new AbortController().signal), false);
    assert(!h.stub.requests.some(request => request.method === "DELETE")); assert(h.stub.sessionStates.has(ref.sessionId));
  } finally { await h.close(); }
});

it("requires session AND message absence and safely retries only exact native retirement", async () => {
  const h = await fixture();
  try {
    const ref = await h.create(); h.stub.failSessionDelete = true;
    assert.equal(await ref.privateRetire!(new AbortController().signal), false); assert(h.stub.sessionStates.has(ref.sessionId));
    h.stub.failSessionDelete = false; h.stub.retainDeletedMessages = true;
    assert.equal(await ref.privateRetire!(new AbortController().signal), false); assert(!h.stub.sessionStates.has(ref.sessionId));
    h.stub.retainDeletedMessages = false;
    assert.equal(await ref.privateRetire!(new AbortController().signal), true);
    assert.equal(h.stub.requests.filter(request => request.path.endsWith("/prompt")).length, 0);
  } finally { await h.close(); }
});

it("pins retirement to its original authenticated server and refuses a confirmed generation replacement", async () => {
  const h = await fixture(), replacement = new StubOpenCodeV2(); await replacement.start();
  try {
    const ref = await h.create(); replacement.sessionStates.set(ref.sessionId, { id: ref.sessionId, agent: "world-builder", location: { directory: "/world" } });
    h.endpoint(replacement.baseUrl());
    assert.equal(await ref.privateRetire!(new AbortController().signal), true);
    assert(replacement.sessionStates.has(ref.sessionId)); assert(!replacement.requests.some(request => request.method === "DELETE"));
    h.endpoint(h.stub.baseUrl()); const stale = await h.create(); h.adapter.runtimeExited();
    const mark = h.stub.requests.length;
    assert.equal(await stale.privateRetire!(new AbortController().signal), false); assert.equal(h.stub.requests.length, mark);
  } finally { await h.close(); await replacement.stop(); }
});
for (const disposed of [false, true]) it(`retires only its captured local private state after trusted cleanup with ${disposed ? "disposed" : "exited"} writing owner`, async () => {
  const h = await fixture(), replacement = new StubOpenCodeV2(); await replacement.start();
  try {
    const ref = await h.create(); h.stub.failNextPrompt = "UNKNOWN_ORIGINAL_WORK";
    await h.adapter.sendMessage({ sessionId: ref.sessionId, parts: [{ type: "text", text: "PRIVATE_ORIGINAL_REQUEST" }] });
    let settled = false; void ref.privateTurnSettled!.then(() => { settled = true; });
    if (disposed) await h.adapter.dispose(); else h.adapter.runtimeExited();
    await h.stub.stop(); h.endpoint(replacement.baseUrl());
    replacement.sessionStates.set(ref.sessionId, { id: ref.sessionId, agent: "world-builder", location: { directory: "/world" } });
    assert.equal(await ref.privateRetire!(new AbortController().signal), false); assert.equal(settled, false, "writer exit/disposal cannot confirm backing inference");
    const requests = h.stub.requests.length;
    ref.privateOwnerStopped!(); // The owning fixture now confirms BOTH original native owners are cleaned up.
    await ref.privateTurnSettled; assert(settled);
    assert.equal(await ref.privateRetire!(new AbortController().signal), true); ref.privateOwnerStopped!();
    assert.equal(h.stub.requests.length, requests); assert.equal(replacement.requests.length, 0);
    assert(replacement.sessionStates.has(ref.sessionId)); assert.throws(() => ref.privateEvents!(new AbortController().signal), /retired/);
    assert(!JSON.stringify(h.shared).includes("PRIVATE_")); assert(!JSON.stringify(h.traces).includes("PRIVATE_"));
  } finally { await h.close(); await replacement.stop(); }
});

it("keeps retired identities private and bounds admission/tombstones before further native creation", async () => {
  const h = await fixture(1);
  try {
    const ref = await h.create(); assert.equal(await ref.privateRetire!(new AbortController().signal), true);
    const mark = h.stub.requests.length;
    await assert.rejects(h.create(), /session budget/); assert.equal(h.stub.requests.length, mark);
    h.stub.nextSessionId = ref.sessionId;
    await assert.rejects(h.adapter.createSession({ purpose: "authoring", agent: "world-builder" }), /already owned/);
    assert(!h.stub.requests.slice(mark).some(request => request.method === "DELETE"));
  } finally { await h.close(); }
});
