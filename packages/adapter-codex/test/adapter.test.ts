import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";
import type { HarnessEvent } from "@arke-studio/contracts";
import { CodexAdapter, codexCredentialEnv, confinedConfig, type CodexAdapterOptions } from "../src/codex-adapter.js";

async function fixture(scenario = "normal", overrides: Partial<CodexAdapterOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), "arke-codex-adapter-")); const log = join(root, "rpc.jsonl");
  const adapter = new CodexAdapter({ command: process.execPath, args: [fileURLToPath(new URL("./fixtures/app-server.mjs", import.meta.url))],
    // Ordinary requests need scheduling headroom beside the suite's native helper processes.
    env: { ...process.env, ARKE_CODEX_TEST_CASE: scenario, ARKE_CODEX_TEST_LOG: log, ARKE_CODEX_TEST_STATE: join(root, "restart-state") }, requestTimeoutMs: 10_000, ...overrides });
  const events: HarnessEvent[] = []; const abort = new AbortController();
  const drain = (async () => { for await (const event of adapter.streamEvents(abort.signal)) events.push(event); })();
  await adapter.init();
  return { root, log, adapter, events, cleanup: async () => { await adapter.dispose(); abort.abort(); await drain; await rm(root, { recursive: true, force: true }); },
    requests: async () => (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line) as Record<string, any>) };
}
async function eventually(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!await predicate()) { assert.ok(Date.now() < deadline, "expected adapter lifecycle transition"); await delay(10); }
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
  assert.equal(f.adapter.usageTokens(session.sessionId), 42); assert.equal(f.adapter.knownInputTokenLimit(), null);
  assert.equal((await f.adapter.listModels()).find(model => model.id === "image-model")?.inputTokenLimit, 100000);
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

test("a canonical model identity wins over another catalog row's colliding alias", async t => {
  const f = await fixture("alias-collision"); t.after(f.cleanup);
  f.adapter.prepareSession({ preparationId: "canonical-chat", model: "openai/text-only" });
  await f.adapter.createSession({ cwd: f.root, agent: "world-builder", purpose: "ask", preparationId: "canonical-chat" });
  assert.equal((await f.requests()).find(request => request.method === "thread/start")?.params.model, "text-only");
  f.adapter.prepareSession({ preparationId: "canonical-stage", model: "openai/text-only" });
  await assert.rejects(f.adapter.createSession({ cwd: f.root, agent: "stage-designer", purpose: "authoring", preparationId: "canonical-stage" }), /cannot inspect/);
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

test("an unsolicited tool callback before turn identity is established cannot edit the proposal", async t => {
  const f = await fixture("wrong-callback"); t.after(f.cleanup);
  const session = await f.adapter.createSession({ cwd: f.root, purpose: "authoring" });
  await f.adapter.sendMessage({ sessionId: session.sessionId, parts: [{ type: "text", text: "normal turn" }] });
  assert.ok((await f.requests()).find(request => request.id === "wrong-request")?.error);
  await assert.rejects(access(join(f.root, "should-not-exist.txt")), /ENOENT/);
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
  // Reach the protocol boundary rather than depending on root-capability startup speed.
  const deadline = Date.now() + 30_000;
  while (!(await f.requests()).some(request => request.method === "thread/start")) {
    assert.ok(Date.now() < deadline, "session did not reach thread/start"); await delay(10);
  }
  abort.abort();
  await assert.rejects(create, /cancelled/); await delay(180);
  assert.ok((await f.requests()).some(request => request.method === "thread/archive"));
});

test("interruption stops the model turn, and concurrent turns cannot displace their waiter", async t => {
  const f = await fixture("hang"); t.after(f.cleanup);
  const session = await f.adapter.createSession({ cwd: f.root, purpose: "ask" });
  const send = f.adapter.sendMessage({ sessionId: session.sessionId, parts: [{ type: "text", text: "wait" }] });
  const rejected = assert.rejects(send, /cancelled/);
  // This fixture answers in request order; a later catalog reply proves start was acknowledged.
  await f.adapter.listModels();
  await assert.rejects(f.adapter.sendMessage({ sessionId: session.sessionId, parts: [{ type: "text", text: "second" }] }), /already running/);
  await f.adapter.interrupt(session.sessionId); await rejected;
  assert.ok((await f.requests()).some(request => request.method === "turn/interrupt"));
});

for (const scenario of ["timeout-once", "announced-timeout-once"]) for (const dispatch of ["sendMessage", "dispatchAsync"] as const) test(`${scenario} ${dispatch}: Stop retires an unanswered turn/start immediately without replay`, async t => {
  let spawns = 0; let originalExited = () => false;
  const f = await fixture(scenario, {
    requestTimeoutMs: 30_000,
    onSpawn: async child => { if (++spawns === 1) originalExited = () => child.exitCode !== null || child.signalCode !== null; },
    killProcess: async child => {
      if (child.exitCode === null && child.signalCode === null) { const closed = once(child, "close"); child.kill("SIGKILL"); await closed; }
    },
  }); t.after(f.cleanup);
  const old = await f.adapter.createSession({ cwd: f.root, purpose: "ask" });
  const pending = assert.rejects(f.adapter[dispatch]({ sessionId: old.sessionId, parts: [{ type: "text", text: "cancel pending start" }] }), /cancelled/);
  await eventually(async () => (await f.requests()).some(request => request.method === "turn/start"));
  if (scenario === "announced-timeout-once") {
    await eventually(() => f.events.some(event => event.type === "message.delta" && event.sessionId === old.sessionId && event.text === "announced before acknowledgment"));
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all([f.adapter.interrupt(old.sessionId), pending]),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Stop waited for the 30-second turn/start deadline")), 5000); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
  assert.equal(originalExited(), true, "the uncertain generating process must stop before interruption resolves");
  assert.equal(f.events.filter(event => event.type === "session.ended" && event.sessionId === old.sessionId && event.reason === "cancelled").length, 1);
  assert.equal(f.events.some(event => event.type === "message.completed" && event.sessionId === old.sessionId), false);
  await eventually(() => spawns === 2 && f.adapter.readiness().ready);
  await assert.rejects(f.adapter.sendMessage({ sessionId: old.sessionId, parts: [{ type: "text", text: "stale session" }] }), /Unknown Codex session/);
  const fresh = await f.adapter.createSession({ cwd: f.root, purpose: "ask" });
  await f.adapter.sendMessage({ sessionId: fresh.sessionId, parts: [{ type: "text", text: "explicit new work" }] });
  assert.deepEqual((await f.requests()).filter(request => request.method === "turn/start").map(request => request.params.input[0].text), ["cancel pending start", "explicit new work"]);
  assert.equal(spawns, 2);
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

test("measured context windows remain scoped to the selected canonical model", async t => {
  const f = await fixture("different-windows"); t.after(f.cleanup);
  const large = await f.adapter.createSession({ cwd: f.root, purpose: "ask" });
  await f.adapter.sendMessage({ sessionId: large.sessionId, parts: [{ type: "text", text: "measure large" }] });
  let models = await f.adapter.listModels();
  assert.equal(models.find(model => model.id === "image-model")?.inputTokenLimit, 100000);
  assert.equal(models.find(model => model.id === "text-only")?.inputTokenLimit, undefined);
  assert.equal(f.adapter.knownInputTokenLimit(), null);
  const measuredRevision = f.adapter.lifecycleRevision();
  await f.adapter.sendMessage({ sessionId: large.sessionId, parts: [{ type: "text", text: "same window" }] });
  assert.equal(f.adapter.lifecycleRevision(), measuredRevision);
  f.adapter.prepareSession({ preparationId: "small", model: "openai/text-only" });
  const small = await f.adapter.createSession({ cwd: f.root, purpose: "ask", preparationId: "small" });
  await Promise.all([large, small].map(session => f.adapter.sendMessage({ sessionId: session.sessionId, parts: [{ type: "text", text: "measure independently" }] })));
  models = await f.adapter.listModels();
  assert.equal(models.find(model => model.id === "image-model")?.inputTokenLimit, 100000);
  assert.equal(models.find(model => model.id === "text-only")?.inputTokenLimit, 8000);
  assert.equal(f.adapter.knownInputTokenLimit(), null); assert.ok(f.adapter.lifecycleRevision() > measuredRevision);
});

test("recovery discards the previous process's measured window for the same canonical model", async t => {
  let spawns = 0; let stopCurrent = () => {};
  const f = await fixture("changed-window-after-recovery", {
    onSpawn: async child => { spawns++; stopCurrent = () => { child.kill(); }; },
    killProcess: async child => {
      if (child.exitCode === null && child.signalCode === null) { const closed = once(child, "close"); child.kill(); await closed; }
    },
  }); t.after(f.cleanup);
  const old = await f.adapter.createSession({ cwd: f.root, purpose: "ask" });
  await f.adapter.sendMessage({ sessionId: old.sessionId, parts: [{ type: "text", text: "measure current profile" }] });
  assert.equal((await f.adapter.listModels()).find(model => model.id === "image-model")?.inputTokenLimit, 100000);
  const revision = f.adapter.lifecycleRevision();
  await writeFile(join(f.root, "restart-state"), "next process uses a smaller profile window");
  stopCurrent();
  await eventually(() => spawns === 2 && f.adapter.readiness().ready);
  assert.ok(f.adapter.lifecycleRevision() > revision);
  const replacementModel = (await f.adapter.listModels()).find(model => model.id === "image-model");
  assert.ok(replacementModel); assert.equal(replacementModel.inputTokenLimit, undefined);
  const fresh = await f.adapter.createSession({ cwd: f.root, purpose: "ask" });
  await f.adapter.sendMessage({ sessionId: fresh.sessionId, parts: [{ type: "text", text: "measure replacement profile" }] });
  assert.equal((await f.adapter.listModels()).find(model => model.id === "image-model")?.inputTokenLimit, 8000);
  assert.equal(f.adapter.knownInputTokenLimit(), null);
});

for (const scenario of ["timeout-once", "reject-once"]) test(`${scenario}: recovery waits for disposal and admits new work without replaying the old turn`, async t => {
  let spawns = 0; let kills = 0; let release!: () => void; let cleanupStarted!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const cleaning = new Promise<void>(resolve => { cleanupStarted = resolve; });
  const f = await fixture(scenario, {
    requestTimeoutMs: 2000,
    onSpawn: async () => { spawns++; },
    killProcess: async child => {
      if (++kills === 1) { cleanupStarted(); await gate; }
      if (child.exitCode === null && child.signalCode === null) { const closed = once(child, "close"); child.kill(); await closed; }
    },
  });
  t.after(async () => { release(); await f.cleanup(); });
  const old = await f.adapter.createSession({ cwd: f.root, purpose: "ask" });
  const revision = f.adapter.lifecycleRevision();
  f.adapter.prepareSession({ preparationId: "old-preparation" });
  const failed = assert.rejects(f.adapter.sendMessage({ sessionId: old.sessionId, parts: [{ type: "text", text: "uncertain original" }] }), /timed out|rejected/);
  await cleaning; assert.equal(spawns, 1); assert.equal(f.adapter.readiness().ready, false);
  const concurrentInit = Promise.all([f.adapter.init(), f.adapter.init()]);
  await delay(20); assert.equal(spawns, 1); release();
  await failed; await concurrentInit;
  assert.equal(spawns, 2); assert.equal(f.adapter.readiness().ready, true); assert.ok(f.adapter.lifecycleRevision() > revision);
  await assert.rejects(f.adapter.createSession({ cwd: f.root, purpose: "ask", preparationId: "old-preparation" }), /missing|consumed/);
  const fresh = await f.adapter.createSession({ cwd: f.root, purpose: "ask" });
  assert.notEqual(fresh.sessionId, old.sessionId);
  await assert.rejects(f.adapter.sendMessage({ sessionId: old.sessionId, parts: [{ type: "text", text: "stale session" }] }), /Unknown Codex session/);
  await f.adapter.sendMessage({ sessionId: fresh.sessionId, parts: [{ type: "text", text: "newly requested turn" }] });
  const requests = await f.requests();
  assert.equal(requests.filter(request => request.method === "initialize").length, 2);
  assert.deepEqual(requests.filter(request => request.method === "turn/start").map(request => request.params.input[0].text), ["uncertain original", "newly requested turn"]);
  assert.equal(f.events.filter(event => event.type === "message.completed" && event.sessionId === old.sessionId).length, 0);
});

test("failed recovery initializes once and never loops or resurrects after disposal", async t => {
  let spawns = 0;
  const f = await fixture("recovery-init-fails", { onSpawn: async () => { spawns++; } }); t.after(f.cleanup);
  const old = await f.adapter.createSession({ cwd: f.root, purpose: "ask" });
  await assert.rejects(f.adapter.sendMessage({ sessionId: old.sessionId, parts: [{ type: "text", text: "fail" }] }), /rejected/);
  await eventually(() => f.adapter.readiness().reason?.includes("could not reconnect") === true);
  await delay(100); assert.equal(spawns, 2); assert.equal(f.adapter.readiness().ready, false);
  await f.adapter.dispose(); await assert.rejects(f.adapter.init(), /disposed/); assert.equal(spawns, 2);
});

test("replacement initialization followed by immediate exit cannot loop background recovery", async t => {
  let spawns = 0;
  const f = await fixture("recovery-exits-after-init", { onSpawn: async () => { spawns++; }, killProcess: async child => {
    if (child.exitCode === null && child.signalCode === null) { const closed = once(child, "close"); child.kill(); await closed; }
  } }); t.after(f.cleanup);
  const old = await f.adapter.createSession({ cwd: f.root, purpose: "ask" });
  await assert.rejects(f.adapter.sendMessage({ sessionId: old.sessionId, parts: [{ type: "text", text: "fail" }] }), /rejected/);
  await eventually(() => spawns >= 2 && !f.adapter.readiness().ready && f.adapter.readiness().reason === "Codex app-server exited.");
  await delay(250);
  assert.equal(spawns, 2);
  const requests = await f.requests();
  assert.equal(requests.filter(request => request.method === "initialize").length, 2);
  assert.equal(requests.filter(request => request.method === "turn/start").length, 1);
  assert.equal(f.adapter.readiness().ready, false);
});

test("final disposal during retirement prevents the pending automatic restart", async t => {
  let spawns = 0; let release!: () => void; let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); const cleaning = new Promise<void>(resolve => { started = resolve; });
  const f = await fixture("reject-once", { onSpawn: async () => { spawns++; }, killProcess: async child => {
    started(); await gate;
    if (child.exitCode === null && child.signalCode === null) { const closed = once(child, "close"); child.kill(); await closed; }
  } });
  t.after(async () => { release(); await f.cleanup(); });
  const session = await f.adapter.createSession({ cwd: f.root, purpose: "ask" });
  const rejected = assert.rejects(f.adapter.sendMessage({ sessionId: session.sessionId, parts: [{ type: "text", text: "fail" }] }));
  await cleaning; const disposed = f.adapter.dispose(); release(); await disposed; await rejected;
  assert.equal(spawns, 1); assert.equal(f.adapter.readiness().ready, false);
  await assert.rejects(f.adapter.init(), /disposed/); assert.equal(spawns, 1);
});

test("environment rotation during retirement performs one restart with the new environment", async t => {
  let spawns = 0; let release!: () => void; let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); const cleaning = new Promise<void>(resolve => { started = resolve; });
  const f = await fixture("reject-once", { onSpawn: async () => { spawns++; }, killProcess: async child => {
    started(); await gate;
    if (child.exitCode === null && child.signalCode === null) { const closed = once(child, "close"); child.kill(); await closed; }
  } });
  t.after(async () => { release(); await f.cleanup(); });
  const old = await f.adapter.createSession({ cwd: f.root, purpose: "ask" });
  const rejected = assert.rejects(f.adapter.sendMessage({ sessionId: old.sessionId, parts: [{ type: "text", text: "fail" }] }));
  await cleaning;
  const update = f.adapter.updateEnvironment({ ...process.env, ARKE_CODEX_TEST_CASE: "normal", ARKE_CODEX_TEST_LOG: f.log });
  await delay(20); assert.equal(spawns, 1); release(); await update; await rejected;
  assert.equal(spawns, 2); assert.equal(f.adapter.readiness().ready, true);
  await assert.rejects(f.adapter.sendMessage({ sessionId: old.sessionId, parts: [{ type: "text", text: "stale" }] }), /Unknown Codex session/);
  const fresh = await f.adapter.createSession({ cwd: f.root, purpose: "ask" });
  await f.adapter.sendMessage({ sessionId: fresh.sessionId, parts: [{ type: "text", text: "fresh" }] });
});

for (const scenario of ["empty-input", "image-input-only"]) test(`${scenario}: default models must accept text before session admission`, async t => {
  const f = await fixture(scenario); t.after(f.cleanup);
  await assert.rejects(f.adapter.createSession({ cwd: f.root, purpose: "ask" }), /text instructions/);
  assert.equal((await f.requests()).some(request => request.method === "thread/start"), false);
});

test("duplicate canonical catalog identities are refused before response order can select metadata", async t => {
  const f = await fixture("duplicate-model"); t.after(f.cleanup);
  await assert.rejects(f.adapter.listModels(), /duplicate canonical/);
});

test("duplicate live wire thread identities retire the connection without archiving the existing session", async t => {
  let spawns = 0; const f = await fixture("duplicate-thread", { onSpawn: async () => { spawns++; } }); t.after(f.cleanup);
  const old = await f.adapter.createSession({ cwd: f.root, purpose: "ask" });
  await assert.rejects(f.adapter.createSession({ cwd: f.root, purpose: "authoring" }), /reused an active thread identity/);
  await eventually(() => spawns === 2 && f.adapter.readiness().ready);
  assert.equal((await f.requests()).some(request => request.method === "thread/archive"), false);
  const fresh = await f.adapter.createSession({ cwd: f.root, purpose: "ask" });
  assert.notEqual(fresh.sessionId, old.sessionId);
  await assert.rejects(f.adapter.sendMessage({ sessionId: old.sessionId, parts: [{ type: "text", text: "old context" }] }), /Unknown Codex session/);
  await f.adapter.sendMessage({ sessionId: fresh.sessionId, parts: [{ type: "text", text: "fresh context" }] });
});
