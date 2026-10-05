import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { castParagraphHashes, castStanding, keptOverlap, paragraphHash, quoteSpans, rebaseCast, reconcileCast, voicedBlocks } from "../src/prose.js";
import { audiobookBlocks } from "../src/audiobook.js";
import { ChapterVoicesSchema } from "../src/world.js";

/**
 * Edited lines keep their speaker, and only edited paragraphs need casting (design turn 198,
 * SPEC-012 R-66..R-70). The fixture is the case that asked for it: "Na love or Juju", chapter 1,
 * 2026-10-05, where two edits to Ade's and Tunde's lines sent both to the narrator and made the
 * whole cast stale.
 */

const BEFORE = [
  "Tunde was telling the goat story again.",
  "\"It is not possible,\" Ade said.",
  "\"Ade, I am telling you. The goat looked at me like this —\" Tunde widened his eyes and lowered his chin. \"— like say na me get the car.\"",
  "\"The goat was in the boot.\"",
  "\"The goat was in the boot spiritually. Physically, he was in front.\"",
  "Ade laughed until his chest hurt.",
].join("\n\n");

const AFTER = BEFORE
  .replace("\"The goat was in the boot.\"", "\"The goat was in the boot, Tunde.\"")
  .replace("\"The goat was in the boot spiritually. Physically, he was in front.\"", "\"Ehn-ehn. The goat was in the boot spiritually,\" Tunde said. \"Physically, he was in front.\"");

const ADE = { speaker: "adeyemi-ade-akinola", sheet: "adeyemi-ade-akinola" };
const TUNDE = { speaker: "tunde", sheet: "tunde" };

/** The record as the cast wrote it against BEFORE: each line by its words, paragraph and occurrence. */
const CAST = {
  lines: [
    { ...ADE, paragraph: 1, occurrence: 0, quote: "\"It is not possible,\"" },
    { ...TUNDE, paragraph: 2, occurrence: 0, quote: "\"Ade, I am telling you. The goat looked at me like this —\"" },
    { ...TUNDE, paragraph: 2, occurrence: 0, quote: "\"— like say na me get the car.\"" },
    { ...ADE, paragraph: 3, occurrence: 0, quote: "\"The goat was in the boot.\"" },
    { ...TUNDE, paragraph: 4, occurrence: 0, quote: "\"The goat was in the boot spiritually. Physically, he was in front.\"" },
  ],
  paragraphs: castParagraphHashes(BEFORE),
};

const speakers = (body: string, record: Parameters<typeof voicedBlocks>[1]) =>
  voicedBlocks(body, record).blocks.map((block) => [block.text, block.speaker ?? null, block.kept === true]);

describe("an edited quote keeps its speaker (design turn 198, R-66)", () => {
  it("the goat case: Ade keeps the edited line, Tunde keeps both parts of his, and the new tag is narration", () => {
    assert.deepEqual(speakers(AFTER, CAST).slice(6), [
      ["\"The goat was in the boot, Tunde.\"", "adeyemi-ade-akinola", true],
      ["\"Ehn-ehn. The goat was in the boot spiritually,\"", "tunde", true],
      ["Tunde said.", null, false],
      ["\"Physically, he was in front.\"", "tunde", true],
      ["Ade laughed until his chest hurt.", null, false],
    ]);
    // Before this turn the record lost both: every edited quote fell to the narrator.
    const { paragraphs: _paragraphs, ...legacy } = CAST;
    assert.deepEqual(speakers(AFTER, legacy).slice(6, 8).map(([, speaker]) => speaker), [null, null]);
  });

  it("only the edited paragraphs are left to cast, and the lines of untouched ones stay cast, unmarked", () => {
    const standing = reconcileCast(CAST, AFTER);
    assert.deepEqual(standing.toCast, [3, 4]);
    assert.equal(standing.legacy, false);
    assert.deepEqual(speakers(AFTER, CAST).slice(0, 3), [
      ["Tunde was telling the goat story again.", null, false],
      ["\"It is not possible,\"", "adeyemi-ade-akinola", false],
      ["Ade said.", null, false],
    ]);
    assert.deepEqual(castStanding({ ...CAST, hash: "sha256:old" }, AFTER, "sha256:new"), { current: false, toCast: [3, 4], legacy: false });
  });

  it("a quote that shares no words with the paragraph's cast quotes is narration until cast", () => {
    const body = BEFORE.replace("\"The goat was in the boot.\"", "\"I was in the market when it happened.\"");
    const blocks = speakers(body, CAST);
    assert.deepEqual(blocks[6], ["\"I was in the market when it happened.\"", null, false], "the words every sentence has are not enough");
    assert.deepEqual(reconcileCast(CAST, body).toCast, [3]);
  });

  it("a paragraph that only moved keeps its lines; one inserted before it holds nothing to cast", () => {
    const paragraphs = BEFORE.split("\n\n");
    const moved = [paragraphs[0], "The music changed.", paragraphs[3], paragraphs[1], paragraphs[2], paragraphs[4], paragraphs[5]].join("\n\n");
    const standing = reconcileCast(CAST, moved);
    assert.deepEqual(standing.toCast, [], "a narration paragraph holds nothing to cast, and moving is no edit");
    const blocks = speakers(moved, CAST);
    assert.deepEqual(blocks.find(([text]) => text === "\"The goat was in the boot.\""), ["\"The goat was in the boot.\"", "adeyemi-ade-akinola", false]);
    assert.deepEqual(blocks.find(([text]) => text === "\"It is not possible,\""), ["\"It is not possible,\"", "adeyemi-ade-akinola", false]);
  });

  it("a line still there word for word stays cast though its paragraph was edited, and a mended tag asks nothing", () => {
    const body = BEFORE.replace("\"It is not possible,\" Ade said.", "\"It is not possible,\" Ade said quietly.");
    assert.deepEqual(reconcileCast(CAST, body).toCast, [], "the quote is the cast line; nothing new to cast");
    assert.deepEqual(speakers(body, CAST)[1], ["\"It is not possible,\"", "adeyemi-ade-akinola", false]);
  });

  it("the rule: half of the edited quote's content words, at least one; short quotes on all their words", () => {
    assert.ok(keptOverlap("\"The goat was in the boot, Tunde.\"", "\"The goat was in the boot.\"") > 0);
    assert.ok(keptOverlap("\"Physically, he was in front.\"", "\"The goat was in the boot spiritually. Physically, he was in front.\"") > 0);
    assert.equal(keptOverlap("\"I was in the market.\"", "\"The goat was in the boot.\""), 0);
    assert.equal(keptOverlap("\"Tunde, the goat ran away from the market today.\"", "\"The goat was in the boot.\""), 0, "one word of five is another line");
    assert.ok(keptOverlap("\"No, no.\"", "\"No.\"") > 0);
    assert.equal(keptOverlap("\"Go.\"", "\"No.\""), 0);
  });

  it("finds quotes by their marks: curly, straight, guillemets, one left open, and single marks with apostrophes inside", () => {
    const at = (text: string) => quoteSpans(text).map((span) => text.slice(span.start, span.end));
    assert.deepEqual(at("“Ehn-ehn,” Tunde said. \"Physically.\""), ["“Ehn-ehn,”", "\"Physically.\""]);
    assert.deepEqual(at("«Non,» dit-il. “And then"), ["«Non,»", "“And then"]);
    assert.deepEqual(at("‘I don’t know,’ she said."), ["‘I don’t know,’"]);
    assert.deepEqual(at("No quote here."), []);
  });

  it("hashes a paragraph's words, so a rewrap is no edit", () => {
    assert.equal(paragraphHash("The goat was\nin the boot."), paragraphHash("The goat was in the boot."));
    assert.notEqual(paragraphHash("The goat was in the boot."), paragraphHash("The goat was in the boot, Tunde."));
    assert.match(paragraphHash("x"), /^[0-9a-f]{14}$/);
  });

  it("the audiobook's rows carry the mark inside a block of several turns", () => {
    const blocks = audiobookBlocks(AFTER, CAST, "Chapter 1", { merge: true }).blocks;
    const tunde = blocks.find((block) => block.paragraph === 4)!;
    assert.deepEqual(tunde.rows?.map((turn) => [turn.speaker ?? null, turn.kept === true]), [["tunde", true], [null, false], ["tunde", true]]);
  });
});

describe("a cast written again against the prose now (R-67)", () => {
  it("rebases into the body's own indices: edited paragraphs wait under the empty hash and carry the lines they keep", () => {
    const paragraphs = BEFORE.split("\n\n");
    const body = [paragraphs[0], "The music changed.", ...AFTER.split("\n\n").slice(1)].join("\n\n");
    const rebased = rebaseCast(CAST, body);
    assert.deepEqual(rebased.toCast, [4, 5]);
    assert.equal(rebased.paragraphs[4], "");
    assert.equal(rebased.paragraphs[5], "");
    assert.equal(rebased.paragraphs[2], paragraphHash(paragraphs[1]!));
    assert.deepEqual(rebased.lines.map((line) => [line.paragraph, line.quote]), [
      [2, "\"It is not possible,\""],
      [3, "\"Ade, I am telling you. The goat looked at me like this —\""],
      [3, "\"— like say na me get the car.\""],
      [4, "\"The goat was in the boot.\""],
      [5, "\"The goat was in the boot spiritually. Physically, he was in front.\""],
    ]);
    // Read again, the rebased record says what the first said: the same kept speakers, nothing lost.
    const { toCast: _toCast, lost: _lost, ...written } = rebased;
    const record = { ...written, version: 6, hash: "sha256:x", derivedAt: "2026-10-05T07:17:17.768Z", passes: 1, dropped: 0, omitted: 0 };
    assert.ok(ChapterVoicesSchema.safeParse(record).success, "the record a build writes now is one it reads");
    assert.deepEqual(speakers(body, record), speakers(body, CAST));
  });

  it("a pin stands where its words still are and is lost where they are gone", () => {
    const record = { ...CAST, pins: [{ paragraph: 1, occurrence: 0, quote: "Ade said.", narration: true as const }, { paragraph: 3, occurrence: 0, quote: "\"The goat was in the boot.\"", speaker: "Tunde" }] };
    const rebased = rebaseCast(record, AFTER);
    assert.deepEqual(rebased.pins, [{ paragraph: 1, occurrence: 0, quote: "Ade said.", narration: true }]);
    assert.equal(rebased.lost, 1);
  });
});
