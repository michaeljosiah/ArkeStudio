import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Append-only NDJSON change log (SPEC-001 R-3; master spec §2.5). Adopted from Arke's
 * `trace.ts`: all appends are serialised through a write queue so concurrent writers never
 * interleave a partial line, and every record carries a file-level monotonic `seq` resumed
 * from the tail on restart, so records order unambiguously across runs.
 */

/** Serialises appendFile calls into a single chain; a failed write must not poison the chain. */
export class WriteQueue {
  private chain: Promise<void> = Promise.resolve();

  enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.chain.then(task, task);
    this.chain = run.catch(() => {});
    return run;
  }

  /** Wait for all currently-enqueued writes to complete (call on shutdown). */
  drain(): Promise<void> {
    return this.chain;
  }
}

export interface LogRecord {
  at: number;
  seq: number;
  [k: string]: unknown;
}

export class ChangeLog {
  private readonly path: string;
  private readonly queue = new WriteQueue();
  private seq = 0;
  private seqLoaded = false;

  constructor(path: string) {
    this.path = path;
  }

  /** Lazily resume the monotonic seq from the tail of the existing file. */
  private async ensureSeq(): Promise<void> {
    if (this.seqLoaded) return;
    this.seqLoaded = true;
    try {
      const raw = await readFile(this.path, "utf8");
      for (const line of raw.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          const s = (JSON.parse(t) as { seq?: number }).seq;
          if (typeof s === "number" && s > this.seq) this.seq = s;
        } catch {
          /* skip malformed */
        }
      }
    } catch {
      /* no file yet → start from seq 0 */
    }
  }

  /**
   * Append a record (best-effort): never rejects — an unwritable log degrades audit but must
   * not crash the event pump, and fire-and-forget callers can't raise unhandled rejections.
   */
  append(record: Record<string, unknown>): Promise<void> {
    return this.queue.enqueue(async () => {
      await this.ensureSeq();
      const line = JSON.stringify({ at: Date.now(), seq: ++this.seq, ...record }) + "\n";
      try {
        await mkdir(dirname(this.path), { recursive: true });
        await appendFile(this.path, line, { encoding: "utf8" });
      } catch {
        this.seq--; // the write didn't land — don't burn the sequence number
      }
    });
  }

  drain(): Promise<void> {
    return this.queue.drain();
  }

  async readAll(): Promise<LogRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch {
      return [];
    }
    const out: LogRecord[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as LogRecord);
      } catch {
        /* skip malformed */
      }
    }
    return out;
  }
}
