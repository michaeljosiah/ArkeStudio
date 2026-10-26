import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { advanceStoragePressure, evaluateStorageAdmission, forecastStorage, STORAGE_POLICY, StorageCapacitySchema, storageWarningFloor, type StorageCapacity } from "../src/storage-health.js";

const GiB = 1024 ** 3;
const sample = (availableBytes: number | null, measuredAt = 600_000, extra: Partial<StorageCapacity> = {}): StorageCapacity => ({
  volumeId: "volume-a", mappingRevision: "mount-1", measuredAt, availableBytes, totalBytes: 500 * GiB, ...extra,
});
const admission = (capacity: StorageCapacity, remainingPeakBytes: number | null, reservedBytes = 0, now = 600_000) =>
  evaluateStorageAdmission({ capacity, remainingPeakBytes, reservedBytes, now, volumeId: "volume-a", mappingRevision: "mount-1" });

describe("storage policy (SPEC-062 R-5–R-14)", () => {
  it("uses bounded versioned warning and reserve defaults", () => {
    assert.equal(STORAGE_POLICY.reserveBytes, GiB);
    assert.equal(storageWarningFloor(null), 5 * GiB);
    assert.equal(storageWarningFloor(100 * GiB), 5 * GiB);
    assert.equal(storageWarningFloor(400 * GiB), 8 * GiB);
    assert.equal(storageWarningFloor(2_000 * GiB), 10 * GiB);
    assert.throws(() => storageWarningFloor(-1));
  });

  it("credits written bytes, includes other remaining reservations and keeps volumes separate", () => {
    assert.equal(admission(sample(10 * GiB), 6 * GiB, 3 * GiB).status, "fits");
    assert.deepEqual(admission(sample(10 * GiB), 7 * GiB, 3 * GiB), {
      status: "held", availableBytes: 10 * GiB, reservedBytes: 3 * GiB, peakBytes: 7 * GiB,
      reserveBytes: GiB, deficitBytes: GiB,
    });
    assert.equal(admission(sample(3 * GiB), GiB, GiB).status, "fits");
    assert.equal(admission(sample(3 * GiB), 2 * GiB, GiB).status, "held");
    assert.equal(admission(sample(100 * GiB, 600_000, { volumeId: "other-volume" }), GiB).status, "unknown");
  });

  it("holds the reserve boundary and cannot lower an existing operation's stricter margin", () => {
    assert.equal(admission(sample(GiB), 0).status, "held");
    assert.equal(admission(sample(GiB + 1), 1).status, "fits");
    const input = { capacity: sample(3 * GiB), volumeId: "volume-a", mappingRevision: "mount-1", now: 600_000, reservedBytes: 0, remainingPeakBytes: GiB };
    assert.equal(evaluateStorageAdmission({ ...input, reserveBytes: 3 * GiB }).status, "held");
    assert.equal(evaluateStorageAdmission({ ...input, capacity: sample(1.5 * GiB), reserveBytes: 0 }).status, "held");
  });

  it("does not turn missing, stale, remounted, future or unbounded measurements into fit", () => {
    assert.deepEqual(admission(sample(null), GiB), { status: "unknown", reason: "capacity-unavailable" });
    assert.deepEqual(admission(sample(10 * GiB, 594_999), GiB), { status: "unknown", reason: "capacity-stale" });
    assert.equal(admission(sample(10 * GiB, 595_000), GiB).status, "fits");
    assert.equal(admission(sample(10 * GiB, 600_001), GiB).status, "unknown");
    assert.deepEqual(admission(sample(10 * GiB, 600_000, { mappingRevision: "mount-2" }), GiB), { status: "unknown", reason: "mapping-changed" });
    assert.deepEqual(admission(sample(10 * GiB), null), { status: "unknown", reason: "unbounded-output" });
  });

  it("rejects invalid capacity and unsafe arithmetic instead of admitting overflow", () => {
    for (const available of [-1, NaN, Infinity, 0.1, Number.MAX_SAFE_INTEGER + 1]) assert.equal(StorageCapacitySchema.safeParse(sample(available)).success, false);
    assert.equal(StorageCapacitySchema.safeParse(sample(GiB, 0, { volumeId: "C:\\private\\world" })).success, false);
    assert.throws(() => admission(sample(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER));
    assert.throws(() => admission(sample(GiB), -1));
  });

  it("warns from six valid intervals before the static floor is reached", () => {
    const samples = Array.from({ length: 7 }, (_, i) => sample((25 - i) * GiB, i * 60_000));
    const forecast = forecastStorage(samples, 360_000)!;
    assert.equal(forecast.method, "median-positive-consumption");
    assert.equal(forecast.from, 0); assert.equal(forecast.to, 360_000);
    assert.equal(forecast.netLossBytes, 6 * GiB);
    assert.equal(forecast.timeToReserveMs, 18 * 60_000);
    assert.equal(forecast.warning, true);
    assert(19 * GiB > storageWarningFloor(500 * GiB));
    assert.equal(forecastStorage(samples.map(s => ({ ...s, availableBytes: s.availableBytes! + 20 * GiB })), 360_000)!.warning, false);
  });

  it("uses the median positive consumption rate without treating releases as consumption", () => {
    const values = [20, 19, 18, 19, 18, 17, 16];
    const forecast = forecastStorage(values.map((v, i) => sample(v * GiB, i * 60_000)), 360_000)!;
    assert.equal(forecast.bytesPerMs, GiB / 60_000);
    assert.equal(forecast.netLossBytes, 4 * GiB);
    assert.equal(forecast.timeToReserveMs, 15 * 60_000);
  });

  it("withholds ETA for insufficient, stale, interrupted or contradictory evidence", () => {
    const samples = Array.from({ length: 7 }, (_, i) => sample((25 - i) * GiB, i * 60_000));
    assert.equal(forecastStorage(samples.slice(1), 360_000), null);
    assert.equal(forecastStorage(samples, 420_001), null);
    assert.equal(forecastStorage(samples, 359_999), null);
    assert.equal(forecastStorage(samples.map(s => ({ ...s, measuredAt: s.measuredAt / 2 })), 180_000), null);
    assert.equal(forecastStorage(samples.map(s => ({ ...s, availableBytes: 25 * GiB })), 360_000), null);
    assert.equal(forecastStorage(samples.map((s, i) => ({ ...s, availableBytes: Math.round((25 - i / 100) * GiB) })), 360_000), null);
    for (const change of [{ availableBytes: null }, { mappingRevision: "mount-2" }, { volumeId: "other-volume" }, { measuredAt: 60_000 }]) {
      const interrupted = samples.map((s, i) => i === 3 ? { ...s, ...change } : s);
      assert.equal(forecastStorage(interrupted, 360_000), null);
    }
    const wake = samples.map(s => ({ ...s, measuredAt: s.measuredAt + (s.measuredAt >= 180_000 ? 180_000 : 0) }));
    assert.equal(forecastStorage(wake, 540_000), null);
    const burst = [25, 20, 21, 22, 23, 24, 19].map((v, i) => sample(v * GiB, i * 60_000));
    assert.equal(forecastStorage(burst, 360_000), null);
  });

  it("clears warning and critical holds only after separated high fresh readings", () => {
    let pressure = advanceStoragePressure(null, sample(GiB), 600_000, false)!;
    assert(pressure.warning && pressure.critical);
    pressure = advanceStoragePressure(pressure, sample(12 * GiB, 601_000), 601_000, false)!;
    assert(pressure.warning && pressure.critical);
    const duplicate = advanceStoragePressure(pressure, sample(12 * GiB, 601_000), 631_000, false)!;
    assert(duplicate.warning && duplicate.critical);
    pressure = advanceStoragePressure(pressure, sample(12 * GiB, 630_999), 630_999, false)!;
    assert(pressure.warning && pressure.critical);
    pressure = advanceStoragePressure(pressure, sample(12 * GiB, 631_000), 631_000, false)!;
    assert(!pressure.warning && !pressure.critical);
  });

  it("restarts clear qualification after low evidence and keeps predictive risk visible", () => {
    let pressure = advanceStoragePressure(null, sample(GiB), 600_000, false)!;
    pressure = advanceStoragePressure(pressure, sample(12 * GiB, 630_000), 630_000, false)!;
    pressure = advanceStoragePressure(pressure, sample(10.5 * GiB, 660_000), 660_000, false)!;
    assert(pressure.warning); assert(!pressure.critical); assert.equal(pressure.warningClearSince, null);
    pressure = advanceStoragePressure(pressure, sample(12 * GiB, 690_000), 690_000, true)!;
    assert(pressure.warning); assert.equal(pressure.warningClearSince, null);
    assert.equal(advanceStoragePressure(pressure, sample(null, 700_000), 700_000, false), null);
    assert.equal(advanceStoragePressure(pressure, sample(12 * GiB, 690_000), 750_001, false), null);
    const remount = advanceStoragePressure(pressure, sample(12 * GiB, 700_000, { mappingRevision: "mount-2" }), 700_000, false)!;
    assert.equal(remount.warning, false);
  });
});
