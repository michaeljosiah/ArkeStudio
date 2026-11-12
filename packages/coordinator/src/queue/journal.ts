import { appendFlushed } from "../flushed-append.js";
import { atomicWriteFile } from "../world/atomic.js";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { JobSchema, type Job } from "@arke-studio/contracts";
import { WriteQueue } from "../change-log.js";
import { NdjsonTail } from "../ndjson-tail.js";

/**
 * The job journal (SPEC-009 §2.2): `%APP_ROOT%\queue\jobs.jsonl`, append-only, global across
 * worlds. State is expressed as appended records, never mutation — a job's current state is
 * its latest record and its history stays readable. Every append is durable before the action
 * it authorises (D1, §2.2.1): write, file sync, close, then resolve. The WriteQueue
 * serialises these complete operations; an OS flush failure rejects the append.
 */
export interface JobStateStore {
  append(job: Job): Promise<void>;
  readHistory(): Promise<Job[]>;
  drain(): Promise<void>;
}

export class JobJournal implements JobStateStore {
  private readonly queue = new WriteQueue();
  private repaired = false;
  private readonly tail: NdjsonTail<Job>;

  constructor(readonly path: string) {
    this.tail = new NdjsonTail(path, (row) => JobSchema.parse(row));
  }

  /** Truncate a torn final line once (crash mid-write); complete records are never touched. */
  private async repairTail(): Promise<void> {
    if (this.repaired) return;
    this.repaired = true;
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch {
      return;
    }
    if (raw.length === 0 || raw.endsWith("\n")) return;
    const cut = raw.lastIndexOf("\n");
    const keep = cut === -1 ? "" : raw.slice(0, cut + 1);
    await atomicWriteFile(this.path, keep);
  }

  /** Durable append of one full job row. Resolves only after the bytes are down (R-1, D1). */
  append(job: Job): Promise<void> {
    const validated = JobSchema.parse(job);
    return this.queue.enqueue(async () => {
      await this.repairTail();
      await mkdir(dirname(this.path), { recursive: true });
      await appendFlushed(this.path, JSON.stringify(validated) + "\n");
    });
  }

  /**
   * Fold to current state: the latest record per job id, in first-seen (FIFO) order. A row whose
   * latest record carries `deletedAt` folds away entirely — the user dropped it from Activity, and
   * a deletion is expressed as an appended record like every other transition.
   */
  async readFolded(): Promise<Job[]> {
    const history = await this.readHistory();
    const byId = new Map<string, Job>();
    for (const job of history) byId.set(job.id, job);
    return [...byId.values()].filter((job) => job.deletedAt === undefined);
  }

  /**
   * Every valid durable row, for conservative migration of unsafe legacy retry histories. Read by
   * what the journal gained since the last read (issue 2792); foreign or torn lines are skipped,
   * never fatal, and a journal that cannot be read is an empty history, as it always was here.
   */
  async readHistory(): Promise<Job[]> {
    await this.queue.enqueue(() => this.repairTail());
    try {
      return [...(await this.tail.read()).entries];
    } catch {
      return [];
    }
  }

  drain(): Promise<void> {
    return this.queue.drain();
  }
}
