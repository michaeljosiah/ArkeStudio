import assert from "node:assert/strict";
import { it } from "node:test";
import type { CpuInfo } from "node:os";
import { createNodeSystemResourceProbe, cpuUtilisation, SystemResourceService } from "../src/system-resources.js";
import { unavailableSystemResources } from "@arke-studio/contracts";

const cpu = (idle: number, user: number): CpuInfo[] => [{ model: "unused", speed: 0, times: { idle, user, sys: 0, nice: 0, irq: 0 } }];
it("measures CPU deltas and actual RAM without deriving utilisation from installed capacity", async () => {
  let reads = 0;
  const sample = await createNodeSystemResourceProbe({ cpu: () => ++reads === 1 ? cpu(100, 100) : cpu(175, 125),
    total: () => 1024, free: () => 256, now: () => 5000, wait: async () => {}, mingRunning: () => false })(new AbortController().signal);
  assert.equal(sample.cpu.value, 25); assert.deepEqual(sample.memory.value, { usedBytes: 768, totalBytes: 1024 });
  assert.equal(sample.ming.value, false); assert.equal(sample.gpu.state, "unsupported");
  assert.equal(cpuUtilisation(cpu(100, 0), cpu(99, 0)), null); assert.equal(cpuUtilisation([], []), null);
});
it("coalesces simultaneous refresh, retains failed samples as old, and cancels/drains before shutdown", async () => {
  let at = 5000, count = 0, release!: () => void, observed = 0, signal!: AbortSignal;
  const service = new SystemResourceService(async abort => {
    signal = abort; count++;
    if (count === 1) { await new Promise<void>(resolve => { release = resolve; }); const value = unavailableSystemResources(at); value.cpu = { source: "node-os", state: "measured", measuredAt: at, value: 0 }; return value; }
    if (count === 2) throw new Error("probe failed");
    await new Promise<void>(resolve => abort.addEventListener("abort", () => { release = resolve; }, { once: true }));
    return unavailableSystemResources(at);
  }, () => at);
  service.subscribe(() => observed++);
  const first = service.refresh(), same = service.refresh(); assert.equal(first, same); await Promise.resolve(); release(); await first;
  assert.equal(count, 1); assert.equal(observed, 1); assert.equal(service.current()?.cpu.value, 0);
  at += 2000; await service.refresh(); assert.equal(service.current()?.cpu.state, "unavailable"); assert.equal(service.current()?.cpu.measuredAt, 5000);
  at += 2000; const last = service.refresh(); await Promise.resolve(); const stop = service.stop(); assert.equal(signal.aborted, true); release(); await stop; await last;
  assert.equal(observed, 2); await service.refresh(); assert.equal(count, 3);
});
it("bounds an uncooperative probe, forbids overlapping retries and suppresses late publication after shutdown", async () => {
  let finish!: (value: ReturnType<typeof unavailableSystemResources>) => void, attempts = 0, events = 0, now = 1000;
  const service = new SystemResourceService(async () => { attempts++; return new Promise(resolve => { finish = resolve; }); }, () => now,
    { observationMs: 10, shutdownMs: 10 });
  service.subscribe(() => events++);
  await service.refresh(); assert.equal(events, 1); assert.equal(service.current()?.cpu.state, "unavailable");
  now += 2000; await service.refresh(); assert.equal(attempts, 1, "native completion remains unconfirmed");
  await service.stop(); finish(unavailableSystemResources(5000)); await Promise.resolve(); await Promise.resolve();
  assert.equal(events, 1, "a late native result cannot resurrect publication");
});
it("stops while a native probe ignores cancellation without waiting for its observation deadline", { timeout: 1000 }, async () => {
  let finish!: (value: ReturnType<typeof unavailableSystemResources>) => void, signal!: AbortSignal, events = 0;
  const service = new SystemResourceService(async abort => { signal = abort; return new Promise(resolve => { finish = resolve; }); }, Date.now,
    { observationMs: 30_000, shutdownMs: 10 });
  service.subscribe(() => events++);
  const observation = service.refresh(); await Promise.resolve();
  await service.stop(); await observation;
  assert.equal(signal.aborted, true); assert.equal(events, 0);
  finish(unavailableSystemResources(Date.now())); await Promise.resolve(); await Promise.resolve();
  assert.equal(events, 0); assert.equal(service.current(), null);
});
