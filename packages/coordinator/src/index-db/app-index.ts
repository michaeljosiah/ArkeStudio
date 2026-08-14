import { mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { JobSchema, LedgerEntrySchema, type Job, type LedgerEntry, type WorldSummary } from "@arke-studio/contracts";
import { readChanges } from "../world/change-writer.js";
import { toExtendedLength } from "../world/paths.js";
import { assertFts5, loadNodeSqlite, type Database, type DatabaseCtor } from "./sqlite.js";

/**
 * The app-level index at `%APP_ROOT%\.index\app.db` (SPEC-003 §2.2, R-5, R-6): the world
 * registry that lets the picker render without opening any world, plus jobs and ledger
 * mirrored from their append-only logs. Rebuildable from the logs and the worlds present —
 * deleting it can never lose spend history, because the logs are the truth.
 */

// v2: closed-world attention counts with their as-of stamp (SPEC-014 R-7, T-5/T-6).
// v3: the world's key art path, so a picker card can show the image the world actually has.
const SCHEMA_VERSION = 3;

const DDL = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS worlds(
  world_id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  logline TEXT,
  characters INTEGER NOT NULL,
  locations INTEGER NOT NULL,
  factions INTEGER NOT NULL,
  canon_entries INTEGER NOT NULL,
  productions INTEGER NOT NULL,
  attention_unreviewed INTEGER,
  attention_proposals INTEGER,
  attention_as_of TEXT,
  key_art TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs(
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL,
  production_id TEXT,
  target_kind TEXT NOT NULL,
  target_id TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  estimated_micro_usd INTEGER NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger(
  job_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  world_id TEXT NOT NULL,
  production_id TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  outcome TEXT NOT NULL,
  estimated_micro_usd INTEGER NOT NULL,
  actual_micro_usd INTEGER,
  actual_source TEXT
);
`;

export class AppIndex {
  private constructor(readonly db: Database) {}

  static open(appRoot: string, sqlite?: DatabaseCtor): AppIndex {
    const Database = sqlite ?? loadNodeSqlite();
    const dir = join(appRoot, ".index");
    const path = join(dir, "app.db");
    mkdirSync(toExtendedLength(dir), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      let db: Database | null = null;
      try {
        db = new Database(toExtendedLength(path));
        db.pragma("journal_mode = WAL");
        assertFts5(db);
        db.exec(DDL);
        const index = new AppIndex(db);
        if (index.getMeta("schema_version") !== String(SCHEMA_VERSION)) {
          /*
           * Dropped and rebuilt, not emptied.
           *
           * `CREATE TABLE IF NOT EXISTS` leaves an existing table exactly as it was, so a version
           * that adds a column found the old shape still in place and every insert failed on a
           * column that was not there. Emptying the rows hid that: the tables looked fine and
           * stayed permanently empty. This is a cache rebuilt from the logs and the worlds
           * present, so throwing the tables away costs nothing but the next scan.
           */
          db.exec("DROP TABLE IF EXISTS worlds; DROP TABLE IF EXISTS jobs; DROP TABLE IF EXISTS ledger;");
          db.exec(DDL);
          index.setMeta("schema_version", String(SCHEMA_VERSION));
          index.setMeta("seeded", "0");
        }
        return index;
      } catch {
        // The failed handle must close before the delete, or Windows refuses it (R-4).
        try {
          db?.close();
        } catch {
          /* already unusable */
        }
        for (const suffix of ["", "-wal", "-shm"]) {
          try {
            rmSync(toExtendedLength(`${path}${suffix}`), { force: true });
          } catch {
            /* best effort */
          }
        }
      }
    }
    throw new Error(`could not open or rebuild ${path}`);
  }

  private getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  // ---- world registry (R-6, D3) -------------------------------------------

  get seeded(): boolean {
    return this.getMeta("seeded") === "1";
  }

  markSeeded(): void {
    this.setMeta("seeded", "1");
  }

  upsertWorld(summary: WorldSummary): void {
    this.db
      .prepare(
        `INSERT INTO worlds(world_id,slug,name,logline,characters,locations,factions,canon_entries,productions,attention_unreviewed,attention_proposals,attention_as_of,key_art,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(world_id) DO UPDATE SET slug=excluded.slug,name=excluded.name,logline=excluded.logline,
           characters=excluded.characters,locations=excluded.locations,factions=excluded.factions,
           canon_entries=excluded.canon_entries,productions=excluded.productions,
           attention_unreviewed=excluded.attention_unreviewed,attention_proposals=excluded.attention_proposals,
           attention_as_of=excluded.attention_as_of,key_art=excluded.key_art,updated_at=excluded.updated_at`,
      )
      .run(
        summary.worldId,
        summary.slug,
        summary.name,
        summary.logline ?? null,
        summary.counts.characters,
        summary.counts.locations,
        summary.counts.factions,
        summary.counts.canonEntries,
        summary.counts.productions,
        summary.attention?.unreviewedTakes ?? null,
        summary.attention?.openProposals ?? null,
        summary.attention?.asOf ?? null,
        summary.keyArt,
        summary.updated,
      );
  }

  removeWorld(worldId: string): void {
    this.db.prepare("DELETE FROM worlds WHERE world_id = ?").run(worldId);
  }

  /** Registry rows validated only by cheap existence checks — no world is scanned (R-6). */
  listWorlds(worldsDir: string): WorldSummary[] {
    const rows = this.db.prepare("SELECT * FROM worlds ORDER BY updated_at DESC").all() as Array<{
      world_id: string;
      slug: string;
      name: string;
      logline: string | null;
      characters: number;
      locations: number;
      factions: number;
      canon_entries: number;
      productions: number;
      attention_unreviewed: number | null;
      attention_proposals: number | null;
      attention_as_of: string | null;
      key_art: string | null;
      updated_at: string;
    }>;
    const out: WorldSummary[] = [];
    for (const row of rows) {
      try {
        statSync(toExtendedLength(join(worldsDir, row.slug, "world.json")));
      } catch {
        this.removeWorld(row.world_id); // the folder is gone; the registry follows the truth
        continue;
      }
      out.push({
        worldId: row.world_id,
        slug: row.slug,
        name: row.name,
        ...(row.logline !== null ? { logline: row.logline } : {}),
        keyArt: row.key_art,
        counts: {
          characters: row.characters,
          locations: row.locations,
          factions: row.factions,
          canonEntries: row.canon_entries,
          productions: row.productions,
        },
        ...(row.attention_unreviewed !== null && row.attention_proposals !== null && row.attention_as_of !== null
          ? {
              attention: {
                unreviewedTakes: row.attention_unreviewed,
                openProposals: row.attention_proposals,
                asOf: row.attention_as_of,
              },
            }
          : {}),
        updated: row.updated_at,
      });
    }
    return out;
  }

  // ---- jobs and ledger, rebuilt from the append-only logs (R-5) -----------

  async rebuildFromLogs(jobsPath: string, ledgerPath: string): Promise<void> {
    const jobLines = await readChanges(jobsPath);
    const ledgerLines = await readChanges(ledgerPath);
    const jobs: Job[] = [];
    // A tombstone anywhere in the log removes that id for good — there is no un-delete — so the
    // ids are collected first and their rows skipped, whatever order the replay meets them in.
    const deleted = new Set<string>();
    for (const line of jobLines) {
      const parsed = JobSchema.safeParse(line);
      if (!parsed.success) continue;
      if (parsed.data.deletedAt !== undefined) deleted.add(parsed.data.id);
      jobs.push(parsed.data);
    }
    const entries: LedgerEntry[] = [];
    for (const line of ledgerLines) {
      const parsed = LedgerEntrySchema.safeParse(line);
      if (parsed.success) entries.push(parsed.data);
    }
    this.db.transaction(() => {
      this.db.exec("DELETE FROM jobs; DELETE FROM ledger;");
      for (const job of jobs) if (!deleted.has(job.id)) this.upsertJob(job);
      // The ledger is replayed whole: a deleted row is history the user dropped, not spend undone.
      for (const entry of entries) this.appendLedger(entry);
    })();
  }

  upsertJob(job: Job): void {
    this.db
      .prepare(
        `INSERT INTO jobs(id,world_id,production_id,target_kind,target_id,provider,model,status,estimated_micro_usd,error,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET status=excluded.status,error=excluded.error,updated_at=excluded.updated_at`,
      )
      .run(
        job.id,
        job.worldId,
        job.productionId ?? null,
        job.target.kind,
        job.target.id ?? null,
        job.provider,
        job.model,
        job.status,
        job.estimatedMicroUsd,
        job.error,
        job.createdAt,
        job.updatedAt,
      );
  }

  appendLedger(entry: LedgerEntry): void {
    this.db
      .prepare(
        "INSERT INTO ledger(job_id,ts,world_id,production_id,provider,model,outcome,estimated_micro_usd,actual_micro_usd,actual_source) VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        entry.jobId,
        entry.ts,
        entry.worldId,
        entry.productionId ?? null,
        entry.provider,
        entry.model,
        entry.outcome,
        entry.estimatedMicroUsd,
        entry.actualMicroUsd,
        entry.actualSource ?? null,
      );
  }

  /** Ledger aggregation (R-15): actual where reported, estimate otherwise — labelled by the caller. */
  spendByProvider(): Array<{ provider: string; microUsd: number; entries: number }> {
    return this.db
      .prepare(
        "SELECT provider, SUM(COALESCE(actual_micro_usd, estimated_micro_usd)) AS microUsd, COUNT(*) AS entries FROM ledger GROUP BY provider ORDER BY microUsd DESC",
      )
      .all() as Array<{ provider: string; microUsd: number; entries: number }>;
  }

  spendByWeek(): Array<{ week: string; microUsd: number }> {
    return this.db
      .prepare(
        "SELECT strftime('%Y-W%W', ts) AS week, SUM(COALESCE(actual_micro_usd, estimated_micro_usd)) AS microUsd FROM ledger GROUP BY week ORDER BY week DESC",
      )
      .all() as Array<{ week: string; microUsd: number }>;
  }

  close(): void {
    this.db.close();
  }
}
