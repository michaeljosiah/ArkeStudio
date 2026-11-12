import { open } from "node:fs/promises";

/**
 * An append-only NDJSON file read by what it gained since the last read (issue 2792). The ledger,
 * the job journal and the Bench logs are never compacted, and every finished job reread and
 * zod-parsed each of them whole: about 600 ms of main-thread work a job at 5,000 jobs.
 *
 * It keeps the file's identity and how far it has parsed. When the file is the same file and only
 * grew, it parses the complete lines after that point; anything else (a repair or replacement, a
 * new inode, a shrink, or a byte before the offset that is no longer a newline) is a full reread.
 * Bytes after the last newline are a torn or unfinished row: reported, not consumed, so a row that
 * completes later is parsed whole. Read failures are thrown, with the cache dropped, for the caller
 * to classify exactly as it did before: an unreadable file is still unknown, never empty.
 *
 * Reads only. Appends keep their own WriteQueue and flush order (SPEC-009 §2.2.1); a confirmed
 * append reaches the index on the next read, which parses just that row.
 */
export class NdjsonTail<T> {
  private state: { dev: bigint; ino: bigint; offset: number; entries: readonly T[]; rejected: number } | null = null;
  /** Changes whenever the rows are reread from the start, so an index knows to rebuild. */
  private generation = 0;

  constructor(readonly path: string, private readonly parse: (row: unknown) => T) {}

  /**
   * Every row that parsed, how many did not, whether a fragment trails the last newline, and the
   * generation: while it is unchanged, `entries` only ever grew, so an index can extend itself.
   */
  async read(): Promise<{ entries: readonly T[]; rejected: number; torn: boolean; generation: number }> {
    try {
      const handle = await open(this.path, "r");
      try {
        const stat = await handle.stat({ bigint: true });
        // Windows opens a directory for reading and calls it empty; readFile refused it everywhere,
        // and a ledger that is not a file is unreadable, not a quiet one (SPEC-032 R-21).
        if (!stat.isFile()) throw Object.assign(new Error(`EISDIR: not a file, read '${this.path}'`), { code: "EISDIR" });
        const size = Number(stat.size);
        let state = this.state;
        if (state && (state.dev !== stat.dev || state.ino !== stat.ino || size < state.offset || !(await endsLine(handle, state.offset)))) state = null;
        if (!state) {
          state = { dev: stat.dev, ino: stat.ino, offset: 0, entries: [], rejected: 0 };
          this.generation++;
        }
        let torn = false;
        if (size > state.offset) {
          const bytes = Buffer.alloc(size - state.offset);
          let read = 0;
          while (read < bytes.length) {
            const { bytesRead } = await handle.read(bytes, read, bytes.length - read, state.offset + read);
            if (bytesRead === 0) break;
            read += bytesRead;
          }
          const complete = bytes.lastIndexOf(10, read - 1) + 1;
          if (complete > 0) {
            const added: T[] = [];
            let rejected = 0;
            for (const line of bytes.toString("utf8", 0, complete).split("\n")) {
              const text = line.trim();
              if (!text) continue;
              try { added.push(this.parse(JSON.parse(text))); } catch { rejected++; }
            }
            // A new array, never a push: a caller may still hold the previous read's entries.
            state = { ...state, offset: state.offset + complete, entries: added.length > 0 ? [...state.entries, ...added] : state.entries,
              rejected: state.rejected + rejected };
          }
          torn = bytes.toString("utf8", complete, read).trim() !== "";
        }
        this.state = state;
        return { entries: state.entries, rejected: state.rejected, torn, generation: this.generation };
      } finally {
        await handle.close();
      }
    } catch (error) {
      this.state = null;
      throw error;
    }
  }
}

/** Whether the byte just before `offset` is still the newline the last read ended on. */
async function endsLine(handle: Awaited<ReturnType<typeof open>>, offset: number): Promise<boolean> {
  if (offset === 0) return true;
  const byte = Buffer.alloc(1);
  const { bytesRead } = await handle.read(byte, 0, 1, offset - 1);
  return bytesRead === 1 && byte[0] === 10;
}
