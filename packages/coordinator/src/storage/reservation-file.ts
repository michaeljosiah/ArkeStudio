import { open } from "node:fs/promises";
import { atomicWriteFile } from "../world/atomic.js";
import { StorageReservationFileSchema, type StorageReservation, type StorageReservationStore, type StorageConsumption } from "./reservations.js";

const CAP_BYTES = 1024 * 1024;

/** One coordinator owns the app-local file. Never store paths, creative records or job outcomes. */
export class FileStorageReservationStore implements StorageReservationStore {
  constructor(readonly path: string) {}
  async load(): Promise<unknown> {
    let file;
    try { file = await open(this.path, "r"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, records: [] }; throw error; }
    try {
      const buffer = Buffer.alloc(CAP_BYTES + 1);
      let size = 0;
      while (size < buffer.length) {
        const part = await file.read(buffer, size, buffer.length - size, size);
        if (!part.bytesRead) break;
        size += part.bytesRead;
      }
      if (size > CAP_BYTES) throw new Error("Storage reservation history exceeds its bound.");
      return StorageReservationFileSchema.parse(JSON.parse(buffer.subarray(0, size).toString("utf8")));
    } finally { await file.close(); }
  }
  async save(records: readonly StorageReservation[], consumed: readonly StorageConsumption[]): Promise<void> {
    const data = StorageReservationFileSchema.parse({ version: 2, records, consumed });
    const body = JSON.stringify(data) + "\n";
    if (Buffer.byteLength(body) > CAP_BYTES) throw new Error("Storage reservation history exceeds its bound.");
    await atomicWriteFile(this.path, body);
  }
}
