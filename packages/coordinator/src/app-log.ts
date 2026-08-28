import { appendFile, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { DIAGNOSTICS_LOG_TAIL_RECORDS } from "@arke-studio/contracts";
import { WriteQueue } from "./change-log.js";
import { redactDeep, type SecretRegistry } from "./redact.js";

/**
 * The app-level operational log at `%APP_ROOT%\logs\app.jsonl` (SPEC-008 R-7): provider
 * faults, validation runs, threshold alerts. Every record passes through the redaction
 * boundary on the way in — there is no unredacted write path to this file.
 */

const TAIL_CHUNK_BYTES = 64 * 1024;

/**
 * At most `maxLines` complete lines from the end of the file, without loading it whole
 * (SPEC-032 R-18): the log grows for the life of an install, and the old read-then-slice
 * paid the whole file to answer for its last hundred lines.
 *
 * Chunks are read backwards and prepended until the buffer holds one newline more than the
 * bound — the extra one is the proof that every counted line below it is whole. Decoding
 * happens once, over the accumulated buffer, so a multi-byte character split between chunks
 * never lands on a decode boundary; the front edge is cut at a newline, which is single-byte
 * in UTF-8, so that cut is character-aligned too.
 */
async function readLastLines(path: string, maxLines: number): Promise<string[]> {
  const handle = await open(path, "r");
  try {
    const size = (await handle.stat()).size;
    if (size === 0 || maxLines <= 0) return [];
    let position = size;
    const chunks: Buffer[] = [];
    let newlines = 0;
    while (position > 0 && newlines <= maxLines) {
      const length = Math.min(TAIL_CHUNK_BYTES, position);
      position -= length;
      const wanted = Buffer.alloc(length);
      // In-bounds reads of a regular file fill the request; honour bytesRead anyway so a
      // short read can never decode alloc'd zeroes as content.
      const { bytesRead } = await handle.read(wanted, 0, length, position);
      const chunk = bytesRead === length ? wanted : wanted.subarray(0, bytesRead);
      for (const byte of chunk) if (byte === 0x0a) newlines += 1;
      chunks.unshift(chunk);
    }
    let text = Buffer.concat(chunks).toString("utf8");
    if (position > 0) {
      // Stopped mid-file: everything before the first newline is the tail of a line whose head
      // was never read. It is not a record; drop it.
      const firstBreak = text.indexOf("\n");
      text = firstBreak < 0 ? "" : text.slice(firstBreak + 1);
    }
    const lines = text.split("\n").filter((line) => line.trim().length > 0);
    return lines.slice(-maxLines);
  } finally {
    await handle.close();
  }
}

export class AppLog {
  private readonly queue = new WriteQueue();

  constructor(
    private readonly path: string,
    private readonly registry: SecretRegistry,
    /** Called after a record actually lands, so a derived reader can re-read (SPEC-032 R-33). */
    private readonly onAppended?: () => void,
  ) {}

  append(record: Record<string, unknown>): Promise<void> {
    return this.queue.enqueue(async () => {
      const redacted = redactDeep({ at: new Date().toISOString(), ...record }, this.registry);
      try {
        await mkdir(dirname(this.path), { recursive: true });
        await appendFile(this.path, JSON.stringify(redacted) + "\n", "utf8");
      } catch {
        /* an unwritable log degrades audit, never the app */
        return;
      }
      try {
        this.onAppended?.();
      } catch {
        /* a listener's failure must not stall the write queue */
      }
    });
  }

  drain(): Promise<void> {
    return this.queue.drain();
  }

  /** The recent tail, for diagnostics — already redacted at write time, scrubbed again on read. */
  async tail(lines: number): Promise<string[]> {
    try {
      const raw = await readLastLines(this.path, lines);
      return raw.map((line) => this.registry.scrub(line));
    } catch {
      return [];
    }
  }

  /**
   * The derivation's tail (SPEC-032 R-18): bounded at the contract's 500 records — the bound is
   * this method's, never a caller argument — parsed, as written. Records were redacted at
   * write time; text carried out of them into a finding passes the derivation's redaction
   * boundary, which is the scrub that can also RECORD that it altered something (R-13) — a
   * pre-scrub here would make that marker structurally unreachable. A log that does not exist
   * yet is a log with nothing in it; any other failure is a source the derivation must name
   * unavailable rather than read as quiet (R-19, R-21).
   */
  async diagnosticsTail(): Promise<ReadonlyArray<Record<string, unknown>> | "unavailable"> {
    let raw: string[];
    try {
      raw = await readLastLines(this.path, DIAGNOSTICS_LOG_TAIL_RECORDS);
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "ENOENT" ? [] : "unavailable";
    }
    const records: Array<Record<string, unknown>> = [];
    for (const line of raw) {
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          records.push(parsed as Record<string, unknown>);
        }
      } catch {
        /* a torn line is not a record */
      }
    }
    return records;
  }
}
