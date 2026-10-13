import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type { HarnessEvent } from "@arke-studio/contracts";
import { OpenCodeV2Adapter } from "../src/v2/opencode-v2-adapter.js";
import { buildSessionConfigV2 } from "../src/v2/config.js";
import { encodePng, solidImage, decodePng } from "../../coordinator/src/references/png.js";
import { until } from "./wait.js";

/** Both image paths must reach the model request on the qualified native pin. A prompt
 * acknowledgement or a text-only tool receipt would not establish image transport. */
it("qualifies native PNG attachment and direct MCP image handoff on the pinned runtime", {
  skip: !process.env["ARKE_TEST_OPENCODE2"], timeout: 60_000,
}, async () => {
  const profile = await mkdtemp(join(tmpdir(), "arke-image-protocol-"));
  const cwd = join(profile, "session"); await mkdir(cwd);
  const red = Buffer.from(encodePng(solidImage(2, 2, [255, 0, 0, 255]))).toString("base64");
  const blue = Buffer.from(encodePng(solidImage(2, 2, [0, 0, 255, 255]))).toString("base64");
  const requests: Array<{ messages: unknown[]; tools?: Array<{ function: { name: string } }> }> = [];
  const provider = createServer((req, res) => {
    let body = ""; req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      if (req.url === "/api/tags") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ models: [{ name: "arke-vision", model: "arke-vision", modified_at: "2026-10-12T00:00:00Z", size: 1, digest: "vision",
          details: { format: "gguf", family: "gemma", parameter_size: "12B", quantization_level: "Q4_K_M" } }] })); return;
      }
      if (req.url === "/api/show") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ capabilities: ["completion", "tools", "vision"],
          model_info: { "general.architecture": "gemma", "gemma.context_length": 262144 } })); return;
      }
      if (req.url !== "/v1/chat/completions") { res.writeHead(404).end(); return; }
      const request = JSON.parse(body);
      const tool = request.tools?.find((tool: { function: { name: string } }) => tool.function.name.endsWith("view_image"));
      const writing = request.tools?.some((tool: { function: { name: string } }) => tool.function.name === "read");
      if (writing) requests.push(request);
      const at = writing ? requests.length : 0;
      // Native MCP registration is asynchronous. A bounded ordinary file read permits its
      // catalog to settle; once advertised, call the exact direct tool name, never Code Mode.
      const imageCall = !!tool && mcpCalls.length === 0;
      const warmup = writing && !tool && at < 5;
      const delta = imageCall || warmup ? { tool_calls: [{ index: 0, id: `call_${at}`, type: "function",
        function: { name: imageCall ? tool.function.name : "read", arguments: JSON.stringify(imageCall
          ? { kind: "reference", file: "frozen-reference.png" }
          : { path: "ready.txt" }) } }] }
        : { content: tool ? "Both images were supplied." : "Image test" };
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: unknown, finish: string | null) => ({ id: `chatcmpl_${at}`, object: "chat.completion.chunk", created: 1,
        model: "arke-vision", choices: [{ index: 0, delta, finish_reason: finish }] });
      res.write(`data: ${JSON.stringify(chunk(delta, null))}\n\n`);
      res.write(`data: ${JSON.stringify({ ...chunk({}, imageCall || warmup ? "tool_calls" : "stop"), usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  const mcpCalls: string[] = [];
  const mcpMethods: string[] = [];
  const mcp = createServer((req, res) => {
    let body = ""; req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      if (req.method !== "POST") { res.writeHead(405).end(); return; }
      const input = JSON.parse(body), method = input.method;
      mcpMethods.push(method);
      if (input.id === undefined) { res.writeHead(202).end(); return; }
      const result = method === "initialize" ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "arke-world", version: "1" } }
        : method === "tools/list" ? { tools: [{ name: "view_image", description: "Return a verified frozen image.",
          inputSchema: { type: "object", properties: { kind: { type: "string" }, file: { type: "string" } }, required: ["kind"], additionalProperties: false } }] }
        : method === "tools/call" ? (mcpCalls.push(input.params.name), { content: [
          { type: "text", text: "Verified reference image supplied." }, { type: "image", mimeType: "image/png", data: blue },
        ] }) : {};
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: input.id, result }));
    });
  });
  provider.listen(0, "127.0.0.1"); mcp.listen(0, "127.0.0.1");
  await Promise.all([once(provider, "listening"), once(mcp, "listening")]);
  const providerAddress = provider.address(), mcpAddress = mcp.address();
  assert.ok(providerAddress && typeof providerAddress !== "string" && mcpAddress && typeof mcpAddress !== "string");
  await mkdir(join(profile, ".config", "opencode"), { recursive: true });
  await writeFile(join(profile, ".config", "opencode", "opencode.json"), JSON.stringify({ providers: {
    ollama: { settings: { baseURL: `http://127.0.0.1:${providerAddress.port}/v1` } },
  } }));
  const preparation = { preparationId: "vision-smoke", model: "ollama/arke-vision", worldQueryUrl: `http://127.0.0.1:${mcpAddress.port}/mcp` };
  await writeFile(join(cwd, "opencode.json"), JSON.stringify(buildSessionConfigV2({ ...preparation, defaultAgent: "world-builder" })));
  await writeFile(join(cwd, "ready.txt"), "Native image qualification.");
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "COMSPEC", "PATHEXT"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  Object.assign(env, { HOME: profile, USERPROFILE: profile,
    XDG_CONFIG_HOME: join(profile, ".config"), XDG_DATA_HOME: join(profile, ".local", "share") });
  const child = spawn(process.env["ARKE_TEST_OPENCODE2"]!, ["serve", "--port", "0", "--hostname", "127.0.0.1"],
    { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let password: string | null = null, address: string | null = null, pending = "", spawnError = false;
  child.on("error", () => { spawnError = true; }); child.stderr.resume();
  child.stdout.on("data", chunk => {
    pending += chunk;
    const lines = pending.split(/\r?\n/); pending = lines.pop() ?? "";
    for (const line of lines) {
      const pass = /^server password (\S+)$/.exec(line.trim()); if (pass) password = pass[1]!;
      const url = /http:\/\/127\.0\.0\.1:\d+/.exec(line); if (url) address = url[0];
    }
  });
  let adapter: OpenCodeV2Adapter | undefined;
  try {
    await until(() => !spawnError && password !== null && address !== null, "native image runtime launch", 35_000);
    adapter = new OpenCodeV2Adapter({ baseUrl: () => address!, password: () => password });
    await adapter.init(); assert.equal(adapter.readiness().ready, true);
    const pin = JSON.parse(await readFile(new URL("../../../apps/desktop/runtime-sources.json", import.meta.url), "utf8"));
    assert.equal(adapter.serverVersion, pin.opencode2.version);
    const catalogDeadline = Date.now() + 10_000;
    let catalog = await adapter.listModels();
    while (!catalog.some(model => model.provider === "ollama" && model.id === "arke-vision" && model.inputModalities?.includes("image")) && Date.now() < catalogDeadline) {
      await new Promise(resolve => setTimeout(resolve, 100)); catalog = await adapter.listModels();
    }
    assert.ok(catalog.some(model => model.provider === "ollama" && model.id === "arke-vision" && model.inputModalities?.includes("image")), "native vision inventory");
    adapter.prepareSession(preparation);
    const { sessionId } = await adapter.createSession({ purpose: "world-chat", agent: "world-builder", cwd, preparationId: preparation.preparationId });
    assert.equal(adapter.imageInputForSession(sessionId), true);
    assert.deepEqual(adapter.imageDestinationForSession(sessionId), { provider: "ollama", local: true });
    const listening = new AbortController(), events: HarnessEvent[] = [];
    const pump = (async () => { for await (const event of adapter!.streamEvents(listening.signal)) events.push(event); })();
    try {
      await adapter.dispatchAsync({ sessionId, parts: [{ type: "text", text: "Read the frozen reference with view_image and compare the attached image." },
        { type: "image", mimeType: "image/png", data: red }] });
      await until(() => events.some(event => event.type === "message.completed" || event.type === "session.error"), "native image turn", 20_000);
      assert.ok(!events.some(event => event.type === "session.error"), JSON.stringify(events));
      assert.deepEqual(mcpCalls, ["view_image"], JSON.stringify({ methods: mcpMethods,
        tools: requests.map(request => request.tools?.map(tool => tool.function.name)),
      }));
      assert.ok(requests.length >= 2 && requests.length <= 6, "bounded warm-up reads, then an image tool continuation");
      const images = (value: unknown): string[] => typeof value === "string" && value.startsWith("data:image/") ? [value]
        : value && typeof value === "object" ? Object.values(value).flatMap(images) : [];
      const colors = (messages: unknown) => images(messages).map(uri => Array.from(decodePng(Buffer.from(uri.slice(uri.indexOf(",") + 1), "base64")).pixels.subarray(0, 4)));
      assert.ok(colors(requests[0]!.messages).some(color => JSON.stringify(color) === "[255,0,0,255]"), "attached red pixels reached the provider");
      assert.ok(colors(requests.at(-1)!.messages).some(color => JSON.stringify(color) === "[0,0,255,255]"), "MCP blue pixels reached the provider");
    } finally { listening.abort(); await adapter.dispose(); await pump; }
  } finally {
    await adapter?.dispose();
    if (child.exitCode === null && !spawnError) { const exited = once(child, "exit"); child.kill(); await exited; }
    for (const server of [provider, mcp]) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
