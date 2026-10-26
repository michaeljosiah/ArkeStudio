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
export const StorageReservationFileSchema = z.object({ version: z.literal(1), records: z.array(StorageReservationSchema).max(2048) }).strict()
  .refine(value => new Set(value.records.map(r => r.id)).size === value.records.length, "Repeated storage reservation");

export interface StorageReservationStore {
  load(): Promise<unknown>;
  /** Resolves only after the snapshot's file is flushed and replaced; failure has an unknown outcome. */
  save(records: readonly StorageReservation[]): Promise<void>;
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
  private opened = false;
  private auditAvailable = true;
  private closing = false;
  private closed = false;

  constructor(private readonly deps: {
    store: StorageReservationStore;
    /** Bounded, cancellable read of a registered host handle. Null means mapping unavailable. */
    probe(rootId: string, signal: AbortSignal): Promise<StorageCapacity | null>;
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
      } catch { this.auditAvailable = false; }
      this.opened = true;
      this.changed();
    });
  }

  snapshot(): { auditAvailable: boolean; records: StorageReservation[] } {
    return { auditAvailable: this.opened && this.auditAvailable, records: structuredClone([...this.records.values()]) };
  }

  private async persist(next: Map<string, StorageReservation>): Promise<boolean> {
    try {
      StorageReservationFileSchema.parse({ version: 1, records: [...next.values()] });
      await this.deps.store.save([...next.values()]);
      this.records = next;
      this.changed();
      return true;
    } catch {
      // Replacement may have reached disk. Keep the union in memory and disable further admission;
      // neither a rejected write nor a caller's retry establishes that the intent did not persist.
      for (const [id, record] of next) this.records.set(id, { ...record, state: "uncertain" });
      this.auditAvailable = false;
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
      const rootIds = new Set([...request.demands.map(d => d.rootId), ...[...this.records.values()].flatMap(r => r.demands.map(d => d.rootId))]);
      if (rootIds.size > 128) return { status: "held", reason: "reservation-limit" };
      const facts = new Map<string, StorageCapacity>();
      const roots = [...rootIds]; let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(4, roots.length) }, async () => {
        while (cursor < roots.length && !combined.aborted) {
          const rootId = roots[cursor++]!;
          try {
            const fact = await this.deps.probe(rootId, combined);
            if (fact) facts.set(rootId, StorageCapacitySchema.parse(fact));
          } catch { /* A failed collector is unavailable, not an assertion of fit. */ }
        }
      }));
      if (this.closing || combined.aborted) return { status: "held", reason: "stopped" };
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
        const sample = readings[0]!;
        // Different roots can have different quota limits. The lowest available reading wins.
        const capacity = { ...sample, measuredAt: Math.min(...readings.map(r => r.measuredAt)),
          availableBytes: readings.some(r => r.availableBytes === null) ? null : Math.min(...readings.map(r => r.availableBytes!)) };
        const admission = evaluateStorageAdmission({ capacity, volumeId, mappingRevision: capacity.mappingRevision,
          reservedBytes: bytes.parse(other.reduce((sum, d) => sum + d.remainingBytes, 0)),
          remainingPeakBytes: bytes.parse(own.reduce((sum, d) => sum + d.remainingBytes, 0)),
          reserveBytes: Math.max(...[...own, ...other].map(d => d.reserveBytes)), now: (this.deps.now ?? Date.now)() });
        if (admission.status !== "fits") return { status: "held", reason: "capacity", volumeId, admission };
      }
      const reservation: StorageReservation = { id: request.id, owner: request.owner, state: "active", demands };
      const next = new Map(this.records); next.set(reservation.id, reservation);
      if (!await this.persist(next)) return { status: "held", reason: "audit-unavailable" };
      if (this.closing || combined.aborted) {
        reservation.state = "uncertain";
        this.changed();
        return { status: "held", reason: "stopped" };
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
      return this.persist(next);
    });
  }

  /** Written bytes reduce future need; increasing a plan uses replan's fresh admission instead. */
  reduce(id: string, confirmedOwner: StorageReservation["owner"], remaining: Readonly<Record<string, number>>): Promise<boolean> {
    return this.serial(async () => {
      const record = this.records.get(id);
      if (this.closing || !this.auditAvailable || !record || record.state !== "active" || !sameOwner(record.owner, confirmedOwner)) return false;
      if (Object.keys(remaining).some(rootId => !record.demands.some(d => d.rootId === rootId))) return false;
      const updated = structuredClone(record);
      for (const d of updated.demands) {
        const value = Object.hasOwn(remaining, d.rootId) ? remaining[d.rootId] : undefined;
        if (value !== undefined) { bytes.parse(value); if (value > d.remainingBytes) return false; d.remainingBytes = value; }
      }
      const next = new Map(this.records); next.set(id, updated);
      return this.persist(next);
    });
  }

  closeAdmission(): void { this.closing = true; this.control.abort(); }
  async stop(): Promise<void> { this.closeAdmission(); await this.writes.drain(); this.closed = true; }
}
