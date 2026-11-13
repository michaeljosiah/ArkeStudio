import { appendFile, mkdir, open, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Append-only NDJSON change log (SPEC-001 R-3; master spec §2.5). Adopted from Arke's
 * `trace.ts`: all appends are serialised through a write queue so concurrent writers never
 * interleave a partial line, and every record carries a file-level monotonic `seq` resumed
 * from the tail on restart, so records order unambiguously across runs.
 *
 * This is a best-effort diagnostic event log, not the world change journal or job recovery
 * authority. Appends are not fsynced: acknowledged diagnostic rows may disappear after an
 * OS crash or power loss. The supported journal crash model is SPEC-009 §2.2.1.
 *
 * It rolls to `<path>.old` past a size cap, as harness.jsonl does (issue 1845). It used to grow
 * for the life of an install: one owner's reached 2.6 GB, and reading it whole to resume the
 * seq overran V8's string limit, so the seq silently restarted at 0. Every read is now bounded
 * to the tail, and one generation of history is kept, which still covers the export rows
 * durableExportReads rebuilds from.
 */

/** 16 MB, larger than harness.jsonl's 5 MB: this log carries every journalled domain event. */
const CHANGE_LOG_ROLL_BYTES = 16 * 1024 * 1024;
/** A live file past this many caps predates rolling; only its tail is worth keeping as `.old`. */
const LEGACY_ROLL_FACTOR = 4;
/** Enough tail to find the last record's seq even behind a megabyte-long legacy catalogue line. */
const SEQ_TAIL_BYTES = 4 * 1024 * 1024;
/** Every record starts with these two fields, so a line's seq is readable without parsing it. */
const SEQ_AT_LINE_START = /(?:^|\n)\{"at":[^,\n]*,"seq":(\d+)/g;

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

/**
 * The last `maxBytes` of a file as text, starting at a line boundary: when the read begins
 * mid-file the partial first line is dropped, which also drops any split UTF-8 sequence.
 * An absent file reads as empty.
 */
async function readTail(path: string, maxBytes: number): Promise<string> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return "";
  }
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    if (start === 0) return text;
    // A window inside one long line holds no whole line at all.
    const newline = text.indexOf("\n");
    return newline === -1 ? "" : text.slice(newline + 1);
  } finally {
    await handle.close();
  }
}

function highestSeq(text: string): number {
  let seq = 0;
  for (const match of text.matchAll(SEQ_AT_LINE_START)) seq = Math.max(seq, Number(match[1]));
  return seq;
}

export class ChangeLog {
  private readonly path: string;
  private readonly rollBytes: number;
  private readonly queue = new WriteQueue();
  private seq = 0;
  private seqLoaded = false;

  constructor(path: string, options: { rollBytes?: number } = {}) {
    this.path = path;
    this.rollBytes = options.rollBytes ?? CHANGE_LOG_ROLL_BYTES;
  }

  /**
   * Lazily resume the monotonic seq from the tail of the existing file, or of `.old` when the
   * live file was rolled and has nothing in it yet, so a roll never restarts the sequence.
   */
  private async ensureSeq(): Promise<void> {
    if (this.seqLoaded) return;
    this.seqLoaded = true;
    try {
      this.seq = highestSeq(await readTail(this.path, SEQ_TAIL_BYTES)) ||
        highestSeq(await readTail(`${this.path}.old`, SEQ_TAIL_BYTES));
    } catch {
      /* unreadable → start from seq 0, as with no file */
    }
  }

  /**
   * Past the cap the live file becomes `.old`, replacing the previous generation. A legacy file
   * many caps over is then cut to its last cap of lines, so the gigabytes it holds are freed now
   * rather than surviving as `.old` until the next roll. The rename comes first: if the cut
   * fails, the live file is already fresh and no later append pays for the cut again.
   */
  private async rollIfOver(): Promise<void> {
    let size: number;
    try {
      size = (await stat(this.path)).size;
    } catch {
      return; // absent file — the append creates it
    }
    if (size <= this.rollBytes) return;
    const old = `${this.path}.old`;
    await rename(this.path, old);
    if (size > this.rollBytes * LEGACY_ROLL_FACTOR) {
      await writeFile(`${old}.tmp`, await readTail(old, this.rollBytes), "utf8");
      await rename(`${old}.tmp`, old);
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
        // A failed roll must not cost the record: the cap is retried on the next append.
        await this.rollIfOver().catch(() => {});
        await appendFile(this.path, line, { encoding: "utf8" });
      } catch {
        this.seq--; // the write didn't land — don't burn the sequence number
      }
    });
  }

  drain(): Promise<void> {
    return this.queue.drain();
  }

  /** The retained history, oldest first: the previous generation's tail, then the live file's. */
  async readAll(): Promise<LogRecord[]> {
    const out: LogRecord[] = [];
    for (const path of [`${this.path}.old`, this.path]) {
      let raw: string;
      try {
        raw = await readTail(path, this.rollBytes * 2);
      } catch {
        continue;
      }
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line) as LogRecord);
        } catch {
          /* skip malformed */
        }
      }
    }
    return out;
  }
}
