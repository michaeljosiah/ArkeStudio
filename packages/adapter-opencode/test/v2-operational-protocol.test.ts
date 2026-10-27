import assert from "node:assert/strict";
import { it } from "node:test";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { createServer } from "node:http";
import { createServer as createSocket } from "node:net";
import type { HarnessEvent } from "@arke-studio/contracts";
import { OpenCodeV2Adapter } from "../src/v2/opencode-v2-adapter.js";
import { buildSessionConfigV2 } from "../src/v2/config.js";
import { until } from "./wait.js";

/** Actual pinned binary, credential-free profile and a scripted local provider. Every model
 * request is counted, including hidden title/compaction/warming helpers. No real inference. */
it("qualifies native operational deny policy, zero tool schemas and exactly one local request per private turn", {
  skip: !process.env.ARKE_TEST_OPENCODE2, timeout: 75_000,
}, async () => {
  const profile = await mkdtemp(join(tmpdir(), "arke-operational-native-")), model = "arke-operational";
  const requests: Array<{ model: string; tools?: unknown[]; messages?: unknown[] }> = [];
  const metadataAuthentication: Array<string | undefined> = [], completionAuthentication: Array<string | undefined> = [];
  const provider = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += String(chunk); if (body.length > 2 * 1024 ** 2) req.destroy(); });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/tags") { res.end(JSON.stringify({ models: [{ name: model, model, modified_at: "2026-10-27T00:00:00Z", size: 1, digest: model,
        details: { format: "gguf", family: "gemma", parameter_size: "12B", quantization_level: "Q4_K_M" } }] })); return; }
      if (req.url === "/api/show") { metadataAuthentication.push(req.headers.authorization); res.end(JSON.stringify({ capabilities: ["completion", "tools"], model_info: { "general.architecture": "gemma", "gemma.context_length": 262144 } })); return; }
      if (req.url !== "/v1/chat/completions") { res.writeHead(404).end(); return; }
      const input = JSON.parse(body); requests.push(input);
      completionAuthentication.push(req.headers.authorization);
      const content = '{"kind":"reply","text":"Qualified local operational reply."}';
      if (!input.stream) { res.end(JSON.stringify({ id: "synthetic", object: "chat.completion", created: 1, model,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } })); return; }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: unknown, finish: string | null) => ({ id: "synthetic", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }] });
      res.write(`data: ${JSON.stringify(chunk({ content }, null))}\n\n`);
      res.write(`data: ${JSON.stringify({ ...chunk({}, "stop"), usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`); res.end("data: [DONE]\n\n");
    });
  });
  provider.listen(0, "127.0.0.1"); await once(provider, "listening");
  const providerAddress = provider.address(); assert(providerAddress && typeof providerAddress !== "string");
  const configDir = join(profile, ".config", "opencode"); await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "opencode.json"), JSON.stringify({ providers: { ollama: { settings: { baseURL: `http://127.0.0.1:${providerAddress.port}/v1`, apiKey: "synthetic-route-key" } } } }));
  const socket = createSocket(); socket.listen(0, "127.0.0.1"); await once(socket, "listening");
  const address = socket.address(); assert(address && typeof address !== "string"); const port = address.port; await new Promise<void>(resolve => socket.close(() => resolve()));
  const env: Record<string, string> = {};
  for (const name of ["SYSTEMROOT", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "TEMP", "TMP"]) if (process.env[name] !== undefined) env[name] = process.env[name]!;
  Object.assign(env, { HOME: profile, USERPROFILE: profile, APPDATA: join(profile, "roaming"), LOCALAPPDATA: join(profile, "local"),
    XDG_CONFIG_HOME: join(profile, ".config"), XDG_DATA_HOME: join(profile, ".local", "share") });
  const child = spawn(process.env.ARKE_TEST_OPENCODE2!, ["serve", "--port", String(port), "--hostname", "127.0.0.1"], { cwd: profile, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let password: string | null = null, partial = "", spawnError = false;
  child.on("error", () => { spawnError = true; }); child.stderr.resume();
  child.stdout.on("data", chunk => {
    partial += String(chunk); const lines = partial.split(/\r?\n/); partial = lines.pop() ?? "";
    for (const line of lines) { const matched = /^server password (\S+)$/.exec(line.trim()); if (matched) password = matched[1]!; }
  });
  const baseUrl = () => `http://127.0.0.1:${port}`;
  const adapter = new OpenCodeV2Adapter({ baseUrl, password: () => password, warmupMs: 3000 });
  const request = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(baseUrl() + path, { method, headers: { authorization: "Basic " + Buffer.from(`opencode:${password}`).toString("base64"), "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    const text = await response.text(); return { status: response.status, body: text ? JSON.parse(text) : undefined };
  };
  try {
    await until(() => password !== null || spawnError || child.exitCode !== null, "the isolated pinned runtime launch", 35_000);
    assert(password && !spawnError && child.exitCode === null);
    await adapter.init(); assert(adapter.readiness().ready);
    for (const role of ["studio-assistant", "diagnostic-specialist"]) {
      const cwd = join(profile, role); await mkdir(cwd);
      const preparation = { agent: role, model: `ollama/${model}`, preparationId: role };
      await writeFile(join(cwd, "opencode.json"), JSON.stringify(buildSessionConfigV2(preparation)));
      // Direct API probes are intentionally not registered with the adapter. A native deny
      // must succeed without relying on its unexpected-permission auto-rejection backstop.
      const direct = await request("POST", "/api/session", { location: { directory: cwd.replaceAll("\\", "/") }, model: { providerID: "ollama", id: model } });
      assert.equal(direct.status, 200);
      await request("POST", `/api/session/${direct.body.data.id}/agent`, { agent: role });
      const state = await request("GET", `/api/session/${direct.body.data.id}`);
      assert.equal(state.status, 200);
      assert.deepEqual(state.body.data.model, { providerID: "ollama", id: model, variant: "default" });
      assert.equal(state.body.data.agent, role);
      for (const action of ["read", "arke-unlisted-native-tool"]) {
        const denied = await request("POST", `/api/session/${direct.body.data.id}/permission`, { action, resources: ["synthetic"], agent: role });
        assert.equal(denied.status, 200, `${role} permission probe must return a native decision`);
        assert.equal(denied.body.data.effect, "deny", `${role} must natively deny ${action}`);
      }
      adapter.prepareSession(preparation);
      const ref = await adapter.createSession({ purpose: "ask", agent: role, visibility: "private", cwd, preparationId: role });
      const destination = await ref.privateDestination!(new AbortController().signal);
      assert(destination); assert.equal(destination.local, true); assert.equal(destination.provider, "ollama");
      assert.equal(destination.model, `ollama/${model}`); assert.match(destination.identity, /^[a-f0-9]{64}$/);
      const scoped = await request("GET", "/api/model?" + new URLSearchParams({ "location[directory]": cwd.replaceAll("\\", "/") }));
      const selected = scoped.body.data.find((row: { providerID: string; id: string }) => row.providerID === "ollama" && row.id === model);
      assert.deepEqual(Object.keys(selected.settings).sort(), ["apiKey", "baseURL", "provider"]);
      assert.equal(selected.settings.provider, "ollama"); assert.equal(typeof selected.settings.apiKey, "string");
      assert.equal(selected.settings.apiKey, "synthetic-route-key");
      const stop = new AbortController(), events: HarnessEvent[] = [];
      const reading = (async () => { for await (const event of ref.privateEvents!(stop.signal)) { events.push(event); if (event.type === "message.completed" || event.type === "session.error") break; } })();
      try {
        const before = requests.length;
        await adapter.sendMessage({ sessionId: ref.sessionId, parts: [{ type: "text", text: "Return one short structured operational reply." }] }); await reading;
        const reply = events.find(event => event.type === "message.completed");
        assert(reply && reply.type === "message.completed", JSON.stringify(events)); assert(reply.text.includes("Qualified local operational reply"));
        await ref.privateTurnSettled;
        await new Promise(resolve => setTimeout(resolve, 500)); // bounded absence check for asynchronous helper requests
        assert.equal(requests.length - before, 1, "private turn must not launch hidden title/summary/compaction requests");
        const actual = requests.at(-1)!; assert.equal(actual.model, model); assert.equal(actual.tools?.length ?? 0, 0, "no native tool schemas may reach the operational model");
      } finally { stop.abort(); await reading; }
      assert.equal(await ref.privateRetire!(new AbortController().signal), true);
      assert.equal(await ref.privateRetire!(new AbortController().signal), true);
      assert.equal((await request("GET", `/api/session/${ref.sessionId}`)).status, 404);
      assert.equal((await request("GET", `/api/session/${ref.sessionId}/message`)).status, 404);
    }
    assert.equal(requests.length, 2);
    assert.deepEqual(completionAuthentication, ["Bearer synthetic-route-key", "Bearer synthetic-route-key"]);
    assert(metadataAuthentication.filter(value => value === "Bearer synthetic-route-key").length >= 4, "initial and final route probes use the measured completion authentication");
  } finally {
    await adapter.dispose();
    if (child.exitCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
    provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()));
    const owned = relative(tmpdir(), profile); assert(owned && !owned.startsWith("..") && !isAbsolute(owned) && owned.startsWith("arke-operational-native-"));
    await rm(profile, { recursive: true, force: true });
  }
});
