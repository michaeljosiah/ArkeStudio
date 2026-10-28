import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { StorageRootRole } from "@arke-studio/contracts";
import type { AppStorageService } from "./service.js";
import type { StorageAssessmentResult, StorageReservationResult } from "./reservations.js";
import { toExtendedLength } from "../world/paths.js";

export interface ArtifactWriteDemand { directory: string; remainingBytes: number; role: StorageRootRole }
export interface ArtifactWriteLease {
  consumed(directory: string, bytes: number): Promise<void>;
  writeFailed(): void;
  /** The file owner calls this only after all its writes/flushes/closes have settled. */
  settle(): Promise<void>;
}
export interface ArtifactWriteSpace {
  /** Operational headroom only, before provider I/O. Not an output/scratch fit claim. */
  checkSubmission?(directories: readonly { directory: string; role: StorageRootRole }[], signal: AbortSignal): Promise<void>;
  reserve(jobId: string, demands: readonly ArtifactWriteDemand[], signal: AbortSignal, sameVolume?: boolean): Promise<ArtifactWriteLease>;
  /** Startup only, under the existing sole job-journal owner. Reconcile just this port's
   * Node file handles, which cannot survive the previous host, never a native worker lease. */
  reconcileIdleJobs?(jobIds: ReadonlySet<string>): Promise<void>;
}
export class SubmissionStorageHeld extends Error {
  constructor(readonly result?: Extract<StorageAssessmentResult, { status: "held" }>) {
    const admission = result?.admission;
    super(admission?.status === "held"
      ? `Not submitted: waiting for storage (${admission.availableBytes} bytes available, ${admission.reservedBytes} already committed, ${admission.peakBytes} minimum headroom and ${admission.reserveBytes} reserve). Check Diagnostics.`
      : "Not submitted: storage capacity or the owning destination could not be verified. Check Diagnostics.");
    this.name = "SubmissionStorageHeld";
  }
}
// A disclosed bookkeeping floor, not an estimate or a bound on generated media.
export const SUBMISSION_BOOKKEEPING_BYTES = 64 * 1024;
export class ArtifactStorageHeld extends Error {
  constructor(readonly result?: Extract<StorageReservationResult, { status: "held" }>, readonly differentVolumes = false) {
    const admission = result?.admission;
    super(differentVolumes ? "The result's staging and destination are on different volumes. Review the destination before retrying local filing."
      : admission?.status === "held" ? `Completed result is waiting for storage: ${admission.availableBytes} bytes available, ${admission.reservedBytes} already committed, ${admission.peakBytes} remaining and ${admission.reserveBytes} reserve. No generation was repeated.`
      : "Completed result is waiting for fresh storage capacity and available accounting. No generation was repeated.");
    this.name = "ArtifactStorageHeld";
  }
}
const safe = (value: number) => { if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid artifact storage plan."); return value; };
const activeByStorage = new WeakMap<AppStorageService, Set<string>>();

/** Finite measured result writes and a read-only operational preflight (SPEC-062 R-7/R-10).
 * Full dispatch/scratch/output plans have their own owners; neither operation grants
 * generation, replay or cleanup authority. */
export class JobArtifactStorage implements ArtifactWriteSpace {
  private readonly active: Set<string>;
  constructor(private readonly storage: AppStorageService) {
    let active = activeByStorage.get(storage); if (!active) { active = new Set(); activeByStorage.set(storage, active); } this.active = active;
  }
  async checkSubmission(input: readonly { directory: string; role: StorageRootRole }[], signal: AbortSignal): Promise<void> {
    const roots = new Map<string, ReturnType<AppStorageService["acquireRoot"]>>();
    try {
      signal.throwIfAborted();
      if (!input.length || input.length > 32) throw new Error("Invalid submission destinations.");
      for (const item of input) {
        signal.throwIfAborted(); const directory = resolve(item.directory);
        if (roots.has(directory)) continue;
        // Only empty destination metadata is prepared here, under the queue's normal world
        // ownership envelope. No result, scratch payload or model execution is authorized.
        await mkdir(toExtendedLength(directory), { recursive: true }); signal.throwIfAborted();
        roots.set(directory, this.storage.acquireRoot(directory, item.role, item.role === "generated-media"));
      }
      await this.storage.start(); signal.throwIfAborted();
      const result = await this.storage.reservations.assess([...roots.values()].map(root => ({
        rootId: root.rootId, remainingBytes: SUBMISSION_BOOKKEEPING_BYTES,
      })), signal);
      signal.throwIfAborted();
      if (result.status !== "fits") throw new SubmissionStorageHeld(result);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof SubmissionStorageHeld) throw error;
      for (const root of roots.values()) this.storage.writeFailed(root.rootId);
      throw new SubmissionStorageHeld();
    } finally { for (const root of roots.values()) root.release(); }
  }
  async reconcileIdleJobs(jobIds: ReadonlySet<string>): Promise<void> {
    await this.storage.start();
    for (const record of this.storage.reservations.snapshot().records) {
      if (record.owner.kind !== "job" || !record.owner.id.startsWith("artifact_") || !/^artifact_[a-f0-9-]{36}$/.test(record.id) || this.active.has(record.id)) continue;
      const jobId = record.owner.id.slice("artifact_".length);
      if (jobIds.has(jobId)) await this.storage.reservations.settle(record.id, record.owner);
    }
  }
  async reserve(jobId: string, input: readonly ArtifactWriteDemand[], signal: AbortSignal, sameVolume = false): Promise<ArtifactWriteLease> {
    signal.throwIfAborted();
    if (!/^[a-zA-Z0-9_-]{1,119}$/.test(jobId) || !input.length || input.length > 32) throw new Error("Invalid artifact storage owner.");
    const demands = new Map<string, { root: ReturnType<AppStorageService["acquireRoot"]>; remaining: number }>();
    const owner = { kind: "job" as const, id: `artifact_${jobId}` }, id = `artifact_${randomUUID()}`;
    let admitted = false, finished = false, stopWriting: (() => void) | undefined;
    this.active.add(id);
    const release = () => { this.active.delete(id); stopWriting?.(); for (const value of demands.values()) value.root.release(); };
    try {
      for (const item of input) {
        signal.throwIfAborted(); const directory = resolve(item.directory); safe(item.remainingBytes);
        const existing = demands.get(directory);
        if (existing) existing.remaining = safe(existing.remaining + item.remainingBytes);
        else {
          // Empty metadata directories let the native collector resolve mounted folders.
          await mkdir(toExtendedLength(directory), { recursive: true });
          demands.set(directory, { root: this.storage.acquireRoot(directory, item.role), remaining: item.remainingBytes });
        }
      }
      await this.storage.start(); signal.throwIfAborted();
      const result = await this.storage.reservations.reserve({ id, owner,
        demands: [...demands.values()].map(value => ({ rootId: value.root.rootId, remainingBytes: value.remaining })) }, signal);
      if (result.status !== "reserved") {
        // No file was opened. A save that finished after invalidation may still retain intent.
        await this.storage.reservations.settle(id, owner); throw new ArtifactStorageHeld(result);
      }
      admitted = true;
      if (sameVolume && new Set(result.reservation.demands.map(value => value.volumeId)).size !== 1) throw new ArtifactStorageHeld(undefined, true);
      stopWriting = this.storage.beginWrite();
      return {
        consumed: async (directory, bytes) => {
          signal.throwIfAborted(); const value = demands.get(resolve(directory)); safe(bytes);
          if (finished || !value || bytes > value.remaining) throw new Error("Artifact write exceeds its admitted plan.");
          value.remaining -= bytes;
          if (!await this.storage.reservations.reduce(id, owner, Object.fromEntries([...demands.values()].map(row => [row.root.rootId, row.remaining])))) throw new ArtifactStorageHeld();
        },
        writeFailed: () => { for (const value of demands.values()) this.storage.writeFailed(value.root.rootId); },
        settle: async () => { if (finished) return; finished = true;
          try { await this.storage.reservations.settle(id, owner); } finally { release(); } },
      };
    } catch (error) {
      try { if (admitted) await this.storage.reservations.settle(id, owner); } finally { release(); }
      throw error;
    }
  }
}
