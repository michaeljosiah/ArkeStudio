import { randomBytes } from "node:crypto";
import { open } from "node:fs/promises";
import { z } from "zod";
import { resolve } from "node:path";
import { CACHE_MAINTENANCE_POLICY, RecoveryCacheMaintenanceRunSchema, type RecoveryCacheMaintenanceRun } from "@arke-studio/contracts";
import { WriteQueue } from "../change-log.js";
import { atomicWriteFile } from "../world/atomic.js";
import { WindowsCacheProofSchema, type WindowsCacheProof } from "./windows-cache-file.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/), instant = z.number().int().nonnegative().safe();
const pid = z.number().int().positive().safe(), ownerToken = randomBytes(32).toString("hex");
const maintenance = z.object({ enabled: z.boolean(), rootIdentity: digest, token: digest, policyRevision: z.literal(1),
  changedAt: instant, nextAttemptAt: instant, lastAttemptId: digest.optional(), lastRun: RecoveryCacheMaintenanceRunSchema.optional() }).strict();
const intent = z.object({ id: digest, planId: digest, key: digest, evidence: digest, rootIdentity: digest, fileIdentity: digest,
  at: instant, phase: z.enum(["intended", "unknown"]), proof: WindowsCacheProofSchema.optional(), automatic: z.boolean().optional(),
  owner: z.object({ pid, token: digest, gate: z.literal("native-input-v1") }).strict().optional(), workerPid: pid.optional(),
}).strict().refine(row => !row.proof || row.proof.rootIdentity === row.rootIdentity && row.proof.fileIdentity === row.fileIdentity);
const outcome = z.object({ planId: digest, key: digest, at: instant, status: z.enum(["removed", "retained", "not-started", "unknown"]), automatic: z.boolean().optional() }).strict();
export const CacheCleanupControlSchema = z.object({ version: z.literal(1), pending: intent.nullable(), outcomes: z.array(outcome).max(32), maintenance: maintenance.optional() }).strict();
type State = z.infer<typeof CacheCleanupControlSchema>;
type AuditFailure = "invalid" | "permission" | "disk-full" | "read-failed" | "write-failed";
export interface CacheCleanupStore { load(): Promise<unknown>; save(state: State): Promise<void> }
const CAP = 64 * 1024;
const fileOwners = new Map<string, CacheCleanupControl>();
class FileStore implements CacheCleanupStore {
  constructor(private readonly path: string) {}
  async load(): Promise<unknown> {
    let file;
    try { file = await open(this.path, "r"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, pending: null, outcomes: [] };
      throw error;
    }
    try {
      const buffer = Buffer.alloc(CAP + 1); let size = 0;
      while (size < buffer.length) { const row = await file.read(buffer, size, buffer.length - size, size); if (!row.bytesRead) break; size += row.bytesRead; }
      if (size > CAP) throw Error("Cleanup control exceeds its bound.");
      return JSON.parse(buffer.subarray(0, size).toString("utf8"));
    } finally { await file.close(); }
  }
  async save(state: State): Promise<void> {
    const text = JSON.stringify(CacheCleanupControlSchema.parse(state)) + "\n";
    if (Buffer.byteLength(text) > CAP) throw Error("Cleanup control exceeds its bound.");
    await atomicWriteFile(this.path, text);
  }
}

/** Minimal deletion authority, separate from removable incident history and creative records.
 * Unknown startup/save/native outcomes never authorize another deletion or automatic replay. */
export class CacheCleanupControl {
  private state: State = { version: 1, pending: null, outcomes: [] };
  private readonly queue = new WriteQueue();
  private readonly store: CacheCleanupStore;
  private opened: Promise<void> | null = null;
  private ready = false;
  private loaded = false;
  private audit = true;
  private failure: AuditFailure | undefined;
  private closing = false;
  private readonly waiters = new Set<() => void>();
  private operations = 0;
  private automaticInFlight: string | null = null;
  private maintenanceRevoked = false;
  private revocation = 0;
  private readonly ownershipKey: string | undefined;
  constructor(path: string, private readonly deps: { store?: CacheCleanupStore; now?: () => number; stopMs?: number; onChange?: () => void } = {}) {
    this.store = deps.store ?? new FileStore(path);
    this.ownershipKey = process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
  }
  private changed(): void { if (!this.closing) try { this.deps.onChange?.(); } catch { /* Presentation never grants deletion authority. */ } }
  private enqueue(work: () => Promise<void>): Promise<void> {
    this.operations++;
    return this.queue.enqueue(work).finally(() => { this.operations--; this.releaseOwnership(); });
  }
  private releaseOwnership(): void {
    if (this.ownershipKey && this.closing && this.quiescent() && fileOwners.get(this.ownershipKey) === this) fileOwners.delete(this.ownershipKey);
  }
  quiescent(): boolean { return this.operations === 0 && this.automaticInFlight === null; }
  maintenancePolicy(): z.infer<typeof maintenance> | null {
    return this.state.maintenance ? { ...structuredClone(this.state.maintenance), enabled: this.state.maintenance.enabled && !this.maintenanceRevoked } : null;
  }
  revokeMaintenance(): void { this.maintenanceRevoked = true; this.revocation++; this.changed(); }
  maintenanceCurrent(planId: string, token: string, rootIdentity: string): boolean {
    const policy = this.state.maintenance;
    return this.ready && this.audit && !this.closing && !this.maintenanceRevoked && this.automaticInFlight === planId && policy?.enabled === true &&
      policy.lastAttemptId === planId && policy.token === token && policy.rootIdentity === rootIdentity;
  }
  snapshot(): { available: boolean; protected: boolean; pending: boolean; key: string | null; outcomes: State["outcomes"]; audit: "starting" | "available" | "unavailable"; reason?: AuditFailure } {
    return { available: this.ready && this.audit && !this.closing && !this.state.pending,
      protected: !this.ready || !this.audit,
      audit: !this.audit ? "unavailable" : this.ready ? "available" : "starting", ...(this.failure ? { reason: this.failure } : {}),
      pending: this.state.pending !== null, key: this.state.pending?.key ?? null, outcomes: structuredClone(this.state.outcomes) };
  }
  pendingForReconciliation(): State["pending"] { return this.loaded && !this.closing ? structuredClone(this.state.pending) : null; }
  ownsPending(id: string): boolean { const row = this.state.pending; return row?.id === id && row.owner?.pid === process.pid && row.owner.token === ownerToken; }
  private classify(error: unknown, fallback: "read-failed" | "write-failed"): AuditFailure {
    if (error instanceof z.ZodError || error instanceof SyntaxError) return "invalid";
    const code = (error as NodeJS.ErrnoException)?.code;
    return code === "ENOSPC" || code === "EDQUOT" ? "disk-full" : code === "EACCES" || code === "EPERM" ? "permission" : fallback;
  }
  private async bounded<T>(work: Promise<T>, fallback: T, failure: "read-failed" | "write-failed" = "write-failed"): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined, stop!: () => void;
    const ending = new Promise<T>(resolve => {
      stop = () => { timer ??= setTimeout(() => { this.audit = false; this.failure ??= failure; if (this.state.pending) this.state.pending.phase = "unknown"; resolve(fallback); }, this.deps.stopMs ?? 2000); };
      this.waiters.add(stop); if (this.closing) stop();
    });
    try { return await Promise.race([work, ending]); } finally { if (timer) clearTimeout(timer); this.waiters.delete(stop); }
  }
  open(): Promise<void> {
    this.opened ??= this.bounded(this.enqueue(async () => {
      if (this.closing) return;
      try {
        if (this.ownershipKey) {
          const previous = fileOwners.get(this.ownershipKey);
          if (previous && previous !== this && (!previous.closing || !previous.quiescent())) throw Error("Cleanup control still has an owner.");
          fileOwners.set(this.ownershipKey, this);
        }
        this.state = CacheCleanupControlSchema.parse(await this.store.load());
        this.loaded = true;
        if (this.state.pending) { this.state.pending.phase = "unknown"; await this.store.save(this.state); }
        this.ready = !this.closing;
      } catch (error) { this.audit = false; this.failure = this.classify(error, "read-failed"); }
      this.changed();
    }), undefined, "read-failed");
    return this.opened;
  }
  private async persist(next: State): Promise<boolean> {
    try {
      if (this.ownershipKey && fileOwners.get(this.ownershipKey) !== this) throw Error("Cleanup control belongs to a different owner.");
      await this.store.save(CacheCleanupControlSchema.parse(next)); this.state = next; this.changed(); return true;
    }
    catch (error) { this.audit = false; this.failure = this.classify(error, "write-failed"); if (next.pending) this.state = next; if (this.state.pending) this.state.pending.phase = "unknown"; this.changed(); return false; }
  }
  async begin(planId: string, entry: { key: string; evidence: string; rootIdentity: string; fileIdentity: string; proof?: WindowsCacheProof; automatic?: boolean }, valid: () => boolean): Promise<string | null> {
    await this.open(); let id: string | null = null;
    await this.bounded(this.enqueue(async () => {
      if (!this.snapshot().available || !valid()) return;
      if (entry.automatic && (!entry.proof || !this.maintenanceCurrent(planId, this.state.maintenance?.token ?? "", entry.proof.nodeRootIdentity))) return;
      const now = (this.deps.now ?? Date.now)(); if (!Number.isSafeInteger(now) || now < 0) return;
      const pending = intent.parse({ ...entry, planId, id: randomBytes(32).toString("hex"), at: now, phase: "intended",
        ...(entry.proof ? { owner: { pid: process.pid, token: ownerToken, gate: "native-input-v1" } } : {}) });
      if (await this.persist({ ...this.state, pending })) {
        if (!this.closing && valid()) id = pending.id;
        else await this.persist({ ...this.state, pending: null,
          outcomes: [...this.state.outcomes, { planId, key: entry.key, at: now, status: "not-started" as const, ...(entry.automatic ? { automatic: true } : {}) }].slice(-32) });
      }
    }), undefined);
    return id;
  }
  /** The helper receives no native input until its exact PID is durably tied to this intent. */
  async admitWorker(id: string, workerPid: number, valid: () => boolean): Promise<boolean> {
    let admitted = false;
    await this.bounded(this.enqueue(async () => {
      const row = this.state.pending;
      if (!row || !this.ownsPending(id) || !row.proof || !this.audit || this.closing || !valid() || !pid.safeParse(workerPid).success || row.workerPid !== undefined) return;
      if (row.automatic && !this.maintenanceCurrent(row.planId, this.state.maintenance?.token ?? "", row.proof.nodeRootIdentity)) return;
      if (await this.persist({ ...this.state, pending: { ...row, workerPid } })) admitted = !this.closing && valid();
    }), undefined);
    return admitted;
  }
  /** Reconciliation changes metadata only after the owner proves all original work has ended. */
  async resolve(id: string, status: "removed" | "retained", valid: () => boolean): Promise<boolean> {
    let saved = false;
    await this.bounded(this.enqueue(async () => {
      const current = this.state.pending;
      if (!this.loaded || this.closing || current?.id !== id || !current.owner || !current.proof || !valid()) return;
      try {
        // A previously rejected atomic write may have installed either state. Never overwrite
        // a different intent or silently discard its minimum outcome records to recover audit.
        const disk = CacheCleanupControlSchema.parse(await this.store.load());
        if (disk.pending && (disk.pending.id !== id || ["planId", "key", "evidence", "rootIdentity", "fileIdentity", "proof", "owner"].some(field =>
          JSON.stringify(disk.pending![field as keyof typeof current]) !== JSON.stringify(current[field as keyof typeof current])) ||
          disk.pending.workerPid !== undefined && disk.pending.workerPid !== current.workerPid)) return;
        const at = (this.deps.now ?? Date.now)();
        if (!Number.isSafeInteger(at) || at < current.at || this.closing || !valid()) return;
        saved = await this.persist({ ...disk, pending: null,
          outcomes: [...disk.outcomes, { planId: current.planId, key: current.key, at, status, ...(current.automatic ? { automatic: true } : {}) }].slice(-32) });
        if (saved) { this.audit = true; this.ready = !this.closing; this.failure = undefined; this.changed(); }
      } catch (error) { this.audit = false; this.failure = this.classify(error, "read-failed"); this.changed(); }
    }), undefined);
    return saved;
  }
  async settle(id: string, status: "removed" | "not-started" | "unknown"): Promise<boolean> {
    let saved = false;
    await this.bounded(this.enqueue(async () => {
      const current = this.state.pending;
      if (!current || current.id !== id || !this.audit) return;
      const at = (this.deps.now ?? Date.now)();
      if (!Number.isSafeInteger(at) || at < current.at) return;
      const next = structuredClone(this.state);
      next.pending = status === "unknown" ? { ...current, phase: "unknown" } : null;
      next.outcomes = [...next.outcomes, { planId: current.planId, key: current.key, at, status, ...(current.automatic ? { automatic: true } : {}) }].slice(-32);
      saved = await this.persist(next);
    }), undefined);
    return saved;
  }
  async setMaintenance(enabled: boolean, rootIdentity: string | null, valid: () => boolean): Promise<boolean> {
    if (!enabled) this.revokeMaintenance();
    await this.open(); let saved = false; const revision = this.revocation;
    await this.bounded(this.enqueue(async () => {
      if (!this.ready || !this.audit || this.closing || !valid() || enabled && this.state.pending) return;
      const previous = this.state.maintenance, root = rootIdentity ?? previous?.rootIdentity;
      if (!root) { saved = !enabled; return; }
      const at = (this.deps.now ?? Date.now)(); if (!Number.isSafeInteger(at) || at < (previous?.changedAt ?? 0)) return;
      if (await this.persist({ ...this.state, maintenance: { ...previous, enabled, rootIdentity: root, token: randomBytes(32).toString("hex"),
        policyRevision: 1, changedAt: at, nextAttemptAt: previous?.nextAttemptAt ?? 0 } })) {
        saved = !this.closing && valid() && (!enabled || revision === this.revocation);
        if (saved && enabled) this.maintenanceRevoked = false;
        this.changed();
      }
    }), undefined);
    return saved;
  }
  async reserveMaintenance(planId: string, rootIdentity: string, valid: () => boolean): Promise<string | null> {
    let token: string | null = null;
    await this.bounded(this.enqueue(async () => {
      const policy = this.state.maintenance, now = (this.deps.now ?? Date.now)();
      if (!this.snapshot().available || this.automaticInFlight || !policy?.enabled || this.maintenanceRevoked || policy.rootIdentity !== rootIdentity ||
        !valid() || !Number.isSafeInteger(now) || now < policy.changedAt || now < policy.nextAttemptAt || !Number.isSafeInteger(now + CACHE_MAINTENANCE_POLICY.intervalMs)) return;
      if (await this.persist({ ...this.state, maintenance: { ...policy, lastAttemptId: planId, nextAttemptAt: now + CACHE_MAINTENANCE_POLICY.intervalMs } }) &&
        !this.closing && valid() && !this.maintenanceRevoked) { token = policy.token; this.automaticInFlight = planId; }
    }), undefined);
    return token;
  }
  async finishMaintenance(planId: string, run: Omit<RecoveryCacheMaintenanceRun, "at">): Promise<void> {
    await this.bounded(this.enqueue(async () => {
      try {
        const policy = this.state.maintenance, at = (this.deps.now ?? Date.now)();
        if (policy?.lastAttemptId !== planId || !this.audit || !Number.isSafeInteger(at) || at < policy.changedAt) return;
        await this.persist({ ...this.state, maintenance: { ...policy, lastRun: RecoveryCacheMaintenanceRunSchema.parse({ ...run, at }) } });
      } finally { if (this.automaticInFlight === planId) this.automaticInFlight = null; }
    }), undefined);
  }
  closeAdmission(): void { this.closing = true; for (const stop of this.waiters) stop(); this.releaseOwnership(); }
}
