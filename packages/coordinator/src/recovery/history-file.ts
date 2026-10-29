import { open } from "node:fs/promises";
import { RECOVERY_HISTORY_LIMITS, RecoveryHistorySchema, emptyRecoveryHistory, type RecoveryHistory } from "@arke-studio/contracts";
import { atomicWriteFile } from "../world/atomic.js";

export interface RecoveryHistoryStore { load(): Promise<unknown>; save(history: RecoveryHistory): Promise<void> }
/** Presentation history has no restart budget/approval authority and never enters a world. */
export class FileRecoveryHistoryStore implements RecoveryHistoryStore {
  constructor(readonly path: string) {}
  async load(): Promise<unknown> {
    let file;
    try { file = await open(this.path, "r"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyRecoveryHistory(); throw error; }
    try {
      const bytes = Buffer.alloc(RECOVERY_HISTORY_LIMITS.maxBytes + 1); let size = 0;
      while (size < bytes.length) { const part = await file.read(bytes, size, bytes.length - size, size); if (!part.bytesRead) break; size += part.bytesRead; }
      if (size > RECOVERY_HISTORY_LIMITS.maxBytes) throw new SyntaxError("Recovery history exceeds its bound.");
      return RecoveryHistorySchema.parse(JSON.parse(bytes.subarray(0, size).toString("utf8")));
    } finally { await file.close(); }
  }
  async save(history: RecoveryHistory): Promise<void> {
    const body = JSON.stringify(RecoveryHistorySchema.parse(history)) + "\n";
    if (Buffer.byteLength(body) > RECOVERY_HISTORY_LIMITS.maxBytes) throw new SyntaxError("Recovery history exceeds its bound.");
    await atomicWriteFile(this.path, body);
  }
}
