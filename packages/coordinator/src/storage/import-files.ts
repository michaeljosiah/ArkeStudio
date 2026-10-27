import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import type { AppStorageService } from "./service.js";
import type { StorageReservationResult } from "./reservations.js";
import { toExtendedLength } from "../world/paths.js";
import { resolve } from "node:path";

export interface ImportFileLease {
  consumed(bytes: number): Promise<void>;
  writeFailed(): void;
  /** Only after all original Node writes and their metadata/cleanup have settled. */
  settle(): Promise<void>;
}
export interface ImportFileSpace {
  reserve(directory: string, payloadBytes: number, signal: AbortSignal, role?: "generated-media" | "working-files"): Promise<ImportFileLease>;
}
export interface ImportFileBatch { readonly space: ImportFileSpace; settle(): Promise<void> }
interface PlannedImportLease extends ImportFileLease { recheck(signal: AbortSignal): Promise<void> }
export class ImportStorageHeld extends Error {
  constructor(readonly result?: Extract<StorageReservationResult, { status: "held" }>) {
    const admission = result?.admission;
    super(admission?.status === "held"
      ? `Import is waiting for storage: ${admission.availableBytes} bytes available, ${admission.reservedBytes} already committed, ${admission.peakBytes} remaining and ${admission.reserveBytes} reserve.`
      : "Import is waiting for fresh destination capacity and available storage accounting. No file was discarded.");
    this.name = "ImportStorageHeld";
  }
}
// Process-wide: another service instance cannot reconcile an original Node write still alive
// in this host. A new host has no surviving Node file handles from the previous process.
const active = new Set<string>();
const PREFIX = "artifact_import_", OVERHEAD = 64 * 1024;

/** Known payload copies, shared with setup/results. No native worker, creative deletion,
 * whole-tree scan or source-file mutation. Small authored records keep normal world durability. */
export class ImportFileStorage implements ImportFileSpace {
  constructor(private readonly storage: AppStorageService) {}
  /** Under the existing sole app-local control owner, not a multi-host filesystem lock. */
  async reconcileIdleImports(): Promise<void> {
    await this.storage.start();
    for (const record of this.storage.reservations.snapshot().records) {
      if (record.owner.kind !== "import" || record.owner.id !== record.id ||
        !/^artifact_import_[a-f0-9-]{36}$/.test(record.id) || active.has(record.id)) continue;
      await this.storage.reservations.settle(record.id, record.owner);
    }
  }
  reserve(directory: string, payloadBytes: number, signal: AbortSignal, role: "generated-media" | "working-files" = "generated-media"): Promise<ImportFileLease> {
    return this.reserveKnown(directory, payloadBytes, OVERHEAD, signal, role);
  }
  /** One known batch; child copies spend this budget rather than reserve the same bytes twice. */
  async reserveBatch(directory: string, payloadBytes: number, copies: number, signal: AbortSignal): Promise<ImportFileBatch> {
    signal.throwIfAborted();
    if (!Number.isSafeInteger(copies) || copies < 0 || copies > 16 || !Number.isSafeInteger(payloadBytes) || payloadBytes < 0 || !copies && payloadBytes !== 0) throw new Error("Invalid import batch plan.");
    const parent = copies ? await this.reserveKnown(directory, payloadBytes, copies * OVERHEAD, signal, "generated-media") : undefined;
    const target = resolve(directory), children = new Set<Promise<void>>();
    let remaining = payloadBytes, slots = copies, closing = false, allocating: Promise<ImportFileLease> | undefined, closed: Promise<void> | undefined;
    const space: ImportFileSpace = { reserve: (requested, bytes, callerSignal, role = "generated-media") => {
      const allowed = () => !closing && !signal.aborted && !callerSignal.aborted && !children.size && role === "generated-media" &&
        resolve(requested) === target && Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= remaining && slots > 0;
      if (allocating || !allowed() || !parent) return Promise.reject(new ImportStorageHeld());
      const task = (async (): Promise<ImportFileLease> => {
        await parent.recheck(AbortSignal.any([signal, callerSignal]));
        if (!allowed()) throw new ImportStorageHeld();
        remaining -= bytes; slots--;
        let done = false, reported = false, written = 0, release!: () => void;
        const settled = new Promise<void>(resolve => { release = resolve; }); children.add(settled);
        return {
          consumed: async count => {
            if (done || !Number.isSafeInteger(count) || count < 0 || count > bytes - written) throw new Error("Import copy exceeds its batch budget.");
            reported = true; written += count; await parent.consumed(count);
          },
          writeFailed: () => parent.writeFailed(),
          settle: async () => {
            if (done) return; done = true;
            remaining += bytes - written; if (!reported) slots++;
            children.delete(settled); release();
          },
        };
      })();
      allocating = task; void task.finally(() => { if (allocating === task) allocating = undefined; }).catch(() => {});
      return task;
    } };
    return { space, settle: () => {
      closing = true;
      closed ??= (async () => { await allocating?.catch(() => {}); await Promise.all(children); await parent?.settle(); })();
      return closed;
    } };
  }
  private async reserveKnown(directory: string, payloadBytes: number, overhead: number, signal: AbortSignal, role: "generated-media" | "working-files"): Promise<PlannedImportLease> {
    signal.throwIfAborted();
    if (!Number.isSafeInteger(payloadBytes) || payloadBytes < 0 || !Number.isSafeInteger(payloadBytes + overhead)) throw new Error("Invalid import storage plan.");
    const id = PREFIX + randomUUID(), owner = { kind: "import" as const, id };
    let root: ReturnType<AppStorageService["acquireRoot"]> | undefined, writing: (() => void) | undefined;
    let finished = false, admitted = false, remaining = payloadBytes + overhead;
    active.add(id);
    const release = () => { active.delete(id); writing?.(); root?.release(); };
    try {
      await this.reconcileIdleImports(); signal.throwIfAborted();
      await mkdir(toExtendedLength(directory), { recursive: true });
      root = this.storage.acquireRoot(directory, role, role === "generated-media");
      const result = await this.storage.reservations.reserve({ id, owner, demands: [{ rootId: root.rootId, remainingBytes: remaining }] }, signal);
      if (result.status !== "reserved") { await this.storage.reservations.settle(id, owner); throw new ImportStorageHeld(result); }
      admitted = true; signal.throwIfAborted(); writing = this.storage.beginWrite();
      return {
        consumed: async bytes => {
          if (finished || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > remaining - overhead) throw new Error("Import write exceeds its admitted payload.");
          remaining -= bytes;
          if (!await this.storage.reservations.reduce(id, owner, { [root!.rootId]: remaining })) throw new ImportStorageHeld();
        },
        recheck: async callerSignal => {
          if (finished || signal.aborted || callerSignal.aborted) throw new ImportStorageHeld();
          const result = await this.storage.reservations.replan({ id, owner, demands: [{ rootId: root!.rootId, remainingBytes: remaining }] }, AbortSignal.any([signal, callerSignal]));
          if (result.status !== "reserved") throw new ImportStorageHeld(result);
        },
        writeFailed: () => this.storage.writeFailed(root!.rootId),
        settle: async () => {
          if (finished) return; finished = true;
          try { await this.storage.reservations.settle(id, owner); } finally { release(); }
        },
      };
    } catch (error) {
      try { if (admitted) await this.storage.reservations.settle(id, owner); } finally { release(); }
      throw error;
    }
  }
}
