import { lstat, open } from "node:fs/promises";
import { StudioAssistantFileSchema, STUDIO_ASSISTANT_LIMITS, type StudioAssistantFile } from "@arke-studio/contracts";
import { atomicWriteFile } from "../world/atomic.js";
import { toExtendedLength } from "../world/paths.js";

export interface StudioConversationStore { load(): Promise<unknown>; save(value: StudioAssistantFile): Promise<void> }

/** Private application conversation history. It never writes a world, job journal, ledger
 * or recovery summary. Unknown/corrupt history is kept, never overwritten with an empty file. */
export class FileStudioConversationStore implements StudioConversationStore {
  constructor(readonly path: string) {}
  async load(): Promise<unknown> {
    let entry;
    try { entry = await lstat(toExtendedLength(this.path)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, threads: [] }; throw error; }
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > STUDIO_ASSISTANT_LIMITS.storeBytes) throw new Error("Studio history is unavailable.");
    const file = await open(toExtendedLength(this.path), "r");
    try {
      const identity = await file.stat();
      if (!identity.isFile() || identity.dev !== entry.dev || identity.ino !== entry.ino || identity.size !== entry.size) throw new Error("Studio history changed.");
      const data = Buffer.alloc(identity.size); let offset = 0;
      while (offset < data.length) { const part = await file.read(data, offset, Math.min(64 * 1024, data.length - offset), offset); if (!part.bytesRead) throw new Error("Studio history changed."); offset += part.bytesRead; }
      const after = await file.stat();
      if (after.size !== identity.size || after.mtimeMs !== identity.mtimeMs || after.ctimeMs !== identity.ctimeMs) throw new Error("Studio history changed.");
      return StudioAssistantFileSchema.parse(JSON.parse(data.toString("utf8")));
    } finally { await file.close(); }
  }
  async save(value: StudioAssistantFile): Promise<void> {
    const text = JSON.stringify(StudioAssistantFileSchema.parse(value)) + "\n";
    if (Buffer.byteLength(text) > STUDIO_ASSISTANT_LIMITS.storeBytes) throw new Error("Studio history is full.");
    await atomicWriteFile(this.path, text);
  }
}
