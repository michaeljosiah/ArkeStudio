import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { createServer as httpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type { HarnessAdapter, HarnessEvent } from "@arke-studio/contracts";
import { OpenCodeV2Adapter } from "../src/v2/opencode-v2-adapter.js";
import { buildProfileConfigV2, buildSessionConfigV2 } from "../src/v2/config.js";
import { until } from "./wait.js";

/**
 * Pin qualification against the shipped binary. The isolated profile has no real credentials;
 * a scripted localhost provider verifies the tool loop without sending paid requests.
 * These observations do not qualify the engine for native steering; see docs/development/.
 */
it("qualifies the pinned runtime's inbox, config, confined tool turn and permission reply", {
  skip: !process.env["ARKE_TEST_OPENCODE2"], timeout: 60_000,
}, async () => {
  const profile = await mkdtemp(join(tmpdir(), "arke-input-protocol-"));
  const cwd = join(profile, "session");
  await mkdir(cwd);
  const requests: Array<{ messages: Array<{ role: string; content?: string }>; tools: Array<{ function: { name: string } }> }> = [];
  const provider = httpServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += String(chunk); });
    req.on("end", () => {
      if (req.url === "/api/tags") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ models: ["arke-smoke", "arke-discovered"].map(name => ({ name, model: name, modified_at: "2026-10-10T00:00:00Z", size: 1, digest: name,
          details: { format: "gguf", family: "gemma", parameter_size: "12B", quantization_level: "Q4_K_M" } })) })); return;
      }
      if (req.url === "/api/show") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ capabilities: ["completion", "tools"], model_info: { "general.architecture": "gemma", "gemma.context_length": 262144 } })); return;
      }
      if (req.url !== "/v1/chat/completions") { res.writeHead(404).end(); return; }
      const request = JSON.parse(body);
      // The engine also makes a title request. Qualify only the writing agent's tool loop.
      const writing = request.tools?.some((tool: { function: { name: string } }) => tool.function.name === "read");
      if (writing) requests.push(request);
      const at = writing ? requests.length : 0;
      const call = (id: string, name: string, args: Record<string, unknown>) => ({ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } });
      const delta = at === 1 ? { tool_calls: [call("call_read", "read", { path: "source.md", offset: 1, limit: 100 })] }
        : at === 2 ? { tool_calls: [call("call_outside", "read", { path: "../outside.md", offset: 1, limit: 100 })] }
        : { content: writing ? "The harbour is Saltlight." : "Smoke test" };
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: unknown, finish: string | null) => ({ id: `chatcmpl_${at}`, object: "chat.completion.chunk",
        created: 1, model: "arke-smoke", choices: [{ index: 0, delta, finish_reason: finish }] });
      res.write(`data: ${JSON.stringify(chunk(delta, null))}\n\n`);
      res.write(`data: ${JSON.stringify({ ...chunk({}, writing && at < 3 ? "tool_calls" : "stop"), usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  provider.listen(0, "127.0.0.1"); await once(provider, "listening");
  const providerAddress = provider.address(); assert.ok(providerAddress && typeof providerAddress !== "string");
  await mkdir(join(profile, ".config", "opencode"), { recursive: true });
  await writeFile(join(profile, ".config", "opencode", "opencode.json"), JSON.stringify(buildProfileConfigV2(
    [{ id: "arke-smoke", contextLength: 262144, tools: true, vision: false }], `http://127.0.0.1:${providerAddress.port}/v1`,
  )));
  const preparation = { preparationId: "smoke-preparation", model: "ollama/arke-smoke" };
  const config = buildSessionConfigV2({ ...preparation, defaultAgent: "sheet-editor" });
  (config.permissions as unknown[]).push({ action: "smoke-approval", resource: "*", effect: "ask" });
  await writeFile(join(cwd, "opencode.json"), JSON.stringify(config));
  await writeFile(join(cwd, "source.md"), "The harbour is Saltlight.");
  await writeFile(join(profile, "outside.md"), "OUTSIDE_MUST_NOT_REACH_THE_MODEL");
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const address = socket.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "COMSPEC", "PATHEXT"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  Object.assign(env, { HOME: profile, USERPROFILE: profile,
    XDG_CONFIG_HOME: join(profile, ".config"), XDG_DATA_HOME: join(profile, ".local", "share") });
  const child = spawn(process.env["ARKE_TEST_OPENCODE2"]!, ["serve", "--port", String(port), "--hostname", "127.0.0.1"], {
    cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let password: string | null = null;
  let pending = "";
  let spawnError = false;
  child.on("error", () => { spawnError = true; });
  child.stderr.resume();
  child.stdout.on("data", chunk => {
    pending += String(chunk);
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const match = /^server password (\S+)$/.exec(line.trim());
      if (match) password = match[1]!;
    }
  });
  const baseUrl = () => `http://127.0.0.1:${port}`;
  async function request(method: string, path: string, body?: unknown) {
    const response = await fetch(baseUrl() + path, { method,
      headers: { authorization: "Basic " + Buffer.from(`opencode:${password}`).toString("base64"), "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  }
  try {
    const deadline = Date.now() + 35_000;
    while (!password) {
      assert.ok(!spawnError && child.exitCode === null && Date.now() < deadline, "native launch did not complete");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const health = await request("GET", "/api/info");
    assert.equal(health.status, 200);
    const pin = JSON.parse(await readFile(new URL("../../../apps/desktop/runtime-sources.json", import.meta.url), "utf8"));
    assert.equal(health.body.version, pin.opencode2.version, "measure the binary shipped by this checkout");
    const adapter: HarnessAdapter = new OpenCodeV2Adapter({ baseUrl, password: () => password });
    assert.equal(adapter.nativeInput, undefined, "inbox support alone must not advertise native steering");
    await adapter.init?.();
    assert.equal(adapter.readiness().ready, true);
    let catalog = await adapter.listModels?.();
    const catalogDeadline = Date.now() + 10_000;
    while (!catalog?.some(model => model.provider === "ollama" && model.id === "arke-smoke" && model.tools === true) && Date.now() < catalogDeadline) {
      await new Promise(resolve => setTimeout(resolve, 100)); catalog = await adapter.listModels?.();
    }
    assert.ok(catalog?.some(model => model.provider === "ollama" && model.id === "arke-smoke" && model.tools === true), JSON.stringify(catalog));
    assert.ok(catalog?.some(model => model.provider === "ollama" && model.id === "arke-discovered" && model.tools === true),
      "native Ollama discovery includes installed completion models absent from the configured models map");
    const created = await request("POST", "/api/session", { location: { directory: cwd.replaceAll("\\", "/") } });
    assert.equal(created.status, 200);
    const sessionId = created.body.data.id as string;
    const input = { id: `msg_${Date.now().toString(16)}${"a".repeat(20)}`,
      text: "Synthetic admission-only input. No model call.", delivery: "steer", resume: false,
      expectedExecutionID: "nonexistent-execution" };
    const first = await request("POST", `/api/session/${sessionId}/prompt`, input);
    assert.equal(first.status, 200, "the native endpoint ignores an expected-execution field");
    assert.equal(first.body.data.id, input.id);
    const duplicate = await request("POST", `/api/session/${sessionId}/prompt`, input);
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.data.id, input.id);
    const changed = await request("POST", `/api/session/${sessionId}/prompt`, { ...input, text: "Changed direction" });
    assert.equal(changed.status, 200, "stable v2 returns the existing input even when the payload differs");
    assert.equal(changed.body.data.id, input.id);
    const inbox = await request("GET", `/api/session/${sessionId}/inbox`);
    assert.equal(inbox.body.data.length, 1);
    assert.equal(inbox.body.data[0].payload.text, input.text, "the original pending input is retained");
    assert.equal((await request("DELETE", `/api/session/${sessionId}/inbox/${input.id}`)).status, 204);
    assert.equal((await request("GET", `/api/session/${sessionId}/inbox`)).body.data.length, 0);
    const interrupted = await request("POST", `/api/session/${sessionId}/interrupt`, {});
    assert.equal(interrupted.status, 200);
    assert.deepEqual(interrupted.body, { interrupted: false }, "idle success still does not identify an execution");
    const listening = new AbortController();
    const events: HarnessEvent[] = [];
    const pump = (async () => { for await (const event of adapter.streamEvents(listening.signal)) events.push(event); })();
    try {
      adapter.prepareSession?.(preparation);
      const writing = await adapter.createSession({ purpose: "authoring", agent: "sheet-editor", cwd, preparationId: preparation.preparationId });
      assert.equal(adapter.knownInputTokenLimit?.(writing.sessionId), 262144);
      let turnTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([adapter.sendMessage({ sessionId: writing.sessionId, parts: [{ type: "text", text: "Read source.md." }] }),
          new Promise((_, reject) => { turnTimer = setTimeout(() => reject(new Error("scripted writing turn timed out")), 20_000); turnTimer.unref(); })]);
      } finally { clearTimeout(turnTimer); }
      assert.equal(requests.length, 3, "a tool round, a denied outside read, then a final answer");
      assert.ok(JSON.stringify(requests[1]?.messages.filter(message => message.role === "tool")).includes("The harbour is Saltlight."));
      assert.ok(JSON.stringify(requests[2]?.messages.filter(message => message.role === "tool")).includes("Permission denied: external_directory"));
      assert.ok(!JSON.stringify(requests).includes("OUTSIDE_MUST_NOT_REACH_THE_MODEL"));
      await until(() => events.some(event => event.type === "message.completed" && event.text === "The harbour is Saltlight."), "final writing text");
      assert.ok(events.some(event => event.type === "tool.activity" && event.tool === "read"));
      assert.ok((adapter.usageTokens?.(writing.sessionId) ?? 0) > 0);
      const permissions = await request("GET", `/api/session/${writing.sessionId}/permission`);
      assert.deepEqual(permissions.body.data, [], "outside access is denied without opening an approval");
      const ask = request("POST", `/api/session/${writing.sessionId}/permission`, { action: "smoke-approval", resources: ["synthetic"], agent: "sheet-editor" });
      const deadline = Date.now() + 10_000;
      let permission: Extract<HarnessEvent, { type: "permission.requested" }> | undefined;
      while (!(permission = events.find((event): event is Extract<HarnessEvent, { type: "permission.requested" }> => event.type === "permission.requested")) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.ok(permission, "the real event stream carried the pending ask");
      assert.deepEqual(await adapter.respondToPermission?.({ permissionId: permission.permissionId, decision: "once" }),
        { permissionId: permission.permissionId, status: "confirmed" });
      assert.equal((await ask).status, 200);
    } finally {
      listening.abort(); await adapter.dispose?.(); await pump;
    }
  } finally {
    if (child.exitCode === null && !spawnError) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
