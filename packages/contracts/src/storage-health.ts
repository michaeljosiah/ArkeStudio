import { z } from "zod";

/** SPEC-062: facts identify real volumes, never drive letters or a sum across destinations. */
const bytes = z.number().int().nonnegative().safe();
const instant = z.number().int().nonnegative().safe();
const identity = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
export const StorageCapacitySchema = z.object({
  volumeId: identity,
  mappingRevision: identity,
  measuredAt: instant,
  /** Space available to this process, including any measured quota restriction. */
  availableBytes: bytes.nullable(),
  totalBytes: bytes.nullable(),
}).strict();
export type StorageCapacity = z.infer<typeof StorageCapacitySchema>;

export const STORAGE_POLICY = {
  revision: "storage-v1",
  reserveBytes: 1024 ** 3,
  admissionMaxAgeMs: 5_000,
  forecastMaxAgeMs: 60_000,
  forecastWindowMs: 15 * 60_000,
  forecastMinSpanMs: 5 * 60_000,
  forecastMaxGapMs: 90_000,
  forecastMinLossBytes: 512 * 1024 ** 2,
  forecastWarningMs: 30 * 60_000,
  clearMarginBytes: 1024 ** 3,
  clearSampleGapMs: 30_000,
} as const;

/** Product defaults, not a completion guarantee or an inferred hardware fit (R-6). */
export function storageWarningFloor(totalBytes: number | null): number {
  if (totalBytes !== null) bytes.parse(totalBytes);
  return Math.max(5 * 1024 ** 3, Math.min(10 * 1024 ** 3, (totalBytes ?? 0) * 0.02));
}

const fresh = (sample: StorageCapacity, now: number, maxAge: number) =>
  sample.measuredAt <= now && now - sample.measuredAt <= maxAge;
const sameVolume = (a: Pick<StorageCapacity, "volumeId" | "mappingRevision">, b: Pick<StorageCapacity, "volumeId" | "mappingRevision">) =>
  a.volumeId === b.volumeId && a.mappingRevision === b.mappingRevision;

export type StorageAdmission =
  | { status: "unknown"; reason: "capacity-unavailable" | "capacity-stale" | "mapping-changed" | "unbounded-output" }
  | { status: "fits" | "held"; availableBytes: number; reservedBytes: number; peakBytes: number; reserveBytes: number; deficitBytes: number };

/** Caller serializes reservation creation with this decision; written bytes are not remaining writes. */
export function evaluateStorageAdmission(input: {
  capacity: StorageCapacity;
  volumeId: string;
  mappingRevision: string;
  reservedBytes: number;
  remainingPeakBytes: number | null;
  now: number;
  /** An operation may retain its stricter existing margin, but cannot lower the shared reserve. */
  reserveBytes?: number;
}): StorageAdmission {
  const capacity = StorageCapacitySchema.parse(input.capacity);
  instant.parse(input.now); bytes.parse(input.reservedBytes);
  if (input.remainingPeakBytes !== null) bytes.parse(input.remainingPeakBytes);
  const reserveBytes = Math.max(STORAGE_POLICY.reserveBytes, bytes.parse(input.reserveBytes ?? STORAGE_POLICY.reserveBytes));
  if (capacity.volumeId !== input.volumeId || capacity.mappingRevision !== input.mappingRevision) return { status: "unknown", reason: "mapping-changed" };
  if (!fresh(capacity, input.now, STORAGE_POLICY.admissionMaxAgeMs)) return { status: "unknown", reason: "capacity-stale" };
  if (capacity.availableBytes === null) return { status: "unknown", reason: "capacity-unavailable" };
  if (input.remainingPeakBytes === null) return { status: "unknown", reason: "unbounded-output" };
  const required = bytes.parse(input.reservedBytes + input.remainingPeakBytes + reserveBytes);
  const deficitBytes = Math.max(0, required - capacity.availableBytes);
  return {
    status: deficitBytes > 0 || capacity.availableBytes <= STORAGE_POLICY.reserveBytes ? "held" : "fits",
    availableBytes: capacity.availableBytes, reservedBytes: input.reservedBytes,
    peakBytes: input.remainingPeakBytes, reserveBytes, deficitBytes,
  };
}

export interface StorageForecast {
  method: "median-positive-consumption";
  from: number;
  to: number;
  netLossBytes: number;
  bytesPerMs: number;
  timeToReserveMs: number;
  warning: boolean;
}

/** Volume-wide observed usage: never attribution to Arke or an exact failure deadline (R-12). */
export function forecastStorage(samples: readonly StorageCapacity[], now: number): StorageForecast | null {
  instant.parse(now);
  const last = samples.at(-1);
  if (!last || last.availableBytes === null || !fresh(last, now, STORAGE_POLICY.forecastMaxAgeMs)) return null;
  const window: StorageCapacity[] = [];
  // A remount, unavailable reading, wake gap or time reversal ends the usable contiguous window.
  for (let i = samples.length - 1; i >= 0; i--) {
    const sample = StorageCapacitySchema.parse(samples[i]);
    const next = window.at(-1);
    if (!sameVolume(sample, last) || sample.availableBytes === null || now - sample.measuredAt > STORAGE_POLICY.forecastWindowMs ||
        next && (next.measuredAt <= sample.measuredAt || next.measuredAt - sample.measuredAt > STORAGE_POLICY.forecastMaxGapMs)) break;
    window.push(sample);
  }
  window.reverse();
  const first = window[0];
  if (!first || window.length < 7 || last.measuredAt - first.measuredAt < STORAGE_POLICY.forecastMinSpanMs) return null;
  const netLossBytes = first.availableBytes! - last.availableBytes;
  if (netLossBytes < STORAGE_POLICY.forecastMinLossBytes) return null;
  const rates: number[] = [];
  for (let i = 1; i < window.length; i++) {
    const a = window[i - 1]!, b = window[i]!;
    if (a.availableBytes! > b.availableBytes!) rates.push((a.availableBytes! - b.availableBytes!) / (b.measuredAt - a.measuredAt));
  }
  if (rates.length < 4) return null;
  rates.sort((a, b) => a - b);
  const middle = Math.floor(rates.length / 2);
  const bytesPerMs = rates.length % 2 ? rates[middle]! : (rates[middle - 1]! + rates[middle]!) / 2;
  const timeToReserveMs = Math.max(0, (last.availableBytes - STORAGE_POLICY.reserveBytes) / bytesPerMs);
  return { method: "median-positive-consumption", from: first.measuredAt, to: last.measuredAt,
    netLossBytes, bytesPerMs, timeToReserveMs, warning: timeToReserveMs <= STORAGE_POLICY.forecastWarningMs };
}

export interface StoragePressure {
  volumeId: string;
  mappingRevision: string;
  warning: boolean;
  critical: boolean;
  warningClearSince: number | null;
  criticalClearSince: number | null;
  lastMeasuredAt: number;
}

export const StorageRootRoleSchema = z.enum(["local-ai", "generated-media", "working-files", "downloads", "exports"]);
export type StorageRootRole = z.infer<typeof StorageRootRoleSchema>;
export const StorageProbeSourceSchema = z.enum(["windows-volume-api", "linux-mountinfo", "darwin-volume-api", "host-provided"]);
export type StorageProbeSource = z.infer<typeof StorageProbeSourceSchema>;
export const StorageLimitationSchema = z.enum(["quota-unavailable", "total-unavailable", "permission-denied", "unsupported-filesystem", "probe-failed", "cancelled"]);
export type StorageLimitation = z.infer<typeof StorageLimitationSchema>;
export const StoragePressureSchema = z.object({
  volumeId: identity, mappingRevision: identity, warning: z.boolean(), critical: z.boolean(),
  warningClearSince: instant.nullable(), criticalClearSince: instant.nullable(), lastMeasuredAt: instant,
}).strict();
export const StorageForecastSchema = z.object({
  method: z.literal("median-positive-consumption"), from: instant, to: instant, netLossBytes: bytes,
  bytesPerMs: z.number().finite().positive(), timeToReserveMs: z.number().finite().nonnegative(), warning: z.boolean(),
}).strict();
export const StorageRootHealthSchema = z.object({
  rootId: identity, role: StorageRootRoleSchema, state: z.enum(["unmeasured", "measured", "stale", "unavailable", "unsupported"]),
  capacity: StorageCapacitySchema.nullable(), source: StorageProbeSourceSchema, limitations: z.array(StorageLimitationSchema).max(5),
  pressure: StoragePressureSchema.nullable(), forecast: StorageForecastSchema.nullable(),
}).strict();
export type StorageRootHealth = z.infer<typeof StorageRootHealthSchema>;
export const StorageHealthSnapshotSchema = z.object({ at: instant, writing: z.boolean(), roots: z.array(StorageRootHealthSchema).max(128), limited: z.boolean().optional(),
  admission: z.object({ state: z.enum(["starting", "available", "reconciling", "unavailable"]), reservations: z.number().int().min(0).max(2048), uncertain: z.number().int().min(0).max(2048),
    reason: z.enum(["invalid", "permission", "disk-full", "read-failed", "write-failed"]).optional(),
  }).strict().optional(),
}).strict();
export type StorageHealthSnapshot = z.infer<typeof StorageHealthSnapshotSchema>;

/** Presentation hysteresis never replaces each operation's fresh admission check (R-14).
 * Null means unknown now; the collector retains the preceding latch rather than declaring recovery. */
export function advanceStoragePressure(previous: StoragePressure | null, sample: StorageCapacity, now: number, predictiveWarning: boolean): StoragePressure | null {
  StorageCapacitySchema.parse(sample); instant.parse(now);
  if (sample.availableBytes === null || !fresh(sample, now, STORAGE_POLICY.forecastMaxAgeMs)) return null;
  // Concurrent probes may finish in a different order. An older observation cannot resolve a
  // newer fault or contribute an earlier clear qualification; only a changed mapping starts afresh.
  if (previous && sameVolume(previous, sample) && sample.measuredAt < previous.lastMeasuredAt && previous.lastMeasuredAt <= now) return previous;
  let prior = previous && sameVolume(previous, sample) ? previous : null;
  // A wall-clock reversal preserves fault latches but starts clear qualification again.
  if (prior && prior.lastMeasuredAt > now) prior = { ...prior, warningClearSince: null, criticalClearSince: null };
  const advance = (held: boolean, since: number | null, low: boolean, clear: boolean): [boolean, number | null] => {
    if (low) return [true, null];
    if (!held) return [false, null];
    if (!clear) return [true, null];
    if (since === null) return [true, sample.measuredAt];
    return sample.measuredAt - since >= STORAGE_POLICY.clearSampleGapMs ? [false, null] : [true, since];
  };
  const floor = storageWarningFloor(sample.totalBytes);
  const [warning, warningClearSince] = advance(prior?.warning ?? false, prior?.warningClearSince ?? null,
    sample.availableBytes < floor || predictiveWarning, sample.availableBytes > floor + STORAGE_POLICY.clearMarginBytes && !predictiveWarning);
  const [critical, criticalClearSince] = advance(prior?.critical ?? false, prior?.criticalClearSince ?? null,
    sample.availableBytes <= STORAGE_POLICY.reserveBytes, sample.availableBytes > STORAGE_POLICY.reserveBytes + STORAGE_POLICY.clearMarginBytes);
  return { volumeId: sample.volumeId, mappingRevision: sample.mappingRevision, warning, critical,
    warningClearSince, criticalClearSince, lastMeasuredAt: sample.measuredAt };
}
