import assert from "node:assert/strict";
import { it } from "node:test";
import { resolve } from "node:path";
import type { HarnessEvent } from "@arke-studio/contracts";
import { STUDIO_ASSISTANT_LIMITS } from "@arke-studio/contracts";
import { OpenCodeV2Adapter } from "../src/v2/opencode-v2-adapter.js";
import { StubOpenCodeV2, STUB_V2_PASSWORD } from "./helpers/stub-server-v2.js";
import { until } from "./wait.js";

async function fixture(privateGenerationMs?: number) {
  const stub = new StubOpenCodeV2(); stub.models = [{ id: "neutral", providerID: "ollama", capabilities: { input: ["text"] } }]; await stub.start();
  const traces: unknown[] = [], shared: HarnessEvent[] = [], events: HarnessEvent[] = [], abort = new AbortController();
  const adapter = new OpenCodeV2Adapter({ baseUrl: () => stub.baseUrl(), password: () => STUB_V2_PASSWORD, privateGenerationMs, onTrace: event => traces.push(event) });
  await adapter.init(); assert(adapter.readiness().ready); assert.equal(adapter.privateTransient, true);
  const cwd = resolve("/private/transient"), preparation = { preparationId: "transient", agent: "studio-assistant", model: "ollama/neutral" };
  const request = { model: preparation.model, system: "PRIVATE_SYSTEM", prompt: "PRIVATE_QUESTION", outputTokenLimit: 4096 };
  const code = adapter.sessionFiles(preparation, cwd, request)[1]!.contents, id = /id: "([^"]+)"/.exec(code)![1]!;
  const control = () => ({ plugins: [{ id, source: { type: "local", path: resolve(cwd, ".arke-private-control/index.js") }, features: { server: true }, state: { status: "active" } }] });
  stub.pluginResponse = control;
  adapter.prepareSession(preparation);
  const ref = await adapter.createSession({ cwd, purpose: "ask", agent: preparation.agent, preparationId: preparation.preparationId, visibility: "private", privateRequest: request });
  let confirmed = false, fences = 0;
  void ref.privateTurnSettled!.then(() => { confirmed = true; });
  const sharedTask = (async () => { for await (const event of adapter.streamEvents(abort.signal)) shared.push(event); })();
  const privateTask = (async () => { for await (const event of ref.privateEvents!(abort.signal)) events.push(event); })();
  const generations = () => stub.requests.filter(row => row.method === "POST" && row.path.endsWith("/generate"));
  const send = () => adapter.sendMessageWithFence({ sessionId: ref.sessionId, parts: [{ type: "text", text: request.prompt }] }, () => { fences++; });
  const drained = async () => {
    const ordinary = await adapter.createSession({ purpose: "authoring", agent: "scene-writer" }); stub.emitTurn(ordinary.sessionId, "ordinary observation sentinel");
    await until(() => shared.some(event => event.type === "message.completed" && event.sessionId === ordinary.sessionId), "ordinary completion proves native SSE was consumed");
  };
  return { adapter, stub, ref, events, shared, traces, request, generations, send, confirmed: () => confirmed, fences: () => fences,
    drained,
    submitted: () => until(() => stub.generations.has(ref.sessionId), "one private transient API admission"),
    complete: (data: unknown, status = 200) => stub.finishGeneration(ref.sessionId, data, status),
    close: async () => { abort.abort(); await adapter.dispose(); await Promise.all([sharedTask, privateTask]); await stub.stop(); } };
}

it("requires a finite bounded native completion-observation deadline", () => {
  for (const privateGenerationMs of [0, -1, NaN, Infinity, 900_001]) {
    assert.throws(() => new OpenCodeV2Adapter({ baseUrl: () => "http://127.0.0.1:0", password: () => null, privateGenerationMs }), /generation deadline/);
  }
});

it("uses only the guarded transient API and ignores native SSE/cached completion through reconnect", async () => {
  const h = await fixture();
  try {
    const sent = h.send(); await h.submitted();
    assert.equal(h.fences(), 1); assert.deepEqual(h.generations()[0]!.body, { prompt: h.request.prompt });
    assert(!h.stub.requests.some(row => row.method === "POST" && row.path.endsWith("/prompt")));
    h.stub.emitTurn(h.ref.sessionId, "PRIVATE_FAKE_SSE_AND_CACHE"); h.stub.disconnectEvents();
    await until(() => h.stub.requests.filter(row => row.path === "/api/event").length >= 2, "actual native SSE reconnect");
    assert.equal(h.confirmed(), false); assert(!h.events.some(event => event.type === "message.delta" || event.type === "message.completed"));
    assert(!h.stub.requests.some(row => row.method === "GET" && row.path.endsWith("/message")), "transient completion never consults cached messages");
    h.complete({ text: "PRIVATE_RESPONSE" }); await sent; await h.ref.privateTurnSettled;
    await until(() => h.events.some(event => event.type === "message.completed"), "guarded API result");
    assert.equal(h.confirmed(), true); assert.equal(h.events.filter(event => event.type === "message.completed").length, 1);
    assert(h.events.some(event => event.type === "message.completed" && event.text === "PRIVATE_RESPONSE"));
    assert(!JSON.stringify([...h.shared, ...h.traces]).includes("PRIVATE_"));
    await assert.rejects(h.send(), /one model turn/); assert.equal(h.generations().length, 1);
  } finally { await h.close(); }
});

for (const [name, result] of [["missing", undefined], ["null", null], ["wrong text", { text: 123 }], ["extra fields", { text: "PRIVATE_RESPONSE", extra: "PRIVATE_METADATA" }],
  ["decoded bound", { text: "x".repeat(STUDIO_ASSISTANT_LIMITS.responseBytes + 1) }], ["HTTP bound", { text: "x".repeat(2 * 1024 ** 2) }]] as const) {
  it(`refuses ${name} transient output without borrowing a native cached finish`, async () => {
    const h = await fixture();
    try {
      const sent = h.send(); await h.submitted(); h.complete(result); await sent;
      await until(() => h.events.some(event => event.type === "session.error"), "bounded private refusal");
      h.stub.emitTurn(h.ref.sessionId, "PRIVATE_LATE_CACHE");
      await h.drained();
      assert.equal(h.confirmed(), false); assert.equal(await h.ref.privateRetire!(new AbortController().signal), false);
      assert(!h.events.some(event => event.type === "message.completed")); assert(!JSON.stringify([...h.shared, ...h.traces]).includes("PRIVATE_"));
      h.ref.privateOwnerStopped!(); await h.ref.privateTurnSettled;
    } finally { await h.close(); }
  });
}

for (const fault of ["HTTP failure", "socket loss", "deadline", "control lost"]) it(`retains unknown transient inference after ${fault}, without retry`, async () => {
  const h = await fixture(fault === "deadline" ? 1 : undefined);
  try {
    const sent = h.send();
    if (fault !== "deadline") {
      await h.submitted();
      if (fault === "HTTP failure") h.complete({ text: "PRIVATE_ERROR_BODY" }, 500);
      if (fault === "socket loss") h.stub.generations.get(h.ref.sessionId)!.destroy();
      if (fault === "control lost") { h.stub.pluginResponse = () => ({ plugins: [] }); h.complete({ text: "PRIVATE_RESPONSE" }); }
    }
    await sent; await until(() => h.events.some(event => event.type === "session.error"), "unknown private outcome");
    await h.adapter.interrupt(h.ref.sessionId); assert.equal(h.confirmed(), false);
    h.stub.emit({ type: "session.execution.succeeded", data: { sessionID: h.ref.sessionId } });
    await h.drained();
    assert.equal(await h.ref.privateRetire!(new AbortController().signal), false); assert.equal(h.fences(), 1); assert(h.generations().length <= 1);
    assert(!h.events.some(event => event.type === "message.completed")); assert(!JSON.stringify([...h.shared, ...h.traces]).includes("PRIVATE_"));
    h.ref.privateOwnerStopped!(); await h.ref.privateTurnSettled;
  } finally { await h.close(); }
});

it("a late guarded API result after Stop confirms only its original owner without publishing a reply", async () => {
  const h = await fixture();
  try {
    const sent = h.send(); await h.submitted(); await h.adapter.interrupt(h.ref.sessionId); await sent;
    assert.equal(h.confirmed(), false); assert.equal(await h.ref.privateRetire!(new AbortController().signal), false);
    assert(h.stub.generations.has(h.ref.sessionId), "requester Stop must leave the independent native completion observer alive");
    h.stub.emitTurn(h.ref.sessionId, "PRIVATE_STOPPED_SSE"); h.complete({ text: "PRIVATE_STOPPED_API" }); await h.ref.privateTurnSettled;
    assert.equal(h.confirmed(), true); assert(!h.events.some(event => event.type === "message.completed"));
    assert.equal(await h.ref.privateRetire!(new AbortController().signal), true); assert.equal(h.generations().length, 1);
    assert(!JSON.stringify([...h.shared, ...h.traces]).includes("PRIVATE_"));
  } finally { await h.close(); }
});

it("runtime exit cannot turn transient HTTP cancellation into completion or send Stop to a replacement", async () => {
  const h = await fixture();
  try {
    const sent = h.send(); await h.submitted(); h.adapter.runtimeExited(); await sent;
    await h.adapter.interrupt(h.ref.sessionId);
    assert(!h.stub.requests.some(row => row.method === "POST" && row.path.endsWith("/interrupt")));
    h.stub.emitTurn(h.ref.sessionId, "PRIVATE_OLD_RUNTIME_REPLY"); await h.drained(); assert.equal(h.confirmed(), false);
    assert.equal(await h.ref.privateRetire!(new AbortController().signal), false); assert(!h.events.some(event => event.type === "message.completed"));
    h.ref.privateOwnerStopped!(); await h.ref.privateTurnSettled;
  } finally { await h.close(); }
});

it("Stop before dispatch retires only the unsent private owner and sends no generation", async () => {
  const h = await fixture();
  try {
    await h.adapter.interrupt(h.ref.sessionId); await assert.rejects(h.send(), /retired/);
    assert.equal(h.generations().length, 0); assert.equal(h.fences(), 0);
    assert.equal(await h.ref.privateRetire!(new AbortController().signal), true);
  } finally { await h.close(); }
});
