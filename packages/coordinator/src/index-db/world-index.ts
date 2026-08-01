import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { WorldBundle } from "@arke-studio/contracts";
import { toExtendedLength } from "../world/paths.js";
import { extract, type Extraction } from "./citations.js";
import { assertFts5, loadNodeSqlite, type Database, type DatabaseCtor } from "./sqlite.js";

/**
 * The per-world index at `.index/world.db` (SPEC-003 §2.2–§2.5): a rebuildable cache,
 * structurally prevented from becoming a source of truth. Populated only from the bundle,
 * which is itself derived only from the world folder (D1). Deleting it costs nothing but a
 * rebuild (R-1); corruption is discarded, never surfaced (R-4, D7).
 */

// v2: canon_fts excludes open threads and retired entries (SPEC-006 R-16/R-19).
// v3: sheet-link citations extracted for reverse relationship lookup (SPEC-007 R-4).
// The bump is what forces existing indexes to rebuild — derivation changes are schema changes.
const SCHEMA_VERSION = 3;

const DDL = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS entities(
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT,
  version INTEGER,
  retired INTEGER NOT NULL DEFAULT 0,
  production_id TEXT,
  updated_at TEXT,
  PRIMARY KEY (kind, id, production_id)
);
CREATE TABLE IF NOT EXISTS citations(
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_version INTEGER,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_version INTEGER,
  relation TEXT NOT NULL,
  production_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_cit_target ON citations(target_id, relation);
CREATE INDEX IF NOT EXISTS idx_cit_source ON citations(source_kind, source_id);
CREATE TABLE IF NOT EXISTS takes(
  id TEXT PRIMARY KEY,
  production_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  canon_revision INTEGER NOT NULL,
  review TEXT,
  estimated_micro_usd INTEGER NOT NULL,
  actual_micro_usd INTEGER,
  dispatched_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS take_shots(take_id TEXT NOT NULL, shot_id TEXT NOT NULL, production_id TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_take_shots ON take_shots(shot_id, production_id);
CREATE TABLE IF NOT EXISTS take_sheets(take_id TEXT NOT NULL, sheet_id TEXT NOT NULL, sheet_version INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_take_sheets ON take_sheets(sheet_id, sheet_version);
CREATE VIRTUAL TABLE IF NOT EXISTS canon_fts USING fts5(entry_id UNINDEXED, title, statement);
`;

/** Stable fingerprint of everything the index derives from — the staleness signal (R-3). */
export function bundleFingerprint(bundle: WorldBundle): string {
  const durable = {
    meta: bundle.meta,
    sheets: bundle.sheets,
    canon: bundle.canon,
    referenceKits: bundle.referenceKits,
    artifacts: bundle.artifacts,
    productions: bundle.productions,
  };
  return createHash("sha256").update(JSON.stringify(durable)).digest("hex");
}

const WORLD_ENTITY_KINDS = ["character", "location", "faction", "canon"] as const;

export class WorldIndex {
  private constructor(
    readonly db: Database,
    private readonly path: string,
  ) {}

  /**
   * Open (or build) the index for a scanned world. Rebuilds on schema mismatch, fingerprint
   * mismatch (files changed while closed — R-3) or corruption (R-4).
   */
  static open(worldDir: string, bundle: WorldBundle, sqlite?: DatabaseCtor): WorldIndex {
    const Database = sqlite ?? loadNodeSqlite();
    const dir = join(worldDir, ".index");
    const path = join(dir, "world.db");
    mkdirSync(toExtendedLength(dir), { recursive: true });

    const fingerprint = bundleFingerprint(bundle);
    for (let attempt = 0; attempt < 2; attempt++) {
      let db: Database | null = null;
      try {
        db = new Database(toExtendedLength(path));
        db.pragma("journal_mode = WAL");
        assertFts5(db);
        db.exec(DDL);
        const index = new WorldIndex(db, path);
        const schema = index.getMeta("schema_version");
        const stored = index.getMeta("fingerprint");
        if (schema !== String(SCHEMA_VERSION) || stored !== fingerprint) {
          index.rebuild(bundle, fingerprint);
        }
        return index;
      } catch {
        // Corrupt or unreadable: discard and rebuild — a cache is never worth recovering (D7).
        // The failed handle must close first, or Windows will refuse the delete.
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
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  /** Rebuild only if the world's durable content differs from what was indexed (R-3). */
  sync(bundle: WorldBundle): void {
    const fingerprint = bundleFingerprint(bundle);
    if (this.getMeta("fingerprint") !== fingerprint) this.rebuild(bundle, fingerprint);
  }

  /** Cold build: the definition of correctness — every other path must match it (§2.5). */
  rebuild(bundle: WorldBundle, fingerprint = bundleFingerprint(bundle)): void {
    const extraction = extract(bundle);
    this.db.transaction(() => {
      this.wipe();
      this.insertWorldEntities(extraction, () => true);
      this.insertProductionRows(extraction, () => true);
      this.insertFts(bundle, () => true);
      this.setMeta("schema_version", String(SCHEMA_VERSION));
      this.setMeta("world_id", bundle.meta.worldId);
      this.setMeta("fingerprint", fingerprint);
      this.setMeta("built_at", new Date().toISOString());
    })();
  }

  /**
   * Incremental update on commit (R-20, D6): re-derive from the freshly rescanned bundle and
   * replace only the slices the changed files own. Sheet/canon commits — the accept-gate hot
   * path — touch only their own rows; production-scoped files replace that production's slice.
   * Equality with a cold rebuild is tested, not assumed.
   */
  applyCommit(changedPaths: string[], bundle: WorldBundle): void {
    const worldEntityIds = new Set<string>();
    const productionIds = new Set<string>();
    let structural = false;

    for (const path of changedPaths) {
      let m = /^(?:characters|locations|factions|canon)\/(.+)\.md$/.exec(path);
      if (m) {
        worldEntityIds.add(m[1]!);
        continue;
      }
      m = /^productions\/([^/]+)\//.exec(path);
      if (m) {
        productionIds.add(m[1]!);
        continue;
      }
      if (path === "world.json") continue; // revision lives in world.json itself, not the index
      structural = true; // references/, artifacts/, or something unclassified
    }

    if (structural) {
      this.rebuild(bundle);
      return;
    }

    const extraction = extract(bundle);
    this.db.transaction(() => {
      if (worldEntityIds.size > 0) {
        const del = this.db.prepare("DELETE FROM entities WHERE id = ? AND kind IN ('character','location','faction','canon')");
        const delCit = this.db.prepare(
          "DELETE FROM citations WHERE source_id = ? AND source_kind IN ('character','location','faction','canon')",
        );
        const delFts = this.db.prepare("DELETE FROM canon_fts WHERE entry_id = ?");
        for (const id of worldEntityIds) {
          del.run(id);
          delCit.run(id);
          delFts.run(id);
        }
        this.insertWorldEntities(extraction, (id) => worldEntityIds.has(id));
        this.insertFts(bundle, (id) => worldEntityIds.has(id));
        // A cited entity's version may have moved: live-reference citations from unchanged
        // sources must follow (dispatch/tile rows are recorded truth and never move — R-8).
        this.refreshLiveTargetVersions(extraction, worldEntityIds);
      }
      if (productionIds.size > 0) {
        const delEnt = this.db.prepare("DELETE FROM entities WHERE production_id = ?");
        const delCit = this.db.prepare("DELETE FROM citations WHERE production_id = ?");
        const delTakes = this.db.prepare("DELETE FROM takes WHERE production_id = ?");
        const delTakeShots = this.db.prepare("DELETE FROM take_shots WHERE production_id = ?");
        const delTakeSheets = this.db.prepare(
          "DELETE FROM take_sheets WHERE take_id IN (SELECT take_id FROM take_shots WHERE production_id = ?)",
        );
        const delProd = this.db.prepare("DELETE FROM entities WHERE kind = 'production' AND id = ?");
        for (const id of productionIds) {
          delTakeSheets.run(id);
          delEnt.run(id);
          delCit.run(id);
          delTakes.run(id);
          delTakeShots.run(id);
          delProd.run(id);
        }
        this.insertProductionRows(extraction, (id) => productionIds.has(id));
      }
      this.setMeta("fingerprint", bundleFingerprint(bundle));
      this.setMeta("built_at", new Date().toISOString());
    })();
  }

  private wipe(): void {
    this.db.exec(
      "DELETE FROM entities; DELETE FROM citations; DELETE FROM takes; DELETE FROM take_shots; DELETE FROM take_sheets; DELETE FROM canon_fts;",
    );
  }

  private insertWorldEntities(extraction: Extraction, include: (id: string) => boolean): void {
    const insEntity = this.db.prepare(
      "INSERT OR REPLACE INTO entities(kind,id,name,status,version,retired,production_id,updated_at) VALUES (?,?,?,?,?,?,?,?)",
    );
    const insCitation = this.citationInsert();
    for (const e of extraction.entities) {
      if (!(WORLD_ENTITY_KINDS as readonly string[]).includes(e.kind)) continue;
      if (!include(e.id)) continue;
      insEntity.run(e.kind, e.id, e.name, e.status, e.version, e.retired ? 1 : 0, e.productionId, e.updatedAt);
    }
    for (const c of extraction.citations) {
      if (!(WORLD_ENTITY_KINDS as readonly string[]).includes(c.sourceKind)) continue;
      if (!include(c.sourceId)) continue;
      insCitation.run(c.sourceKind, c.sourceId, c.sourceVersion, c.targetKind, c.targetId, c.targetVersion, c.relation, c.productionId);
    }
  }

  private insertProductionRows(extraction: Extraction, include: (productionId: string) => boolean): void {
    const insEntity = this.db.prepare(
      "INSERT OR REPLACE INTO entities(kind,id,name,status,version,retired,production_id,updated_at) VALUES (?,?,?,?,?,?,?,?)",
    );
    const insCitation = this.citationInsert();
    for (const e of extraction.entities) {
      if (e.kind === "production" && include(e.id)) {
        insEntity.run(e.kind, e.id, e.name, e.status, e.version, e.retired ? 1 : 0, e.productionId, e.updatedAt);
      } else if ((e.kind === "scene" || e.kind === "shot") && e.productionId && include(e.productionId)) {
        insEntity.run(e.kind, e.id, e.name, e.status, e.version, e.retired ? 1 : 0, e.productionId, e.updatedAt);
      } else if (e.kind === "artifact" && include("__artifacts__")) {
        insEntity.run(e.kind, e.id, e.name, e.status, e.version, e.retired ? 1 : 0, e.productionId, e.updatedAt);
      }
    }
    for (const c of extraction.citations) {
      if (c.productionId !== null && include(c.productionId)) {
        insCitation.run(c.sourceKind, c.sourceId, c.sourceVersion, c.targetKind, c.targetId, c.targetVersion, c.relation, c.productionId);
      } else if (c.sourceKind === "artifact" && include("__artifacts__")) {
        insCitation.run(c.sourceKind, c.sourceId, c.sourceVersion, c.targetKind, c.targetId, c.targetVersion, c.relation, c.productionId);
      } else if (c.sourceKind === "reference-tile" && include("__references__")) {
        insCitation.run(c.sourceKind, c.sourceId, c.sourceVersion, c.targetKind, c.targetId, c.targetVersion, c.relation, c.productionId);
      }
    }
    const insTake = this.db.prepare(
      "INSERT OR REPLACE INTO takes(id,production_id,kind,provider,model,canon_revision,review,estimated_micro_usd,actual_micro_usd,dispatched_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    );
    const insTakeShot = this.db.prepare("INSERT INTO take_shots(take_id,shot_id,production_id) VALUES (?,?,?)");
    const insTakeSheet = this.db.prepare("INSERT INTO take_sheets(take_id,sheet_id,sheet_version) VALUES (?,?,?)");
    for (const t of extraction.takes) {
      if (!include(t.productionId)) continue;
      insTake.run(t.id, t.productionId, t.kind, t.provider, t.model, t.canonRevision, t.review, t.estimatedMicroUsd, t.actualMicroUsd, t.dispatchedAt);
      for (const s of t.shots) insTakeShot.run(t.id, s, t.productionId);
      for (const s of t.sheets) insTakeSheet.run(t.id, s.sheetId, s.sheetVersion);
    }
  }

  private insertFts(bundle: WorldBundle, include: (entryId: string) => boolean): void {
    const insFts = this.db.prepare("INSERT INTO canon_fts(entry_id, title, statement) VALUES (?,?,?)");
    for (const entry of bundle.canon) {
      // Open threads assert nothing — retrieving one would answer a question with the same
      // question (SPEC-006 R-16, D5). Retired entries resolve for old citations but must not
      // answer new questions (R-19, D9). Neither enters the searchable set, so the refusal's
      // "searched all N" stays honest.
      if (entry.status === "open" || entry.retired === true) continue;
      if (include(entry.id)) insFts.run(entry.id, entry.title, entry.body);
    }
  }

  private citationInsert() {
    return this.db.prepare(
      "INSERT INTO citations(source_kind,source_id,source_version,target_kind,target_id,target_version,relation,production_id) VALUES (?,?,?,?,?,?,?,?)",
    );
  }

  private refreshLiveTargetVersions(extraction: Extraction, changedIds: Set<string>): void {
    const upd = this.db.prepare(
      "UPDATE citations SET target_version = ? WHERE target_id = ? AND relation IN ('canon-rule','entry-link','artifact-link','scene-location','shot-cast','sheet-link')",
    );
    for (const e of extraction.entities) {
      if (!changedIds.has(e.id)) continue;
      if (e.version !== null && (WORLD_ENTITY_KINDS as readonly string[]).includes(e.kind)) {
        upd.run(e.version, e.id);
      }
    }
  }

  close(): void {
    this.db.close();
  }
}
