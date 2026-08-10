import type { Job, RippleItem, WorldBundle } from "@arke-studio/contracts";
import type { Database } from "./sqlite.js";

/**
 * The named query surface (SPEC-003 §2.8, D9). Callers above this spec never write SQL —
 * the ripple queries are correctness-critical and live here, specified and tested once.
 */

// ---------------------------------------------------------------------------
// Search and the refusal floor (§2.6)
// ---------------------------------------------------------------------------

export interface CanonCandidate {
  entryId: string;
  title: string;
  /** Full statement text so a caller can verify quoted excerpts (R-23). */
  statement: string;
  /** Higher is better (negated bm25). */
  score: number;
}

export interface CanonSearchResult {
  /** How many entries were searched — the refusal state says it out loud (R-18). */
  searched: number;
  /**
   * True when at least one candidate cleared the floor. Clearing the floor is NOT evidence
   * any candidate answers the question — grounding verification settles that (R-17).
   */
  floorCleared: boolean;
  /** Above-floor candidates when cleared; the closest-scoring entries regardless when not. */
  candidates: CanonCandidate[];
}

/**
 * Conservative default floor on the negated-bm25 score. A product decision wearing a
 * technical costume (§2.6): configuration until a real world's question set calibrates it.
 */
export const DEFAULT_RELEVANCE_FLOOR = 0.3;

/**
 * Column weights for `canon_fts(entry_id UNINDEXED, title, statement)`.
 *
 * The leading zero is load-bearing. FTS5 counts bm25 weights positionally across *every* column,
 * including UNINDEXED ones, so a two-weight list puts its first weight on `entry_id` — which
 * never matches, so the weight is simply discarded — and leaves both real columns at 1.0. That
 * is what this call did until now: the intended title boost was silently absent, and a title
 * match ranked no higher than a passing mention in somebody else's statement.
 *
 * Nothing about the call site shows that. It is written here so the next person to add a column
 * or tune a weight has the trap in front of them.
 */
const CANON_WEIGHTS = "0.0, 5.0, 1.0";

/** Escape user text into an FTS5 OR-query over its word tokens. */
export function ftsQuery(input: string): string | null {
  const tokens = input
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .map((t) => t.replaceAll("'", ""))
    .filter((t) => t.length > 1);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"`).join(" OR ");
}

export function searchCanon(
  db: Database,
  query: string,
  opts: { limit?: number; floor?: number } = {},
): CanonSearchResult {
  const limit = opts.limit ?? 8;
  const floor = opts.floor ?? DEFAULT_RELEVANCE_FLOOR;
  const searched = (db.prepare("SELECT COUNT(*) AS n FROM canon_fts").get() as { n: number }).n;
  const match = ftsQuery(query);
  if (match === null) return { searched, floorCleared: false, candidates: [] };

  const rows = db
    .prepare(
      `SELECT entry_id AS entryId, title, statement, -bm25(canon_fts, ${CANON_WEIGHTS}) AS score FROM canon_fts WHERE canon_fts MATCH ? ORDER BY score DESC LIMIT ?`,
    )
    .all(match, limit) as CanonCandidate[];

  const above = rows.filter((r) => r.score >= floor);
  if (above.length > 0) return { searched, floorCleared: true, candidates: above };
  // Below the floor: refusal — with the closest-scoring entries as receipts, and no model
  // call anywhere in this path (D8).
  return { searched, floorCleared: false, candidates: rows.slice(0, 3) };
}

export interface SheetCandidate {
  sheetId: string;
  kind: string;
  name: string;
  /** Role for a character, region for a location — what tells two similar names apart. */
  descriptor: string;
  score: number;
}

export interface SheetSearchResult {
  searched: number;
  floorCleared: boolean;
  candidates: SheetCandidate[];
}

/**
 * Lexical search over accepted sheets (#70 §9.2).
 *
 * Same bounded discipline as `searchCanon`: a floor, an honest `searched` count, and the closest
 * few as receipts when nothing clears it. The question this answers is "is this person already
 * written down?", so a name match outranks a passing mention in someone else's prose.
 *
 * The weights are positional over *every* column, including the UNINDEXED ones, which is why the
 * two leading zeros are here rather than omitted — a weight list that skips them silently shifts
 * onto the wrong columns.
 */
export function searchSheets(
  db: Database,
  query: string,
  opts: { kind?: string; limit?: number; floor?: number; production?: string } = {},
): SheetSearchResult {
  const limit = opts.limit ?? 8;
  const floor = opts.floor ?? DEFAULT_RELEVANCE_FLOOR;
  // The visible corpus (SPEC-020 R-7): the world's own sheets, plus this production's guests
  // when asked from inside one. `IS NOT` rather than `<>` so the bound NULL of a world-level
  // caller compares rather than swallowing the row — `owner_production <> NULL` is never true,
  // and every guest would stay in the corpus.
  const visible =
    "sheet_id NOT IN (SELECT id FROM entities WHERE owner_production IS NOT NULL AND owner_production IS NOT ?)";
  const scope = opts.production ?? null;
  // `searched` counts the same corpus the search ran over. A scoped search reporting the whole
  // world's total would make "searched all 40" a lie in the one place the product promises it.
  const searched = (
    opts.kind === undefined
      ? (db.prepare(`SELECT COUNT(*) AS n FROM sheet_fts WHERE ${visible}`).get(scope) as { n: number })
      : (db
          .prepare(`SELECT COUNT(*) AS n FROM sheet_fts WHERE kind = ? AND ${visible}`)
          .get(opts.kind, scope) as { n: number })
  ).n;
  const match = ftsQuery(query);
  if (match === null) return { searched, floorCleared: false, candidates: [] };

  const select = `SELECT sheet_id AS sheetId, kind, name, descriptor, -bm25(sheet_fts, 0.0, 0.0, 8.0, 3.0, 1.0) AS score FROM sheet_fts WHERE sheet_fts MATCH ? AND ${visible}`;
  const rows = (
    opts.kind === undefined
      ? db.prepare(`${select} ORDER BY score DESC LIMIT ?`).all(match, scope, limit)
      : db.prepare(`${select} AND kind = ? ORDER BY score DESC LIMIT ?`).all(match, scope, opts.kind, limit)
  ) as SheetCandidate[];

  const above = rows.filter((r) => r.score >= floor);
  if (above.length > 0) return { searched, floorCleared: true, candidates: above };
  return { searched, floorCleared: false, candidates: rows.slice(0, 3) };
}

/** Ranked lexical overlap for a proposed entry — an aid for human judgement, never a block (R-19, D11). */
export function contradictionCandidates(
  db: Database,
  proposed: { title: string; statement: string; excludeEntryId?: string },
  limit = 3,
): CanonCandidate[] {
  const match = ftsQuery(`${proposed.title} ${proposed.statement}`);
  if (match === null) return [];
  const rows = db
    .prepare(
      `SELECT entry_id AS entryId, title, statement, -bm25(canon_fts, ${CANON_WEIGHTS}) AS score FROM canon_fts WHERE canon_fts MATCH ? ORDER BY score DESC LIMIT ?`,
    )
    .all(match, limit + 1) as CanonCandidate[];
  return rows.filter((r) => r.entryId !== proposed.excludeEntryId).slice(0, limit);
}

// ---------------------------------------------------------------------------
// Reference queries (R-11, R-12)
// ---------------------------------------------------------------------------

export interface SheetRefs {
  tiles: number;
  productions: string[];
  artifacts: string[];
  scenes: string[];
  /** takes dispatched against each version of this sheet. */
  takesByVersion: Record<number, number>;
}

export function refsForSheet(db: Database, sheetId: string): SheetRefs {
  const tiles = (
    db.prepare("SELECT COUNT(*) AS n FROM citations WHERE target_id = ? AND relation = 'tile-source'").get(sheetId) as { n: number }
  ).n;
  const productions = (
    db
      .prepare(
        "SELECT DISTINCT production_id AS id FROM citations WHERE target_id = ? AND production_id IS NOT NULL ORDER BY id",
      )
      .all(sheetId) as Array<{ id: string }>
  ).map((r) => r.id);
  const artifacts = (
    db
      .prepare("SELECT DISTINCT source_id AS id FROM citations WHERE target_id = ? AND relation = 'artifact-link' ORDER BY id")
      .all(sheetId) as Array<{ id: string }>
  ).map((r) => r.id);
  const scenes = (
    db
      .prepare(
        "SELECT DISTINCT source_id AS id FROM citations WHERE target_id = ? AND relation IN ('shot-cast','scene-location') ORDER BY id",
      )
      .all(sheetId) as Array<{ id: string }>
  ).map((r) => r.id);
  const takesByVersion: Record<number, number> = {};
  for (const row of db
    .prepare("SELECT sheet_version AS v, COUNT(*) AS n FROM take_sheets WHERE sheet_id = ? GROUP BY sheet_version")
    .all(sheetId) as Array<{ v: number; n: number }>) {
    takesByVersion[row.v] = row.n;
  }
  return { tiles, productions, artifacts, scenes, takesByVersion };
}

export interface CanonRefs {
  sheets: Array<{ id: string; atVersion: number | null }>;
  entries: string[];
  productions: string[];
  takesByRevision: Record<number, number>;
}

export function refsForCanon(db: Database, entryId: string): CanonRefs {
  const sheets = (
    db
      .prepare(
        "SELECT source_id AS id, source_version AS atVersion FROM citations WHERE target_id = ? AND relation = 'canon-rule' ORDER BY id",
      )
      .all(entryId) as Array<{ id: string; atVersion: number | null }>
  ).map((r) => ({ id: r.id, atVersion: r.atVersion }));
  const entries = (
    db
      .prepare("SELECT DISTINCT source_id AS id FROM citations WHERE target_id = ? AND relation = 'entry-link' ORDER BY id")
      .all(entryId) as Array<{ id: string }>
  ).map((r) => r.id);
  const productions = (
    db
      .prepare(
        "SELECT DISTINCT production_id AS id FROM citations WHERE target_id = ? AND production_id IS NOT NULL ORDER BY id",
      )
      .all(entryId) as Array<{ id: string }>
  ).map((r) => r.id);
  const takesByRevision: Record<number, number> = {};
  for (const row of db
    .prepare(
      "SELECT target_version AS v, COUNT(*) AS n FROM citations WHERE relation = 'dispatch' AND target_kind = 'canon' GROUP BY target_version",
    )
    .all() as Array<{ v: number; n: number }>) {
    takesByRevision[row.v] = row.n;
  }
  return { sheets, entries, productions, takesByRevision };
}

// ---------------------------------------------------------------------------
// Ripples (R-13) — computed from the index alone, never asked of a model
// ---------------------------------------------------------------------------

export function ripplesForSheet(
  db: Database,
  input: { sheetId: string; sheetName: string; newVersion: number },
): RippleItem[] {
  const { sheetId, sheetName, newVersion } = input;
  const items: RippleItem[] = [];

  const staleTiles = db
    .prepare(
      "SELECT source_id AS id FROM citations WHERE target_id = ? AND relation = 'tile-source' AND target_version < ? ORDER BY id",
    )
    .all(sheetId, newVersion) as Array<{ id: string }>;
  if (staleTiles.length > 0) {
    items.push({
      kind: "stale-reference-tiles",
      summary: `${staleTiles.length} reference tile${staleTiles.length === 1 ? "" : "s"} predate v${newVersion} — regenerate looks after accept`,
      targets: staleTiles.map((t) => `references/${t.id}`),
    });
  }

  const productions = db
    .prepare(
      "SELECT DISTINCT production_id AS id FROM citations WHERE target_id = ? AND relation = 'shot-cast' AND production_id IS NOT NULL ORDER BY id",
    )
    .all(sheetId) as Array<{ id: string }>;
  if (productions.length > 0) {
    items.push({
      kind: "productions-pick-up",
      summary: `${productions.length} production${productions.length === 1 ? "" : "s"} cast ${sheetName} — their next dispatch picks up v${newVersion}`,
      targets: productions.map((p) => p.id),
    });
  }

  const scenes = db
    .prepare(
      `SELECT DISTINCT e.id AS id FROM citations c
       JOIN entities e ON e.kind = 'scene' AND e.production_id = c.production_id
       JOIN entities sh ON sh.kind = 'shot' AND sh.id = c.source_id AND sh.production_id = c.production_id
       WHERE c.target_id = ? AND c.relation = 'shot-cast' ORDER BY id`,
    )
    .all(sheetId) as Array<{ id: string }>;
  if (scenes.length > 0) {
    items.push({
      kind: "scene-briefs-rerender",
      summary: `${scenes.length} scene brief${scenes.length === 1 ? "" : "s"} re-render their cast block`,
      targets: scenes.map((s) => s.id),
    });
  }

  const rules = db
    .prepare("SELECT target_id AS id FROM citations WHERE source_id = ? AND relation = 'canon-rule' ORDER BY id")
    .all(sheetId) as Array<{ id: string }>;
  if (rules.length > 0) {
    items.push({
      kind: "owning-canon-rules",
      summary: `${rules.length === 1 ? `${rules[0]!.id} owns` : `${rules.length} canon entries own`} this sheet's rules — the edit must not restate them`,
      targets: rules.map((r) => r.id),
    });
  }

  const pinned = db
    .prepare(
      `SELECT ts.take_id AS id FROM take_sheets ts JOIN takes t ON t.id = ts.take_id
       WHERE ts.sheet_id = ? AND ts.sheet_version < ? AND t.review = 'accepted' ORDER BY id`,
    )
    .all(sheetId, newVersion) as Array<{ id: string }>;
  if (pinned.length > 0) {
    items.push({
      kind: "takes-pinned-to-old-version",
      summary: `${pinned.length} accepted take${pinned.length === 1 ? " stays" : "s stay"} pinned to the version they were made with; the cut keeps playing them`,
      targets: pinned.map((p) => p.id),
    });
  }

  return items;
}

export function ripplesForCanonEntry(
  db: Database,
  input: { entryId?: string; title: string; statement: string },
): RippleItem[] {
  const items: RippleItem[] = [];

  const candidates = contradictionCandidates(db, {
    title: input.title,
    statement: input.statement,
    ...(input.entryId !== undefined ? { excludeEntryId: input.entryId } : {}),
  });
  if (candidates.length > 0) {
    items.push({
      kind: "contradiction-candidates",
      summary: `${candidates.length} existing entr${candidates.length === 1 ? "y shares" : "ies share"} this vocabulary — check for conflict; judgement is yours, nothing blocks`,
      targets: candidates.map((c) => c.entryId),
    });
  }

  if (input.entryId) {
    const gains = db
      .prepare("SELECT DISTINCT source_id AS id FROM citations WHERE target_id = ? AND relation = 'entry-link' ORDER BY id")
      .all(input.entryId) as Array<{ id: string }>;
    if (gains.length > 0) {
      items.push({
        kind: "gains-cross-reference",
        summary: `${gains.length} entr${gains.length === 1 ? "y links" : "ies link"} here and gain the amended text`,
        targets: gains.map((g) => g.id),
      });
    }
  }

  const productions = db
    .prepare("SELECT id FROM entities WHERE kind = 'production' ORDER BY id")
    .all() as Array<{ id: string }>;
  if (productions.length > 0) {
    items.push({
      kind: "productions-see-new-revision",
      summary: `${productions.length} production${productions.length === 1 ? "" : "s"} see the new revision on their next dispatch`,
      targets: productions.map((p) => p.id),
    });
  }

  return items;
}

// ---------------------------------------------------------------------------
// Needs-you (R-14) — computed, never stored
// ---------------------------------------------------------------------------

export interface NeedsYouItem {
  kind: "proposal" | "review" | "failed-job" | "needs-reconciliation" | "external-edit";
  summary: string;
  count: number;
}

export function needsYou(bundle: WorldBundle | null, jobs: Job[]): NeedsYouItem[] {
  const items: NeedsYouItem[] = [];
  if (bundle) {
    if (bundle.proposals.length > 0) {
      items.push({
        kind: "proposal",
        summary: `${bundle.proposals.length} proposal${bundle.proposals.length === 1 ? "" : "s"} awaiting a decision`,
        count: bundle.proposals.length,
      });
    }
    let pendingReviews = 0;
    for (const production of bundle.productions) {
      const decided = new Set(production.reviews.map((r) => r.takeId));
      pendingReviews += production.takes.filter((t) => !decided.has(t.id)).length;
    }
    if (pendingReviews > 0) {
      items.push({
        kind: "review",
        summary: `${pendingReviews} take${pendingReviews === 1 ? "" : "s"} awaiting review`,
        count: pendingReviews,
      });
    }
    if (bundle.externalEdits.length > 0) {
      items.push({
        kind: "external-edit",
        summary: `${bundle.externalEdits.length} file${bundle.externalEdits.length === 1 ? "" : "s"} changed outside the app`,
        count: bundle.externalEdits.length,
      });
    }
  }
  const failed = jobs.filter((j) => j.status === "failed").length;
  if (failed > 0) {
    items.push({ kind: "failed-job", summary: `${failed} job${failed === 1 ? "" : "s"} failed`, count: failed });
  }
  const unreconciled = jobs.filter((j) => j.status === "needs-reconciliation").length;
  if (unreconciled > 0) {
    items.push({
      kind: "needs-reconciliation",
      summary: `${unreconciled} job${unreconciled === 1 ? "" : "s"} of unknown remote state need you`,
      count: unreconciled,
    });
  }
  return items;
}
