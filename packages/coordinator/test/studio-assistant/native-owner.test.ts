import assert from "node:assert/strict";
import { it } from "node:test";
import type { HarnessEvent } from "@arke-studio/contracts";
import { OpenCodeV2Adapter } from "@arke-studio/adapter-opencode";
import { StubOpenCodeV2, STUB_V2_PASSWORD } from "../../../adapter-opencode/test/helpers/stub-server-v2.js";
import { HarnessStudioModelRunner } from "../../src/studio-assistant/runner.js";
import { HarnessRuntimeChanges } from "../../src/harness/runtime-change.js";
import { withLocalGpu } from "../../src/harness/local-gpu.js";
import { withModelValidation } from "../../src/harness/model-validation.js";
import { LocalGpu } from "../../src/local-ai/gpu.js";
import { tempDir } from "../tmp.js";
import { until } from "../wait.js";

it("keeps real v2 private HTTP/SSE work owned after an error and releases it only on late native completion", async () => {
  const stub = new StubOpenCodeV2(); stub.models = [{ id: "test", providerID: "ollama" }];
  await stub.start();
  const traces: Record<string, unknown>[] = [];
  const raw = new OpenCodeV2Adapter({ baseUrl: () => stub.baseUrl(), password: () => STUB_V2_PASSWORD, warmupMs: 3000, onTrace: line => traces.push(line) });
  const changes = new HarnessRuntimeChanges();
  let finishUnload!: () => void, unloading = false, admitted = false, releaseCreative: (() => void) | undefined;
  const unload = new Promise<void>(resolve => { finishUnload = resolve; });
  const gpu = new LocalGpu(async engine => { if (engine === "Ollama") { unloading = true; await unload; } });
  const adapter = withModelValidation(withLocalGpu(changes.wrap(raw), gpu), async () => ({}));
  const runner = new HarnessStudioModelRunner({ adapter: () => adapter, scratch: await tempDir("arke-private-native-owner-"),
    sessionInput: async input => input, destination: () => ({ local: true, identity: "c".repeat(64) }), timeoutMs: 10_000 });
  const shared: HarnessEvent[] = [], sharedStop = new AbortController();
  const reading = (async () => { for await (const event of adapter.streamEvents(sharedStop.signal)) shared.push(event); })();
  try {
    await raw.init(); assert(raw.readiness().ready);
    stub.failNextPrompt = "PRIVATE_NATIVE_PROMPT_ECHO";
    await assert.rejects(runner.run({ role: "studio-assistant", model: "ollama/test", prompt: "One private question" }, new AbortController().signal, async () => ({ cloudApproved: false })), /could not be completed/);
    const prompt = stub.requests.find(request => request.method === "POST" && request.path.endsWith("/prompt")); assert(prompt);
    const sessionId = prompt.path.split("/")[3]!;
    assert(runner.busy()); assert(gpu.isBusy("Ollama"));
    await assert.rejects(changes.run(async () => {}), /Finish or cancel writing/);
    const creative = gpu.acquire("ComfyUI", new AbortController().signal).then(release => { admitted = true; releaseCreative = release; });
    await adapter.interrupt?.(sessionId); assert.equal(unloading, false); assert.equal(admitted, false);
    // The visible private reader already ended. The adapter's native proof must keep
    // observing its original owner, independently of request cancellation or UI closure.
    stub.emitTurn(sessionId, "PRIVATE_LATE_RESPONSE");
    await until(() => !runner.busy() && unloading, "late v2 completion retires the old owner and starts normal handover");
    assert.equal(admitted, false); finishUnload(); await creative; assert(admitted);
    await changes.run(async () => {});
    assert.equal(stub.requests.filter(request => request.method === "POST" && request.path.endsWith("/prompt")).length, 1);
    assert(!shared.some(event => "sessionId" in event && event.sessionId === sessionId));
    assert(!JSON.stringify(traces).includes("PRIVATE_")); assert(!JSON.stringify(traces).includes(sessionId));
  } finally {
    finishUnload(); releaseCreative?.(); sharedStop.abort(); await runner.stop(); await adapter.dispose?.(); await reading;
    await runner.ownerStopped(); gpu.stop(); await stub.stop();
  }
});
