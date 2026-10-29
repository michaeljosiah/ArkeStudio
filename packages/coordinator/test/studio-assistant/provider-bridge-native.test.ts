import assert from "node:assert/strict";
import { it } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { agentPromptFor, ROSTER } from "@arke-studio/contracts";
import { privateWireBody } from "../../../adapter-opencode/src/v2/private-control.js";
import { assembleHarness, managedStudioAssistant, harnessProfileDir, v2ProfileEnv } from "../../src/harness/v2-launch.js";
import { ChildSupervisor, allocateLoopbackPort } from "../../src/supervisor.js";
import { HarnessStudioModelRunner } from "../../src/studio-assistant/runner.js";
import { StudioProviderBridge } from "../../src/studio-assistant/provider-bridge.js";
import { OllamaEngineService } from "../../src/local-ai/ollama.js";
import { OLLAMA_VERSION } from "../../src/setup/catalogue.js";
import { withLocalGpu } from "../../src/harness/local-gpu.js";
import { withModelValidation } from "../../src/harness/model-validation.js";
import { LocalGpu } from "../../src/local-ai/gpu.js";
import { assertNativeProfileExcludes } from "./native-profile.js";
import { tempDir, closeOnCleanup } from "../tmp.js";
import { until, untilAsync } from "../wait.js";
import { nodeRuntimeContentPin } from "../fixtures/runtime-content.js";

async function assertBridgeAddress(baseURL: string, retained: boolean): Promise<void> {
  const replacement = createServer();
  try {
    const listening = new Promise<void>((resolve, reject) => {
      replacement.once("error", reject); replacement.listen(Number(new URL(baseURL).port), "127.0.0.1", () => resolve());
    });
    if (retained) await assert.rejects(listening, { code: "EADDRINUSE" }); else await listening;
  } finally { if (replacement.listening) await new Promise<void>(resolve => replacement.close(() => resolve())); }
}
const scenarios: Array<{ overflow: boolean; managedWriter: boolean; managedProvider: boolean; interrupted?: boolean; variant?: "default" }> = [
  { overflow: false, managedWriter: false, managedProvider: false }, { overflow: true, managedWriter: false, managedProvider: false },
  { overflow: false, managedWriter: true, managedProvider: false }, { overflow: false, managedWriter: true, managedProvider: true },
  { overflow: false, managedWriter: true, managedProvider: true, interrupted: true },
  { overflow: false, managedWriter: true, managedProvider: true, variant: "default" },
];
for (const { overflow, managedWriter, managedProvider, interrupted, variant } of scenarios) it(`pinned native private generation through the bounded bridge: ${variant ? "production managed effort selection" : interrupted ? "production composition Stop retains both original owners" : managedProvider ? "production managed composition" : managedWriter ? "verified managed writer" : overflow ? "upstream overflow" : "complete response"}`, {
  skip: !process.env.ARKE_TEST_OPENCODE2 || managedWriter && process.platform !== "win32", timeout: managedWriter ? 150_000 : 75_000,
}, async () => {
  const root = await realpath(await tempDir("arke-studio-native-bridge-")), model = "bridge-selected", profile = harnessProfileDir(root);
  const prompt = "PRIVATE_BRIDGE_QUESTION", answer = '{"kind":"reply","text":"PRIVATE_BRIDGE_REPLY"}';
  const system = agentPromptFor({ ...ROSTER.find(row => row.name === "studio-assistant")!, researchWeb: false });
  const expected = privateWireBody({ model: `ollama/${model}`, prompt, system, outputTokenLimit: 4096, ...(variant ? { variant } : {}) });
  const calls: Array<{ body: unknown; headers: Record<string, unknown> }> = [], traces: unknown[] = [];
  let phase = "provider startup";
  const writerReads: Array<{ method: string; path: string; status?: number; ms: number }> = [];
  const provider = createServer((request, response) => {
    let body = ""; request.on("data", chunk => { body += String(chunk); if (body.length > 1024 ** 2) request.destroy(); });
    request.on("end", () => {
      if (request.url === "/api/tags") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ models: [{ name: model, model, size: 1, digest: model, modified_at: "2026-10-27T00:00:00Z", details: { format: "gguf", family: "gemma", parameter_size: "12B", quantization_level: "Q4_K_M" } }] })); return; }
      if (request.url === "/api/show") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ capabilities: ["completion", "tools"], model_info: { "general.architecture": "gemma", "gemma.context_length": 262144 } })); return; }
      if (request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
      calls.push({ body: JSON.parse(body), headers: request.headers });
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (overflow) { response.end("PRIVATE_UPSTREAM_OVERFLOW" + "x".repeat(1024 ** 2)); return; }
      const chunk = (delta: unknown, finish_reason: string | null) => ({ id: "synthetic", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason }] });
      response.end(`data: ${JSON.stringify(chunk({ content: answer }, null))}\n\ndata: ${JSON.stringify({ ...chunk({}, "stop"), usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`);
    });
  });
  let service: OllamaEngineService | undefined, providerEndpoint: string, marker: string | undefined;
  if (managedProvider) {
    const providerRoot = join(root, "managed-provider"); marker = join(providerRoot, "requests.jsonl");
    await mkdir(join(providerRoot, "ollama-runtime"), { recursive: true }); await copyFile(process.execPath, join(providerRoot, "ollama-runtime", "ollama.exe"));
    service = new OllamaEngineService({ appRoot: providerRoot, port: await allocateLoopbackPort(),
      privateContentPin: await nodeRuntimeContentPin(),
      supervise: spec => new ChildSupervisor({ ...spec, args: [join(import.meta.dirname, "../fixtures/managed-http-origin.mjs")],
        env: { ...spec.env, SERVICE_VERSION: OLLAMA_VERSION, ORIGIN_MARKER: marker!, NATIVE_PROVIDER_MODEL: model, NATIVE_PROVIDER_REPLY: answer,
          ...(interrupted ? { NATIVE_PROVIDER_HOLD: "1" } : {}) } }) });
    closeOnCleanup(() => service?.dispose());
    await service.applySettings({ engineUrl: null, modelsDir: null }); assert(service.captureManagedOrigin()?.current()); providerEndpoint = service.endpoint();
  } else {
    provider.listen(0, "127.0.0.1"); await once(provider, "listening"); const address = provider.address(); assert(address && typeof address !== "string"); providerEndpoint = `http://127.0.0.1:${address.port}`;
  }
  const bridge = service ? null : new StudioProviderBridge({ upstream: providerEndpoint + "/v1", requestBody: JSON.stringify(expected), model });
  let route!: { baseURL: string; apiKey: string; identity: string };
  if (bridge) route = await bridge.start();
  const wiring = await assembleHarness({ appRoot: root, v2: managedWriter ? { bundledPath: process.env.ARKE_TEST_OPENCODE2!,
    runCommand: async (command, args, timeoutMs, env) => {
      if (command === "where" || command === "which") return { status: 1, stdout: "" }; // deterministic bundled discovery
      assert.equal(command, process.env.ARKE_TEST_OPENCODE2!); assert.deepEqual(args, ["--version"]);
      return new Promise(resolve => { execFile(command, args, { env, timeout: timeoutMs, maxBuffer: 4096, windowsHide: true, encoding: "utf8" },
        (error, stdout) => resolve({ status: error ? 1 : 0, stdout })); });
    } } : { configuredPath: process.env.ARKE_TEST_OPENCODE2! }, ollamaEndpoint: () => providerEndpoint, onTrace: value => traces.push(value),
    createSupervisor: (spec, deps) => new ChildSupervisor({ ...spec, inheritEnv: false, env: {
      ...Object.fromEntries(["SYSTEMROOT", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "TEMP", "TMP"].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]])),
      ...v2ProfileEnv(profile), APPDATA: join(profile, "roaming"), LOCALAPPDATA: join(profile, "local"),
    } }, deps) });
  assert(wiring.adapter && wiring.supervisor && wiring.recovery); assert.equal(wiring.harnessInfo?.version, "2.0.26");
  const production = service ? managedStudioAssistant(wiring, service) : undefined;
  const gpu = new LocalGpu(async () => {}), adapter = withModelValidation(withLocalGpu(wiring.adapter, gpu), async () => ({}));
  const runner = new HarnessStudioModelRunner({ adapter: () => adapter, scratch: join(root, "studio", "turns"), sessionInput: async value => value,
    destination: production?.destination ?? (() => ({ local: true, identity: wiring.recovery!.componentDigest() })), timeoutMs: managedWriter ? 90_000 : 30_000,
    privateTransport: async (request, signal) => { assert.deepEqual(privateWireBody(request), expected);
      const transport = await production?.privateTransport?.(request, signal);
      const writer = transport?.writer ?? (managedWriter ? await wiring.createPrivateWriter?.(request, signal) : undefined);
      if (managedWriter) assert(writer, "the actual bundled supervisor must supply its original writer connection");
      if (writer && managedProvider) {
        const original = writer.fetch.bind(writer);
        writer.fetch = async (url, init) => {
          const at = Date.now(), path = new URL(String(url)).pathname.replace(/\/session\/[^/]+/, "/session/<id>");
          try { const result = await original(url, init); writerReads.push({ method: init?.method ?? "GET", path, status: result.status, ms: Date.now() - at }); return result; }
          catch (error) { writerReads.push({ method: init?.method ?? "GET", path, ms: Date.now() - at }); throw error; }
        };
      }
      if (transport) return { ...(writer ? { writer } : {}), get configuration() { return transport.configuration; }, get identity() { return transport.identity; },
        prepare: async admission => { await transport.prepare!(admission); route = { ...transport.configuration, identity: transport.identity }; },
        approve: transport.approve.bind(transport), seal: transport.seal.bind(transport), stop: transport.stop.bind(transport), ownersStopped: transport.ownersStopped!.bind(transport) };
      assert(bridge);
      return { configuration: { baseURL: route.baseURL, apiKey: route.apiKey }, identity: route.identity, approve: () => bridge.approve(), seal: () => bridge.seal(), stop: () => bridge.stop(),
        ...(writer ? { writer } : {}) }; } });
  try {
    phase = "native readiness";
    await wiring.relaunchHarness({}); await wiring.supervisor.start(); await until(() => wiring.supervisor!.status === "healthy", "the isolated pinned native bridge owner", 35_000);
    await adapter.init?.(); assert(adapter.readiness().ready);
    phase = "global catalogue";
    await untilAsync(async () => (await adapter.listModels?.())?.some(row => row.provider === "ollama" && row.id === model) === true, "original native catalogue");
    let approvals = 0;
    if (variant) {
      await assert.rejects(runner.run({ role: "studio-assistant", model: `ollama/${model}`, prompt, variant: "high" }, new AbortController().signal,
        async () => { approvals++; return { cloudApproved: false }; }), /does not offer this effort/);
      assert.equal(approvals, 0); assert.equal(runner.busy(), false);
    }
    phase = "private run";
    const caller = new AbortController();
    const operation = runner.run({ role: "studio-assistant", model: `ollama/${model}`, prompt, ...(variant ? { variant } : {}) }, caller.signal, async disclosure => {
      approvals++; assert(disclosure.local); assert.equal(disclosure.prompt, prompt); assert.equal(calls.length, 0);
      assert.equal(disclosure.variant, variant);
      phase = "approved private run";
      if (marker) assert.equal((await readFile(marker, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { path: string }).filter(row => row.path === "/v1/chat/completions").length, 0);
      return { cloudApproved: false };
    });
    if (interrupted) {
      const stopped = assert.rejects(operation, /stopped/);
      await untilAsync(async () => (await readFile(marker!, "utf8")).trim().split("\n").some(line => (JSON.parse(line) as { path: string }).path === "/v1/chat/completions"), "one actual native request is held by the original provider", 60_000);
      caller.abort(); await stopped; await runner.stop();
      assert(runner.busy()); assert(gpu.isBusy("Ollama")); await assertBridgeAddress(route.baseURL, true);
      const refused = await fetch(route.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify(expected), headers: { authorization: `Bearer ${route.apiKey}` } });
      assert.equal(refused.status, 401); await refused.arrayBuffer();
      await adapter.dispose?.(); await wiring.supervisor.stopAndConfirm();
      await runner.reconcileRetirement();
      assert(runner.busy()); assert(gpu.isBusy("Ollama"), "writer exit alone cannot release the backing inference lane");
      await assertBridgeAddress(route.baseURL, true);
      await service!.dispose(); await runner.reconcileRetirement();
      await until(() => !runner.busy() && !gpu.isBusy("Ollama"), "both exact native owners confirmed cleanup");
      await assertBridgeAddress(route.baseURL, false);
    } else if (overflow) { await assert.rejects(operation, /could not be completed/); assert(runner.busy()); assert(gpu.isBusy("Ollama")); }
    else { assert.equal(await operation, answer); await until(() => !runner.busy(), "completed native bridge result retired"); assert.equal(gpu.isBusy("Ollama"), false); }
    const actualCalls = marker ? (await readFile(marker, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { path: string; body: string; headers: Record<string, unknown> })
      .filter(row => row.path === "/v1/chat/completions").map(row => ({ body: JSON.parse(row.body), headers: row.headers })) : calls;
    assert.equal(approvals, 1); assert.equal(actualCalls.length, 1); assert.deepEqual(actualCalls[0]?.body, expected);
    for (const key of ["authorization", "b3", "traceparent", "x-session-id", "x-opencode-session-id"]) assert.equal(actualCalls[0]?.headers[key], undefined);
    assert(!JSON.stringify(traces).includes("PRIVATE_")); assert(!JSON.stringify(traces).includes(route.apiKey));
    await assertNativeProfileExcludes(profile, [prompt, answer, "PRIVATE_UPSTREAM_OVERFLOW", route.apiKey]);
  } finally {
    if (managedProvider) {
      const providerPaths = marker ? (await readFile(marker, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => (JSON.parse(line) as { path: string }).path) : [];
      console.log(JSON.stringify({ managedNativePhase: phase, writerReads, providerPaths, providerState: service?.status().state, providerCurrent: service?.captureManagedOrigin()?.current() }));
    }
    try { await runner.stop(); await adapter.dispose?.(); await wiring.supervisor.stopAndConfirm(); await service?.dispose();
      if (provider.listening) { provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); }
      await runner.ownerStopped(); await until(() => !runner.busy(), "original native session/files retired after confirmed owned cleanup"); gpu.stop(); if (bridge) assert(await bridge.stop());
      assert.deepEqual(await readdir(join(root, "studio", "turns")).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; }), []);
      await assertNativeProfileExcludes(profile, [prompt, answer, "PRIVATE_UPSTREAM_OVERFLOW", route?.apiKey ?? "UNUSED_BRIDGE_KEY"]); }
    finally { await service?.dispose(); if (provider.listening) { provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); } }
  }
});
