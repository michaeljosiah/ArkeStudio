import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { AudiobookActivitySchema, audiobookActivityLive, type AudiobookActivity, type AudiobookActivityUpdate } from "@arke-studio/contracts";
import { WriteQueue } from "../change-log.js";
import { appendFlushed } from "../flushed-append.js";
import { atomicWriteFile } from "../world/atomic.js";
import { toExtendedLength } from "../world/paths.js";

/** Durable operation progress; jobs and ledger remain the charge/recovery authority. */
export class AudiobookActivityJournal {
  private readonly queue = new WriteQueue();
  private readonly runs = new Map<string, AudiobookActivity>();
  constructor(private readonly path: string | undefined, private readonly publish: (run: AudiobookActivity) => void, private readonly now = () => new Date().toISOString()) {}

  async load(): Promise<AudiobookActivity[]> {
    if (!this.path) return [];
    let raw: string;
    try { raw = await readFile(toExtendedLength(this.path), "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const end = raw.lastIndexOf("\n") + 1;
    const loaded = new Map<string, AudiobookActivity>();
    for (const [index, line] of raw.slice(0, end).split("\n").entries()) {
      if (!line.trim()) continue;
      try { const parsed = AudiobookActivitySchema.parse(JSON.parse(line)); loaded.set(parsed.id, parsed); }
      catch { throw new Error(`Narration activity journal contains an unreadable complete record at line ${index + 1}.`); }
    }
    // Validate complete records before even repairing the tail: corrupted history is never
    // silently skipped, nor overwritten by an apparently successful recovery append.
    if (end !== raw.length) await atomicWriteFile(this.path, raw.slice(0, end));
    for (const [id, run] of loaded) this.runs.set(id, run);
    for (const run of this.runs.values()) if (audiobookActivityLive(run)) {
      await this.update(run.id, { phase: "interrupted", reason: "Studio restarted before this read finished." });
    }
    return this.all();
  }

  all(): AudiobookActivity[] { return [...this.runs.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 200); }

  update(id: string, patch: AudiobookActivityUpdate, initial?: Omit<AudiobookActivity, "phase" | "updatedAt" | "toMake" | "made" | "flagged" | "requests" | "request" | "estimatedMicroUsd" | "models" | "local" | "jobs">): Promise<void> {
    return this.queue.enqueue(async () => {
      const held = this.runs.get(id);
      // A price/consent proposal is not running work. Only the authorized start creates it.
      if (!held && (!initial || patch.toMake === undefined)) return;
      if (held && !audiobookActivityLive(held) && patch.phase === "stopping") return;
      const { job, ...change } = patch;
      if (held?.phase === "stopping" && change.phase && ["queued", "reading", "aligning"].includes(change.phase)) change.phase = "stopping";
      const jobs = held?.jobs ?? [];
      const next = AudiobookActivitySchema.parse({
        ...initial, phase: "queued", toMake: 0, made: 0, flagged: 0, requests: 0, request: 0,
        estimatedMicroUsd: 0, models: [], local: false, ...held, ...change,
        updatedAt: this.now(), jobs: job ? [...jobs.filter(ref => ref.id !== job.id), job] : jobs,
      });
      if (this.path) {
        await mkdir(toExtendedLength(dirname(this.path)), { recursive: true });
        await appendFlushed(this.path, JSON.stringify(next) + "\n");
      }
      this.runs.set(id, next);
      this.publish(next);
    });
  }

  drain(): Promise<void> { return this.queue.drain(); }
}
