import { createHash, randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import type { AppStorageService } from "./service.js";
import type { StorageReservationResult } from "./reservations.js";

export interface SetupFilePlan { target: string; totalBytes: number; writtenBytes: number }
export interface SetupFileSpaceLease {
  /** Before a response/body can exceed the declared estimate; never inferred from progress. */
  plan(target: string, totalBytes: number): Promise<void>;
  /** Only confirmed bytes written by this owner reduce its remaining peak. */
  written(target: string, writtenBytes: number): Promise<void>;
  writeFailed(target: string): void;
  /** Called after all this operation's file handles/checkpoints have settled. */
  settle(): Promise<void>;
}
export interface SetupFileSpace {
  reserve(componentId: string, files: readonly SetupFilePlan[], reserveBytes: number, signal: AbortSignal): Promise<SetupFileSpaceLease>;
}
const amount = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GiB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MiB` : `${bytes} bytes`;
export class SetupSpaceHeldError extends Error {
  constructor(readonly result: Extract<StorageReservationResult, { status: "held" }>) {
    const admission = result.admission;
    super(admission?.status === "held"
      ? `This download is waiting for disk space: ${amount(admission.availableBytes)} available; ${amount(admission.peakBytes)} estimated remaining files, ${amount(admission.reservedBytes)} already committed and ${amount(admission.reserveBytes)} reserve.`
      : admission?.status === "unknown" && admission.reason === "unbounded-output"
      ? "The source exceeded its declared file-size budget without a complete length. Review the download before retrying."
      : result.reason === "capacity" ? "This download is waiting for fresh disk capacity and room for its remaining files."
      : result.reason === "reconciliation-required" ? "Earlier storage accounting needs review before this download can continue."
      : "Storage accounting is unavailable. Review before continuing this download.");
    this.name = "SetupSpaceHeldError";
  }
}
const safeBytes = (value: number) => { if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid setup storage estimate."); return value; };

/** Only the existing HTTP file owner uses this port. Archive expansion and runtime-owned
 * pulls require their own phase/native-cleanup accounting; they cannot borrow this receipt. */
export class SetupFileStorage implements SetupFileSpace {
  constructor(private readonly storage: AppStorageService) {}
  async reserve(componentId: string, files: readonly SetupFilePlan[], reserveBytes: number, signal: AbortSignal): Promise<SetupFileSpaceLease> {
    signal.throwIfAborted();
    if (files.length === 0 || files.length > 1024 || new Set(files.map(file => file.target)).size !== files.length) throw new Error("Invalid setup file plan.");
    safeBytes(reserveBytes);
    const holds = new Map<string, ReturnType<AppStorageService["acquireRoot"]>>();
    const plan = new Map(files.map(file => [file.target, { ...file, totalBytes: safeBytes(file.totalBytes), writtenBytes: safeBytes(file.writtenBytes) }]));
    const id = randomUUID(), owner = { kind: "setup" as const, id: createHash("sha256").update(componentId).digest("hex") };
    let finished = false, admitted = false, stopWriting: (() => void) | undefined;
    const demands = () => [...holds].map(([path, hold]) => ({ rootId: hold.rootId, reserveBytes,
      remainingBytes: safeBytes([...plan.values()].filter(file => dirname(file.target) === path).reduce((sum, file) => sum + Math.max(0, file.totalBytes - file.writtenBytes), 0)) }));
    const release = () => { stopWriting?.(); stopWriting = undefined; for (const hold of holds.values()) hold.release(); };
    try {
      // Empty destination directories are ordinary setup metadata. Creating them before
      // measurement lets the native port resolve actual mounted-folder/junction identity.
      for (const file of files) {
        signal.throwIfAborted(); const path = dirname(file.target);
        if (!holds.has(path)) {
          try { await mkdir(path, { recursive: true }); }
          catch (error) { throw new Error("The model destination could not be prepared. Check folder access before retrying.", { cause: error }); }
          holds.set(path, this.storage.acquireRoot(path, "local-ai"));
        }
      }
      await this.storage.start(); signal.throwIfAborted();
      const result = await this.storage.reservations.reserve({ id, owner, demands: demands() }, signal);
      if (result.status !== "reserved") {
        // A grant that aged during its flushed save may have retained an intent. This owner
        // knows it has opened no transfer handle and submitted no request, so it can settle it.
        await this.storage.reservations.settle(id, owner);
        throw new SetupSpaceHeldError(result);
      }
      admitted = true; stopWriting = this.storage.beginWrite();
      return {
        plan: async (target, totalBytes) => {
          const file = plan.get(target); if (finished || !file) throw new Error("Setup storage target is not active.");
          safeBytes(totalBytes); if (totalBytes <= file.totalBytes) return;
          const previous = file.totalBytes; file.totalBytes = totalBytes;
          const result = await this.storage.reservations.replan({ id, owner, demands: demands() }, signal);
          if (result.status !== "reserved") { file.totalBytes = previous; throw new SetupSpaceHeldError(result); }
        },
        written: async (target, writtenBytes) => {
          const file = plan.get(target); if (finished || !file) throw new Error("Setup storage target is not active.");
          safeBytes(writtenBytes);
          if (writtenBytes < file.writtenBytes || writtenBytes > file.totalBytes) throw new Error("Setup writes exceed their admitted storage plan.");
          file.writtenBytes = writtenBytes;
          const remaining = Object.fromEntries(demands().map(demand => [demand.rootId, demand.remainingBytes]));
          if (!await this.storage.reservations.reduce(id, owner, remaining)) throw new SetupSpaceHeldError({ status: "held", reason: "audit-unavailable" });
        },
        writeFailed: target => { const hold = holds.get(dirname(target)); if (hold) this.storage.writeFailed(hold.rootId); },
        settle: async () => { if (finished) return; finished = true; try { await this.storage.reservations.settle(id, owner); } finally { release(); } },
      };
    } catch (error) {
      if (admitted) await this.storage.reservations.settle(id, owner);
      release(); throw error;
    }
  }
}
