import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BEAT_MAX_SECONDS, audiobookBlockOptions, audiobookBlocks, beatSeams, expectedSpeechSeconds, type AudiobookSeam } from "../src/index.js";

/**
 * Blocks grouped by beats (SPEC-047 R-172): the director names where each beat begins, and the
 * blocks of a beat are joined by design turn 198's seams — a beat is one block, never across a
 * scene break and never past the join's length.
 */
const AT = "2026-10-08T12:00:00.000Z";
const BODY = [
  "Tunde was telling the goat story again.",
  "\"It is not possible,\" Ade said.",
  "\"The goat was in the boot,\" Tunde said.",
  "Ade laughed until his chest hurt.",
  "* * *",
  "The bridge was empty at two.",
  "She was standing under a streetlamp.",
].join("\n\n");
const narrator = (seams?: AudiobookSeam[]) =>
  audiobookBlocks(BODY, null, "Chapter 1", audiobookBlockOptions({ reading: "narrator" }, seams === undefined ? null : { seams }));

describe("beatSeams", () => {
  it("joins each named beat into one block, and a scene break begins a beat whether named or not", () => {
    const auto = narrator();
    assert.deepEqual(auto.blocks.map((block) => block.key), ["title", "p0.0", "p1.0", "p2.0", "p3.0", "p5.0", "p6.0"]);
    // The director names two beats: the goat story from p0, the laugh from p3; it names none at the bridge.
    const joins = beatSeams(auto.blocks, auto.seams.gaps, new Set(["p0.0", "p3.0"]), AT);
    assert.deepEqual(joins.beats.map((beat) => [beat.start, beat.blocks]), [["p0.0", 3], ["p3.0", 1], ["p5.0", 2]]);
    assert.equal(joins.cut, 1, "the scene break began a beat the director did not name");
    assert.ok(joins.seams.every((seam) => seam.kind === "join" && seam.at === AT));
    const grouped = narrator(joins.seams);
    assert.deepEqual(grouped.blocks.map((block) => block.key), ["title", "p0.0", "p3.0", "p5.0"], "three beats, three blocks after the title");
    assert.match(grouped.blocks[1]!.text, /goat story again\.\n\n"It is not possible," Ade said\.\n\n"The goat was in the boot," Tunde said\./);
    assert.equal(grouped.seams.held, 0, "no join held back");
  });

  it("begins a beat wherever joining the next block would carry it past the cap", () => {
    const long = Array.from({ length: 6 }, (_, n) => `Paragraph ${n}: ${"word ".repeat(260).trim()}.`);
    const body = long.join("\n\n");
    const auto = audiobookBlocks(body, null, "Chapter 2", audiobookBlockOptions({ reading: "narrator" }, null));
    const each = expectedSpeechSeconds(long[0]!);
    assert.ok(each * 2 <= BEAT_MAX_SECONDS && each * 3 > BEAT_MAX_SECONDS, `two paragraphs fit and three do not (${each} s each)`);
    // One beat named over the whole chapter: it is cut every two paragraphs.
    const joins = beatSeams(auto.blocks, auto.seams.gaps, new Set(["p0.0"]), AT);
    assert.deepEqual(joins.beats.map((beat) => beat.blocks), [2, 2, 2]);
    assert.equal(joins.cut, 2);
    assert.ok(joins.beats.every((beat) => beat.seconds <= BEAT_MAX_SECONDS));
    const grouped = audiobookBlocks(body, null, "Chapter 2", audiobookBlockOptions({ reading: "narrator" }, { seams: joins.seams }));
    assert.equal(grouped.blocks.length, 4);
    assert.equal(grouped.seams.held, 0, "every join stands: none carried a block past the join's own limit");
  });

  it("names nothing it was not given: every block its own beat when every block is named", () => {
    const auto = narrator();
    const keys = auto.blocks.map((block) => block.key).filter((key) => key !== "title");
    const joins = beatSeams(auto.blocks, auto.seams.gaps, new Set(keys), AT);
    assert.equal(joins.seams.length, 0);
    assert.equal(joins.beats.length, keys.length);
    assert.equal(joins.cut, 0);
  });
});
