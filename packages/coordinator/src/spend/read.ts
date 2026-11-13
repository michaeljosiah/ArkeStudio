import { lstat, readFile, readdir } from "node:fs/promises";
import { NdjsonTail } from "../ndjson-tail.js";
import { join } from "node:path";
import { BenchEventEnvelopeSchema, BenchSessionMetaSchema, JobSchema, LedgerEntrySchema, SessionIdSchema, foldBenchSession,
  type Job, type WorldBundle } from "@arke-studio/contracts";
import { productionSpend, type SpendEvidence } from "./rollups.js";
import { readChapterSpendHistory } from "./chapter-history.js";

/**
 * One reader per file and schema, kept between passes. A pass runs after every finished job, ledger
 * append and Bench event, and it reread and parsed the ledger, the whole job journal and every
 * session log each time: about 450 ms at 5,000 jobs (issue 2792). Each now reads what was appended.
 * Bench logs belong to the world on screen, so a pass keeps only the ones it read: another world's
 * sessions are not held for the life of the process (codex on PR 2848).
 */
const tails = new Map<string, NdjsonTail<unknown>>();

/** Analytics never repairs, truncates or appends its input files. A torn final row is incomplete. */
async function evidenceFile<T>(path: string | undefined, kind: string, parse: (row: unknown) => T, used?: Set<string>) {
  if (!path) return { entries: [] as readonly T[], unavailable: true, incomplete: false, generation: -1 };
  const key = kind + ":" + path;
  used?.add(key);
  let tail = tails.get(key) as NdjsonTail<T> | undefined;
  if (!tail) tails.set(key, tail = new NdjsonTail(path, parse));
  try {
    const { entries, rejected, torn, generation } = await tail.read();
    return { entries, unavailable: false, incomplete: rejected > 0 || torn, generation };
  } catch (error) {
    return { entries: [] as readonly T[], unavailable: !["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""), incomplete: false, generation: -1 };
  }
}

/**
 * The journal holds a full row for every transition, six or more a job; the rollup and the session
 * check want each job's latest. Folded as rows arrive, in first-seen order like the Map they fill.
 */
const latestJobs = new Map<string, { generation: number; count: number; latest: Map<string, Job> }>();
function foldJobs(path: string | undefined, rows: readonly Job[], generation: number): Job[] {
  if (!path || generation < 0) return [];
  let fold = latestJobs.get(path);
  if (!fold || fold.generation !== generation) latestJobs.set(path, fold = { generation, count: 0, latest: new Map() });
  for (let i = fold.count; i < rows.length; i++) fold.latest.set(rows[i]!.id, rows[i]!);
  fold.count = rows.length;
  return [...fold.latest.values()];
}

export async function readProductionSpend(input: { world: WorldBundle; worldDir: string; ledgerPath?: string; jobsPath?: string }) {
  const [ledger, history, chapters] = await Promise.all([
    evidenceFile(input.ledgerPath, "ledger", row => LedgerEntrySchema.parse(row)),
    evidenceFile(input.jobsPath, "jobs", row => JobSchema.parse(row)),
    readChapterSpendHistory(input.world, input.worldDir),
  ]);
  const jobs = foldJobs(input.jobsPath, history.entries, history.generation);
  const bench: SpendEvidence["bench"][number][] = [];
  let benchIncomplete = false;
  const root = join(input.worldDir, ".sessions");
  const read = new Set<string>();
  try {
    if ((await lstat(root)).isSymbolicLink()) throw new Error("linked Bench history");
    const directories = await readdir(root, { withFileTypes: true });
    for (const directory of directories) {
      if (!SessionIdSchema.safeParse(directory.name).success) continue;
      if (!directory.isDirectory() || directory.isSymbolicLink()) { benchIncomplete = true; continue; }
      try {
        const dir = join(root, directory.name);
        const meta = BenchSessionMetaSchema.parse(JSON.parse(await readFile(join(dir, "session.json"), "utf8")));
        if (meta.id !== directory.name) throw new Error("Bench identity mismatch");
        const events = await evidenceFile(join(dir, "events.jsonl"), "bench", row => BenchEventEnvelopeSchema.parse(row), read);
        benchIncomplete ||= events.incomplete || events.unavailable;
        // Deleted media remains produced history. The ordinary wall still folds deletion normally.
        const session = foldBenchSession(meta, events.entries.filter(row => row.event.type !== "take-deleted"));
        bench.push({ sessionId: directory.name, takes: session.takes });
      } catch { benchIncomplete = true; }
    }
  } catch (error) {
    benchIncomplete = !["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
  }
  for (const key of tails.keys()) if (key.startsWith("bench:") && !read.has(key)) tails.delete(key);
  // Missing sessions can hide production ownership on legacy Bench jobs. Never claim completeness.
  const knownSessions = new Set(bench.map(session => session.sessionId));
  if (jobs.some(job => job.worldId === input.world.meta.worldId && job.target.kind === "bench-take" &&
    !knownSessions.has((job.target.id ?? "").split("/")[0]!))) benchIncomplete = true;
  return productionSpend(input.world, { ledger: ledger.entries, jobs, bench, chapters,
    ledgerUnavailable: ledger.unavailable, historyUnavailable: history.unavailable,
    ledgerIncomplete: ledger.incomplete, historyIncomplete: history.incomplete, benchIncomplete });
}
