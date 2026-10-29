import { createHash, randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import type { AppStorageService } from "./service.js";
import { SetupSpaceHeldError, type SetupFilePlan, type SetupFileSpaceLease } from "./setup-files.js";

export interface SetupArchiveSpaceLease extends SetupFileSpaceLease {
  /** The verified archive's bounded manifest must pass fresh admission before native writes. */
  beforeExtraction(estimatedBytes: number): Promise<void>;
  /** Only the owner, after confirmed native exit, can report no remaining extraction writes. */
  extractionSettled(): Promise<void>;
}
export interface SetupArchiveSpace {
  reserve(componentId: string, archive: SetupFilePlan, expansionBytes: number | null, reserveBytes: number, signal: AbortSignal): Promise<SetupArchiveSpaceLease>;
}
const safe = (value: number) => { if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid setup archive estimate."); return value; };

/** Archive and extraction coexist in their existing staging directory. Publication and
 * rollback use same-volume rename, not another payload copy. The native executor retains
 * this lease on unknown cleanup; this class never equates cancellation with process exit. */
export class SetupArchiveStorage implements SetupArchiveSpace {
  constructor(private readonly storage: AppStorageService) {}
  async reserve(componentId: string, archive: SetupFilePlan, expansionBytes: number | null, reserveBytes: number, signal: AbortSignal): Promise<SetupArchiveSpaceLease> {
    if (expansionBytes === null) throw new SetupSpaceHeldError({ status: "held", reason: "capacity", admission: { status: "unknown", reason: "unbounded-output" } }, "installation");
    safe(expansionBytes); safe(reserveBytes); safe(archive.totalBytes); safe(archive.writtenBytes); signal.throwIfAborted();
    const directory = dirname(archive.target); await mkdir(directory, { recursive: true });
    const root = this.storage.acquireRoot(directory, "local-ai"), id = randomUUID(), owner = { kind: "setup" as const, id: createHash("sha256").update(componentId).digest("hex") };
    let total = archive.totalBytes, written = archive.writtenBytes, expansion = expansionBytes, admitted = false, finished = false, extraction = false;
    let stopWriting: (() => void) | undefined;
    const demands = () => [{ rootId: root.rootId, remainingBytes: safe(Math.max(0, total - written) + expansion), reserveBytes }];
    const check = (target?: string) => { if (finished || target !== undefined && target !== archive.target) throw new Error("Setup archive storage is not active."); signal.throwIfAborted(); };
    const replan = async () => {
      const result = await this.storage.reservations.replan({ id, owner, demands: demands() }, signal);
      if (result.status !== "reserved") throw new SetupSpaceHeldError(result);
    };
    try {
      await this.storage.start(); signal.throwIfAborted();
      const result = await this.storage.reservations.reserve({ id, owner, demands: demands() }, signal);
      if (result.status !== "reserved") {
        await this.storage.reservations.settle(id, owner); throw new SetupSpaceHeldError(result);
      }
      admitted = true; stopWriting = this.storage.beginWrite();
      return {
        plan: async (target, bytes) => { check(target); safe(bytes); if (bytes <= total) return;
          const previous = total; total = bytes; try { await replan(); } catch (error) { total = previous; throw error; } },
        written: async (target, bytes) => { check(target); safe(bytes);
          if (bytes < written || bytes > total) throw new Error("Setup archive writes exceed their admitted plan.");
          written = bytes;
          if (!await this.storage.reservations.reduce(id, owner, { [root.rootId]: demands()[0]!.remainingBytes })) throw new SetupSpaceHeldError({ status: "held", reason: "audit-unavailable" });
        },
        beforeExtraction: async bytes => { check(); if (extraction) throw new Error("Setup extraction already started.");
          expansion = Math.max(expansion, safe(bytes)); await replan(); extraction = true; },
        extractionSettled: async () => {
          // No further native bytes can arrive after confirmed exit. Charging the entire old
          // estimate is conservative until a post-phase capacity sample observes actual use.
          check(); if (!extraction) throw new Error("Setup extraction has not started."); expansion = 0;
          if (!await this.storage.reservations.reduce(id, owner, { [root.rootId]: demands()[0]!.remainingBytes })) throw new SetupSpaceHeldError({ status: "held", reason: "audit-unavailable" });
        },
        writeFailed: () => this.storage.writeFailed(root.rootId),
        settle: async () => { if (finished) return; finished = true;
          try { await this.storage.reservations.settle(id, owner); } finally { stopWriting?.(); root.release(); } },
      };
    } catch (error) {
      if (admitted) await this.storage.reservations.settle(id, owner);
      stopWriting?.(); root.release(); throw error;
    }
  }
}
