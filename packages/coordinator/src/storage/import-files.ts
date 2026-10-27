import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import type { AppStorageService } from "./service.js";
import type { StorageReservationResult } from "./reservations.js";
import { toExtendedLength } from "../world/paths.js";

export interface ImportFileLease {
  consumed(bytes: number): Promise<void>;
  writeFailed(): void;
  /** Only after all original Node writes and their metadata/cleanup have settled. */
  settle(): Promise<void>;
}
export interface ImportFileSpace {
  reserve(directory: string, payloadBytes: number, signal: AbortSignal, role?: "generated-media" | "working-files"): Promise<ImportFileLease>;
}
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
  async reserve(directory: string, payloadBytes: number, signal: AbortSignal, role: "generated-media" | "working-files" = "generated-media"): Promise<ImportFileLease> {
    signal.throwIfAborted();
    if (!Number.isSafeInteger(payloadBytes) || payloadBytes < 0 || !Number.isSafeInteger(payloadBytes + OVERHEAD)) throw new Error("Invalid import storage plan.");
    const id = PREFIX + randomUUID(), owner = { kind: "import" as const, id };
    let root: ReturnType<AppStorageService["acquireRoot"]> | undefined, writing: (() => void) | undefined;
    let finished = false, admitted = false, remaining = payloadBytes + OVERHEAD;
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
          if (finished || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > remaining - OVERHEAD) throw new Error("Import write exceeds its admitted payload.");
          remaining -= bytes;
          if (!await this.storage.reservations.reduce(id, owner, { [root!.rootId]: remaining })) throw new ImportStorageHeld();
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
