import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { JobSchema, type Job } from "@arke-studio/contracts";
import { WriteQueue } from "../change-log.js";

/**
 * The job journal (SPEC-009 §2.2): `%APP_ROOT%\queue\jobs.jsonl`, append-only, global across
 * worlds. State is expressed as appended records, never mutation — a job's current state is
 * its latest record and its history stays readable. Every append is durable before the action
 * it authorises (D1): callers await the append, and the WriteQueue serialises writers.
 */
export class JobJournal {
  private readonly queue = new WriteQueue();
  private repaired = false;

  constructor(readonly path: string) {}

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
    const tmp = join(dirname(this.path), `.tmp-jobs-repair-${process.pid}`);
    await writeFile(tmp, keep, "utf8");
    await rename(tmp, this.path);
  }

  /** Durable append of one full job row. Resolves only after the bytes are down (R-1, D1). */
  append(job: Job): Promise<void> {
    const validated = JobSchema.parse(job);
    return this.queue.enqueue(async () => {
      await this.repairTail();
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, JSON.stringify(validated) + "\n", "utf8");
    });
  }

  /** Fold to current state: the latest record per job id, in first-seen (FIFO) order. */
  async readFolded(): Promise<Job[]> {
    await this.queue.enqueue(() => this.repairTail());
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch {
      return [];
    }
    const byId = new Map<string, Job>();
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const parsed = JobSchema.safeParse(JSON.parse(t));
        if (parsed.success) byId.set(parsed.data.id, parsed.data);
      } catch {
        /* foreign or torn line — skipped, never fatal */
      }
    }
    return [...byId.values()];
  }

  drain(): Promise<void> {
    return this.queue.drain();
  }
}
