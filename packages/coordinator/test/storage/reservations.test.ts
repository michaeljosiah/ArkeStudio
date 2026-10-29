import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { join } from "node:path";
import { writeFile, readFile } from "node:fs/promises";
import type { StorageCapacity } from "@arke-studio/contracts";
import { StorageReservations, type StorageCheckObservation, type StorageReservation, type StorageReservationRequest, type StorageReservationStore } from "../../src/storage/reservations.js";
import { FileStorageReservationStore } from "../../src/storage/reservation-file.js";
import { AppStorageService } from "../../src/storage/service.js";
import { tempDir } from "../tmp.js";

const GiB = 1024 ** 3;
const owner = { kind: "job" as const, id: "job-a" };
const fact = (availableBytes = 10 * GiB, extra: Partial<StorageCapacity> = {}): StorageCapacity => ({
  volumeId: "volume-a", mappingRevision: "mount-a", measuredAt: 600_000, availableBytes, totalBytes: 500 * GiB, ...extra,
});
const request = (id: string, remainingBytes: number | null, rootId = "media"): StorageReservationRequest => ({ id, owner, demands: [{ rootId, remainingBytes }] });

it("reports a whole known multi-drive check without adding free space across drives or granting through a throwing observer", async () => {
  const observations: StorageCheckObservation[] = [];
  const registry = new StorageReservations({ now: () => 600_000,
    probe: async rootId => fact(rootId === "media" ? 6 * GiB : 100 * GiB, { volumeId: rootId, mappingRevision: rootId }),
    onCheck: check => { observations.push(structuredClone(check)); check.volumes[0]!.admission.deficitBytes = 0; check.owner.id = "changed-by-view"; throw new Error("view unavailable"); },
    store: { load: async () => ({ version: 2, records: [], consumed: [] }), save: async () => {} },
  });
  try {
    await registry.open(); const result = await registry.reserve({ id: "two-drives", owner,
      demands: [{ rootId: "media", remainingBytes: 8 * GiB }, { rootId: "scratch", remainingBytes: 2 * GiB }] });
    assert.equal(result.status, "held"); assert.equal(registry.snapshot().records.length, 0);
    assert(result.status === "held" && result.admission?.status === "held"); assert.equal(result.admission.deficitBytes, 3 * GiB);
    assert.equal(observations.length, 1); assert.equal(observations[0]!.volumes.length, 2);
    assert.deepEqual(observations[0]!.volumes.map(volume => [volume.volumeId, volume.admission.status, volume.admission.deficitBytes]), [["media", "held", 3 * GiB], ["scratch", "fits", 0]]);
    await registry.assess([{ rootId: "media", remainingBytes: null }]);
    assert.equal(observations.length, 1, "unknown output does not become a numeric check");
  } finally { await registry.stop(); }
});

it("read-only assessment uses shared commitments without granting, consuming or persisting a reservation", async () => {
  let saves = 0;
  const registry = new StorageReservations({ now: () => 600_000, probe: async () => fact(3 * GiB), store: {
    async load() { return { version: 2, records: [], consumed: [] }; }, async save() { saves++; },
  } });
  try {
    await registry.open();
    assert.equal((await registry.reserve(request("other", GiB))).status, "reserved");
    const before = registry.snapshot(); assert.equal(saves, 1);
    for (let i = 0; i < 3; i++) assert.equal((await registry.assess([{ rootId: "media", remainingBytes: GiB }])).status, "fits");
    const shortage = await registry.assess([{ rootId: "media", remainingBytes: GiB + 1 }]);
    assert.equal(shortage.status, "held");
    assert.equal((await registry.assess([{ rootId: "media", remainingBytes: null }])).status, "held", "Unknown output remains unknown");
    assert.deepEqual(registry.snapshot(), before); assert.equal(saves, 1);
  } finally { await registry.stop(); }
});

for (const change of ["mapping", "capacity", "unavailable"] as const) it(`revokes flushed admission when a concurrent observation detects ${change} without an explicit invalidation`, async () => {
  const root = await tempDir("arke-admission-observed-"), entered = deferred(), finish = deferred(); let now = 600_000, changed = false;
  const storage = new AppStorageService({ appRoot: root, now: () => now, store: {
    load: async () => ({ version: 2, records: [], consumed: [] }), save: async () => { entered.resolve(); await finish.promise; },
  }, native: { setRoots: () => {}, stop: async () => {}, probe: async rootId => changed && change === "unavailable"
    ? { state: "unavailable", source: "host-provided", limitations: ["probe-failed"], capacity: null }
    : { state: "measured", source: "host-provided", limitations: [], capacity: fact(changed ? GiB : 100 * GiB,
      { measuredAt: ++now, volumeId: changed && change === "mapping" ? "remounted-volume" : "volume-a", mappingRevision: rootId }) } } });
  try {
    await storage.start(); const rootId = storage.snapshot().roots[0]!.rootId;
    const pending = storage.reservations.reserve(request("pending-observation", 6 * GiB, rootId));
    await entered.promise; changed = true; now += 1001; await storage.refresh(); finish.resolve();
    assert.deepEqual(await pending, { status: "held", reason: "capacity", admission: { status: "unknown", reason: "capacity-unavailable" } });
    assert.equal(storage.reservations.snapshot().records[0]!.state, "uncertain");
  } finally { finish.resolve(); await storage.stop(); }
});

for (const replacing of [false, true]) it(`revokes a pending ${replacing ? "replan" : "reservation"} grant when another writer invalidates capacity during its flush`, async () => {
  const root = await tempDir("arke-admission-invalidated-"), entered = deferred(), finish = deferred();
  let now = 600_000, blocked = false;
  const storage = new AppStorageService({ appRoot: root, now: () => now, store: {
    load: async () => ({ version: 2, records: [], consumed: [] }),
    save: async () => { if (blocked) { entered.resolve(); await finish.promise; } },
  }, native: { setRoots: () => {}, stop: async () => {}, probe: async rootId => ({ state: "measured", source: "host-provided", limitations: [],
    capacity: fact(100 * GiB, { measuredAt: ++now, mappingRevision: rootId }) }) } });
  const hold = storage.acquireRoot(join(root, "models"), "local-ai");
  try {
    await storage.start(); const operation = request("flushing", GiB, hold.rootId);
    if (replacing) assert.equal((await storage.reservations.reserve(operation)).status, "reserved");
    blocked = true; now += 1001;
    const pending = replacing ? storage.reservations.replan(operation) : storage.reservations.reserve(operation);
    await entered.promise;
    const otherRoot = storage.snapshot().roots.find(value => value.rootId !== hold.rootId)!;
    storage.writeFailed(otherRoot.rootId); now += 1001;
    await storage.refresh(); // Even refreshed facts cannot restore the old grant's authority.
    finish.resolve();
    assert.deepEqual(await pending, { status: "held", reason: "capacity", admission: { status: "unknown", reason: "capacity-unavailable" } });
    assert.equal(storage.reservations.snapshot().records[0]!.state, "uncertain");
    assert.equal((await storage.reservations.reserve(request("competing", 1, hold.rootId))).status, "held");
    blocked = false; assert.equal(await storage.reservations.settle(operation.id, owner), true);
  } finally { finish.resolve(); hold.release(); await storage.stop(); }
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

for (const phase of ["read", "reserve"] as const) it(`bounds a stalled reservation ${phase} during shutdown without granting late write permission`, { timeout: 5000 }, async () => {
  const entered = deferred(), finish = deferred(); let disk: unknown = { version: 2, records: [], consumed: [] }, block = phase === "read";
  const manager = new StorageReservations({ stopTimeoutMs: 20, now: () => 600_000, probe: async () => fact(), store: {
    load: async () => { if (block) { entered.resolve(); await finish.promise; } return disk; },
    save: async (records, consumed) => { if (block) { entered.resolve(); await finish.promise; } disk = structuredClone({ version: 2, records, consumed }); },
  } });
  let pending: Promise<unknown>;
  if (phase === "read") pending = manager.open();
  else { await manager.open(); block = true; pending = manager.reserve(request("stalled", GiB)); }
  await entered.promise; manager.closeAdmission();
  assert.deepEqual(await pending, phase === "read" ? undefined : { status: "held", reason: "stopped" });
  await manager.stop(); assert.equal(manager.snapshot().auditAvailable, false);
  finish.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await manager.reserve(request("late", 1))).status, "held");
  if (phase === "reserve") {
    const restarted = new StorageReservations({ now: () => 600_000, probe: async () => fact(), store: { load: async () => disk, save: async () => {} } });
    await restarted.open(); assert.equal(restarted.snapshot().records[0]!.state, "uncertain");
    assert.equal((await restarted.reserve(request("new", 1))).status, "held"); await restarted.stop();
  }
});
function harness(options: { load?: unknown; save?: (records: readonly StorageReservation[]) => Promise<void>; probe?: (root: string, signal: AbortSignal, after?: number) => Promise<StorageCapacity | null>; onChange?: () => void; now?: () => number } = {}) {
  let disk: unknown = Object.hasOwn(options, "load") ? options.load : { version: 1, records: [] };
  const store: StorageReservationStore = {
    load: async () => structuredClone(disk),
    save: async (records, consumed) => { await options.save?.(records); disk = structuredClone({ version: 2, records, consumed }); },
  };
  const manager = new StorageReservations({ store, now: options.now ?? (() => 600_000), probe: options.probe ?? (async () => fact()), onChange: options.onChange });
  return { manager, disk: () => structuredClone(disk) };
}

describe("shared storage reservations (SPEC-062 R-8/R-9/R-24)", () => {
  it("serializes concurrent writes sharing a real volume even through different roots", async () => {
    const { manager } = harness(); await manager.open();
    const results = await Promise.all([manager.reserve(request("first", 6 * GiB)), manager.reserve(request("second", 6 * GiB, "exports"))]);
    assert.equal(results[0]!.status, "reserved");
    assert.deepEqual(results[1], { status: "held", reason: "capacity", volumeId: "volume-a", admission: {
      status: "held", availableBytes: 10 * GiB, reservedBytes: 6 * GiB, peakBytes: 6 * GiB, reserveBytes: GiB, deficitBytes: 3 * GiB,
    } });
    assert.equal(manager.snapshot().records.length, 1);
    await manager.stop();
  });

  it("persists the entire multi-volume intent before granting write permission", async () => {
    const entered = deferred(), finish = deferred(); let granted = false;
    const { manager, disk } = harness({ save: async records => { assert.equal(records.length, 1); entered.resolve(); await finish.promise; },
      probe: async root => fact(10 * GiB, { volumeId: root === "scratch" ? "volume-b" : "volume-a" }) });
    await manager.open();
    const pending = manager.reserve({ ...request("first", 6 * GiB), demands: [{ rootId: "media", remainingBytes: 6 * GiB }, { rootId: "scratch", remainingBytes: 6 * GiB }] }).then(result => { granted = true; return result; });
    await entered.promise;
    assert.equal(granted, false); assert.equal(manager.snapshot().records.length, 0);
    finish.resolve(); assert.equal((await pending).status, "reserved");
    assert.equal((disk() as { records: StorageReservation[] }).records[0]!.demands.length, 2);
    await manager.stop();
  });

  it("acquires no partial reservation when one destination cannot fit", async () => {
    let saves = 0;
    const { manager } = harness({ save: async () => { saves++; }, probe: async root => fact(root === "scratch" ? 2 * GiB : 100 * GiB, { volumeId: root === "scratch" ? "volume-b" : "volume-a" }) });
    await manager.open();
    const result = await manager.reserve({ ...request("first", GiB), demands: [{ rootId: "media", remainingBytes: 50 * GiB }, { rootId: "scratch", remainingBytes: 2 * GiB }] });
    assert.equal(result.status, "held"); assert.equal(saves, 0); assert.deepEqual(manager.snapshot().records, []);
    await manager.stop();
  });

  it("aggregates an operation's archive, extraction and copy peaks on a shared volume", async () => {
    const { manager } = harness(); await manager.open();
    const result = await manager.reserve({ ...request("install", GiB), demands: [
      { rootId: "downloads", remainingBytes: 3 * GiB }, { rootId: "extract", remainingBytes: 4 * GiB }, { rootId: "install", remainingBytes: 4 * GiB },
    ] });
    assert.equal(result.status, "held");
    assert(result.status === "held" && result.admission?.status === "held");
    assert.equal(result.admission.peakBytes, 11 * GiB);
    await manager.stop();
  });

  it("uses the lowest effective quota reading and preserves stricter margins", async () => {
    const { manager } = harness({ probe: async root => fact(root === "restricted" ? 3 * GiB : 20 * GiB) }); await manager.open();
    assert.equal((await manager.reserve(request("first", GiB, "restricted"))).status, "reserved");
    assert.equal((await manager.reserve(request("second", 2 * GiB))).status, "held");
    assert.equal(await manager.settle("first", owner), true);
    assert.equal((await manager.reserve({ ...request("third", GiB), demands: [{ rootId: "media", remainingBytes: GiB, reserveBytes: 18 * GiB }] })).status, "reserved");
    assert.equal((await manager.reserve(request("fourth", 2 * GiB))).status, "held");
    await manager.stop();
  });

  it("does not count written bytes twice and rechecks growth without counting the old plan twice", async () => {
    let available = 10 * GiB, now = 600_000;
    const { manager } = harness({ now: () => now, probe: async (_root, _signal, after) => { if (after !== undefined) now = Math.max(now, after + 1); return fact(available, { measuredAt: now }); } }); await manager.open();
    assert.equal((await manager.reserve(request("first", 6 * GiB))).status, "reserved");
    available = 6 * GiB;
    assert.equal(await manager.reduce("first", owner, { media: 2 * GiB }), true);
    now++;
    assert.equal((await manager.reserve(request("second", 3 * GiB))).status, "reserved");
    assert.equal(await manager.settle("second", owner), true);
    assert.equal((await manager.replan(request("first", 5 * GiB))).status, "reserved");
    assert.equal((await manager.replan(request("first", 6 * GiB))).status, "held");
    assert.equal(manager.snapshot().records[0]!.demands[0]!.remainingBytes, 5 * GiB);
    assert.equal(await manager.reduce("first", owner, { media: 6 * GiB }), false);
    assert.equal(await manager.reduce("first", { ...owner, id: "wrong-owner" }, { media: 0 }), false);
    assert.equal(await manager.reduce("first", owner, { not_a_root: 0 }), false);
    await manager.stop();
  });

  it("requires owner reconciliation after restart and does not release unknown work", async () => {
    const initial = harness(); await initial.manager.open();
    assert.equal((await initial.manager.reserve(request("first", 6 * GiB))).status, "reserved"); await initial.manager.stop();
    const restored = harness({ load: initial.disk(), probe: async root => fact(20 * GiB, { volumeId: root === "independent" ? "volume-b" : "volume-a" }) });
    await restored.manager.open();
    assert.equal(restored.manager.snapshot().records[0]!.state, "uncertain");
    assert.deepEqual(await restored.manager.reserve(request("second", GiB)), { status: "held", reason: "reconciliation-required", volumeId: "volume-a" });
    assert.equal((await restored.manager.reserve(request("third", GiB, "independent"))).status, "reserved");
    assert.equal((await restored.manager.replan(request("first", GiB))).status, "held");
    assert.equal(await restored.manager.settle("first", { ...owner, kind: "export" }), false);
    assert.equal(await restored.manager.settle("first", owner), true);
    assert.equal((await restored.manager.reserve(request("second", GiB))).status, "reserved");
    await restored.manager.stop();
  });

  it("does not convert failed persistence or corrupt control state into permission", async () => {
    for (const load of [{ version: 99, records: [] }, { version: 1, records: [{}] }, null, "torn-json"]) {
      const { manager } = harness({ load }); await manager.open();
      assert.deepEqual(await manager.reserve(request("first", GiB)), { status: "held", reason: "audit-unavailable" });
      await manager.stop();
    }
    const { manager } = harness({ save: async () => { throw Object.assign(new Error("full"), { code: "ENOSPC" }); } });
    await manager.open();
    assert.deepEqual(await manager.reserve(request("first", GiB)), { status: "held", reason: "audit-unavailable" });
    assert.equal(manager.snapshot().records[0]!.state, "uncertain");
    assert.deepEqual(await manager.reserve(request("second", GiB)), { status: "held", reason: "audit-unavailable" });
    assert.equal(await manager.settle("first", owner), false);
    await manager.stop();
  });

  it("refuses stale, unavailable, unbounded and changed mappings", async () => {
    for (const probe of [async () => null, async () => fact(10 * GiB, { measuredAt: 594_999 }), async () => fact(10 * GiB, { availableBytes: null }), async () => { throw new Error("probe failed"); }]) {
      const { manager } = harness({ probe }); await manager.open();
      assert.equal((await manager.reserve(request("first", GiB))).status, "held");
      await manager.stop();
    }
    let revision = "mount-a";
    const { manager } = harness({ probe: async () => fact(10 * GiB, { mappingRevision: revision }) }); await manager.open();
    assert.equal((await manager.reserve(request("unbounded", null))).status, "held");
    assert.equal((await manager.reserve(request("first", GiB))).status, "reserved");
    revision = "mount-b";
    assert.deepEqual(await manager.reserve(request("second", GiB)), { status: "held", reason: "reconciliation-required" });
    assert.equal(manager.snapshot().records[0]!.state, "uncertain");
    await manager.stop();
  });

  it("closes admission, cancels probes and drains before shutdown", async () => {
    const entered = deferred(); let aborted = false;
    const { manager } = harness({ probe: async (_root, signal) => new Promise(resolve => {
      entered.resolve(); signal.addEventListener("abort", () => { aborted = true; resolve(null); }, { once: true });
    }) });
    await manager.open();
    const pending = manager.reserve(request("first", GiB)); await entered.promise;
    await manager.stop();
    assert(aborted); assert.deepEqual(await pending, { status: "held", reason: "stopped" });
    assert.deepEqual(await manager.reserve(request("second", GiB)), { status: "held", reason: "stopped" });
  });

  it("does not grant a late reservation when shutdown races a durable intent", async () => {
    const entered = deferred(), finish = deferred();
    const { manager } = harness({ save: async () => { entered.resolve(); await finish.promise; } }); await manager.open();
    const pending = manager.reserve(request("first", GiB)); await entered.promise;
    const stopping = manager.stop(); finish.resolve(); await stopping;
    assert.deepEqual(await pending, { status: "held", reason: "stopped" });
    assert.equal(manager.snapshot().records[0]!.state, "uncertain");
  });

  it("bounds collection concurrency and ignores a broken presentation subscriber", async () => {
    let active = 0, maximum = 0;
    const { manager } = harness({ onChange: () => { throw new Error("broken view"); }, probe: async () => {
      active++; maximum = Math.max(maximum, active); await new Promise(resolve => setImmediate(resolve)); active--; return fact(100 * GiB);
    } });
    await manager.open();
    assert.equal((await manager.reserve({ ...request("first", GiB), demands: Array.from({ length: 16 }, (_, i) => ({ rootId: `root-${i}`, remainingBytes: GiB })) })).status, "reserved");
    assert(maximum <= 4); assert(manager.snapshot().auditAvailable);
    await manager.stop();
  });

  it("retains the intent as uncertain if its save outlives measurement freshness", async () => {
    let now = 600_000;
    const { manager } = harness({ now: () => now, save: async () => { now += 5_001; } }); await manager.open();
    assert.deepEqual(await manager.reserve(request("first", GiB)), { status: "held", reason: "capacity", admission: { status: "unknown", reason: "capacity-stale" } });
    assert.equal(manager.snapshot().records[0]!.state, "uncertain"); await manager.stop();
  });

  it("keeps consumed bytes charged against a cached reading after progress releases remaining need", async () => {
    let now = 600_000, cached = fact();
    const { manager } = harness({ now: () => now, probe: async () => cached }); await manager.open();
    assert.equal((await manager.reserve(request("first", 6 * GiB))).status, "reserved");
    now += 100; assert.equal(await manager.reduce("first", owner, { media: GiB }), true);
    const blocked = await manager.reserve(request("second", 6 * GiB));
    assert.equal(blocked.status, "held");
    assert(blocked.status === "held" && blocked.admission?.status === "held");
    assert.equal(blocked.admission.reservedBytes, 6 * GiB, "one remaining plus five written since measurement");
    now++; cached = fact(5 * GiB, { measuredAt: now });
    assert.equal((await manager.reserve(request("second", 6 * GiB))).status, "held");
    assert.equal((await manager.reserve(request("third", 3 * GiB))).status, "reserved", "fresh capacity already includes the written bytes");
    await manager.stop();
  });

  it("persists settlement accounting for cached aliases even when no reservation remains", async () => {
    let now = 600_000, cached = fact();
    const initial = harness({ now: () => now, probe: async () => cached }); await initial.manager.open();
    assert.equal((await initial.manager.reserve(request("first", 6 * GiB))).status, "reserved");
    now += 100; assert.equal(await initial.manager.settle("first", owner), true); await initial.manager.stop();
    const restored = harness({ now: () => now, load: initial.disk(), probe: async () => cached }); await restored.manager.open();
    assert.equal(restored.manager.snapshot().records.length, 0);
    assert.equal((await restored.manager.reserve(request("second", 6 * GiB, "alias"))).status, "held");
    now++; cached = fact(4 * GiB, { measuredAt: now });
    assert.equal((await restored.manager.reserve(request("third", 3 * GiB, "alias"))).status, "reserved");
    now += 5_001;
    assert.deepEqual(restored.manager.snapshot().consumed, []);
    assert.equal((await restored.manager.reserve(request("fourth", GiB))).status, "held", "expired accounting does not make the stale reading valid");
    await restored.manager.stop();
  });

  it("requires a post-report measurement when a changed estimate can hide prior writes", async () => {
    let now = 600_000, cached = fact(), honorAfter = false;
    const { manager } = harness({ now: () => now, probe: async (_root, _signal, after) => {
      if (honorAfter && after !== undefined) { now = after + 1; cached = fact(8 * GiB, { measuredAt: now }); }
      return cached;
    } }); await manager.open();
    assert.equal((await manager.reserve(request("first", 6 * GiB))).status, "reserved");
    now += 100;
    assert.equal((await manager.replan(request("first", 8 * GiB))).status, "held");
    assert.equal(manager.snapshot().records[0]!.demands[0]!.remainingBytes, 6 * GiB);
    honorAfter = true;
    assert.equal((await manager.replan(request("first", 8 * GiB))).status, "held", "actual free space is now eight and still needs a reserve");
    assert.equal((await manager.replan(request("first", GiB))).status, "reserved");
    await manager.stop();
  });
});

describe("bounded storage reservation file", () => {
  it("classifies control failures without retaining raw paths or native error messages", async () => {
    for (const [code, reason] of [["EACCES", "permission"], ["EPERM", "permission"], ["ENOSPC", "disk-full"], ["EDQUOT", "disk-full"], ["EIO", "read-failed"]]) {
      const manager = new StorageReservations({ store: { load: async () => { throw Object.assign(new Error("private/path"), { code }); }, save: async () => {} }, probe: async () => fact() });
      await manager.open(); assert.equal(manager.snapshot().auditFailure, reason); await manager.stop();
    }
    const { manager } = harness({ save: async () => { throw Object.assign(new Error("private/path"), { code: "ENOSPC" }); } });
    await manager.open(); await manager.reserve(request("first", GiB));
    assert.equal(manager.snapshot().auditFailure, "disk-full"); assert.equal(manager.snapshot().auditAvailable, false); await manager.stop();
  });

  it("persists and restores a flushed snapshot separately from world records", async () => {
    const path = join(await tempDir("arke-storage-reservations-"), "reservations.json");
    const store = new FileStorageReservationStore(path);
    const manager = new StorageReservations({ store, now: () => 600_000, probe: async () => fact() });
    await manager.open(); assert.equal((await manager.reserve(request("first", GiB))).status, "reserved"); await manager.stop();
    const restored = new StorageReservations({ store, now: () => 600_000, probe: async () => fact() });
    await restored.open(); assert.equal(restored.snapshot().records[0]!.state, "uncertain");
    assert.equal(await restored.settle("first", owner), true); await restored.stop();
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { version: 2, records: [], consumed: [{ volumeId: "volume-a", bytes: GiB, at: 600_000 }] });
  });

  it("treats oversized, torn and duplicate files as unknown without clearing them", async () => {
    const path = join(await tempDir("arke-storage-reservations-invalid-"), "reservations.json");
    const store = new FileStorageReservationStore(path);
    const duplicate = { id: "first", owner, state: "active", demands: [{ rootId: "media", volumeId: "volume-a", mappingRevision: "mount-a", remainingBytes: GiB, reserveBytes: GiB }] };
    for (const raw of ["{", "null", " ".repeat(1024 * 1024 + 1), JSON.stringify({ version: 1, records: [duplicate, duplicate] })]) {
      await writeFile(path, raw);
      const manager = new StorageReservations({ store, now: () => 600_000, probe: async () => fact() }); await manager.open();
      assert.equal(manager.snapshot().auditAvailable, false);
      assert.deepEqual(await manager.reserve(request("first", GiB)), { status: "held", reason: "audit-unavailable" });
      assert.equal(await readFile(path, "utf8"), raw); await manager.stop();
    }
  });
});
