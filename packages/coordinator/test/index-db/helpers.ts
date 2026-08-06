import type { WorldBundle } from "@arke-studio/contracts";
import type { Database } from "../../src/index-db/sqlite.js";
import { scanWorld } from "../../src/world/scan.js";
import { FIXTURE_WORLD } from "../world/helpers.js";

export async function fixtureBundle(): Promise<WorldBundle> {
  return (await scanWorld(FIXTURE_WORLD)).bundle;
}

/** Deterministic dump of every derived table — the equality basis for the cache contract. */
export function dumpIndex(db: Database): Record<string, unknown[]> {
  const all = (sql: string) => db.prepare(sql).all();
  return {
    entities: all("SELECT * FROM entities ORDER BY kind, id, production_id"),
    citations: all(
      "SELECT * FROM citations ORDER BY source_kind, source_id, relation, target_id, target_version",
    ),
    takes: all("SELECT * FROM takes ORDER BY id"),
    take_shots: all("SELECT * FROM take_shots ORDER BY take_id, shot_id"),
    take_sheets: all("SELECT * FROM take_sheets ORDER BY take_id, sheet_id"),
    canon_fts: all("SELECT entry_id, title, statement FROM canon_fts ORDER BY entry_id"),
    sheet_fts: all("SELECT sheet_id, kind, name, descriptor, body FROM sheet_fts ORDER BY sheet_id"),
  };
}
