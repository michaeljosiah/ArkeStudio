import assert from "node:assert/strict";
import { it } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { assembleHarness, harnessProfileDir, v2ProfileEnv } from "../../src/harness/v2-launch.js";
import { ChildSupervisor } from "../../src/supervisor.js";
import { HarnessStudioModelRunner } from "../../src/studio-assistant/runner.js";
import { withLocalGpu } from "../../src/harness/local-gpu.js";
import { withModelValidation } from "../../src/harness/model-validation.js";
import { LocalGpu } from "../../src/local-ai/gpu.js";
import { tempDir } from "../tmp.js";
import { until, untilAsync } from "../wait.js";

// The owned native retry hook must stop the retry behavior measured on unguarded 2.0.26.
// Production attestation stays closed until the remaining payload/spend gates qualify.
for (const failureStatus of [undefined, 503, 429, 400, "socket-drop"] as const) it(failureStatus === undefined
  ? "qualifies the actual pinned launcher, private runner, native destination approval and single zero-tool completion"
  : `measures pinned native provider failure ${failureStatus} without application replay or false owner settlement`, {
  skip: !process.env.ARKE_TEST_OPENCODE2, timeout: 75_000,
}, async () => {
  const root = await tempDir("arke-studio-pinned-binding-"), model = "studio-qualified";
  const requests: Array<{ model?: string; tools?: unknown[]; stream?: boolean }> = [], traces: unknown[] = [];
  const provider = createServer((req, res) => {
    let body = ""; req.on("data", chunk => { body += String(chunk); if (body.length > 2 * 1024 ** 2) req.destroy(); });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/tags") { res.end(JSON.stringify({ models: [{ name: model, model, size: 1, digest: model, modified_at: "2026-10-27T00:00:00Z",
        details: { format: "gguf", family: "gemma", parameter_size: "12B", quantization_level: "Q4_K_M" } }] })); return; }
      if (req.url === "/api/show") { res.end(JSON.stringify({ capabilities: ["completion", "tools"], model_info: { "general.architecture": "gemma", "gemma.context_length": 262144 } })); return; }
      if (req.url !== "/v1/chat/completions") { res.writeHead(404).end(); return; }
      const input = JSON.parse(body); requests.push(input);
      if (failureStatus === "socket-drop") { req.socket.destroy(); return; }
      if (failureStatus && (failureStatus === 400 || requests.length <= 2)) {
        res.writeHead(failureStatus); res.end(JSON.stringify({ error: { message: "PRIVATE_SCRIPTED_FAILURE", type: "server_error", code: "server_error" } })); return;
      }
      const content = '{"kind":"reply","text":"PRIVATE_PINNED_REPLY"}';
      if (!input.stream) { res.end(JSON.stringify({ id: "synthetic", object: "chat.completion", created: 1, model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } })); return; }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: unknown, finish_reason: string | null) => ({ id: "synthetic", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason }] });
      res.write(`data: ${JSON.stringify(chunk({ content }, null))}\n\n`);
      res.write(`data: ${JSON.stringify({ ...chunk({}, "stop"), usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`); res.end("data: [DONE]\n\n");
    });
  });
  provider.listen(0, "127.0.0.1"); await once(provider, "listening");
  const address = provider.address(); assert(address && typeof address !== "string");
  const profile = harnessProfileDir(root);
  let nativePassword: string | null = null;
  const wiring = await assembleHarness({ appRoot: root, v2: { configuredPath: process.env.ARKE_TEST_OPENCODE2! }, ollamaEndpoint: () => `http://127.0.0.1:${address.port}`, onTrace: value => traces.push(value),
    createSupervisor: (spec, deps) => new ChildSupervisor({ ...spec, onStdoutLine: line => {
      spec.onStdoutLine?.(line); nativePassword = /^server password (\S+)$/.exec(line.trim())?.[1] ?? nativePassword;
    }, inheritEnv: false, env: {
      ...Object.fromEntries(["SYSTEMROOT", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "TEMP", "TMP"].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]])),
      ...v2ProfileEnv(profile), APPDATA: join(profile, "roaming"), LOCALAPPDATA: join(profile, "local"),
    } }, deps) });
  assert(wiring.adapter && wiring.supervisor && wiring.recovery); assert.equal(wiring.harnessInfo?.version, "2.0.26");
  const gpu = new LocalGpu(async () => {}), adapter = withModelValidation(withLocalGpu(wiring.adapter, gpu), async () => ({}));
  const runner = new HarnessStudioModelRunner({ adapter: () => adapter, scratch: join(root, "studio", "turns"), sessionInput: async value => value,
    destination: () => ({ local: true, identity: wiring.recovery!.componentDigest() }), timeoutMs: 30_000 });
  try {
    await wiring.relaunchHarness({}); await wiring.supervisor.start(); await until(() => wiring.supervisor!.status === "healthy", "the actual pinned owned launcher", 35_000);
    await adapter.init?.(); assert(adapter.readiness().ready); assert.equal(adapter.privateDestinations, true);
    await untilAsync(async () => (await adapter.listModels?.())?.some(row => row.provider === "ollama" && row.id === model) === true, "native model discovery");
    let approvals = 0;
    const work = runner.run({ role: "studio-assistant", model: `ollama/${model}`, prompt: "PRIVATE_PINNED_QUESTION" }, new AbortController().signal, async disclosure => {
      approvals++; assert(disclosure.local); assert.equal(requests.length, 0); assert.notEqual(disclosure.destination, wiring.recovery!.componentDigest());
      assert.equal(disclosure.model, `ollama/${model}`); return { cloudApproved: false };
    });
    if (failureStatus !== undefined) {
      await assert.rejects(work, /could not be completed/); assert(runner.busy()); assert(gpu.isBusy("Ollama"));
      assert(nativePassword);
      const nativeGet = async (path: string) => {
        const response = await fetch(`http://127.0.0.1:${wiring.supervisor!.port}${path}`, { headers: {
          authorization: "Basic " + Buffer.from(`opencode:${nativePassword}`).toString("base64"),
        }, signal: AbortSignal.timeout(5_000) }); assert.equal(response.status, 200);
        return (await response.json() as { data: Array<{ id?: string; type?: string; finish?: string; error?: { type?: string; status?: number }; time?: { completed?: number } }> }).data;
      };
      const sessions = await nativeGet("/api/session"); assert.equal(sessions.length, 1); assert(sessions[0]!.id);
      const messages = await nativeGet(`/api/session/${sessions[0]!.id}/message`), failed = messages.find(row => row.type === "assistant");
      assert(failed); assert(Number.isSafeInteger(failed.time?.completed)); assert.equal(failed.finish, "error");
      if (failureStatus === 400) assert.equal(failed.error?.type, "provider.invalid-request");
      if (typeof failureStatus === "number") assert.equal(failed.error?.status, failureStatus);
      await runner.stop(); assert(runner.busy()); assert(gpu.isBusy("Ollama"));
    } else {
      const reply = await work; assert.match(reply, /PRIVATE_PINNED_REPLY/); await until(() => !runner.busy(), "actual private native settlement");
      assert.equal(gpu.isBusy("Ollama"), false);
      assert.deepEqual(await readdir(join(root, "studio", "turns")), [], "native retirement also removes only its captured control/config files");
    }
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(approvals, 1); assert.equal(requests.length, 1);
    assert(requests.every(input => input.model === model && (input.tools?.length ?? 0) === 0));
    assert(!JSON.stringify(traces).includes("PRIVATE_PINNED_"));
    assert(!JSON.stringify(traces).includes("PRIVATE_SCRIPTED_FAILURE"));
  } finally {
    await runner.stop(); await adapter.dispose?.(); await wiring.supervisor.stop(); await runner.ownerStopped(); gpu.stop();
    provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()));
  }
});
