import { lstat, open } from "node:fs/promises";
import { resolve } from "node:path";
import { StudioAssistantFileSchema, STUDIO_ASSISTANT_LIMITS, type StudioAssistantFile } from "@arke-studio/contracts";
import { atomicWriteFile } from "../world/atomic.js";
import { toExtendedLength } from "../world/paths.js";

export interface StudioConversationStore { load(): Promise<unknown>; save(value: StudioAssistantFile): Promise<void> }
const writing = new Map<string, Promise<void>>();
const keyFor = (path: string) => process.platform === "win32" || process.platform === "darwin" ? resolve(path).toLowerCase() : resolve(path);

/** Private application conversation history. It never writes a world, job journal, ledger
 * or recovery summary. Unknown/corrupt history is kept, never overwritten with an empty file. */
export class FileStudioConversationStore implements StudioConversationStore {
  constructor(readonly path: string, private readonly write: (path: string, text: string) => Promise<void> = atomicWriteFile) {}
  async load(): Promise<unknown> {
    // Bounded service shutdown may leave an admitted atomic write settling in this process.
    // A replacement must read after that write, not overwrite a successor with its late rename.
    // This same-path I/O barrier is not a cross-process or multiple-active-host lock.
    await writing.get(keyFor(this.path))?.catch(() => {});
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
    const key = keyFor(this.path), previous = writing.get(key);
    const work = (previous ?? Promise.resolve()).catch(() => {}).then(() => this.write(this.path, text));
    writing.set(key, work);
    try { await work; }
    finally { if (writing.get(key) === work) writing.delete(key); }
  }
}
