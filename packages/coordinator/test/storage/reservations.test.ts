import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { join } from "node:path";
import { writeFile, readFile } from "node:fs/promises";
import type { StorageCapacity } from "@arke-studio/contracts";
import { StorageReservations, type StorageReservation, type StorageReservationRequest, type StorageReservationStore } from "../../src/storage/reservations.js";
import { FileStorageReservationStore } from "../../src/storage/reservation-file.js";
import { tempDir } from "../tmp.js";

const GiB = 1024 ** 3;
const owner = { kind: "job" as const, id: "job-a" };
const fact = (availableBytes = 10 * GiB, extra: Partial<StorageCapacity> = {}): StorageCapacity => ({
  volumeId: "volume-a", mappingRevision: "mount-a", measuredAt: 600_000, availableBytes, totalBytes: 500 * GiB, ...extra,
});
const request = (id: string, remainingBytes: number | null, rootId = "media"): StorageReservationRequest => ({ id, owner, demands: [{ rootId, remainingBytes }] });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function harness(options: { load?: unknown; save?: (records: readonly StorageReservation[]) => Promise<void>; probe?: (root: string, signal: AbortSignal) => Promise<StorageCapacity | null>; onChange?: () => void } = {}) {
  let disk: unknown = Object.hasOwn(options, "load") ? options.load : { version: 1, records: [] };
  const store: StorageReservationStore = {
    load: async () => structuredClone(disk),
    save: async records => { await options.save?.(records); disk = structuredClone({ version: 1, records }); },
  };
  const manager = new StorageReservations({ store, now: () => 600_000, probe: options.probe ?? (async () => fact()), onChange: options.onChange });
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
    let available = 10 * GiB;
    const { manager } = harness({ probe: async () => fact(available) }); await manager.open();
    assert.equal((await manager.reserve(request("first", 6 * GiB))).status, "reserved");
    available = 6 * GiB;
    assert.equal(await manager.reduce("first", owner, { media: 2 * GiB }), true);
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
});

describe("bounded storage reservation file", () => {
  it("persists and restores a flushed snapshot separately from world records", async () => {
    const path = join(await tempDir("arke-storage-reservations-"), "reservations.json");
    const store = new FileStorageReservationStore(path);
    const manager = new StorageReservations({ store, now: () => 600_000, probe: async () => fact() });
    await manager.open(); assert.equal((await manager.reserve(request("first", GiB))).status, "reserved"); await manager.stop();
    const restored = new StorageReservations({ store, now: () => 600_000, probe: async () => fact() });
    await restored.open(); assert.equal(restored.snapshot().records[0]!.state, "uncertain");
    assert.equal(await restored.settle("first", owner), true); await restored.stop();
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { version: 1, records: [] });
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
