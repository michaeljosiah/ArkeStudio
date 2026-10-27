import assert from "node:assert/strict";
import { it } from "node:test";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { resolve } from "node:path";
import { OpenCodeV2Adapter } from "../src/v2/opencode-v2-adapter.js";
import type { WireModel } from "../src/model-metadata.js";
import { StubOpenCodeV2, STUB_V2_PASSWORD } from "./helpers/stub-server-v2.js";
import { until } from "./wait.js";

async function fixture() {
  let metadata: unknown = { model_info: { "general.architecture": "gemma" } }, mode = "normal", shows = 0;
  const authentication: Array<string | undefined> = [];
  const held = new Set<ServerResponse>();
  const provider = createServer((req, res) => {
    req.resume(); req.on("end", () => {
      shows++;
      authentication.push(req.headers.authorization);
      if (mode === "hold") { held.add(res); res.on("close", () => held.delete(res)); return; }
      if (mode === "redirect") { res.writeHead(302, { location: "/unexpected" }).end(); return; }
      res.setHeader("content-type", "application/json");
      res.end(mode === "oversized" ? '"' + "x".repeat(1024 ** 2) + '"' : JSON.stringify(metadata));
    });
  });
  provider.listen(0, "127.0.0.1"); await once(provider, "listening");
  const address = provider.address(); assert(address && typeof address !== "string");
  const row: WireModel = { providerID: "ollama", id: "neutral", package: "@opencode/ai/providers/openai-compatible",
    settings: { baseURL: `http://127.0.0.1:${address.port}/v1` } };
  const stub = new StubOpenCodeV2(); await stub.start(); stub.models = [row];
  const traces: unknown[] = [];
  const adapter = new OpenCodeV2Adapter({ baseUrl: () => stub.baseUrl(), password: () => STUB_V2_PASSWORD, onTrace: value => traces.push(value) });
  await adapter.init(); assert(adapter.readiness().ready);
  adapter.prepareSession({ preparationId: "private-route", agent: "studio-assistant", model: "ollama/neutral" });
  const ref = await adapter.createSession({ purpose: "ask", agent: "studio-assistant", cwd: "/private/route", visibility: "private", preparationId: "private-route" });
  return { adapter, stub, row, ref, traces, authentication, read: () => ref.privateDestination!(new AbortController().signal),
    metadata: (value: unknown) => { metadata = value; }, mode: (value: string) => { mode = value; }, shows: () => shows,
    release: () => { for (const response of held) { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(metadata)); } held.clear(); },
    close: async () => { await adapter.dispose(); await stub.stop(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); } };
}

it("binds a text-only native session route, rechecks before its final fence and keeps route settings opaque", async () => {
  const h = await fixture();
  try {
    Object.assign(h.row.settings!, { apiKey: "PRIVATE_ROUTE_CREDENTIAL", provider: "ollama" });
    const proof = await h.read(); assert(proof); assert(Object.isFrozen(proof));
    assert.deepEqual(Object.keys(proof).sort(), ["identity", "local", "model", "provider"]);
    assert.equal(proof.model, "ollama/neutral"); assert.equal(proof.local, true); assert.match(proof.identity, /^[a-f0-9]{64}$/);
    assert.deepEqual(await h.read(), proof); let fenced = false;
    assert(h.authentication.every(value => value === "Bearer PRIVATE_ROUTE_CREDENTIAL"));
    const sent = h.adapter.sendMessageWithFence({ sessionId: h.ref.sessionId, parts: [{ type: "text", text: "PRIVATE_ROUTE_PROMPT" }] }, () => { fenced = true; assert.equal(h.shows(), 3); });
    await until(() => h.stub.requests.some(request => request.path.endsWith("/prompt")), "the reverified native prompt");
    assert(fenced); h.stub.emitTurn(h.ref.sessionId, "PRIVATE_ROUTE_RESPONSE"); await sent;
    assert.equal(await h.read(), null, "a consumed private turn cannot supply fresh route authority");
    assert(!JSON.stringify(h.traces).includes("PRIVATE_ROUTE_"));
    assert(!JSON.stringify(proof).includes("127.0.0.1"));
  } finally { await h.close(); }
});

for (const change of ["missing", "failed", "source", "extra", "duplicate", "scope", "oversized"]) it(`refuses ${change} native retry control before dispatch`, async () => {
  const h = await fixture();
  try {
    assert(await h.read());
    const control = { id: "arke.studio.private-control.v1", source: { type: "local", path: resolve("/private/route", ".arke-private-control/index.js") }, features: { server: true }, state: { status: "active" } };
    h.stub.pluginResponse = () => {
      if (change === "missing") return { plugins: [{ id: "native", source: { type: "builtin" } }] };
      if (change === "failed") return { plugins: [{ ...control, state: { status: "failed" } }] };
      if (change === "source") return { plugins: [{ ...control, source: { type: "local", path: "/different/index.js" } }] };
      if (change === "extra") return { plugins: [control, { id: "unapproved", source: { type: "sdk" }, state: { status: "active" } }] };
      if (change === "duplicate") return { plugins: [control, control] };
      if (change === "scope") return { plugins: [control], directory: null };
      return { plugins: [{ ...control, unbounded: "x".repeat(1024 ** 2) }] };
    };
    let fenced = false;
    await assert.rejects(h.adapter.sendMessageWithFence({ sessionId: h.ref.sessionId, parts: [{ type: "text", text: "MUST_NOT_DISPATCH" }] }, () => { fenced = true; }), /destination|metadata exceeds/);
    assert.equal(fenced, false); assert(!h.stub.requests.some(request => request.path.endsWith("/prompt")));
  } finally { await h.close(); }
});

it("a control lost during metadata I/O cannot borrow its earlier activation", async () => {
  const h = await fixture();
  try {
    assert(await h.read()); h.mode("hold"); let fenced = false;
    const refused = assert.rejects(h.adapter.sendMessageWithFence({ sessionId: h.ref.sessionId, parts: [{ type: "text", text: "MUST_NOT_DISPATCH" }] }, () => { fenced = true; }), /destination/);
    await until(() => h.shows() === 2, "the native metadata observation");
    h.stub.pluginResponse = () => ({ plugins: [{ id: "native", source: { type: "builtin" } }] }); h.release(); await refused;
    assert.equal(fenced, false); assert(!h.stub.requests.some(request => request.path.endsWith("/prompt")));
  } finally { await h.close(); }
});

it("a direct private sender also requires active native retry control without borrowing route approval", async () => {
  const h = await fixture();
  try {
    h.stub.pluginResponse = () => ({ plugins: [] });
    await assert.rejects(h.adapter.sendMessage({ sessionId: h.ref.sessionId, parts: [{ type: "text", text: "MUST_NOT_DISPATCH" }] }), /retry control/);
    assert(!h.stub.requests.some(request => request.path.endsWith("/prompt")));
  } finally { await h.close(); }
});

for (const change of ["route", "session"]) it(`rechecks ${change} changes that arrive during model-metadata I/O`, async () => {
  const h = await fixture();
  try {
    assert(await h.read()); h.mode("hold"); let fenced = false;
    const pending = assert.rejects(h.adapter.sendMessageWithFence({ sessionId: h.ref.sessionId, parts: [{ type: "text", text: "MUST_NOT_DISPATCH" }] }, () => { fenced = true; }), /destination/);
    await until(() => h.shows() === 2, "the final route check's model-metadata request");
    if (change === "route") Object.assign(h.row.settings!, { apiKey: "CHANGED_DURING_METADATA" });
    else h.stub.sessionStates.get(h.ref.sessionId)!.model!.id = "different-model";
    h.release(); await pending;
    assert.equal(fenced, false); assert(!h.stub.requests.some(request => request.path.endsWith("/prompt")));
  } finally { await h.close(); }
});

for (const change of ["cloud-forwarding", "endpoint", "credentials", "unknown-transport", "model", "variant", "agent", "directory", "catalogue-scope", "duplicate", "disabled", "package", "oversized-catalogue"]) {
  it(`refuses ${change} changes before the native dispatch fence without submitting a prompt`, async () => {
    const h = await fixture();
    try {
      assert((await h.read())?.local);
      const state = h.stub.sessionStates.get(h.ref.sessionId)!;
      switch (change) {
        case "cloud-forwarding": h.metadata({ remote_host: "https://cloud.invalid", remote_model: "cloud-model" }); break;
        case "endpoint": h.row.settings = { baseURL: "http://127.0.0.1:1/v1" }; break;
        case "credentials": Object.assign(h.row.settings!, { apiKey: "CHANGED_PRIVATE_TOKEN" }); break;
        case "unknown-transport": Object.assign(h.row.settings!, { headers: { "x-proxy": "https://unknown.invalid" } }); break;
        case "model": state.model!.id = "changed"; break;
        case "variant": state.model!.variant = "changed"; break;
        case "agent": state.agent = "world-builder"; break;
        case "directory": state.location!.directory = "/different"; break;
        case "catalogue-scope": h.stub.modelResponse = () => ({ directory: null }); break;
        case "duplicate": h.stub.models.push({ ...h.row }); break;
        case "disabled": h.row.disabled = true; break;
        case "package": h.row.package = "unqualified-sdk"; break;
        case "oversized-catalogue": Object.assign(h.row.settings!, { unbounded: "x".repeat(1024 ** 2) }); break;
      }
      let fenced = false;
      await assert.rejects(h.adapter.sendMessageWithFence({ sessionId: h.ref.sessionId, parts: [{ type: "text", text: "MUST_NOT_DISPATCH" }] }, () => { fenced = true; }), /destination|metadata exceeds/);
      assert.equal(fenced, false); assert(!h.stub.requests.some(request => request.path.endsWith("/prompt")));
    } finally { await h.close(); }
  });
}

it("classifies native cloud forwarding as nonlocal and binds the actual forwarded destination", async () => {
  const h = await fixture();
  try {
    h.metadata({ remote_host: "https://cloud.invalid", remote_model: "ordinary-name" });
    const proof = await h.read(); assert(proof); assert.equal(proof.local, false);
    h.metadata({ remote_host: "https://other.invalid", remote_model: "ordinary-name" });
    assert.equal(await h.read(), null); assert.equal(await h.read(), null, "a changed route cannot replace its original proof");
  } finally { await h.close(); }
});

for (const mode of ["redirect", "oversized", "unknown"]) it(`unproved ${mode} metadata cannot become dispatch authority`, async () => {
  const h = await fixture();
  try {
    h.mode(mode); if (mode === "unknown") h.metadata({ model_info: {} });
    assert.equal(await h.read(), null);
    h.mode("normal"); h.metadata({ model_info: { "general.architecture": "gemma" } });
    await assert.rejects(h.adapter.dispatchAsync({ sessionId: h.ref.sessionId, parts: [{ type: "text", text: "MUST_NOT_DISPATCH" }] }), /destination/);
    assert.equal(h.shows(), 1, "a failed proof cannot silently authorize itself during dispatch");
    assert(!h.stub.requests.some(request => request.path.endsWith("/prompt")));
  } finally { await h.close(); }
});

it("cancellation or writing-generation loss during metadata verification cannot leave usable route authority", async () => {
  for (const reason of ["cancel", "generation"]) {
    const h = await fixture(), stop = new AbortController();
    try {
      h.mode("hold"); const pending = assert.rejects(h.ref.privateDestination!(stop.signal));
      await until(() => h.shows() === 1, "the bounded metadata read");
      if (reason === "cancel") stop.abort(); else h.adapter.runtimeExited();
      await pending; h.mode("normal");
      let fenced = false;
      await assert.rejects(h.adapter.sendMessageWithFence({ sessionId: h.ref.sessionId, parts: [{ type: "text", text: "MUST_NOT_DISPATCH" }] }, () => { fenced = true; }));
      assert.equal(fenced, false); assert(!h.stub.requests.some(request => request.path.endsWith("/prompt")));
    } finally { await h.close(); }
  }
});
