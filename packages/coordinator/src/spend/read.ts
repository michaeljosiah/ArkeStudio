import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { BenchEventEnvelopeSchema, BenchSessionMetaSchema, JobSchema, LedgerEntrySchema, SessionIdSchema, foldBenchSession,
  type WorldBundle } from "@arke-studio/contracts";
import { productionSpend, type SpendEvidence } from "./rollups.js";

/** Analytics never repairs, truncates or appends its input files. A torn final row is incomplete. */
async function evidenceFile<T>(path: string | undefined, parse: (row: unknown) => T) {
  if (!path) return { entries: [] as T[], unavailable: true, incomplete: false };
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error) { return { entries: [] as T[], unavailable: !["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""), incomplete: false }; }
  const entries: T[] = [];
  let incomplete = false;
  for (const line of text.split("\n")) if (line.trim()) {
    try { entries.push(parse(JSON.parse(line))); } catch { incomplete = true; }
  }
  return { entries, unavailable: false, incomplete };
}

export async function readProductionSpend(input: { world: WorldBundle; worldDir: string; ledgerPath?: string; jobsPath?: string }) {
  const [ledger, history] = await Promise.all([
    evidenceFile(input.ledgerPath, row => LedgerEntrySchema.parse(row)),
    evidenceFile(input.jobsPath, row => JobSchema.parse(row)),
  ]);
  const bench: SpendEvidence["bench"][number][] = [];
  let benchIncomplete = false;
  const root = join(input.worldDir, ".sessions");
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
        const events = await evidenceFile(join(dir, "events.jsonl"), row => BenchEventEnvelopeSchema.parse(row));
        benchIncomplete ||= events.incomplete || events.unavailable;
        // Deleted media remains produced history. The ordinary wall still folds deletion normally.
        const session = foldBenchSession(meta, events.entries.filter(row => row.event.type !== "take-deleted"));
        bench.push({ sessionId: directory.name, takes: session.takes });
      } catch { benchIncomplete = true; }
    }
  } catch (error) {
    benchIncomplete = !["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
  }
  // Missing sessions can hide production ownership on legacy Bench jobs. Never claim completeness.
  const knownSessions = new Set(bench.map(session => session.sessionId));
  if (history.entries.some(job => job.worldId === input.world.meta.worldId && job.target.kind === "bench-take" &&
    !knownSessions.has((job.target.id ?? "").split("/")[0]!))) benchIncomplete = true;
  return productionSpend(input.world, { ledger: ledger.entries, jobs: history.entries, bench,
    ledgerUnavailable: ledger.unavailable, historyUnavailable: history.unavailable,
    ledgerIncomplete: ledger.incomplete, historyIncomplete: history.incomplete, benchIncomplete });
}
