import assert from "node:assert/strict";
import { it } from "node:test";
import { OpenCodeV2Adapter } from "../src/v2/opencode-v2-adapter.js";
import { sessionImageInput } from "../src/v2/image-input.js";
import type { WireModel } from "../src/model-metadata.js";
import { StubOpenCodeV2, STUB_V2_PASSWORD } from "./helpers/stub-server-v2.js";
import { until } from "./wait.js";

const vision: WireModel = { id: "vision", providerID: "ollama", package: "@opencode/ai/providers/openai-compatible",
  settings: { baseURL: "http://127.0.0.1:11434/v1" }, capabilities: { tools: true, input: ["text", "image"] } };
const png = { type: "image" as const, mimeType: "image/png" as const, data: "cGl4ZWxz" };

it("pins image capability to the session's scoped model and sends inline native attachments", async t => {
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
    assert.equal(sessionImageInput({ ...vision, settings: { baseURL } }, "ollama").local, true);
  }
  for (const baseURL of ["https://remote.example/v1", "http://localhost.example/v1", "file:///local", "invalid", "http://user:password@localhost/v1", undefined]) {
    assert.equal(sessionImageInput({ ...vision, settings: { baseURL } }, "ollama").local, false);
  }
  assert.equal(sessionImageInput({ ...vision, package: "unqualified-provider" }, "ollama").local, false);
  assert.deepEqual(sessionImageInput({ ...vision, providerID: "hosted" }, "hosted"), { supported: true, provider: "hosted", local: false });
  assert.deepEqual(sessionImageInput(null, "unknown"), { supported: false, provider: "unknown", local: false });
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
