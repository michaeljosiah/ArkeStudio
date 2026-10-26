import { z } from "zod";
import { evaluateStorageAdmission, StorageCapacitySchema, STORAGE_POLICY, type StorageAdmission, type StorageCapacity } from "@arke-studio/contracts";
import { WriteQueue } from "../change-log.js";

const key = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const bytes = z.number().int().nonnegative().safe();
const owner = z.object({ kind: z.enum(["setup", "job", "import", "export", "publication", "scratch"]), id: key }).strict();
const demand = z.object({ rootId: key, volumeId: key, mappingRevision: key, remainingBytes: bytes, reserveBytes: bytes }).strict();
export const StorageReservationSchema = z.object({
  id: key, owner, state: z.enum(["active", "uncertain"]), demands: z.array(demand).min(1).max(32),
}).strict().refine(value => new Set(value.demands.map(d => d.rootId)).size === value.demands.length, "Repeated storage root");
export type StorageReservation = z.infer<typeof StorageReservationSchema>;
const recordList = z.array(StorageReservationSchema).max(2048)
  .refine(value => new Set(value.map(r => r.id)).size === value.length, "Repeated storage reservation");
const consumptionSchema = z.object({ volumeId: key, bytes, at: z.number().int().nonnegative().safe() }).strict();
export type StorageConsumption = z.infer<typeof consumptionSchema>;
export type StorageAuditFailure = "invalid" | "permission" | "disk-full" | "read-failed" | "write-failed";
export const StorageReservationFileSchema = z.union([
  z.object({ version: z.literal(2), records: recordList, consumed: z.array(consumptionSchema).max(4096) }).strict(),
  z.object({ version: z.literal(1), records: recordList }).strict().transform(value => ({ ...value, version: 2 as const, consumed: [] as StorageConsumption[] })),
])
  .refine(value => new Set(value.records.map(r => r.id)).size === value.records.length, "Repeated storage reservation");

export interface StorageReservationStore {
  load(): Promise<unknown>;
  /** Resolves only after the snapshot's file is flushed and replaced; failure has an unknown outcome. */
  save(records: readonly StorageReservation[], consumed: readonly StorageConsumption[]): Promise<void>;
}

export type StorageReservationResult =
  | { status: "reserved"; reservation: StorageReservation }
  | { status: "held"; reason: "stopped" | "audit-unavailable" | "reconciliation-required" | "reservation-limit" | "capacity"; admission?: StorageAdmission; volumeId?: string };

const requestSchema = z.object({
  id: key, owner, demands: z.array(z.object({ rootId: key, remainingBytes: bytes.nullable(), reserveBytes: bytes.optional() }).strict()).min(1).max(32),
}).strict().refine(value => new Set(value.demands.map(d => d.rootId)).size === value.demands.length, "Repeated storage root");
export type StorageReservationRequest = z.infer<typeof requestSchema>;
const sameOwner = (a: StorageReservation["owner"], b: StorageReservation["owner"]) => a.kind === b.kind && a.id === b.id;

/** One host-local owner for SPEC-062 R-8/R-9/R-24. Callers are operation owners, never renderer paths.
 * The lane covers all volumes together so a multi-volume operation cannot partly acquire capacity.
 * This is planning, not OS allocation: writers still handle ENOSPC through their durable job owner. */
export class StorageReservations {
  private readonly writes = new WriteQueue();
  private readonly control = new AbortController();
  private records = new Map<string, StorageReservation>();
  private consumed: StorageConsumption[] = [];
  private opened = false;
  private auditAvailable = true;
  private auditFailure: StorageAuditFailure | undefined;
  private closing = false;
  private closed = false;

  constructor(private readonly deps: {
    store: StorageReservationStore;
    /** Bounded, cancellable read of a registered host handle. Null means mapping unavailable. */
    probe(rootId: string, signal: AbortSignal, after?: number): Promise<StorageCapacity | null>;
    now?: () => number;
    onChange?: () => void;
  }) {}

  private serial<T>(action: () => Promise<T>): Promise<T> {
    let result!: T;
    return this.writes.enqueue(async () => { result = await action(); }).then(() => result);
  }

  private changed(): void {
    try { this.deps.onChange?.(); } catch { /* A presentation subscriber cannot change durable authority. */ }
  }

  async open(): Promise<void> {
    return this.serial(async () => {
      if (this.opened || this.closing) return;
      try {
        const data = StorageReservationFileSchema.parse(await this.deps.store.load());
        // A saved active intent says nothing about what survived the previous host. No automatic release.
        this.records = new Map(data.records.map(record => [record.id, { ...record, state: "uncertain" }]));
        this.consumed = this.recent(data.consumed);
      } catch (error) { this.auditAvailable = false; this.auditFailure = this.failureKind(error, "read-failed"); }
      this.opened = true;
      this.changed();
    });
  }

  snapshot(): { auditAvailable: boolean; auditFailure?: StorageAuditFailure; records: StorageReservation[]; consumed: StorageConsumption[] } {
    return { auditAvailable: this.opened && this.auditAvailable, auditFailure: this.auditFailure, records: structuredClone([...this.records.values()]), consumed: structuredClone(this.recent(this.consumed)) };
  }

  private failureKind(error: unknown, fallback: "read-failed" | "write-failed"): StorageAuditFailure {
    if (error instanceof z.ZodError || error instanceof SyntaxError) return "invalid";
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    return code === "ENOSPC" || code === "EDQUOT" ? "disk-full" : code === "EACCES" || code === "EPERM" ? "permission" : fallback;
  }

  private now(): number { return (this.deps.now ?? Date.now)(); }
  private recent(entries: readonly StorageConsumption[]): StorageConsumption[] {
    // Any older reading is already outside admission's freshness window. Future markers remain
    // conservative if the wall clock moved backwards; they are never silently credited.
    const now = this.now();
    return entries.filter(entry => now - entry.at <= STORAGE_POLICY.admissionMaxAgeMs);
  }
  private charges(demands: readonly { volumeId: string; remainingBytes: number }[], at: number): StorageConsumption[] {
    return demands.filter(d => d.remainingBytes > 0).map(d => ({ volumeId: d.volumeId, bytes: d.remainingBytes, at }));
  }

  private async persist(next: Map<string, StorageReservation>, consumed = this.consumed): Promise<boolean> {
    consumed = this.recent(consumed);
    try {
      StorageReservationFileSchema.parse({ version: 2, records: [...next.values()], consumed });
      await this.deps.store.save([...next.values()], consumed);
      this.records = next;
      this.consumed = consumed;
      this.changed();
      return true;
    } catch (error) {
      // Replacement may have reached disk. Keep the union in memory and disable further admission;
      // neither a rejected write nor a caller's retry establishes that the intent did not persist.
      for (const [id, record] of next) this.records.set(id, { ...record, state: "uncertain" });
      this.consumed = consumed;
      this.auditAvailable = false;
      this.auditFailure = this.failureKind(error, "write-failed");
      this.changed();
      return false;
    }
  }

  reserve(request: StorageReservationRequest, signal?: AbortSignal): Promise<StorageReservationResult> {
    return this.admit(request, false, signal);
  }

  /** Recheck an owner's changed peak atomically, without reserving its old plan a second time. */
  replan(request: StorageReservationRequest, signal?: AbortSignal): Promise<StorageReservationResult> {
    return this.admit(request, true, signal);
  }

  private admit(request: StorageReservationRequest, replacing: boolean, signal?: AbortSignal): Promise<StorageReservationResult> {
    request = requestSchema.parse(request);
    return this.serial(async () => {
      if (this.closing || signal?.aborted) return { status: "held", reason: "stopped" };
      if (!this.opened || !this.auditAvailable) return { status: "held", reason: "audit-unavailable" };
      // Idempotent retries must not acquire twice or silently change an existing operation's plan.
      const previous = this.records.get(request.id);
      if (replacing ? !previous || previous.state !== "active" || !sameOwner(previous.owner, request.owner) : previous !== undefined) {
        return { status: "held", reason: "reconciliation-required" };
      }
      if (!replacing && this.records.size >= 2048) return { status: "held", reason: "reservation-limit" };
      const combined = signal ? AbortSignal.any([signal, this.control.signal]) : this.control.signal;
      const replanAfter = replacing ? this.now() : undefined;
      // A changed estimate can hide consumption even when the new peak grew. Replan therefore
      // requires a measurement after the owner fenced/reported its old phase, rather than
      // guessing how much was written from the difference between two estimates.
      const consumed = [...this.recent(this.consumed), ...(previous ? this.charges(previous.demands, replanAfter!) : [])];
      const rootIds = new Set([...request.demands.map(d => d.rootId), ...[...this.records.values()].flatMap(r => r.demands.map(d => d.rootId))]);
      if (rootIds.size > 128) return { status: "held", reason: "reservation-limit" };
      const facts = new Map<string, StorageCapacity>();
      const roots = [...rootIds]; let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(4, roots.length) }, async () => {
        while (cursor < roots.length && !combined.aborted) {
          const rootId = roots[cursor++]!;
          try {
            const fact = await this.deps.probe(rootId, combined, replanAfter);
            if (fact) facts.set(rootId, StorageCapacitySchema.parse(fact));
          } catch { /* A failed collector is unavailable, not an assertion of fit. */ }
        }
      }));
      if (this.closing || combined.aborted) return { status: "held", reason: "stopped" };
      if (replanAfter !== undefined && [...facts.values()].some(fact => fact.measuredAt <= replanAfter)) {
        return { status: "held", reason: "capacity", admission: { status: "unknown", reason: "capacity-stale" } };
      }
      // Revalidate every outstanding mapping before using its old volume for concurrent accounting.
      // If a mapping vanished, it could now share any destination; no new fit claim is justified.
      for (const record of this.records.values()) for (const d of record.demands) {
        const fact = facts.get(d.rootId);
        if (!fact || fact.volumeId !== d.volumeId || fact.mappingRevision !== d.mappingRevision) {
          record.state = "uncertain";
          this.changed();
          return { status: "held", reason: "reconciliation-required" };
        }
      }
      const demands: StorageReservation["demands"] = [];
      for (const d of request.demands) {
        const fact = facts.get(d.rootId);
        if (!fact) return { status: "held", reason: "capacity", admission: { status: "unknown", reason: "capacity-unavailable" } };
        if (d.remainingBytes === null) return { status: "held", reason: "capacity", volumeId: fact.volumeId, admission: { status: "unknown", reason: "unbounded-output" } };
        demands.push({ ...d, remainingBytes: d.remainingBytes, volumeId: fact.volumeId, mappingRevision: fact.mappingRevision,
          reserveBytes: Math.max(STORAGE_POLICY.reserveBytes, d.reserveBytes ?? STORAGE_POLICY.reserveBytes) });
      }
      for (const volumeId of new Set(demands.map(d => d.volumeId))) {
        const pending = [...this.records.values()].filter(r => (!replacing || r.id !== request.id) && r.demands.some(d => d.volumeId === volumeId));
        if (pending.some(r => r.state === "uncertain")) return { status: "held", reason: "reconciliation-required", volumeId };
        const own = demands.filter(d => d.volumeId === volumeId), other = pending.flatMap(r => r.demands.filter(d => d.volumeId === volumeId));
        const readings = [...own, ...other].map(d => facts.get(d.rootId)!);
        const now = this.now();
        if (readings.some(r => r.measuredAt > now || now - r.measuredAt > STORAGE_POLICY.admissionMaxAgeMs)) {
          return { status: "held", reason: "capacity", volumeId, admission: { status: "unknown", reason: "capacity-stale" } };
        }
        const adjusted = readings.map(reading => ({ reading, debit: bytes.parse(consumed.filter(entry => entry.volumeId === volumeId && entry.at >= reading.measuredAt).reduce((sum, entry) => sum + entry.bytes, 0)) }));
        adjusted.sort((a, b) => ((a.reading.availableBytes ?? 0) - a.debit) - ((b.reading.availableBytes ?? 0) - b.debit));
        const sample = adjusted[0]!;
        // Quotas differ by root. Compare usable capacity after accounting for writes newer than
        // each reading, while retaining the original measured available figure in the verdict.
        const capacity = { ...sample.reading, availableBytes: readings.some(r => r.availableBytes === null) ? null : sample.reading.availableBytes };
        const admission = evaluateStorageAdmission({ capacity, volumeId, mappingRevision: capacity.mappingRevision,
          reservedBytes: bytes.parse(other.reduce((sum, d) => sum + d.remainingBytes, sample.debit)),
          remainingPeakBytes: bytes.parse(own.reduce((sum, d) => sum + d.remainingBytes, 0)),
          reserveBytes: Math.max(...[...own, ...other].map(d => d.reserveBytes)), now });
        if (admission.status !== "fits") return { status: "held", reason: "capacity", volumeId, admission };
      }
      const reservation: StorageReservation = { id: request.id, owner: request.owner, state: "active", demands };
      const next = new Map(this.records); next.set(reservation.id, reservation);
      if (!await this.persist(next, consumed)) return { status: "held", reason: "audit-unavailable" };
      if (this.closing || combined.aborted) {
        reservation.state = "uncertain";
        this.changed();
        return { status: "held", reason: "stopped" };
      }
      const grantedAt = this.now();
      if ([...facts.values()].some(fact => fact.measuredAt > grantedAt || grantedAt - fact.measuredAt > STORAGE_POLICY.admissionMaxAgeMs)) {
        reservation.state = "uncertain"; this.changed();
        return { status: "held", reason: "capacity", admission: { status: "unknown", reason: "capacity-stale" } };
      }
      return { status: "reserved", reservation: structuredClone(reservation) };
    });
  }

  /** The owning operation confirms its write/cancellation/checkpoint has settled before release.
   * This removes space planning only; it is never a job/provider replay or completion receipt. */
  settle(id: string, confirmedOwner: StorageReservation["owner"]): Promise<boolean> {
    return this.serial(async () => {
      const record = this.records.get(id);
      if (this.closed || !record || !sameOwner(record.owner, confirmedOwner)) return false;
      const next = new Map(this.records); next.delete(id);
      if (!this.auditAvailable) return false;
      return this.persist(next, [...this.recent(this.consumed), ...this.charges(record.demands, this.now())]);
    });
  }

  /** Written bytes reduce future need; increasing a plan uses replan's fresh admission instead. */
  reduce(id: string, confirmedOwner: StorageReservation["owner"], remaining: Readonly<Record<string, number>>): Promise<boolean> {
    return this.serial(async () => {
      const record = this.records.get(id);
      if (this.closing || !this.auditAvailable || !record || record.state !== "active" || !sameOwner(record.owner, confirmedOwner)) return false;
      if (Object.keys(remaining).some(rootId => !record.demands.some(d => d.rootId === rootId))) return false;
      const updated = structuredClone(record);
      const released: Array<{ volumeId: string; remainingBytes: number }> = [];
      for (const d of updated.demands) {
        const value = Object.hasOwn(remaining, d.rootId) ? remaining[d.rootId] : undefined;
        if (value !== undefined) {
          bytes.parse(value); if (value > d.remainingBytes) return false;
          released.push({ volumeId: d.volumeId, remainingBytes: d.remainingBytes - value }); d.remainingBytes = value;
        }
      }
      const next = new Map(this.records); next.set(id, updated);
      return this.persist(next, [...this.recent(this.consumed), ...this.charges(released, this.now())]);
    });
  }

  closeAdmission(): void { this.closing = true; this.control.abort(); }
  async stop(): Promise<void> { this.closeAdmission(); await this.writes.drain(); this.closed = true; }
}
