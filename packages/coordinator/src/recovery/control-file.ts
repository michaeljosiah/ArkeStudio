import { open } from "node:fs/promises";
import { RecoveryControlSchema, type RecoveryControl } from "@arke-studio/contracts";
import { atomicWriteFile } from "../world/atomic.js";

const CAP_BYTES = 256 * 1024;
export interface RecoveryControlStore { load(): Promise<unknown>; save(control: RecoveryControl): Promise<void> }

/** Minimal mutation authority survives cleared incident history. No paths or subprocess text
 * belong in this file; one coordinator owns it and flushes it before a repair can begin. */
export class FileRecoveryControlStore implements RecoveryControlStore {
  constructor(readonly path: string) {}
  async load(): Promise<unknown> {
    let file;
    try { file = await open(this.path, "r"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, policyRevision: 1, mode: "automatic", targets: [] }; throw error; }
    try {
      const buffer = Buffer.alloc(CAP_BYTES + 1); let size = 0;
      while (size < buffer.length) {
        const part = await file.read(buffer, size, buffer.length - size, size);
        if (!part.bytesRead) break; size += part.bytesRead;
      }
      if (size > CAP_BYTES) throw new Error("Recovery control exceeds its bound.");
      return RecoveryControlSchema.parse(JSON.parse(buffer.subarray(0, size).toString("utf8")));
    } finally { await file.close(); }
  }
  async save(control: RecoveryControl): Promise<void> {
    const body = JSON.stringify(RecoveryControlSchema.parse(control)) + "\n";
    if (Buffer.byteLength(body) > CAP_BYTES) throw new Error("Recovery control exceeds its bound.");
    await atomicWriteFile(this.path, body);
  }
}
