import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChapterContinuityState, ChapterSummary } from "@arke-studio/contracts";
import { continuityRows, continuityRowStamp, continuityStamp } from "../src/lib/continuity.js";

/**
 * Where everyone is (design turn 129, SPEC-012 R-43): the door's table, computed from the
 * summaries' placings alone. The drawing's own rows are the first case; the rest are the rules
 * codex made binding — a chapter not derived breaks the chain, a chapter that moved taints
 * every cell carried past it, a record over the cap carries nothing, and a record that cannot
 * be read is neither absent nor a source.
 */

const CAST = ["maren-kest", "odile-sarn", "ines-half-hitch", "bray-half-hitch", "the-chorister"];

function chapter(order: number, bodyHash: string, continuity?: ChapterContinuityState): ChapterSummary {
  return { id: `c${order}`, file: `0${order}-c`, order, title: `Chapter ${order}`, status: "drafted", version: 1, hash: `file-${bodyHash}`, bodyHash, ...(continuity ? { continuity } : {}) };
}

/** A placing per sheet; `null` says the chapter said they had gone. */
function derived(hash: string, placed: Record<string, string | null>, extra: { omitted?: number } = {}): ChapterContinuityState {
  return {
    version: 1,
    hash,
    derivedAt: "2026-09-06T00:00:00.000Z",
    passes: 1,
    dropped: 0,
    omitted: extra.omitted ?? 0,
    cut: 0,
    placed: Object.entries(placed).map(([sheet, where]) => ({ character: sheet.replace(/-/g, " "), sheet, present: where !== null, ...(where !== null ? { where } : {}) })),
  };
}

describe("the continuity table (turn 129)", () => {
  it("draws 129c: placed cells plain, carried cells naming their chapter, nothing past a chapter not derived, warning past one that moved", () => {
    const rows = continuityRows(
      [
        chapter(1, "h1", derived("h1", { "maren-kest": "the-vigil", "bray-half-hitch": "the-quay" })),
        chapter(2, "h2", derived("h2", { "maren-kest": "the-rail-desk", "odile-sarn": "the-rail-desk" })),
        chapter(3, "h3", derived("h3", { "maren-kest": "the-ebb-council", "ines-half-hitch": "the-ebb-council" })),
        chapter(4, "h4"),
        chapter(5, "h5", derived("h5-before", { "maren-kest": "the-vigil", "bray-half-hitch": "At sea" })),
        chapter(6, "h6", derived("h6", { "maren-kest": "the-vigil", "odile-sarn": "Below the harbour", "the-chorister": "The drowned city" })),
        chapter(7, "h7", derived("h7", { "maren-kest": "the-vigil", "odile-sarn": "the-vigil" })),
      ],
      CAST,
    );
    assert.deepEqual(rows[1]!.cells[3], { where: "the-quay", since: 1, warn: false }, "02 carries Bray from 01, quietly, naming it");
    assert.deepEqual(rows[2]!.cells[1], { where: "the-rail-desk", since: 2, warn: false }, "03 carries Odile from 02");
    assert.deepEqual(rows[2]!.cells[3], { where: "the-quay", since: 1, warn: false }, "and Bray still from 01");
    assert.equal(rows[3]!.stamp.kind, "none");
    assert.ok(rows[3]!.cells.every((cell) => cell === null), "a chapter not derived is a row of dashes");
    assert.equal(rows[4]!.cells[2], null, "Ines, placed in 03, is a dash from 05 on: 04 was never read");
    assert.deepEqual(rows[4]!.cells[3], { where: "At sea", warn: true }, "05 moved, so its own placings are in warning");
    assert.equal(rows[4]!.stamp.kind, "stale");
    assert.deepEqual(rows[5]!.cells[3], { where: "At sea", since: 5, warn: true }, "carried from a chapter that moved, in warning");
    assert.deepEqual(rows[6]!.cells[3], { where: "At sea", since: 5, warn: true });
    assert.deepEqual(rows[6]!.cells[4], { where: "The drowned city", since: 6, warn: false }, "carried from a fresh chapter, quietly");
    assert.deepEqual(rows[6]!.cells[0], { where: "the-vigil", warn: false }, "placed here, plain");
    assert.equal(continuityRowStamp(rows[0]!.stamp), "derived · v1");
    assert.equal(continuityRowStamp(rows[3]!.stamp), "not derived");
    assert.equal(continuityRowStamp(rows[4]!.stamp), "chapter moved · derived against v1");
  });

  it("a chapter that moved taints every cell carried past it, even when the source is fresh (codex, round four)", () => {
    const rows = continuityRows(
      [
        chapter(1, "h1", derived("h1", { "maren-kest": "the-vigil" })),
        chapter(2, "h2", derived("h2-before", { "odile-sarn": "the-quay" })),
        chapter(3, "h3", derived("h3", { "odile-sarn": "the-quay" })),
      ],
      ["maren-kest", "odile-sarn"],
    );
    assert.deepEqual(rows[1]!.cells[0], { where: "the-vigil", since: 1, warn: false }, "carried into the moved chapter from a fresh source: the source is what it was");
    assert.deepEqual(rows[2]!.cells[0], { where: "the-vigil", since: 1, warn: true }, "carried past it: the chapter that moved may have moved anyone");
  });

  it("a record over the cap, or one that cannot be read, carries nothing and breaks the chain", () => {
    const capped = continuityRows(
      [
        chapter(1, "h1", derived("h1", { "maren-kest": "the-vigil", "odile-sarn": "the-quay" })),
        chapter(2, "h2", derived("h2", { "maren-kest": "the-rail-desk" }, { omitted: 2 })),
        chapter(3, "h3", derived("h3", {})),
      ],
      ["maren-kest", "odile-sarn"],
    );
    assert.deepEqual(capped[1]!.cells[0], { where: "the-rail-desk", warn: false }, "what it placed is shown");
    assert.equal(capped[1]!.cells[1], null, "what it did not place is a dash: a character the cap hid may have moved");
    assert.equal(capped[2]!.cells[0], null, "and nothing carries past it");
    assert.equal(continuityRowStamp(capped[1]!.stamp), "derived · v1 · 2 over the cap");

    const unreadable = continuityRows(
      [chapter(1, "h1", derived("h1", { "maren-kest": "the-vigil" })), chapter(2, "h2", { unreadable: true }), chapter(3, "h3", derived("h3", {}))],
      ["maren-kest"],
    );
    assert.equal(unreadable[1]!.stamp.kind, "unreadable");
    assert.equal(continuityRowStamp(unreadable[1]!.stamp), "record unreadable");
    assert.equal(unreadable[1]!.cells[0], null);
    assert.equal(unreadable[2]!.cells[0], null, "a record that cannot be read is no source");
  });

  it("a chapter that says a character has gone clears their place until a chapter places them again (codex, round five)", () => {
    const rows = continuityRows(
      [
        chapter(1, "h1", derived("h1", { "maren-kest": "the-vigil" })),
        chapter(2, "h2", derived("h2", { "maren-kest": null })),
        chapter(3, "h3", derived("h3", {})),
        chapter(4, "h4", derived("h4", { "maren-kest": "the-quay" })),
      ],
      ["maren-kest"],
    );
    assert.deepEqual(rows[1]!.cells[0], { gone: true, since: 2, warn: false }, "gone: a dash, not the Vigil carried");
    assert.deepEqual(rows[2]!.cells[0], { gone: true, since: 2, warn: false }, "and nothing carried from before it");
    assert.deepEqual(rows[3]!.cells[0], { where: "the-quay", warn: false }, "until a chapter places them again");

    // A departure from a chapter that has since moved is a dash in warning, not one that looks
    // current (codex, round six).
    const moved = continuityRows(
      [chapter(1, "h1", derived("h1", { "maren-kest": "the-vigil" })), chapter(2, "h2", derived("h2-before", { "maren-kest": null })), chapter(3, "h3", derived("h3", {}))],
      ["maren-kest"],
    );
    assert.deepEqual(moved[1]!.cells[0], { gone: true, since: 2, warn: true });
    assert.deepEqual(moved[2]!.cells[0], { gone: true, since: 2, warn: true }, "carried past, still in warning");
  });

  it("the panel's stamp says what the check proved and what it dropped or cut", () => {
    const base = { version: 4, hash: "h", derivedAt: "2026-09-06T00:00:00.000Z", passes: 1, dropped: 0, omitted: 0, cut: 0, characters: [] };
    assert.equal(continuityStamp(base), "derived · v4 · every line is the chapter’s own words");
    assert.equal(continuityStamp({ ...base, version: 3, dropped: 2 }), "derived · v3 · 2 lines dropped, not in the chapter");
    assert.equal(continuityStamp({ ...base, dropped: 1, passes: 2 }), "derived · v4 · 2 passes · 1 line dropped, not in the chapter");
    assert.equal(continuityStamp({ ...base, omitted: 2, cut: 1 }), "derived · v4 · every line is the chapter’s own words · 2 characters over the cap · 1 line over the cap");
  });
});
