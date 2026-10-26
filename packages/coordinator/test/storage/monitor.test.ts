import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { StorageHealthSnapshot } from "@arke-studio/contracts";
import { StorageMonitor, type StorageProbeResult } from "../../src/storage/monitor.js";

const GiB = 1024 ** 3;
const root = { rootId: "media", role: "generated-media" as const, revision: "root-1" };
const result = (now: number, availableBytes = 20 * GiB): StorageProbeResult => ({ state: "measured", source: "host-provided", limitations: ["quota-unavailable"],
  capacity: { volumeId: "volume-a", mappingRevision: "mount-a", measuredAt: now, availableBytes, totalBytes: 500 * GiB } });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

describe("bounded scoped storage monitor (SPEC-062 R-1–R-5)", () => {
  it("collects at startup without opening diagnostics and coalesces repeated requests", async () => {
    let now = 600_000, probes = 0; const snapshots: StorageHealthSnapshot[] = [];
    const monitor = new StorageMonitor({ now: () => now, probe: async () => { probes++; return result(now); }, onSnapshot: snapshot => snapshots.push(snapshot) });
    monitor.setRoots([root]); await monitor.start();
    assert.equal(probes, 1); assert.equal(snapshots.at(-1)!.roots[0]!.state, "measured");
    await Promise.all([monitor.refresh(), monitor.refresh(), monitor.refresh()]); assert.equal(probes, 1);
    now += 1_000; await Promise.all([monitor.refresh(), monitor.refresh()]); assert.equal(probes, 2);
    await monitor.stop();
  });

  it("samples every thirty seconds during writes and every five minutes while idle", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let now = 600_000, probes = 0;
    const monitor = new StorageMonitor({ now: () => now, probe: async () => { probes++; return result(now); }, onSnapshot: () => {} });
    monitor.setRoots([root]); await monitor.start();
    now += 30_000; t.mock.timers.tick(30_000); assert.equal(probes, 1);
    monitor.setWriting(true); now += 30_000; t.mock.timers.tick(30_000); await monitor.refresh(); assert.equal(probes, 2);
    now += 30_000; t.mock.timers.tick(30_000); await monitor.refresh(); assert.equal(probes, 3);
    monitor.setWriting(false); now += 299_999; t.mock.timers.tick(299_999); assert.equal(probes, 3);
    now++; t.mock.timers.tick(1); await monitor.refresh(); assert.equal(probes, 4);
    await monitor.stop();
  });

  it("refreshes a stale capacity on admission and refuses unregistered handles", async () => {
    let now = 600_000, probes = 0;
    const monitor = new StorageMonitor({ now: () => now, probe: async () => { probes++; return result(now); }, onSnapshot: () => {} });
    monitor.setRoots([root]); await monitor.start();
    const signal = new AbortController().signal;
    assert.equal((await monitor.capacity("media", signal))!.measuredAt, now); assert.equal(probes, 1);
    now += 5_001; assert.equal((await monitor.capacity("media", signal))!.measuredAt, now); assert.equal(probes, 2);
    assert.equal(await monitor.capacity("C:\\private\\world", signal), null);
    now += 60_001; assert.equal(monitor.snapshot().roots[0]!.state, "stale");
    await monitor.stop();
  });

  it("builds qualified forecasts and discards the observation window on wake", async () => {
    let now = 600_000, available = 25 * GiB;
    const monitor = new StorageMonitor({ now: () => now, probe: async () => result(now, available), onSnapshot: () => {} });
    monitor.setRoots([root]); await monitor.start();
    for (let i = 0; i < 6; i++) { now += 60_000; available -= GiB; await monitor.refresh(); }
    assert(monitor.snapshot().roots[0]!.forecast?.warning);
    const pending = monitor.wake(); assert.equal(monitor.snapshot().roots[0]!.capacity, null); await pending;
    assert.equal(monitor.snapshot().roots[0]!.forecast, null);
    now += 1_000; await monitor.refresh(); assert.equal(monitor.snapshot().roots[0]!.forecast, null);
    await monitor.stop();
  });

  it("keeps failure refresh pending across throttle and does not publish a pre-failure probe", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let now = 600_000, probes = 0; const entered = deferred(), finish = deferred();
    const monitor = new StorageMonitor({ now: () => now, probe: async () => { probes++; if (probes === 2) { entered.resolve(); await finish.promise; } return result(now); }, onSnapshot: () => {} });
    monitor.setRoots([root]); await monitor.start();
    now += 1_000; const pending = monitor.refresh(); await entered.promise;
    monitor.invalidate("media"); assert.equal(monitor.snapshot().roots[0]!.capacity, null);
    finish.resolve(); await pending; assert.equal(monitor.snapshot().roots[0]!.capacity, null);
    await monitor.refresh(); assert.equal(probes, 2);
    now += 999; t.mock.timers.tick(999); assert.equal(probes, 2);
    now++; t.mock.timers.tick(1); await monitor.refresh(); assert.equal(probes, 3);
    assert.equal(monitor.snapshot().roots[0]!.state, "measured"); await monitor.stop();
  });

  it("preserves a critical latch through unavailable readings until measured recovery qualifies", async () => {
    let now = 600_000, current: StorageProbeResult = result(now, GiB);
    const monitor = new StorageMonitor({ now: () => now, probe: async () => current, onSnapshot: () => {} });
    monitor.setRoots([root]); await monitor.start(); assert(monitor.snapshot().roots[0]!.pressure?.critical);
    now += 30_000; current = { capacity: null, state: "unavailable", source: "host-provided", limitations: ["probe-failed"] };
    await monitor.refresh(); assert.equal(monitor.snapshot().roots[0]!.pressure, null);
    now += 30_000; current = result(now); await monitor.refresh(); assert(monitor.snapshot().roots[0]!.pressure?.critical);
    now += 30_000; current = result(now); await monitor.refresh(); assert.equal(monitor.snapshot().roots[0]!.pressure?.critical, false);
    await monitor.stop();
  });

  it("drops late readings after root replacement or shutdown", async () => {
    const entered = deferred(), finish = deferred(); let count = 0;
    const monitor = new StorageMonitor({ now: () => 600_000, probe: async () => { entered.resolve(); await finish.promise; return result(600_000); }, onSnapshot: () => { count++; } });
    monitor.setRoots([root]); const starting = monitor.start(); await entered.promise;
    monitor.setRoots([]); const stopped = monitor.stop(); const before = count;
    finish.resolve(); await starting; await stopped;
    assert.equal(count, before); assert.deepEqual(monitor.snapshot().roots, []);
    await monitor.refresh(); assert.equal(count, before);
  });

  it("reports unsupported and malformed probes explicitly and keeps observing if a view fails", async () => {
    const monitor = new StorageMonitor({ now: () => 600_000, probe: async id => id === "media" ? { state: "unsupported", source: "host-provided", capacity: null, limitations: ["unsupported-filesystem"] } : result(-1), onSnapshot: () => { throw new Error("view failed"); } });
    monitor.setRoots([root, { rootId: "downloads", role: "downloads", revision: "root-1" }]); await monitor.start();
    const roots = monitor.snapshot().roots;
    assert.equal(roots[0]!.state, "unsupported"); assert.equal(roots[1]!.state, "unavailable");
    await monitor.stop();
  });

  it("carries an invalidation fence through a cached host read and refuses older measurements", async () => {
    let now = 600_000, observedAfter: number | undefined, stamp = now;
    const monitor = new StorageMonitor({ now: () => now, probe: async (_root, _signal, after) => { observedAfter = after; return result(stamp); }, onSnapshot: () => {} });
    monitor.setRoots([root]); await monitor.start();
    now += 100; monitor.invalidate("media");
    now += 1_000; await monitor.refresh();
    assert.equal(observedAfter, 600_100); assert.equal(monitor.snapshot().roots[0]!.capacity, null);
    now += 1_000; stamp = now; await monitor.refresh();
    assert.equal(monitor.snapshot().roots[0]!.capacity!.measuredAt, now);
    now += 100;
    assert.equal(await monitor.capacity("media", new AbortController().signal, now), null, "an admission replan requires a post-report read");
    await monitor.stop();
  });
});
