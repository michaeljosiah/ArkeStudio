import assert from "node:assert/strict";
import { it } from "node:test";
import type { HarnessEvent, SessionRef } from "@arke-studio/contracts";
import { OpenCodeV2Adapter } from "../src/v2/opencode-v2-adapter.js";
import { StubOpenCodeV2, STUB_V2_PASSWORD } from "./helpers/stub-server-v2.js";
import { until } from "./wait.js";

async function fixture() {
  const stub = new StubOpenCodeV2(), traces: Record<string, unknown>[] = [];
  await stub.start();
  const adapter = new OpenCodeV2Adapter({ baseUrl: () => stub.baseUrl(), password: () => STUB_V2_PASSWORD, onTrace: line => traces.push(line), warmupMs: 3000 });
  await adapter.init();
  if (!adapter.readiness().ready) { await adapter.dispose(); await stub.stop(); assert.fail(adapter.readiness().reason ?? "Native adapter fixture unavailable"); }
  const stop = new AbortController(), shared: HarnessEvent[] = [];
  const sharedDone = (async () => { for await (const event of adapter.streamEvents(stop.signal)) shared.push(event); })();
  const create = async () => {
    const preparationId = crypto.randomUUID();
    adapter.prepareSession({ preparationId, agent: "studio-assistant" });
    return adapter.createSession({ purpose: "ask", agent: "studio-assistant", visibility: "private", preparationId, cwd: "/private/studio-events" });
  };
  const close = async () => { stop.abort(); await adapter.dispose(); await sharedDone; await stub.stop(); };
  return { stub, adapter, traces, shared, create, close };
}
function observe(ref: SessionRef, isDone: (event: HarnessEvent) => boolean) {
  const stop = new AbortController(), events: HarnessEvent[] = [];
  const stream = ref.privateEvents!(stop.signal);
  const timer = setTimeout(() => stop.abort(), 30_000);
  const done = (async () => {
    try { for await (const event of stream) { events.push(event); if (isDone(event)) return; } throw new Error("Private observer ended without its expected terminal event"); }
    finally { clearTimeout(timer); }
  })();
  void done.catch(() => {});
  return { events, done, stop };
}
it("requires a prepared operational role before creating a private native session", async () => {
  const h = await fixture(), mark = h.stub.requests.length;
  try {
    await assert.rejects(h.adapter.createSession({ purpose: "ask", agent: "studio-assistant", visibility: "private" }), /prepared operational/);
    h.adapter.prepareSession({ preparationId: "ordinary", agent: "world-builder" });
    await assert.rejects(h.adapter.createSession({ purpose: "ask", agent: "world-builder", visibility: "private", preparationId: "ordinary" }), /prepared operational/);
    assert.equal(h.stub.requests.slice(mark).some(request => request.method === "POST" && request.path === "/api/session"), false);
  } finally { await h.close(); }
});
it("delivers each private session only through its one-use observer while ordinary events stay on the shared stream", async () => {
  const h = await fixture(); let observation: ReturnType<typeof observe> | undefined;
  try {
    const ordinary = await h.adapter.createSession({ purpose: "authoring", agent: "world-builder" }), privateRef = await h.create();
    assert.equal(ordinary.privateEvents, undefined); assert.equal(h.adapter.privateSessions, true);
    observation = observe(privateRef, event => event.type === "message.completed");
    assert.throws(() => privateRef.privateEvents!(new AbortController().signal), /already used/);
    await until(() => h.stub.streamCount > 0, "the native event channel to connect");
    h.stub.emitTurn(ordinary.sessionId, "Ordinary world response");
    await until(() => h.shared.some(event => event.type === "message.completed" && event.sessionId === ordinary.sessionId), "ordinary completion on shared stream");
    h.stub.emitTurn(privateRef.sessionId, "PRIVATE_STUDIO_RESPONSE");
    await observation.done;
    assert(observation.events.some(event => event.type === "message.completed" && event.text === "PRIVATE_STUDIO_RESPONSE"));
    assert(observation.events.every(event => "sessionId" in event && event.sessionId === privateRef.sessionId));
    assert(h.shared.every(event => !("sessionId" in event) || event.sessionId !== privateRef.sessionId));
    assert(!JSON.stringify(h.traces).includes(privateRef.sessionId)); assert(!JSON.stringify(h.traces).includes("PRIVATE_STUDIO_RESPONSE"));
    assert(JSON.stringify(h.traces).includes(ordinary.sessionId), "ordinary lifecycle trace still works");
  } finally { observation?.stop.abort(); await observation?.done.catch(() => {}); await h.close(); }
});
it("refuses a reused native identity without reclassifying or deleting the existing World session", async () => {
  const h = await fixture();
  try {
    const ordinary = await h.adapter.createSession({ purpose: "authoring", agent: "world-builder" });
    h.stub.nextSessionId = ordinary.sessionId; const mark = h.stub.requests.length;
    await assert.rejects(h.create(), /already owned session identity/);
    assert(!h.stub.requests.slice(mark).some(request => request.method === "DELETE" && request.path === `/api/session/${ordinary.sessionId}`));
    await until(() => h.stub.streamCount > 0, "the native event channel to connect");
    h.stub.emitTurn(ordinary.sessionId, "Existing World session still owns its events");
    await until(() => h.shared.some(event => event.type === "message.completed" && event.sessionId === ordinary.sessionId), "existing World events remain shared");
    assert(JSON.stringify(h.traces).includes(ordinary.sessionId));
  } finally { await h.close(); }
});
it("keeps backend errors that echo private content out of shared events and harness traces", async () => {
  const h = await fixture(); let observation: ReturnType<typeof observe> | undefined;
  try {
    const ref = await h.create(); observation = observe(ref, event => event.type === "session.error");
    h.stub.failNextPrompt = "PRIVATE_ECHOED_PROMPT_AND_RESPONSE";
    await h.adapter.sendMessage({ sessionId: ref.sessionId, parts: [{ type: "text", text: "PRIVATE_REQUEST" }] }); await observation.done;
    assert(observation.events.some(event => event.type === "session.error" && event.message.includes("private model request")));
    assert(!JSON.stringify(observation.events).includes("PRIVATE_ECHOED_PROMPT_AND_RESPONSE"));
    assert.equal(h.stub.failNextPrompt, null, "the native backend echo failure was consumed");
    assert(!JSON.stringify(h.traces).includes("PRIVATE_")); assert(!JSON.stringify(h.shared).includes("PRIVATE_"));
    assert(!h.shared.some(event => "sessionId" in event && event.sessionId === ref.sessionId));
    const ordinary = await h.adapter.createSession({ purpose: "authoring", agent: "world-builder" });
    h.stub.failNextPrompt = "PUBLIC_TRACE_FAILURE";
    await h.adapter.sendMessage({ sessionId: ordinary.sessionId, parts: [{ type: "text", text: "ordinary" }] });
    assert(JSON.stringify(h.traces).includes("PUBLIC_TRACE_FAILURE"), "the scripted failure really contains the backend error body");
  } finally { observation?.stop.abort(); await observation?.done.catch(() => {}); await h.close(); }
});
it("keeps private native settlement unknown after an error/interrupt and forbids reusing the session for another prompt", async () => {
  const h = await fixture(); let observation: ReturnType<typeof observe> | undefined;
  try {
    const ref = await h.create(); let settled = false;
    assert(ref.privateTurnSettled); void ref.privateTurnSettled.then(() => { settled = true; });
    observation = observe(ref, event => event.type === "session.error");
    h.stub.failNextPrompt = "The private request outcome is unknown";
    await h.adapter.sendMessage({ sessionId: ref.sessionId, parts: [{ type: "text", text: "One request" }] }); await observation.done;
    assert.equal(settled, false);
    await h.adapter.interrupt(ref.sessionId); assert.equal(settled, false);
    await assert.rejects(h.adapter.sendMessage({ sessionId: ref.sessionId, parts: [{ type: "text", text: "Another request must use a new session" }] }), /one model turn/);
    assert.equal(h.stub.requests.filter(request => request.path === `/api/session/${ref.sessionId}/prompt`).length, 1);
    h.stub.emitTurn(ref.sessionId, "A late confirmed native completion");
    await until(() => settled, "the original native turn finally confirms completion");
  } finally { observation?.stop.abort(); await observation?.done.catch(() => {}); await h.close(); }
});
it("does not claim backing-model completion when the writing process exits or the adapter is disposed", async () => {
  const h = await fixture();
  try {
    const ref = await h.create(); let settled = false;
    void ref.privateTurnSettled!.then(() => { settled = true; });
    h.adapter.runtimeExited(); await h.adapter.dispose();
    assert.equal(settled, false);
    ref.privateOwnerStopped!(); await ref.privateTurnSettled; assert.equal(settled, true, "only the owning host can confirm the backing inference cleanup");
  } finally { await h.close(); }
});
it("the trusted cleanup capability retires its exact unused session and cannot authorize a later prompt", async () => {
  const h = await fixture();
  try {
    const ref = await h.create(); ref.privateOwnerStopped!(); await ref.privateTurnSettled;
    await assert.rejects(h.adapter.sendMessage({ sessionId: ref.sessionId, parts: [{ type: "text", text: "Retired owner must not dispatch" }] }), /owner has been retired/);
    assert.equal(h.stub.requests.filter(request => request.path === `/api/session/${ref.sessionId}/prompt`).length, 0);
  } finally { await h.close(); }
});
it("rejects unexpected private tool permissions within the native owner without opening the world permission path", async () => {
  const h = await fixture(); let observation: ReturnType<typeof observe> | undefined;
  try {
    let attemptedGrant: ReturnType<OpenCodeV2Adapter["respondToPermission"]> | undefined;
    const ref = await h.create(); observation = observe(ref, event => {
      if (event.type === "permission.requested") attemptedGrant = h.adapter.respondToPermission({ permissionId: event.permissionId, decision: "once" });
      return event.type === "permission.replied";
    });
    await until(() => h.stub.streamCount > 0, "the native event channel to connect");
    h.stub.emitHeldToolCall(ref.sessionId, "private-permission", "PRIVATE_TOOL_ARGUMENTS");
    await observation.done;
    const reply = h.stub.requests.find(request => request.path.endsWith("/private-permission/reply"));
    assert.deepEqual(reply?.body, { decision: "reject" });
    assert.equal((await attemptedGrant)?.status, "failed");
    assert(h.stub.requests.filter(request => request.path.endsWith("/private-permission/reply")).every(request => (request.body as { decision?: string }).decision === "reject"));
    assert(observation.events.some(event => event.type === "permission.replied" && event.decision === "reject"));
    assert(!h.shared.some(event => "sessionId" in event && event.sessionId === ref.sessionId));
    assert(!JSON.stringify(h.traces).includes("PRIVATE_TOOL_ARGUMENTS")); assert(!JSON.stringify(h.traces).includes(ref.sessionId));
  } finally { observation?.stop.abort(); await observation?.done.catch(() => {}); await h.close(); }
});
