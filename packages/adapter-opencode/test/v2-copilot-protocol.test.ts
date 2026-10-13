import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import type { HarnessEvent } from "@arke-studio/contracts";
import { OpenCodeV2Adapter } from "../src/v2/opencode-v2-adapter.js";
import { buildSessionConfigV2 } from "../src/v2/config.js";
import { until } from "./wait.js";

// Exact-pin qualification: synthetic Copilot credentials and local HTTP only. The fixture
// deliberately holds discovery open so a fallback SDK package cannot qualify a new session.
it("waits for native Copilot routing before dispatching Claude (#1709)", {
  skip: !process.env["ARKE_TEST_OPENCODE2"], timeout: 60_000,
}, async () => {
  const profile = await mkdtemp(join(tmpdir(), "arke-copilot-protocol-"));
  const cwd = join(profile, "session");
  await mkdir(cwd);
  let releaseModels!: () => void;
  const held = new Promise<void>(resolve => { releaseModels = resolve; });
  let modelRequests = 0;
  const inference: Array<{ path: string; model: string }> = [];
  const provider = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += String(chunk);
    if (req.url === "/models") {
      modelRequests++;
      await held;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "claude-opus-5.5", name: "Synthetic Opus", version: "2026-10-01",
        model_picker_enabled: true, supported_endpoints: ["/v1/messages", "/chat/completions"], policy: { state: "enabled" },
        capabilities: { family: "claude-opus-5.5", limits: { max_output_tokens: 1024, max_prompt_tokens: 100000 },
          supports: { streaming: true, tool_calls: true } } }] }));
      return;
    }
    const input = JSON.parse(body || "{}");
    inference.push({ path: req.url ?? "", model: input.model });
    if (req.url !== "/v1/messages") { res.writeHead(404).end("404 fixture route"); return; }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const event = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    event("message_start", { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant",
      model: input.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
    event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Synthetic route ready." } });
    event("content_block_stop", { type: "content_block_stop", index: 0 });
    event("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
    event("message_stop", { type: "message_stop" });
    res.end();
  });
  provider.listen(0, "127.0.0.1"); await once(provider, "listening");
  const address = provider.address(); assert.ok(address && typeof address !== "string");
  const baseURL = `http://127.0.0.1:${address.port}`;
  await mkdir(join(profile, ".config", "opencode"), { recursive: true });
  // Override template inference URLs too: a regressed early fallback must stay local.
  await writeFile(join(profile, ".config", "opencode", "opencode.json"), JSON.stringify({ providers: {
    "github-copilot": { settings: { baseURL: `${baseURL}/v1` }, models: {
      "claude-opus-5.5": { settings: { baseURL: `${baseURL}/v1` } },
    } },
  } }));
  await writeFile(join(cwd, "opencode.json"), JSON.stringify(buildSessionConfigV2({
    preparationId: "fixture", model: "github-copilot/claude-opus-5.5", defaultAgent: "canon-author",
  })));
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (["PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "COMSPEC", "PATHEXT"].includes(key.toUpperCase())) env[key] = value;
  }
  Object.assign(env, { HOME: profile, USERPROFILE: profile,
    XDG_CONFIG_HOME: join(profile, ".config"), XDG_DATA_HOME: join(profile, ".local", "share") });
  let child: ChildProcess | undefined;
  let password: string | null = null;
  let url = "";
  async function stop() {
    if (!child || child.exitCode !== null) return;
    const exit = once(child, "exit"); child.kill(); await exit; child = undefined;
  }
  async function start() {
    password = null; url = "";
    child = spawn(process.env["ARKE_TEST_OPENCODE2"]!, ["serve", "--port", "0", "--hostname", "127.0.0.1"], {
      cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr?.resume();
    let pending = "";
    child.stdout?.on("data", chunk => {
      pending += String(chunk);
      const lines = pending.split(/\r?\n/); pending = lines.pop() ?? "";
      for (const line of lines) {
        const p = /^server password (\S+)$/.exec(line.trim()); if (p) password = p[1]!;
        const u = /(http:\/\/127\.0\.0\.1:\d+)/.exec(line); if (u) url = u[1]!;
      }
    });
    await until(() => !!password && !!url, "native private server startup");
    const health = await fetch(`${url}/api/info`, { headers: {
      authorization: "Basic " + Buffer.from(`opencode:${password}`).toString("base64"),
    }, signal: AbortSignal.timeout(10_000) });
    assert.equal(health.status, 200);
    assert.equal((await health.json() as { version: string }).version, "2.0.26");
  }
  const traces: string[] = [];
  const adapter = new OpenCodeV2Adapter({ baseUrl: () => url, password: () => password,
    onTrace: trace => traces.push(String(trace.what)) });
  try {
    // Let the native runtime create its schema, then seed only this disposable database.
    await start(); await stop();
    const db = new DatabaseSync(join(profile, ".local", "share", "opencode", "opencode.db"));
    try {
      db.prepare("INSERT INTO credential (id,integration_id,label,value,time_created,time_updated) VALUES (?,?,?,?,?,?)").run(
        "fixture-copilot", "github-copilot", "default", JSON.stringify({ type: "oauth", methodID: "device",
          refresh: "synthetic-not-a-real-token", access: "synthetic-not-a-real-token", expires: 0,
          metadata: { apiEndpoint: baseURL } }), Date.now(), Date.now());
    } finally { db.close(); }
    await start(); await adapter.init();
    adapter.prepareSession({ preparationId: "fixture", model: "github-copilot/claude-opus-5.5" });
    const creation = adapter.createSession({ purpose: "extraction", cwd, agent: "canon-author", preparationId: "fixture" });
    await until(() => modelRequests > 0, "held remote model discovery");
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(traces.includes("session.created"), false, "fallback package must not publish the session");
    assert.equal(inference.length, 0, "no inference before discovery settles");
    releaseModels();
    const session = await creation;
    const events: HarnessEvent[] = [];
    const listening = new AbortController();
    const stream = (async () => { for await (const event of adapter.streamEvents(listening.signal)) {
      if ("sessionId" in event && event.sessionId === session.sessionId) events.push(event);
    } })();
    await adapter.dispatchAsync({ sessionId: session.sessionId, parts: [{ type: "text", text: "Synthetic fixture: say hello." }] });
    await until(() => events.some(event => event.type === "message.completed" || event.type === "session.error"), "native Claude final text");
    assert.equal(events.some(event => event.type === "session.error"), false);
    assert.ok(events.some(event => event.type === "message.completed" && event.text === "Synthetic route ready."));
    const claude = inference.filter(call => call.model === "claude-opus-5.5");
    assert.ok(claude.length > 0);
    assert.ok(claude.every(call => call.path === "/v1/messages"));
    assert.equal(traces.filter(what => what === "dispatch.accepted").length, 1);
    listening.abort(); await adapter.dispose(); await stream;
  } finally {
    releaseModels(); await adapter.dispose(); await stop();
    provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()));
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
