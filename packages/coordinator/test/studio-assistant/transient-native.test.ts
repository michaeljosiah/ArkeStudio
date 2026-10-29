import assert from "node:assert/strict";
import { it } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import type { HarnessAdapter } from "@arke-studio/contracts";
import { privateControlFiles, privateControlProof, privateWireBody } from "../../../adapter-opencode/src/v2/private-control.js";
import { OpenCodeV2Http } from "../../../adapter-opencode/src/v2/http.js";
import { assembleHarness, harnessProfileDir } from "../../src/harness/v2-launch.js";
import { ChildSupervisor } from "../../src/supervisor.js";
import { createPreparedSession } from "../../src/harness/session-files.js";
import { tempDir } from "../tmp.js";
import { untilAsync } from "../wait.js";

/** Direct native protocol qualification, deliberately separate from production dispatch.
 * No model, paid call, physical inference settlement or secure disk erasure is claimed. */
it("qualifies guarded transient native replies without persisted transcript copies or accepted partial/error output", {
  skip: !process.env.ARKE_TEST_OPENCODE2, timeout: 75_000,
}, async () => {
  const root = await tempDir("arke-transient-native-"), model = "synthetic-retention";
  let mode = "stored";
  const calls: Array<{ mode: string; body: unknown }> = [];
  const provider = createServer((req, res) => {
    let body = ""; req.on("data", chunk => { body += String(chunk); if (body.length > 1024 ** 2) req.destroy(); });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/tags") { res.end(JSON.stringify({ models: [{ name: model, model, size: 1, digest: model, modified_at: "2026-10-27T00:00:00Z",
        details: { format: "gguf", family: "gemma", parameter_size: "12B", quantization_level: "Q4_K_M" } }] })); return; }
      if (req.url === "/api/show") { res.end(JSON.stringify({ capabilities: ["completion", "tools"], model_info: { "general.architecture": "gemma", "gemma.context_length": 262144 } })); return; }
      if (req.url !== "/v1/chat/completions") { res.writeHead(404).end(); return; }
      calls.push({ mode, body: JSON.parse(body) });
      if (mode === "socket-drop") { req.socket.destroy(); return; }
      if (["400", "429", "503"].includes(mode)) { res.writeHead(Number(mode)).end(JSON.stringify({ error: { message: "TRANSIENT_PRIVATE_PROVIDER_ERROR", type: "server_error" } })); return; }
      const content = JSON.stringify({ kind: "reply", text: mode === "stored" ? "STORED_NATIVE_REPLY_MARKER" : "TRANSIENT_NATIVE_REPLY_MARKER" });
      res.writeHead(200, { "content-type": "text/event-stream", "x-private-metadata": "TRANSIENT_PRIVATE_PROVIDER_ERROR" });
      const chunk = (delta: unknown, finish_reason: string | null) => ({ id: "TRANSIENT_PRIVATE_PROVIDER_ERROR", object: "chat.completion.chunk", created: 1,
        model: mode === "wrong-model" ? "unreviewed" : model, choices: [{ index: 0, delta, finish_reason }] });
      res.write(`data: ${JSON.stringify(chunk(mode === "tools" ? { tool_calls: [{ function: { name: "unreviewed", arguments: "{}" } }] } : { content: mode === "oversized" ? "x".repeat(1024 ** 2) : content }, null))}\n\n`);
      res.write(`data: ${JSON.stringify({ ...chunk({}, mode.endsWith("length") ? "length" : mode === "tools" ? "tool_calls" : "stop"), usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`);
      res.end(mode === "missing-done" ? "" : "data: [DONE]\n\n");
    });
  });
  provider.listen(0, "127.0.0.1"); await once(provider, "listening"); const address = provider.address(); assert(address && typeof address !== "string");
  let password: string | null = null;
  const wiring = await assembleHarness({ appRoot: root, ollamaEndpoint: () => `http://127.0.0.1:${address.port}`, v2: { configuredPath: process.env.ARKE_TEST_OPENCODE2! },
    createSupervisor: (spec, deps) => new ChildSupervisor({ ...spec, onStdoutLine: line => { spec.onStdoutLine?.(line); const match = /^server password (\S+)$/.exec(line.trim()); if (match) password = match[1]!; } }, deps) });
  assert(wiring.adapter && wiring.supervisor); const adapter: HarnessAdapter = wiring.adapter;
  const baseUrl = () => `http://127.0.0.1:${wiring.supervisor!.port}`, http = new OpenCodeV2Http({ baseUrl, password: () => password });
  const request = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(baseUrl() + path, { method, headers: { authorization: "Basic " + Buffer.from(`opencode:${password}`).toString("base64"), "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
    const text = await response.text(); return { status: response.status, body: text ? JSON.parse(text) : undefined };
  };
  try {
    await wiring.relaunchHarness({}); await wiring.supervisor.start();
    await untilAsync(async () => wiring.supervisor!.status === "healthy", "native healthy", 35_000); await adapter.init?.();
    await untilAsync(async () => (await adapter.listModels?.())?.some(row => row.provider === "ollama" && row.id === model) === true, "native catalogue");
    const normalDir = join(root, "stored"); await mkdir(normalDir);
    const normal = await createPreparedSession(adapter, normalDir, { agent: "studio-assistant", model: `ollama/${model}` },
      { cwd: normalDir, purpose: "ask", agent: "studio-assistant", visibility: "private" });
    assert(await normal.privateDestination!(new AbortController().signal));
    const abort = new AbortController(), reading = (async () => { for await (const event of normal.privateEvents!(abort.signal)) { if (event.type === "message.completed" || event.type === "session.error") break; } })();
    try { await adapter.sendMessage({ sessionId: normal.sessionId, parts: [{ type: "text", text: "STORED_NATIVE_QUESTION_MARKER" }] }); await reading; }
    finally { abort.abort(); }
    await normal.privateTurnSettled; assert.equal(await normal.privateRetire!(new AbortController().signal), true);

    const scenarios = ["unguarded-length", "success", "400", "429", "503", "socket-drop", "length", "tools", "missing-done", "wrong-model", "oversized"];
    for (const scenario of scenarios) {
      mode = scenario; const cwd = join(root, scenario), guarded = scenario !== "unguarded-length";
      const manifest = { model: `ollama/${model}`, system: "REVIEWED_TRANSIENT_SYSTEM", prompt: `TRANSIENT_NATIVE_QUESTION_${scenario}`, outputTokenLimit: 4096 };
      const control = privateControlFiles(manifest, "generate");
      const files = adapter.sessionFiles!({ agent: "studio-assistant", model: manifest.model }, cwd, guarded ? manifest : undefined);
      for (const file of files) {
        const path = join(cwd, file.name); await mkdir(dirname(path), { recursive: true });
        await writeFile(path, guarded ? control.find(candidate => candidate.name === file.name)?.contents ?? file.contents : file.contents);
      }
      const created = await request("POST", "/api/session", { location: { directory: cwd.replaceAll("\\", "/") }, model: { providerID: "ollama", id: model } });
      assert.equal(created.status, 200); const id = created.body.data.id;
      await request("POST", `/api/session/${id}/agent`, { agent: "studio-assistant" });
      await untilAsync(async () => !!await privateControlProof(http, cwd, new AbortController().signal, guarded ? manifest : undefined, guarded ? "generate" : "primary"), `native ${scenario} control`);
      if (guarded) assert.equal(await privateControlProof(http, cwd, new AbortController().signal, manifest), null, "primary proof cannot stand in for transient proof");
      const before = await request("GET", `/api/session/${id}/message`), count = calls.length;
      const result = await request("POST", `/api/session/${id}/generate`, { prompt: manifest.prompt });
      if (scenario === "success" || !guarded) { assert.equal(result.status, 200, scenario); assert.match(result.body.data.text, /TRANSIENT_NATIVE_REPLY_MARKER/); }
      else { assert.equal(result.status, scenario === "socket-drop" ? 503 : 500, `${scenario} cannot be published as a successful generation`); const refusal = JSON.stringify(result.body ?? null);
        assert(!refusal.includes("TRANSIENT_NATIVE_")); assert(!refusal.includes("TRANSIENT_PRIVATE_PROVIDER_ERROR")); }
      assert.deepEqual((await request("GET", `/api/session/${id}/message`)).body, before.body, `${scenario} must not mutate native messages`);
      assert.equal(calls.length - count, 1, `${scenario} must not retry`);
      if (guarded) assert.deepEqual(calls.at(-1)!.body, privateWireBody(manifest));
      assert([200, 204].includes((await request("DELETE", `/api/session/${id}`)).status));
      assert.equal((await request("GET", `/api/session/${id}/message`)).status, 404);
    }

    const hits = { storedQuestion: 0, storedReply: 0, transient: [] as string[] }, scanned: string[] = [];
    let total = 0;
    const scan = async (path: string) => {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const file = join(path, entry.name); if (entry.isDirectory()) { await scan(file); continue; }
        assert(entry.isFile(), "no unexamined linked profile entries"); const size = (await stat(file)).size; total += size;
        assert(size <= 64 * 1024 ** 2 && total <= 128 * 1024 ** 2, "the entire synthetic profile must fit the bounded measurement");
        const bytes = await readFile(file); scanned.push(file);
        if (bytes.includes(Buffer.from("STORED_NATIVE_QUESTION_MARKER"))) hits.storedQuestion++;
        if (bytes.includes(Buffer.from("STORED_NATIVE_REPLY_MARKER"))) hits.storedReply++;
        if (["TRANSIENT_NATIVE_QUESTION_", "TRANSIENT_NATIVE_REPLY_MARKER", "TRANSIENT_PRIVATE_PROVIDER_ERROR", "REVIEWED_TRANSIENT_SYSTEM"].some(marker => bytes.includes(Buffer.from(marker)))) hits.transient.push(file);
      }
    };
    await scan(harnessProfileDir(root)); assert(scanned.length > 0); assert(hits.storedQuestion > 0 && hits.storedReply > 0, "retired prompt-path markers remain as a positive detector control");
    assert.deepEqual(hits.transient, [], "transient system/question/reply/error markers must not remain in the scanned native DB/WAL/log/cache files");
    assert.equal(calls.length, scenarios.length + 1);
    await adapter.dispose?.(); await wiring.supervisor.stop();
    const beforeExitFiles = scanned.length; total = 0; await scan(harnessProfileDir(root)); assert(scanned.length > beforeExitFiles);
    assert.deepEqual(hits.transient, [], "owned native exit must not leave a late persisted transient copy");
  } finally { await adapter.dispose?.(); await wiring.supervisor.stop(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); }
});
