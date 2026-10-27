import assert from "node:assert/strict";
import { it } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { join } from "node:path";
import { agentPromptFor, ROSTER } from "@arke-studio/contracts";
import { privateWireBody } from "../../../adapter-opencode/src/v2/private-control.js";
import { assembleHarness, harnessProfileDir, v2ProfileEnv } from "../../src/harness/v2-launch.js";
import { ChildSupervisor } from "../../src/supervisor.js";
import { HarnessStudioModelRunner } from "../../src/studio-assistant/runner.js";
import { StudioProviderBridge } from "../../src/studio-assistant/provider-bridge.js";
import { withLocalGpu } from "../../src/harness/local-gpu.js";
import { withModelValidation } from "../../src/harness/model-validation.js";
import { LocalGpu } from "../../src/local-ai/gpu.js";
import { assertNativeProfileExcludes } from "./native-profile.js";
import { tempDir } from "../tmp.js";
import { until, untilAsync } from "../wait.js";

for (const overflow of [false, true]) it(`pinned native private generation through the bounded bridge: ${overflow ? "upstream overflow" : "complete response"}`, {
  skip: !process.env.ARKE_TEST_OPENCODE2, timeout: 75_000,
}, async () => {
  const root = await tempDir("arke-studio-native-bridge-"), model = "bridge-selected", profile = harnessProfileDir(root);
  const prompt = "PRIVATE_BRIDGE_QUESTION", answer = '{"kind":"reply","text":"PRIVATE_BRIDGE_REPLY"}';
  const system = agentPromptFor({ ...ROSTER.find(row => row.name === "studio-assistant")!, researchWeb: false });
  const expected = privateWireBody({ model: `ollama/${model}`, prompt, system, outputTokenLimit: 4096 });
  const calls: Array<{ body: unknown; headers: Record<string, unknown> }> = [], traces: unknown[] = [];
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
  provider.listen(0, "127.0.0.1"); await once(provider, "listening"); const address = provider.address(); assert(address && typeof address !== "string");
  const bridge = new StudioProviderBridge({ upstream: `http://127.0.0.1:${address.port}/v1`, requestBody: JSON.stringify(expected), model });
  const route = await bridge.start();
  const wiring = await assembleHarness({ appRoot: root, v2: { configuredPath: process.env.ARKE_TEST_OPENCODE2! }, ollamaEndpoint: () => `http://127.0.0.1:${address.port}`, onTrace: value => traces.push(value),
    createSupervisor: (spec, deps) => new ChildSupervisor({ ...spec, inheritEnv: false, env: {
      ...Object.fromEntries(["SYSTEMROOT", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "TEMP", "TMP"].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]])),
      ...v2ProfileEnv(profile), APPDATA: join(profile, "roaming"), LOCALAPPDATA: join(profile, "local"),
    } }, deps) });
  assert(wiring.adapter && wiring.supervisor && wiring.recovery); assert.equal(wiring.harnessInfo?.version, "2.0.26");
  const gpu = new LocalGpu(async () => {}), adapter = withModelValidation(withLocalGpu(wiring.adapter, gpu), async () => ({}));
  const runner = new HarnessStudioModelRunner({ adapter: () => adapter, scratch: join(root, "studio", "turns"), sessionInput: async value => value,
    destination: () => ({ local: true, identity: wiring.recovery!.componentDigest() }), timeoutMs: 30_000,
    privateTransport: async request => { assert.deepEqual(privateWireBody(request), expected); return { configuration: { baseURL: route.baseURL, apiKey: route.apiKey }, identity: route.identity, approve: () => bridge.approve(), stop: () => bridge.stop() }; } });
  try {
    await wiring.relaunchHarness({}); await wiring.supervisor.start(); await until(() => wiring.supervisor!.status === "healthy", "the isolated pinned native bridge owner", 35_000);
    await adapter.init?.(); assert(adapter.readiness().ready);
    await untilAsync(async () => (await adapter.listModels?.())?.some(row => row.provider === "ollama" && row.id === model) === true, "original native catalogue");
    let approvals = 0;
    const operation = runner.run({ role: "studio-assistant", model: `ollama/${model}`, prompt }, new AbortController().signal, async disclosure => {
      approvals++; assert(disclosure.local); assert.equal(disclosure.prompt, prompt); assert.equal(calls.length, 0); return { cloudApproved: false };
    });
    if (overflow) { await assert.rejects(operation, /could not be completed/); assert(runner.busy()); assert(gpu.isBusy("Ollama")); }
    else { assert.equal(await operation, answer); await until(() => !runner.busy(), "completed native bridge result retired"); assert.equal(gpu.isBusy("Ollama"), false); }
    assert.equal(approvals, 1); assert.equal(calls.length, 1); assert.deepEqual(calls[0]?.body, expected);
    for (const key of ["authorization", "b3", "traceparent", "x-session-id", "x-opencode-session-id"]) assert.equal(calls[0]?.headers[key], undefined);
    assert(!JSON.stringify(traces).includes("PRIVATE_")); assert(!JSON.stringify(traces).includes(route.apiKey));
    await assertNativeProfileExcludes(profile, [prompt, answer, "PRIVATE_UPSTREAM_OVERFLOW", route.apiKey]);
  } finally {
    try { await runner.stop(); await adapter.dispose?.(); await wiring.supervisor.stop(); await runner.ownerStopped(); gpu.stop(); assert(await bridge.stop());
      await assertNativeProfileExcludes(profile, [prompt, answer, "PRIVATE_UPSTREAM_OVERFLOW", route.apiKey]); }
    finally { provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); }
  }
});
