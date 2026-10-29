import assert from "node:assert/strict";
import { it } from "node:test";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { StudioProviderBridge } from "../../src/studio-assistant/provider-bridge.js";
import { until } from "../wait.js";

const body = JSON.stringify({ model: "selected", messages: [{ role: "user", content: "PRIVATE_QUESTION" }], stream: true });
async function canBind(baseURL: string): Promise<boolean> {
  const server = createServer();
  try {
    return await new Promise<boolean>((resolve, reject) => {
      server.once("error", (error: NodeJS.ErrnoException) => { if (error.code === "EADDRINUSE") resolve(false); else reject(error); });
      server.listen(Number(new URL(baseURL).port), "127.0.0.1", () => resolve(true));
    });
  } finally { if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())); }
}
async function fixture(implementation?: typeof fetch) {
  const calls: Array<{ body: string; headers: Record<string, unknown> }> = [];
  const upstream = createServer((request, response) => {
    let text = ""; request.on("data", chunk => { text += String(chunk); });
    request.on("end", () => { calls.push({ body: text, headers: request.headers }); response.writeHead(200, { "content-type": "text/event-stream", "x-provider-private": "DO_NOT_FORWARD" }); response.end("data: PRIVATE_REPLY\n\n"); });
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening"); const address = upstream.address(); assert(address && typeof address !== "string");
  const options = { upstream: `http://127.0.0.1:${address.port}/v1`, requestBody: body, model: "selected", upstreamKey: "UPSTREAM_KEY", fetch: implementation, shutdownMs: 10 };
  const bridge = new StudioProviderBridge(options), route = await bridge.start();
  const send = (value = body, headers: Record<string, string> = {}, signal?: AbortSignal) => fetch(route.baseURL + "/chat/completions", { method: "POST", headers: {
    authorization: `Bearer ${route.apiKey}`, "content-type": "application/json", ...headers }, body: value, signal });
  return { bridge, route, send, calls, options, async close() { assert(await bridge.stop()); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); } };
}
it("admits one exact reviewed body with a private capability and strips native metadata in both directions", async () => {
  const h = await fixture();
  try {
    assert.equal((await h.send(body, { authorization: "Bearer wrong" })).status, 401);
    assert.equal((await h.send()).status, 409); assert.equal(h.calls.length, 0);
    h.options.upstreamKey = "MUST_NOT_CHANGE_CAPTURED_KEY";
    assert(h.bridge.approve()); const result = await h.send(body, { traceparent: "PRIVATE_NATIVE_ID", b3: "PRIVATE_NATIVE_ID", cookie: "PRIVATE_COOKIE" });
    assert.equal(result.status, 200); assert.equal(await result.text(), "data: PRIVATE_REPLY\n\n"); assert.equal(result.headers.get("x-provider-private"), null);
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0]?.body, body); assert.equal(h.calls[0]?.headers.authorization, "Bearer UPSTREAM_KEY");
    for (const key of ["traceparent", "b3", "cookie"]) assert.equal(h.calls[0]?.headers[key], undefined);
    assert.equal((await h.send()).status, 409); assert.equal(h.calls.length, 1); assert(!h.bridge.approve());
  } finally { await h.close(); }
});
it("a changed body spends no provider request and cannot retry using the same route", async () => {
  const h = await fixture();
  try { assert(h.bridge.approve()); assert.equal((await h.send(body + " ")).status, 502); assert.equal(h.calls.length, 0); assert.equal((await h.send()).status, 409); }
  finally { await h.close(); }
});
it("sealing retains the exact refusing listener until final native retirement releases it", async () => {
  const h = await fixture();
  try {
    assert(h.bridge.approve()); h.bridge.seal(); h.bridge.seal();
    assert(!h.bridge.approve()); await assert.rejects(h.bridge.start(), /stopped/);
    assert.equal((await h.send()).status, 401); assert.equal(h.calls.length, 0);
    assert.equal(await canBind(h.route.baseURL), false, "a replacement listener cannot receive a late native prompt");
    assert(await h.bridge.stop()); assert.equal(await canBind(h.route.baseURL), true, "only final cleanup releases the port");
  } finally { await h.close(); }
});
it("sealing preserves an already-sent completion while refusing successors and keeping its address", async () => {
  let release!: () => void, calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const h = await fixture(async () => { calls++; await gate; return new Response("data: ORIGINAL_COMPLETION\n\n", { headers: { "content-type": "text/event-stream" } }); });
  try {
    h.bridge.approve(); const pending = h.send(); await until(() => calls === 1, "the original upstream was sent");
    h.bridge.seal(); assert(h.bridge.busy()); assert.equal(await canBind(h.route.baseURL), false);
    assert.equal((await h.send()).status, 401); assert.equal(calls, 1);
    release(); const response = await pending; assert.equal(response.status, 200); assert.equal(await response.text(), "data: ORIGINAL_COMPLETION\n\n");
    await until(() => !h.bridge.busy(), "the existing completion drained without releasing its listener");
    assert.equal(await canBind(h.route.baseURL), false); assert.equal(calls, 1);
  } finally { release(); await h.close(); }
});
it("sealing a partially received native request prevents any subsequent upstream transmission", async () => {
  const h = await fixture(); h.bridge.approve();
  const request = httpRequest(h.route.baseURL + "/chat/completions", { method: "POST", headers: { authorization: `Bearer ${h.route.apiKey}`, "content-length": Buffer.byteLength(body) } });
  const response = new Promise<number>((resolve, reject) => { request.once("error", reject); request.once("response", incoming => { incoming.resume(); incoming.once("end", () => resolve(incoming.statusCode!)); }); });
  try {
    request.flushHeaders(); await until(() => h.bridge.busy(), "the native body is still arriving");
    h.bridge.seal(); request.end(body); assert.equal(await response, 502); assert.equal(h.calls.length, 0);
    assert.equal(await canBind(h.route.baseURL), false);
  } finally { request.destroy(); await h.close(); }
});
for (const fault of ["declared", "actual", "fragments", "status", "type"] as const) it(`bounds upstream ${fault} before publishing any native body`, async () => {
  let cancelled = 0, chunks = 0;
  const implementation: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) { chunks++; controller.enqueue(new Uint8Array(fault === "actual" ? 600_000 : 1)); }, cancel() { cancelled++; },
  }), { status: fault === "status" ? 503 : 200, headers: { "content-type": fault === "type" ? "application/json" : "text/event-stream", ...(fault === "declared" ? { "content-length": String(1024 ** 2 + 1) } : {}) } });
  const h = await fixture(implementation);
  try {
    assert(h.bridge.approve()); const result = await h.send(); assert.equal(result.status, 502); assert.equal(await result.text(), "Private response refused.");
    assert.equal(cancelled, 1); assert(chunks <= 16_386); assert.equal(h.calls.length, 0);
  } finally { await h.close(); }
});
it("retains an abandoned upstream cancellation until actual cleanup and never publishes its late bytes", async () => {
  let release!: () => void, cancelling = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const implementation: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(1024 ** 2 + 1)); }, cancel() { cancelling = true; return gate; },
  }), { headers: { "content-type": "text/event-stream" } });
  const h = await fixture(implementation), control = new AbortController();
  try {
    h.bridge.approve(); const pending = h.send(body, {}, control.signal).catch(() => null);
    await until(() => cancelling, "bounded body cancellation is in flight"); assert(h.bridge.busy()); control.abort();
    assert.equal(await h.bridge.stop(), false); assert(h.bridge.busy()); assert(!h.bridge.approve()); await assert.rejects(h.bridge.start(), /stopped/);
    release(); await pending; await until(() => !h.bridge.busy(), "original body cancellation settled"); assert(await h.bridge.stop());
  } finally { release(); await h.close(); }
});
it("refuses DNS, redirects by policy, and changed/unknown paths without granting another route", async () => {
  for (const upstream of ["http://localhost:1234/v1", "https://127.0.0.1/v1", "http://127.0.0.1/v1?secret=x", "http://user@127.0.0.1/v1", "http://127.0.0.1/other"]) {
    assert.throws(() => new StudioProviderBridge({ upstream, model: "selected", requestBody: body }));
  }
  const h = await fixture(async (_input, init) => { assert.equal(init?.redirect, "error"); return new Response(null, { status: 302, headers: { location: "http://elsewhere.invalid" } }); });
  try {
    const refused = await fetch(h.route.baseURL + "/other", { headers: { authorization: `Bearer ${h.route.apiKey}` } }); assert.equal(refused.status, 404);
    h.bridge.approve(); assert.equal((await h.send()).status, 502);
  } finally { await h.close(); }
});
it("stop during startup cannot leave a late listening bridge", async () => {
  const bridge = new StudioProviderBridge({ upstream: "http://127.0.0.1:1234/v1", model: "selected", requestBody: body });
  const opening = assert.rejects(bridge.start(), /stopped/); assert(await bridge.stop()); await opening; assert(!bridge.busy());
});
