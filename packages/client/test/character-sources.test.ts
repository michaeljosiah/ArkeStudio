import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { characterPickerSources } from "../src/components/reference-picker.js";

/**
 * Every character picture offered as a reference (2026-08-18).
 *
 * The picker could only reach the artifacts folder, which in a real world is a small corner of
 * the pictures it holds: aurora-sabato had nine images against the world's two artifacts, and
 * not one of them was pickable. The source union was artifact|take, with nothing that could
 * name a plain world file.
 */
const world = {
  sheets: [{ id: "aurora-sabato", name: "Aurora Sabato" }],
  referenceKits: [
    {
      sheetId: "aurora-sabato",
      mainPhoto: { file: "main-photo.png" },
      anchor: "head-front.png",
      designatedCompilation: "model-sheet-v4.png",
      tiles: [{ angle: "head-front", file: "head-front.png" }, { angle: "three-quarter", file: "tq.png" }],
      looks: [{ kind: "costume", file: "looks/coat.png" }],
    },
  ],
  referenceTakes: [
    { id: "tk_1", reference: { sheetId: "aurora-sabato" }, media: "character-sheet.png" },
    { id: "tk_2", reference: { sheetId: "aurora-sabato" }, media: "clip.mp4" },
  ],
  referenceCandidates: { "aurora-sabato": ["candidates/candidate-1.png", "candidates/candidate-2.png"] },
} as never;

describe("a character's pictures in the picker", () => {
  const rows = characterPickerSources(world, null);

  it("offers the identity, the looks, the takes and the unreviewed candidates", () => {
    const paths = rows.map((r) => (r.pick as { path: string }).path);
    for (const expected of [
      "references/aurora-sabato/main-photo.png",
      "references/aurora-sabato/model-sheet-v4.png",
      "references/aurora-sabato/looks/coat.png",
      "references/aurora-sabato/takes/tk_1/character-sheet.png",
      "references/aurora-sabato/candidates/candidate-1.png",
    ]) {
      assert.ok(paths.includes(expected), expected);
    }
  });

  it("says what each one is, because the whole set includes pictures that failed review", () => {
    // Offering candidates puts an unreviewed picture one press from a paid generation. The
    // label is the only thing left distinguishing it, so it is not optional.
    const candidate = rows.find((r) => /candidate-1/.test((r.pick as { path: string }).path))!;
    assert.match(candidate.meta, /not reviewed/);
    assert.match(candidate.name, /Aurora Sabato/, "and whose picture it is");
  });

  it("names one file once, however many ways the kit points at it", () => {
    // head-front is both the anchor and a tile; two rows for one picture would let the same
    // bytes ride under two tokens.
    const heads = rows.filter((r) => /head-front\.png$/.test((r.pick as { path: string }).path));
    assert.equal(heads.length, 1);
  });

  it("leaves out what a path cannot price", () => {
    // A loose file carries no measured duration, and the reference budget is spent in seconds.
    const paths = rows.map((r) => (r.pick as { path: string }).path);
    assert.equal(paths.some((p) => p.endsWith(".mp4")), false);
  });
});
