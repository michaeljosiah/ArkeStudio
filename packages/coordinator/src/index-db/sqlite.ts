import { createRequire } from "node:module";
import type BetterSqlite3 from "better-sqlite3";

/**
 * The SQLite binding seam (SPEC-003 R-7, §2.9).
 *
 * better-sqlite3 is a native module: tests and the dev coordinator load the Node-ABI build,
 * while the Electron main process must load an Electron-ABI build. The index code therefore
 * never requires the module directly — it takes a constructor, and the desktop shell injects
 * its own copy (aliased `better-sqlite3-electron`, rebuilt by @electron/rebuild).
 */

export type DatabaseCtor = typeof BetterSqlite3;
export type Database = BetterSqlite3.Database;

let cached: DatabaseCtor | null = null;

/** Default loader for Node contexts (tests, dev coordinator). Lazy so bundlers can ignore it. */
export function loadNodeSqlite(): DatabaseCtor {
  if (!cached) {
    const require = createRequire(import.meta.url);
    cached = require("better-sqlite3") as DatabaseCtor;
  }
  return cached;
}

/** Prove FTS5 is present in the compiled SQLite (R-7) — called once per database open. */
export function assertFts5(db: Database): void {
  db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS temp.__fts5_probe USING fts5(x)");
  db.exec("DROP TABLE temp.__fts5_probe");
}
