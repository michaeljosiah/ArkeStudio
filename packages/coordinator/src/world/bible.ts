import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  applyBibleEdits,
  BIBLE_PATH,
  BibleEditError,
  EMPTY_BIBLE,
  type BibleEdit,
  type BibleEditRecord,
  type WorldBible,
} from "@arke-studio/contracts";
import { fromPortable, toExtendedLength } from "./paths.js";
import { MarkdownFile, sha256 } from "./text-files.js";
import type { WorldStore } from "./store.js";

/**
 * Reading and writing the author's bible (SPEC-022).
 *
 * Two writers, one path. The author types in the editor; the agent describes edits in its turn
 * result and the coordinator performs them. Both land here, so both version, both snapshot, and
 * neither can forget to.
 *
 * There is no gate. What replaces it is the version: every save cuts one, `.history/bible/vN.md`
 * holds the outgoing text, and `changes.jsonl` records who wrote it. An edit nobody wanted is one
 * restore away, which for a document that cites nothing is the better trade — an approval step on
 * a notes file is a toll on thinking out loud.
 */

/** Read `bible.md`, or the empty bible. A world without one is ordinary, not broken. */
export async function readBible(dir: string): Promise<WorldBible> {
  let raw: string;
  try {
    raw = await readFile(toExtendedLength(join(dir, fromPortable(BIBLE_PATH))), "utf8");
  } catch {
    // Every world made before SPEC-022 is here, and so is every world whose author has not
    // started one. Mirrors SPEC-002 R-1's treatment of a folder with no world.json: absent is
    // ignored, never reported as corrupt.
    return EMPTY_BIBLE;
  }
  try {
    const doc = MarkdownFile.parse(raw);
    return {
      version: typeof doc.data["version"] === "number" ? doc.data["version"] : 1,
      updated: typeof doc.data["updated"] === "string" ? doc.data["updated"] : EMPTY_BIBLE.updated,
      text: doc.body,
      present: true,
    };
  } catch {
    // A hand-written bible with no frontmatter at all still reads as a bible. It is prose the
    // user typed; refusing it because it lacks a YAML header would lose the file's whole point,
    // and the first save writes the frontmatter back in.
    return { version: 1, updated: EMPTY_BIBLE.updated, text: raw.replace(/^﻿/, "").replace(/\r\n/g, "\n"), present: true };
  }
}

/** The live bytes and their hash, for a commit that has to prove what it was drafted against. */
async function liveBible(dir: string): Promise<{ raw: string | null; hash: string | null }> {
  try {
    const raw = await readFile(toExtendedLength(join(dir, fromPortable(BIBLE_PATH))), "utf8");
    return { raw, hash: sha256(raw) };
  } catch {
    return { raw: null, hash: null };
  }
}

/**
 * The bible a world is born with (2026-08-22).
 *
 * A world door that produced a cast, places and canon left the one document that is the
 * author's own — the through-line, in their words — empty, so the thinking that made the world
 * lived only in a conversation nobody reads twice. Genesis writes it now, and it is v1 like any
 * other first version: editable immediately, no accept step, a restore away.
 */
export function initialBible(text: string, at: string): string {
  return compose(null, text.trim(), at);
}

function compose(live: string | null, text: string, at: string): string {
  const doc = live !== null ? tryParse(live) : MarkdownFile.create({ version: 1, created: at.slice(0, 10) }, "");
  doc.setBody(text);
  return doc.serialize();
}

function tryParse(raw: string): MarkdownFile {
  try {
    return MarkdownFile.parse(raw);
  } catch {
    // Frontmatter-less bible: keep the prose, give it a header. The committer stamps the version.
    return MarkdownFile.create({ version: 1 }, raw);
  }
}

/**
 * Write the bible whole — what the editor's autosave calls.
 *
 * `baseVersion` is the version the editor had loaded. It is checked here rather than only by the
 * committer's hash comparison so the refusal can say something a person can act on: "this moved
 * while you were typing" is actionable, a hash mismatch is not.
 */
export async function saveBible(
  store: WorldStore,
  text: string,
  options: { source: string; baseVersion?: number },
): Promise<BibleEditRecord> {
  const current = await readBible(store.dir);
  if (options.baseVersion !== undefined && options.baseVersion !== current.version) {
    throw new BibleStaleError(options.baseVersion, current.version);
  }
  const { raw, hash } = await liveBible(store.dir);
  const at = store.now();
  const result = await store.commit({
    kind: "bible-save",
    source: options.source,
    files: [
      {
        path: BIBLE_PATH,
        action: raw === null ? "create" : "replace",
        content: compose(raw, text, at),
        baseHash: hash,
      },
    ],
  });
  return {
    fromVersion: current.version,
    toVersion: result.versions[BIBLE_PATH] ?? current.version + 1,
    headings: ["the whole bible"],
    at,
  };
}

/**
 * Apply a turn's edits (SPEC-022, #70 §8.3).
 *
 * Returns null when there are no edits, so callers need no special case for the ordinary turn.
 * Throws `BibleEditError` when a heading does not resolve and `BibleStaleError` when the file
 * moved underneath the turn — both reject the whole turn rather than landing part of it.
 */
export async function applyTurnBibleEdits(
  store: WorldStore,
  edits: readonly BibleEdit[],
  options: { source: string; baseVersion: number },
): Promise<BibleEditRecord | null> {
  if (edits.length === 0) return null;

  const current = await readBible(store.dir);
  if (current.version !== options.baseVersion) {
    // The turn read one bible and is writing to another — the author edited in a text editor
    // while the model was thinking, which is expected for a file meant to be hand-edited. The
    // turn is refused rather than merged, exactly as SPEC-002 R-27 refuses a moved base: the app
    // cannot know which of the two versions was meant.
    throw new BibleStaleError(options.baseVersion, current.version);
  }

  const applied = applyBibleEdits(current.text, edits);
  const { raw, hash } = await liveBible(store.dir);
  const at = store.now();
  const result = await store.commit({
    kind: "bible-edit",
    source: options.source,
    files: [
      {
        path: BIBLE_PATH,
        action: raw === null ? "create" : "replace",
        content: compose(raw, applied.text, at),
        baseHash: hash,
      },
    ],
  });
  return {
    fromVersion: current.version,
    toVersion: result.versions[BIBLE_PATH] ?? current.version + 1,
    headings: applied.headings,
    at,
  };
}

/** Undo: put v<n> back as a new version, leaving everything between it and now in history (R-20). */
export async function restoreBible(store: WorldStore, version: number, source: string): Promise<number> {
  const result = await store.restoreVersion(BIBLE_PATH, version, source);
  return result.versions[BIBLE_PATH] ?? version;
}

export class BibleStaleError extends Error {
  constructor(
    readonly expected: number,
    readonly found: number,
  ) {
    super(
      `the bible moved from v${expected} to v${found} while this change was being made — it was not overwritten`,
    );
    this.name = "BibleStaleError";
  }
}

export { BibleEditError };
