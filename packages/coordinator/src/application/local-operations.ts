import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { WriteQueue } from "../change-log.js";
import { appendFlushed } from "../flushed-append.js";
import type { EngineOperation, EngineOperationStore } from "./contracts.js";

/** One local host owns this file. Distributed hosts must supply atomic durable uniqueness. */
export class FileEngineOperationStore implements EngineOperationStore {
  private readonly writes = new WriteQueue();
  private records: Map<string, EngineOperation> | null = null;
  private failure: unknown;
  constructor(readonly path: string) {}

  private async load(): Promise<Map<string, EngineOperation>> {
    if (this.failure) throw this.failure;
    if (this.records) return this.records;
    let text: string;
    try { text = await readFile(this.path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; text = ""; }
    const records = new Map<string, EngineOperation>();
    // An unreadable/torn row is unknown, not an empty journal granting permission to repeat work.
    for (const line of text.split("\n").filter(Boolean)) {
      const row = JSON.parse(line) as EngineOperation;
      if (!/^[a-f0-9]{64}$/.test(row.key) || !/^[a-f0-9]{64}$/.test(row.fingerprint) ||
        !["started", "completed"].includes(row.status)) throw new Error("Invalid engine operation journal.");
      const before = records.get(row.key);
      if (before && before.fingerprint !== row.fingerprint) throw new Error("Conflicting engine operation journal.");
      records.set(row.key, row);
    }
    this.records = records;
    return records;
  }

  private async serialise<T>(action: () => Promise<T>): Promise<T> {
    let result!: T;
    await this.writes.enqueue(async () => { result = await action(); });
    return result;
  }

  private async append(operation: EngineOperation): Promise<void> {
    try { await appendFlushed(this.path, JSON.stringify(operation) + "\n"); }
    catch (error) { this.failure = error; throw error; }
  }

  begin(operation: EngineOperation) {
    return this.serialise(async () => {
      const records = await this.load();
      const existing = records.get(operation.key);
      if (existing) return { inserted: false, operation: structuredClone(existing) };
      await mkdir(dirname(this.path), { recursive: true });
      await this.append(operation);
      records.set(operation.key, structuredClone(operation));
      return { inserted: true, operation: structuredClone(operation) };
    });
  }

  complete(key: string, fingerprint: string, result: unknown): Promise<void> {
    return this.writes.enqueue(async () => {
      const records = await this.load();
      const existing = records.get(key);
      if (!existing || existing.fingerprint !== fingerprint) throw new Error("Unknown engine operation completion.");
      if (existing.status === "completed") return;
      const row: EngineOperation = { ...existing, status: "completed", result: structuredClone(result) };
      await this.append(row);
      records.set(key, row);
    });
  }

  read(key: string): Promise<EngineOperation | null> {
    return this.serialise(async () => structuredClone((await this.load()).get(key) ?? null));
  }
  drain(): Promise<void> { return this.writes.drain(); }
}
