import {
  isGraphScene,
  SceneRecordSchema,
  structuralMeaning,
  type ProposalConflict,
  type SceneRecord,
} from "@arke-studio/contracts";
import { FrontmatterError, splitSections, type BodySection } from "../frontmatter.js";
import { MarkdownFile } from "../world/text-files.js";

/**
 * The field-level three-way merge (SPEC-004 §2.5, R-6, D3, D4).
 *
 * Entities are structured — frontmatter keys and named prose sections — so the merge unit is
 * a field, never a line. Disjoint edits merge silently; same-field edits are a conflict a
 * human resolves; and because merging picks whole values, the output cannot be the
 * half-spliced text a line merge produces. List fields merge as sets.
 */

/** Frontmatter keys merged as sets: order-stable union minus removals, never a conflict. */
const SET_FIELDS = new Set(["links", "canonRules"]);
/** Keys the commit primitive owns; they never merge and never conflict. */
const MACHINE_FIELDS = new Set(["version", "updated", "introducedAt", "settledAt", "amendedAt"]);

export interface MergeResult {
  merged: string;
  conflicts: ProposalConflict[];
  /** Fields taken from `theirs` — what the live world contributed to the merged result. */
  tookTheirs: string[];
}

// A deleted key and an explicit null are different edits: collapsing them made a deletion
// opposite a null silently vanish, with tookTheirs never recording that theirs-side deletions
// happened at all.
const asComparable = (v: unknown): string => (v === undefined ? "\u0000absent" : JSON.stringify(v));

function mergeSets(base: unknown, mine: unknown, theirs: unknown): unknown[] {
  const b = Array.isArray(base) ? base.map(String) : [];
  const m = Array.isArray(mine) ? mine.map(String) : [];
  const t = Array.isArray(theirs) ? theirs.map(String) : [];
  const removed = new Set([...b.filter((x) => !m.includes(x)), ...b.filter((x) => !t.includes(x))]);
  const out: string[] = [];
  for (const x of b) if (!removed.has(x)) out.push(x);
  for (const x of [...m, ...t]) if (!out.includes(x) && !b.includes(x)) out.push(x);
  return out;
}

function sectionMap(body: string): Map<string, string> | null {
  try {
    return new Map(splitSections(body).map((s: BodySection) => [s.heading, s.body]));
  } catch (err) {
    if (err instanceof FrontmatterError) return null; // canon-style plain body
    throw err;
  }
}

/**
 * Merge three versions of a frontmatter document at field granularity. `path` labels
 * conflicts; the caller persists them on the proposal manifest.
 */
export function mergeMarkdown(path: string, baseRaw: string, mineRaw: string, theirsRaw: string): MergeResult {
  const base = MarkdownFile.parse(baseRaw);
  const mine = MarkdownFile.parse(mineRaw);
  const theirs = MarkdownFile.parse(theirsRaw);
  const conflicts: ProposalConflict[] = [];
  const tookTheirs: string[] = [];

  // ---- frontmatter ---------------------------------------------------------
  const data: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(base.data), ...Object.keys(mine.data), ...Object.keys(theirs.data)]);
  for (const key of keys) {
    const b = base.data[key];
    const m = mine.data[key];
    const t = theirs.data[key];
    if (MACHINE_FIELDS.has(key)) {
      // The committer stamps these; carry the live value so the plan verifies cleanly.
      if (t !== undefined) data[key] = t;
      else if (m !== undefined) data[key] = m;
      continue;
    }
    if (SET_FIELDS.has(key)) {
      data[key] = mergeSets(b, m, t);
      continue;
    }
    const bs = asComparable(b);
    const ms = asComparable(m);
    const ts = asComparable(t);
    if (ms === bs) {
      if (t !== undefined) data[key] = t; // theirs deleted it: staying absent IS taking theirs
      if (ts !== bs) tookTheirs.push(key);
    } else if (ts === bs || ts === ms) {
      if (m !== undefined) data[key] = m;
    } else {
      conflicts.push({
        path,
        field: key,
        base: b === undefined ? null : String(typeof b === "object" ? JSON.stringify(b) : b),
        mine: m === undefined ? null : String(typeof m === "object" ? JSON.stringify(m) : m),
        theirs: t === undefined ? null : String(typeof t === "object" ? JSON.stringify(t) : t),
      });
      if (m !== undefined) data[key] = m; // provisional until the human chooses
    }
  }

  // ---- body ----------------------------------------------------------------
  const baseSections = sectionMap(base.body);
  const mineSections = sectionMap(mine.body);
  const theirsSections = sectionMap(theirs.body);

  let body: string;
  if (baseSections === null || mineSections === null || theirsSections === null) {
    // Plain-prose body (canon entries): the whole body is one field.
    const b = base.body.trim();
    const m = mine.body.trim();
    const t = theirs.body.trim();
    if (m === b) {
      body = t;
      if (t !== b) tookTheirs.push("body");
    } else if (t === b || t === m) {
      body = m;
    } else {
      conflicts.push({ path, field: "body", base: b, mine: m, theirs: t });
      body = m;
    }
  } else {
    const headings: string[] = [];
    const seen = new Set<string>();
    for (const source of [baseSections, mineSections, theirsSections]) {
      for (const h of source.keys()) {
        if (!seen.has(h)) {
          seen.add(h);
          headings.push(h);
        }
      }
    }
    const parts: string[] = [];
    for (const heading of headings) {
      const b = baseSections.get(heading);
      const m = mineSections.get(heading);
      const t = theirsSections.get(heading);
      let value: string | undefined;
      if (m === b) {
        value = t; // includes t===undefined: removed live and untouched by mine → stays removed
        if ((t ?? null) !== (b ?? null)) tookTheirs.push(heading);
      } else if (t === b || t === m) {
        value = m;
      } else {
        conflicts.push({
          path,
          field: heading,
          base: b ?? null,
          mine: m ?? null,
          theirs: t ?? null,
        });
        value = m ?? t; // provisional
      }
      if (value !== undefined) parts.push(`## ${heading}\n${value.trim()}`);
    }
    body = parts.join("\n\n");
  }

  const doc = MarkdownFile.create(data, body);
  return { merged: doc.serialize(), conflicts, tookTheirs };
}

/** Stamped by the committer, so the live value is carried and the plan verifies cleanly. */
const JSON_MACHINE_FIELDS = new Set(["version"]);

/**
 * `shots` and `flow` are two spellings of ONE field (SPEC-029 R-1), and a merge that treats them
 * as two produces a record carrying both — which the read union then refuses, stranding the
 * proposal with no resolution that can save it. Reachable today: Arke stages a shot amendment
 * against a legacy scene, somebody saves the same scene in the storyboard (migrating it), and
 * the rebase merges the proposal's `shots` beside the live `flow`.
 *
 * So the structure is merged ONCE, on what it means rather than how it is spelled: the ordered
 * shots. Whichever side actually changed the order or the payloads wins; if both did, it is a
 * single conflict on one field, and the provisional value keeps the LIVE spelling so a resolved
 * proposal lands the shape the file already has.
 */
const STRUCTURAL_FIELDS = ["shots", "flow"] as const;

/**
 * The one name a structural conflict is raised under, whichever arm either side is.
 *
 * A person choosing "mine" or "theirs" is choosing a scene's shape, not a key — so it is one
 * field with one decision, and `applyJsonResolution` restores whichever spelling the chosen
 * side actually used.
 */
const STRUCTURAL_CONFLICT_FIELD = "shots";

/**
 * What a partial JSON document means structurally, or null when it is not a scene record.
 *
 * The WHOLE flow, not the ordered shots. A graph proposal can change nothing but the graph —
 * an authored group, a node identity — and comparing shot payloads reports that as no change,
 * so the merge would replace the proposal's flow with the live one and discard an approved
 * edit without ever raising a conflict.
 */
function structureOf(value: Record<string, unknown>): { record: SceneRecord; meaning: string } | null {
  const parsed = SceneRecordSchema.safeParse(value);
  if (!parsed.success) return null;
  const meaning = structuralMeaning(parsed.data);
  return meaning === null ? null : { record: parsed.data, meaning };
}

/** The structural field as the winning side spells it — one key, never both. */
function structuralValue(record: SceneRecord): { key: "shots" | "flow"; value: unknown } {
  return isGraphScene(record) ? { key: "flow", value: record.flow } : { key: "shots", value: record.shots };
}

function mergeStructure(
  path: string,
  base: Record<string, unknown>,
  mine: Record<string, unknown>,
  theirs: Record<string, unknown>,
): { assign: { key: "shots" | "flow"; value: unknown }; conflict?: ProposalConflict; tookTheirs: boolean } | null {
  const b = structureOf(base);
  const m = structureOf(mine);
  const t = structureOf(theirs);
  if (b === null || m === null || t === null) return null;

  // The proposal says what the base said: the live answer stands, migration included.
  if (m.meaning === b.meaning) {
    return { assign: structuralValue(t.record), tookTheirs: m.meaning !== t.meaning };
  }
  if (t.meaning === b.meaning || t.meaning === m.meaning) {
    // Only the proposal changed the structure — carry ITS answer, in its own spelling. A legacy
    // amendment travels as shots and the gate re-derives the graph at accept; a graph proposal
    // travels as its flow, because that flow IS the change and re-deriving would erase it.
    return { assign: structuralValue(m.record), tookTheirs: false };
  }
  /*
   * The conflict carries each side's own structural VALUE — the array or the flow, as that side
   * spells it — not the canonical form the comparison used. Resolution has to be able to put the
   * chosen answer back on disk, and a canonical flow assigned to `shots` is a scene that parses
   * as neither arm.
   */
  return {
    assign: structuralValue(m.record),
    conflict: {
      path,
      field: STRUCTURAL_CONFLICT_FIELD,
      base: JSON.stringify(structuralValue(b.record).value),
      mine: JSON.stringify(structuralValue(m.record).value),
      theirs: JSON.stringify(structuralValue(t.record).value),
    },
    tookTheirs: false,
  };
}

/**
 * The JSON lane of the same merge (SPEC-023 R-18, issue #385): three-way at top-level-field
 * granularity, arrays and nested objects atomic. JSON never passes through the Markdown merge —
 * mergeMarkdown re-serialises with frontmatter fences and destroys a JSON document, which is
 * the exact failure the art-direction restatement branch was built to avoid; this lane is the
 * general answer for every JSON track (story, scene, season, series).
 *
 * Conflict values are carried as JSON text (`JSON.stringify`), so resolution can round-trip a
 * chosen value without guessing whether "1747" was a number or a title.
 */
export function mergeJson(path: string, baseRaw: string, mineRaw: string, theirsRaw: string): MergeResult {
  const base = JSON.parse(baseRaw) as Record<string, unknown>;
  const mine = JSON.parse(mineRaw) as Record<string, unknown>;
  const theirs = JSON.parse(theirsRaw) as Record<string, unknown>;
  const conflicts: ProposalConflict[] = [];
  const tookTheirs: string[] = [];
  const out: Record<string, unknown> = {};
  const keys: string[] = [];
  for (const source of [mine, theirs, base]) {
    for (const key of Object.keys(source)) if (!keys.includes(key)) keys.push(key);
  }
  // One field, merged once, before the generic pass can produce a record carrying both spellings.
  const structure = mergeStructure(path, base, mine, theirs);
  if (structure !== null) {
    out[structure.assign.key] = structure.assign.value;
    if (structure.conflict) conflicts.push(structure.conflict);
    if (structure.tookTheirs) tookTheirs.push(structure.assign.key);
  }
  for (const key of keys) {
    if (structure !== null && (STRUCTURAL_FIELDS as readonly string[]).includes(key)) continue;
    const b = base[key];
    const m = mine[key];
    const t = theirs[key];
    if (JSON_MACHINE_FIELDS.has(key)) {
      // The committer stamps these; carry the live value so the plan verifies cleanly.
      if (t !== undefined) out[key] = t;
      else if (m !== undefined) out[key] = m;
      continue;
    }
    const bs = asComparable(b);
    const ms = asComparable(m);
    const ts = asComparable(t);
    if (ms === bs) {
      if (t !== undefined) out[key] = t; // theirs deleted it: staying absent IS taking theirs
      if (ts !== bs) tookTheirs.push(key);
    } else if (ts === bs || ts === ms) {
      if (m !== undefined) out[key] = m;
    } else {
      conflicts.push({
        path,
        field: key,
        base: b === undefined ? null : JSON.stringify(b),
        mine: m === undefined ? null : JSON.stringify(m),
        theirs: t === undefined ? null : JSON.stringify(t),
      });
      if (m !== undefined) out[key] = m; // provisional until the human chooses
    }
  }
  return { merged: JSON.stringify(out, null, 2) + "\n", conflicts, tookTheirs };
}

/** Apply a human's per-field choice to a previously merged JSON document (R-6). */
export function applyJsonResolution(
  mergedRaw: string,
  conflict: ProposalConflict,
  choice: "mine" | "theirs",
): string {
  const doc = JSON.parse(mergedRaw) as Record<string, unknown>;
  const value = choice === "mine" ? conflict.mine : conflict.theirs;
  if (conflict.field === STRUCTURAL_CONFLICT_FIELD && ("shots" in doc || "flow" in doc)) {
    /*
     * A scene's structure is one field with two spellings (SPEC-029 R-1), so restoring a choice
     * means writing the chosen side's OWN key and removing the other. Assigning it blindly to
     * `shots` would put a flow object under the array key, or leave a stale `flow` beside a
     * restored array — either way a record neither arm of the union can read, and a conflict
     * nobody can accept their way out of.
     */
    for (const key of STRUCTURAL_FIELDS) delete doc[key];
    if (value !== null) {
      const chosen = JSON.parse(value) as unknown;
      doc[Array.isArray(chosen) ? "shots" : "flow"] = chosen;
    }
    return JSON.stringify(doc, null, 2) + "\n";
  }
  if (value === null) delete doc[conflict.field];
  else doc[conflict.field] = JSON.parse(value) as unknown;
  return JSON.stringify(doc, null, 2) + "\n";
}

/** Apply a human's per-field choice to a previously merged document (R-6). */
export function applyResolution(
  path: string,
  mergedRaw: string,
  conflict: ProposalConflict,
  choice: "mine" | "theirs",
): string {
  const doc = MarkdownFile.parse(mergedRaw);
  const value = choice === "mine" ? conflict.mine : conflict.theirs;

  if (conflict.field === "body") {
    doc.setBody(value ?? "");
    return doc.serialize();
  }
  const sections = sectionMap(doc.body);
  if (sections !== null && (sections.has(conflict.field) || looksLikeHeading(conflict))) {
    if (value === null) sections.delete(conflict.field);
    else sections.set(conflict.field, value);
    doc.setBody([...sections.entries()].map(([h, b]) => `## ${h}\n${b.trim()}`).join("\n\n"));
    return doc.serialize();
  }
  // Frontmatter field.
  if (value === null) {
    const next = { ...doc.data };
    delete next[conflict.field];
    doc.data = next;
    doc.setData({});
  } else {
    doc.setData({ [conflict.field]: coerce(value) });
  }
  return doc.serialize();
}

function looksLikeHeading(conflict: ProposalConflict): boolean {
  // Section conflicts carry prose values; frontmatter conflicts carry scalars.
  return (conflict.base ?? conflict.mine ?? conflict.theirs ?? "").includes("\n");
}

function coerce(value: string): unknown {
  if (/^-?\d+$/.test(value)) return Number(value);
  if (value === "true") return true;
  if (value === "false") return false;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === "object" && parsed !== null) return parsed;
  } catch {
    /* plain string */
  }
  return value;
}
