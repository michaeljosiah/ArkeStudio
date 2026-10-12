import assert from "node:assert/strict";
import { it } from "node:test";
import { OpenCodeV2Adapter } from "../src/v2/opencode-v2-adapter.js";
import { sessionImageInput, localOllamaModelEndpoint, qualifySessionImageInput } from "../src/v2/image-input.js";
import type { WireModel } from "../src/model-metadata.js";
import { StubOpenCodeV2, STUB_V2_PASSWORD } from "./helpers/stub-server-v2.js";
import { until } from "./wait.js";

const vision: WireModel = { id: "vision", providerID: "ollama", package: "@opencode/ai/providers/openai-compatible",
  settings: { baseURL: "http://127.0.0.1:11434/v1" }, capabilities: { tools: true, input: ["text", "image"] } };
const png = { type: "image" as const, mimeType: "image/png" as const, data: "cGl4ZWxz" };

it("pins image capability to the session's scoped model and sends inline native attachments", async t => {
  const nativeFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    String(input) === "http://127.0.0.1:11434/api/show" ? Promise.resolve(Response.json({ model_info: { "general.architecture": "gemma" } })) : nativeFetch(input, init));
  const stub = new StubOpenCodeV2(); await stub.start();
  const adapter = new OpenCodeV2Adapter({ baseUrl: () => stub.baseUrl(), password: () => STUB_V2_PASSWORD });
  t.after(async () => { await adapter.dispose(); await stub.stop(); });
  stub.models = [vision];
  await adapter.listModels();
  adapter.prepareSession({ preparationId: "vision", model: "ollama/vision" });
  const { sessionId } = await adapter.createSession({ purpose: "world-chat", cwd: "/world/scratch", preparationId: "vision", agent: "world-builder" });
  assert.equal(adapter.imageInputForSession(sessionId), true);
  assert.deepEqual(adapter.imageDestinationForSession(sessionId), { provider: "ollama", local: true });
  const receipt = await adapter.dispatchAsync({ sessionId, parts: [{ type: "text", text: "Compare" }, png,
    { type: "text", text: "these." }, { ...png, data: "c2Vjb25k" }] });
  assert.equal(receipt.sessionId, sessionId);
  await until(() => stub.requests.some(r => r.path.endsWith("/prompt")), "native image prompt");
  const prompt = stub.requests.find(r => r.path.endsWith("/prompt"))!.body as Record<string, unknown>;
  assert.deepEqual(prompt.files, [
    { uri: "data:image/png;base64,cGl4ZWxz", name: "arke-image-1.png" },
    { uri: "data:image/png;base64,c2Vjb25k", name: "arke-image-2.png" },
  ]);
  assert.equal(prompt.text, "Compare\nthese.");
  assert.ok(stub.requests.some(r => r.path === "/api/model" && r.query["location[directory]"] === "/world/scratch"));
  await adapter.dispose(); assert.equal(adapter.imageInputForSession(sessionId), false);
});

it("unknown, text-only, disabled and unpinned models never dispatch images", async t => {
  const stub = new StubOpenCodeV2(); await stub.start();
  const adapter = new OpenCodeV2Adapter({ baseUrl: () => stub.baseUrl(), password: () => STUB_V2_PASSWORD });
  t.after(async () => { await adapter.dispose(); await stub.stop(); });
  for (const row of [{ ...vision, capabilities: undefined }, { ...vision, capabilities: { input: ["text"] } },
    { ...vision, capabilities: { input: { text: true, image: false } } }, { ...vision, disabled: true }]) {
    stub.models = [row]; adapter.prepareSession({ preparationId: "choice", model: "ollama/vision" });
    await adapter.listModels();
    const { sessionId } = await adapter.createSession({ purpose: "world-chat", agent: "world-builder", preparationId: "choice" });
    assert.equal(adapter.imageInputForSession(sessionId), false);
    await assert.rejects(adapter.dispatchAsync({ sessionId, parts: [png] }), /cannot inspect images/);
  }
  stub.models = [vision]; stub.defaultModel = { ...vision, id: "vision", providerID: "ollama" };
  const unpinned = await adapter.createSession({ purpose: "world-chat" });
  assert.equal(adapter.imageInputForSession(unpinned.sessionId), false, "a default is not a pinned destination");
  await assert.rejects(adapter.dispatchAsync({ sessionId: unpinned.sessionId, parts: [png] }), /cannot inspect images/);
  assert.equal(stub.requests.filter(r => r.path.endsWith("/prompt")).length, 0);
});

it("wrong-location metadata cannot enable inspection, while ordinary text still works", async t => {
  const stub = new StubOpenCodeV2(); await stub.start();
  const adapter = new OpenCodeV2Adapter({ baseUrl: () => stub.baseUrl(), password: () => STUB_V2_PASSWORD });
  t.after(async () => { await adapter.dispose(); await stub.stop(); });
  stub.modelResponse = () => ({ models: [vision], directory: "/another-world" });
  await adapter.listModels();
  adapter.prepareSession({ preparationId: "choice", model: "ollama/vision" });
  const { sessionId } = await adapter.createSession({ purpose: "world-chat", agent: "world-builder", cwd: "/world/scratch", preparationId: "choice" });
  assert.equal(adapter.imageInputForSession(sessionId), false);
  await assert.rejects(adapter.dispatchAsync({ sessionId, parts: [png] }), /cannot inspect images/);
  await adapter.dispatchAsync({ sessionId, parts: [{ type: "text", text: "Read the records." }] });
  await until(() => stub.requests.some(r => r.path.endsWith("/prompt")), "text fallback");
  assert.equal((stub.requests.find(r => r.path.endsWith("/prompt"))!.body as Record<string, unknown>).files, undefined);
});

it("locality requires the native Ollama route and a verified loopback endpoint", () => {
  for (const baseURL of ["http://localhost:11434/v1", "http://127.0.0.1:11434/v1", "https://[::1]:11434/v1"]) {
    assert.ok(localOllamaModelEndpoint({ ...vision, settings: { baseURL } }));
    assert.equal(sessionImageInput({ ...vision, settings: { baseURL } }, "ollama").local, false, "an endpoint alone cannot prove local inference");
  }
  for (const baseURL of ["https://remote.example/v1", "http://localhost.example/v1", "file:///local", "invalid", "http://user:password@localhost/v1", undefined]) {
    assert.equal(sessionImageInput({ ...vision, settings: { baseURL } }, "ollama").local, false);
    assert.equal(localOllamaModelEndpoint({ ...vision, settings: { baseURL } }), null);
  }
  assert.equal(sessionImageInput({ ...vision, package: "unqualified-provider" }, "ollama").local, false);
  assert.deepEqual(sessionImageInput({ ...vision, providerID: "hosted" }, "hosted"), { supported: true, provider: "hosted", local: false });
  assert.deepEqual(sessionImageInput(null, "unknown"), { supported: false, provider: "unknown", local: false });
});

it("Ollama cloud aliases, unavailable metadata and redirects remain cloud destinations", async t => {
  let reply: unknown = { model_info: { "general.architecture": "gemma" } };
  let redirect = false, calls = 0;
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls++; assert.equal(String(input), "http://127.0.0.1:11434/api/show");
    assert.equal(init?.redirect, "error"); assert.deepEqual(JSON.parse(String(init?.body)), { model: "vision", verbose: false });
    if (redirect) throw new TypeError("redirect refused"); return Response.json(reply);
  });
  assert.equal((await qualifySessionImageInput(vision, "ollama", AbortSignal.timeout(1000))).local, true);
  for (const model of [{ model_info: { "general.architecture": "gemma" }, remote_host: "https://ollama.com" },
    { model_info: { "general.architecture": "gemma" }, remote_model: "vision-cloud" }, {}, { model_info: {} }]) {
    reply = model;
    assert.deepEqual(await qualifySessionImageInput(vision, "ollama", AbortSignal.timeout(1000)), { supported: true, provider: "ollama", local: false });
  }
  redirect = true; assert.equal((await qualifySessionImageInput(vision, "ollama", AbortSignal.timeout(1000))).local, false);
  redirect = false; reply = { model_info: { "general.architecture": "gemma" }, template: "x".repeat(1_048_576) };
  assert.equal((await qualifySessionImageInput(vision, "ollama", AbortSignal.timeout(1000))).local, false, "metadata is bounded");
  const prior = calls;
  for (const baseURL of ["https://remote.example/v1", "http://localhost:11434/v1?key=secret", "http://localhost:11434/custom", "http://user:pass@localhost:11434/v1"]) {
    assert.equal((await qualifySessionImageInput({ ...vision, settings: { baseURL } }, "ollama", AbortSignal.timeout(1000))).local, false);
  }
  assert.equal(calls, prior, "no requests to unqualified routes");
});

it("missing scope and ambiguous model rows cannot enable image inspection", async t => {
  const stub = new StubOpenCodeV2(); await stub.start();
  const adapter = new OpenCodeV2Adapter({ baseUrl: () => stub.baseUrl(), password: () => STUB_V2_PASSWORD });
  t.after(async () => { await adapter.dispose(); await stub.stop(); });
  stub.models = [vision]; await adapter.listModels();
  for (const reply of [{ models: [vision], directory: null }, { models: [vision, { ...vision, capabilities: { input: ["text"] } }] }]) {
    stub.modelResponse = directory => directory ? reply : { models: [vision] };
    adapter.prepareSession({ preparationId: "choice", model: "ollama/vision" });
    const { sessionId } = await adapter.createSession({ purpose: "world-chat", agent: "world-builder", cwd: "/world/scratch", preparationId: "choice" });
    assert.equal(adapter.imageInputForSession(sessionId), false);
    await assert.rejects(adapter.dispatchAsync({ sessionId, parts: [png] }), /cannot inspect images/);
  }
  assert.equal(stub.requests.filter(r => r.path.endsWith("/prompt")).length, 0);
});

it("stopping local destination verification retires the session without sending media", async t => {
  const stub = new StubOpenCodeV2(); await stub.start();
  const adapter = new OpenCodeV2Adapter({ baseUrl: () => stub.baseUrl(), password: () => STUB_V2_PASSWORD });
  t.after(async () => { await adapter.dispose(); await stub.stop(); });
  let checking = false;
  const nativeFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input) !== "http://127.0.0.1:11434/api/show") return nativeFetch(input, init);
    checking = true;
    return new Promise<Response>((_, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }));
  });
  stub.models = [vision]; await adapter.listModels();
  adapter.prepareSession({ preparationId: "choice", model: "ollama/vision" });
  const controller = new AbortController();
  const creating = adapter.createSession({ purpose: "world-chat", agent: "world-builder", cwd: "/world/scratch", preparationId: "choice", signal: controller.signal });
  const rejected = assert.rejects(creating, /stopped/);
  await until(() => checking, "local model verification");
  controller.abort(new Error("stopped")); await rejected;
  assert.ok(stub.requests.some(r => r.method === "DELETE" && r.path.startsWith("/api/session/")));
  assert.equal(stub.requests.filter(r => r.path.endsWith("/prompt")).length, 0);
});

it("a changed scoped model cannot borrow the global vision capability", async t => {
  const stub = new StubOpenCodeV2(); await stub.start();
  const adapter = new OpenCodeV2Adapter({ baseUrl: () => stub.baseUrl(), password: () => STUB_V2_PASSWORD });
  t.after(async () => { await adapter.dispose(); await stub.stop(); });
  stub.models = [vision]; await adapter.listModels();
  stub.modelResponse = directory => directory ? { models: [{ ...vision, capabilities: { input: ["text"] } }] } : { models: [vision] };
  adapter.prepareSession({ preparationId: "choice", model: "ollama/vision" });
  const { sessionId } = await adapter.createSession({ purpose: "world-chat", agent: "world-builder", cwd: "/world/scratch", preparationId: "choice" });
  assert.equal(adapter.imageInputForSession(sessionId), false);
  await assert.rejects(adapter.dispatchAsync({ sessionId, parts: [png] }), /cannot inspect images/);
  assert.equal(stub.requests.filter(r => r.path.endsWith("/prompt")).length, 0);
});

it("cancelling scoped image verification retires the unpublished session without inference", async t => {
  const stub = new StubOpenCodeV2(); await stub.start();
  const adapter = new OpenCodeV2Adapter({ baseUrl: () => stub.baseUrl(), password: () => STUB_V2_PASSWORD });
  t.after(async () => { await adapter.dispose(); await stub.stop(); });
  stub.models = [vision]; await adapter.listModels();
  stub.modelResponse = directory => directory ? { hold: true } : { models: [vision] };
  adapter.prepareSession({ preparationId: "choice", model: "ollama/vision" });
  const controller = new AbortController();
  const creating = adapter.createSession({ purpose: "world-chat", agent: "world-builder", cwd: "/world/scratch", preparationId: "choice", signal: controller.signal });
  const rejected = assert.rejects(creating, /stopped/);
  await until(() => stub.requests.some(r => r.path === "/api/model" && r.query["location[directory]"] === "/world/scratch"), "scoped verification");
  controller.abort(new Error("stopped")); await rejected;
  assert.ok(stub.requests.some(r => r.method === "DELETE" && r.path.startsWith("/api/session/")));
  assert.equal(stub.requests.filter(r => r.path.endsWith("/prompt")).length, 0);
});
