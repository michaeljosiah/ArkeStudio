import assert from "node:assert/strict";
import { it } from "node:test";
import { createDesktopGpuProbe, parseNvidiaReadings } from "../src/system-resources.js";

it("keeps each GPU's measured memory separate and handles unsupported counters without zero", () => {
  const result = parseNvidiaReadings("42, 7987, 12288\n[N/A], 1024, 8192\n", 1000);
  assert.equal(result.value?.length, 2); assert.equal(result.value?.[0]?.utilisation, 42);
  assert.equal(result.value?.[1]?.utilisation, null); assert.equal(result.value?.[1]?.usedBytes, 1024 ** 3);
  assert.throws(() => parseNvidiaReadings("999, 1, 0", 1000)); assert.throws(() => parseNvidiaReadings("N/A, N/A, N/A", 1000));
});
it("only invokes fixed read-only arguments through the bounded native runner and reports unsupported hosts", async () => {
  let calls = 0;
  const signal = new AbortController().signal;
  const probe = createDesktopGpuProbe({ now: () => 5000, runner: { running: false, async confirmCleanup() {}, async dispose() {}, async run(_command, args, bounded) {
    calls++; assert.deepEqual(args, ["--query-gpu=utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"]);
    assert.equal(bounded.aborted, signal.aborted);
    return { code: 0, output: "0, 512, 8192" };
  } } });
  assert.equal((await probe(signal)).value?.[0]?.utilisation, 0); assert.equal(calls, 1);
  assert.equal((await createDesktopGpuProbe({ platform: "darwin" })(signal)).state, "unsupported");
});
it("retains failed native cleanup and never starts another reader until its owner confirms exit", async () => {
  let running = true, allowed = false, calls = 0, cleanup = 0;
  const probe = createDesktopGpuProbe({ runner: { get running() { return running; }, async confirmCleanup() { cleanup++; if (!allowed) throw new Error('cleanup pending'); running = false; },
    async run() { calls++; return { code: 0, output: "0, 512, 8192" }; }, async dispose() { await this.confirmCleanup(); } } });
  assert.equal((await probe(new AbortController().signal)).state, 'unavailable'); assert.equal(calls, 0);
  await assert.rejects(probe.dispose()); assert.equal(cleanup, 2);
  allowed = true; await probe.dispose(); assert.equal(running, false); assert.equal(calls, 0);
});
