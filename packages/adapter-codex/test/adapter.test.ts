import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import type { HarnessEvent } from "@arke-studio/contracts";
import { CodexAdapter, codexCredentialEnv, confinedConfig } from "../src/codex-adapter.js";

async function fixture(scenario = "normal") {
  const root = await mkdtemp(join(tmpdir(), "arke-codex-adapter-")); const log = join(root, "rpc.jsonl");
  const adapter = new CodexAdapter({ command: process.execPath, args: [fileURLToPath(new URL("./fixtures/app-server.mjs", import.meta.url))],
    env: { ...process.env, ARKE_CODEX_TEST_CASE: scenario, ARKE_CODEX_TEST_LOG: log }, requestTimeoutMs: 2000 });
  const events: HarnessEvent[] = []; const abort = new AbortController();
  const drain = (async () => { for await (const event of adapter.streamEvents(abort.signal)) events.push(event); })();
  await adapter.init();
  return { root, log, adapter, events, cleanup: async () => { await adapter.dispose(); abort.abort(); await drain; await rm(root, { recursive: true, force: true }); },
    requests: async () => (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line) as Record<string, any>) };
}

test("live paginated model catalog preserves identity, aliases and modalities", async t => {
  const f = await fixture(); t.after(f.cleanup);
  const models = await f.adapter.listModels();
  assert.equal(models.length, 2); assert.deepEqual(models[0]?.aliases, ["catalog-alias"]);
  assert.deepEqual(models[1]?.inputModalities, ["text"]);
});

test("prepared overrides and brief are captured; streaming accumulates across items and settles only at terminal turn", async t => {
  const f = await fixture(); t.after(f.cleanup);
  const prepared = { preparationId: "once", agents: { "stage-designer": { model: "openai/catalog-alias", brief: "ORIGINAL_BRIEF" } }, researchWeb: true };
  f.adapter.prepareSession(prepared); prepared.agents["stage-designer"].brief = "MUTATED_BRIEF";
  const session = await f.adapter.createSession({ cwd: f.root, agent: "stage-designer", purpose: "authoring", preparationId: "once" });
  await assert.rejects(f.adapter.createSession({ cwd: f.root, purpose: "ask", preparationId: "once" }), /already consumed/);
  const start = (await f.requests()).find(request => request.method === "thread/start")!.params;
  assert.equal(start.model, "image-model"); assert.match(start.baseInstructions, /ORIGINAL_BRIEF/); assert.doesNotMatch(start.baseInstructions, /MUTATED_BRIEF/);
  assert.deepEqual(start.environments, []); assert.deepEqual(start.selectedCapabilityRoots, []);
  assert.equal(start.config["agents.enabled"], false); assert.equal(start.config["features.multi_agent_v2"], false);
  assert.equal(start.config["web_search"], "disabled"); assert.deepEqual(start.config["features.code_mode.direct_only_tool_namespaces"], ["arke"]);
  let done = false;
  const send = f.adapter.sendMessage({ sessionId: session.sessionId, correlationId: "correlation-1", parts: [{ type: "text", text: "hello" }] }).then(receipt => { done = true; return receipt; });
  await delay(30); assert.equal(done, false); await send; await new Promise<void>(resolve => setImmediate(resolve));
  const final = f.events.find(event => event.type === "message.completed");
  assert.ok(final && final.type === "message.completed"); assert.deepEqual(JSON.parse(final.text), { reply: "Second item" }); assert.equal(final.correlationId, "correlation-1");
  assert.ok(f.events.some(event => event.type === "message.delta" && event.text === "Hello world\n\nSecond item"));
  assert.equal(f.adapter.usageTokens(session.sessionId), 42); assert.equal(f.adapter.knownInputTokenLimit(), 100000);
});

test("Stage rejects known text-only models and an explicit unavailable override cannot fall back", async t => {
  const f = await fixture(); t.after(f.cleanup);
  f.adapter.prepareSession({ preparationId: "stage", model: "openai/text-only" });
  await assert.rejects(f.adapter.createSession({ cwd: f.root, agent: "stage-designer", purpose: "authoring", preparationId: "stage" }), /cannot inspect/);
  f.adapter.prepareSession({ preparationId: "missing", model: "openai/missing" });
  await assert.rejects(f.adapter.createSession({ cwd: f.root, purpose: "ask", preparationId: "missing" }), /unavailable/);
  f.adapter.prepareSession({ preparationId: "chat", model: "openai/text-only" });
  await f.adapter.createSession({ cwd: f.root, agent: "world-builder", purpose: "ask", preparationId: "chat" });
});

test("real tool reply contains image bytes, with a read receipt only after successful delivery", async t => {
  const f = await fixture("image"); t.after(f.cleanup);
  await writeFile(join(f.root, "frame.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAZklEQVR42u3QQREAAAQAMEm89T/9yOHssQKLzprPQoAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECLhvAVR6kdJApJA8AAAAAElFTkSuQmCC", "base64"));
  const session = await f.adapter.createSession({ cwd: f.root, purpose: "authoring" });
  await f.adapter.sendMessage({ sessionId: session.sessionId, parts: [{ type: "text", text: "inspect" }] });
  const response = (await f.requests()).find(request => request.id === "tool-request")!;
  assert.equal(response.result.success, true); assert.equal(response.result.contentItems[1].type, "inputImage");
  assert.ok(f.events.some(event => event.type === "tool.activity" && event.summary === "read frame.png"));
});

test("native or unknown server tools are rejected without a tool activity receipt", async t => {
  const f = await fixture("forbidden"); t.after(f.cleanup);
  const session = await f.adapter.createSession({ cwd: f.root, purpose: "authoring" });
  await f.adapter.sendMessage({ sessionId: session.sessionId, parts: [{ type: "text", text: "try shell" }] });
  assert.ok((await f.requests()).find(request => request.id === "tool-request")!.error);
  assert.equal(f.events.some(event => event.type === "tool.activity"), false);
  assert.equal(f.events.some(event => event.type === "tool.refused"), true);
});

test("native asynchronous question notification fails the turn without showing a question or successful answer", async t => {
  const f = await fixture("async-question"); t.after(f.cleanup);
  const session = await f.adapter.createSession({ cwd: f.root, purpose: "ask" });
  await assert.rejects(f.adapter.sendMessage({ sessionId: session.sessionId, parts: [{ type: "text", text: "question" }] }), /question tool is not available/);
  await delay(20);
  assert.ok(f.events.some(event => event.type === "tool.refused")); assert.ok(f.events.some(event => event.type === "session.error"));
  assert.equal(f.events.some(event => event.type === "message.completed" || event.type === "message.delta" || event.type === "tool.activity"), false);
  assert.ok((await f.requests()).some(request => request.method === "turn/interrupt"));
});

for (const scenario of ["exit", "malformed"]) test(`process ${scenario} settles pending turn and readiness`, async t => {
  const f = await fixture(scenario); t.after(f.cleanup);
  const session = await f.adapter.createSession({ cwd: f.root, purpose: "ask" });
  await assert.rejects(f.adapter.sendMessage({ sessionId: session.sessionId, parts: [{ type: "text", text: "hello" }] }));
  assert.equal(f.adapter.readiness().ready, false);
});

test("cancellation during creation consumes preparation and archives late ephemeral thread", async t => {
  const f = await fixture("slow-create"); t.after(f.cleanup);
  const abort = new AbortController(); f.adapter.prepareSession({ preparationId: "cancel" });
  const create = f.adapter.createSession({ cwd: f.root, purpose: "ask", preparationId: "cancel", signal: abort.signal });
  setTimeout(() => abort.abort(), 40);
  await assert.rejects(create, /cancelled/); await delay(180);
  assert.ok((await f.requests()).some(request => request.method === "thread/archive"));
});

test("interruption stops the model turn, and concurrent turns cannot displace their waiter", async t => {
  const f = await fixture("hang"); t.after(f.cleanup);
  const session = await f.adapter.createSession({ cwd: f.root, purpose: "ask" });
  const send = f.adapter.sendMessage({ sessionId: session.sessionId, parts: [{ type: "text", text: "wait" }] });
  const rejected = assert.rejects(send, /cancelled/); await delay(30);
  await assert.rejects(f.adapter.sendMessage({ sessionId: session.sessionId, parts: [{ type: "text", text: "second" }] }), /already running/);
  await f.adapter.interrupt(session.sessionId); await rejected;
  assert.ok((await f.requests()).some(request => request.method === "turn/interrupt"));
});

for (const scenario of ["substitute", "instructions"]) test(`unexpected ${scenario} is refused and thread archived`, async t => {
  const f = await fixture(scenario); t.after(f.cleanup);
  await assert.rejects(f.adapter.createSession({ cwd: f.root, purpose: "ask" }), /changed the selected/);
  await delay(10); assert.ok((await f.requests()).some(request => request.method === "thread/archive"));
});

test("credential rotation strips old managed values; configuration disables inherited tools", () => {
  assert.deepEqual(codexCredentialEnv({ openai: "new" }, { OPENAI_API_KEY: "old", ANTHROPIC_API_KEY: "stale", CODEX_HOME: "own-login", UNRELATED: "kept" }), { OPENAI_API_KEY: "new", CODEX_HOME: "own-login", UNRELATED: "kept" });
  const config = confinedConfig({ mcp_servers: { "unsafe.name": {} } }, true);
  assert.deepEqual(config.mcp_servers, { "unsafe.name": { enabled: false } }); assert.equal(config.web_search, "live");
});
