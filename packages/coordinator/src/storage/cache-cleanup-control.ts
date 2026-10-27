import { randomBytes } from "node:crypto";
import { open } from "node:fs/promises";
import { z } from "zod";
import { WriteQueue } from "../change-log.js";
import { atomicWriteFile } from "../world/atomic.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/), instant = z.number().int().nonnegative().safe();
const intent = z.object({ id: digest, planId: digest, key: digest, evidence: digest, rootIdentity: digest, fileIdentity: digest,
  at: instant, phase: z.enum(["intended", "unknown"]) }).strict();
const outcome = z.object({ planId: digest, key: digest, at: instant, status: z.enum(["removed", "not-started", "unknown"]) }).strict();
export const CacheCleanupControlSchema = z.object({ version: z.literal(1), pending: intent.nullable(), outcomes: z.array(outcome).max(32) }).strict();
type State = z.infer<typeof CacheCleanupControlSchema>;
type AuditFailure = "invalid" | "permission" | "disk-full" | "read-failed" | "write-failed";
export interface CacheCleanupStore { load(): Promise<unknown>; save(state: State): Promise<void> }
const CAP = 64 * 1024;
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
  private audit = true;
  private failure: AuditFailure | undefined;
  private closing = false;
  private readonly waiters = new Set<() => void>();
  constructor(path: string, private readonly deps: { store?: CacheCleanupStore; now?: () => number; stopMs?: number; onChange?: () => void } = {}) {
    this.store = deps.store ?? new FileStore(path);
  }
  private changed(): void { if (!this.closing) try { this.deps.onChange?.(); } catch { /* Presentation never grants deletion authority. */ } }
  snapshot(): { available: boolean; protected: boolean; pending: boolean; key: string | null; outcomes: State["outcomes"]; audit: "starting" | "available" | "unavailable"; reason?: AuditFailure } {
    return { available: this.ready && this.audit && !this.closing && !this.state.pending,
      protected: !this.ready || !this.audit,
      audit: !this.audit ? "unavailable" : this.ready ? "available" : "starting", ...(this.failure ? { reason: this.failure } : {}),
      pending: this.state.pending !== null, key: this.state.pending?.key ?? null, outcomes: structuredClone(this.state.outcomes) };
  }
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
    this.opened ??= this.bounded(this.queue.enqueue(async () => {
      if (this.closing) return;
      try {
        this.state = CacheCleanupControlSchema.parse(await this.store.load());
        if (this.state.pending) { this.state.pending.phase = "unknown"; await this.store.save(this.state); }
        this.ready = !this.closing;
      } catch (error) { this.audit = false; this.failure = this.classify(error, "read-failed"); }
      this.changed();
    }), undefined, "read-failed");
    return this.opened;
  }
  private async persist(next: State): Promise<boolean> {
    try { await this.store.save(CacheCleanupControlSchema.parse(next)); this.state = next; this.changed(); return true; }
    catch (error) { this.audit = false; this.failure = this.classify(error, "write-failed"); if (next.pending) this.state = next; if (this.state.pending) this.state.pending.phase = "unknown"; this.changed(); return false; }
  }
  async begin(planId: string, entry: { key: string; evidence: string; rootIdentity: string; fileIdentity: string }, valid: () => boolean): Promise<string | null> {
    await this.open(); let id: string | null = null;
    await this.bounded(this.queue.enqueue(async () => {
      if (!this.snapshot().available || !valid()) return;
      const now = (this.deps.now ?? Date.now)(); if (!Number.isSafeInteger(now) || now < 0) return;
      const pending = intent.parse({ ...entry, planId, id: randomBytes(32).toString("hex"), at: now, phase: "intended" });
      if (await this.persist({ ...this.state, pending })) {
        if (!this.closing && valid()) id = pending.id;
        else await this.persist({ ...this.state, pending: null,
          outcomes: [...this.state.outcomes, { planId, key: entry.key, at: now, status: "not-started" as const }].slice(-32) });
      }
    }), undefined);
    return id;
  }
  async settle(id: string, status: "removed" | "not-started" | "unknown"): Promise<boolean> {
    let saved = false;
    await this.bounded(this.queue.enqueue(async () => {
      const current = this.state.pending;
      if (!current || current.id !== id || !this.audit) return;
      const at = (this.deps.now ?? Date.now)();
      if (!Number.isSafeInteger(at) || at < current.at) return;
      const next = structuredClone(this.state);
      next.pending = status === "unknown" ? { ...current, phase: "unknown" } : null;
      next.outcomes = [...next.outcomes, { planId: current.planId, key: current.key, at, status }].slice(-32);
      saved = await this.persist(next);
    }), undefined);
    return saved;
  }
  closeAdmission(): void { this.closing = true; for (const stop of this.waiters) stop(); }
}
