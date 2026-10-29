import { createHash, randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { SetupComponent, SetupRepairReview } from "@arke-studio/contracts";
import { atomicWriteFile } from "../world/atomic.js";
import { toExtendedLength } from "../world/paths.js";
import type { CatalogueEntry } from "./catalogue.js";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** One small record per catalogue component. A pending deletion is never replayed after restart.
 * Existing setup owns replacement downloads, their cancellation, receipts and verification. */
export class SetupRepairReviews {
  private readonly session = randomUUID();
  private readonly generations = new Map<string, number>();
  private readonly pendingReads = new Map<string, Promise<boolean>>();
  constructor(private readonly appRoot: string) {}
  changed(id: string): void { this.generations.set(id, (this.generations.get(id) ?? 0) + 1); }
  review(entry: CatalogueEntry, component: SetupComponent, location: string | null): SetupRepairReview | undefined {
    if (entry.spec.kind !== "files" || entry.id.startsWith("adapter-") || !location || ["queued", "downloading", "paused", "installing", "skipped"].includes(component.state)) return;
    const componentDigest = digest([entry.id, entry.spec, location]);
    return { revision: digest([this.session, componentDigest, this.generations.get(entry.id) ?? 0]),
      componentDigest, policyRevision: 1, downloadBytes: Math.ceil(entry.sizeMb * 1024 ** 2),
      peakBytes: Math.ceil(Math.max(entry.sizeMb, entry.installedMb ?? entry.sizeMb) * 1024 ** 2), interruptsWork: false };
  }
  private path(id: string): string { return join(this.appRoot, "operations", "setup-repairs", `${digest(id)}.json`); }
  pending(id: string): Promise<boolean> {
    let read = this.pendingReads.get(id);
    if (!read) {
      read = this.readPending(id); this.pendingReads.set(id, read);
    }
    return read;
  }
  private async readPending(id: string): Promise<boolean> {
    let file;
    try {
      file = await open(toExtendedLength(this.path(id)), "r");
      const bytes = Buffer.alloc(4097), result = await file.read(bytes, 0, bytes.length, 0);
      if (result.bytesRead > 4096) return true;
      const record = JSON.parse(bytes.subarray(0, result.bytesRead).toString("utf8"));
      return record.version !== 1 || record.componentId !== id || record.phase !== "files-removed";
    } catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
    finally { await file?.close(); }
  }
  async record(id: string, review: SetupRepairReview, phase: "intended" | "files-removed"): Promise<void> {
    // Mark unknown before awaiting persistence. An uncertain write never authorizes deletion.
    this.pendingReads.set(id, Promise.resolve(true));
    await atomicWriteFile(this.path(id), JSON.stringify({ version: 1, componentId: id, phase,
      revision: review.revision, componentDigest: review.componentDigest, policyRevision: review.policyRevision }));
    this.pendingReads.set(id, Promise.resolve(phase !== "files-removed"));
  }
}
