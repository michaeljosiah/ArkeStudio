import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AUDIOBOOK_JOIN_MAX_SECONDS,
  ChapterAudiobookSchema,
  GROUPED_READ_CAPS,
  audiobookBlockOptions,
  audiobookBlockPlan,
  audiobookBlockState,
  audiobookBlocks,
  audiobookRekeyed,
  audiobookSeamHash,
  audiobookSeamLabel,
  audiobookTextHash,
  placePictures,
  type AudiobookSeam,
  type ChapterAudiobook,
} from "../src/index.js";

/**
 * Block seams (design turn 198): every gap between two lines is a block's edge or not, and the
 * author can change which. A seam lives on the chapter's audiobook record, names the turns it
 * sits between and the hash of their words, and follows the reading.
 */
const LINE = "\"It is not possible,\"";
const REPLY = "\"The goat was in the boot.\"";
const P0 = `${LINE} Ade said. ${REPLY}`;
const P1 = "Tunde laughed until his chest hurt.";
const P3 = "Below them the quarter opened.";
const P4 = "The night went on.";
const BODY = [P0, P1, "* * *", P3, P4].join("\n\n");
const CAST = {
  lines: [
    { speaker: "Ade", sheet: "ade", paragraph: 0, occurrence: 0, quote: LINE },
    { speaker: "Tunde", sheet: "tunde", paragraph: 0, occurrence: 0, quote: REPLY },
  ],
};
const AT = "2026-10-05T10:00:00.000Z";
const NARRATOR = { provider: "kokoro", model: "kokoro-82m", voiceId: "af_heart" };

const join = (before: [number, number], after: [number, number], a: string, b: string): AudiobookSeam => ({
  kind: "join",
  before: { paragraph: before[0], turn: before[1] },
  after: { paragraph: after[0], turn: after[1] },
  textHash: audiobookSeamHash(a, b),
  at: AT,
});
const split = (before: [number, number], after: [number, number], a: string, b: string): AudiobookSeam => ({ ...join(before, after, a, b), kind: "split" });

const narrator = (seams?: AudiobookSeam[]) => audiobookBlocks(BODY, CAST, "Chapter 1", audiobookBlockOptions({ reading: "narrator" }, seams === undefined ? null : { seams }));
const cast = (seams?: AudiobookSeam[]) => audiobookBlocks(BODY, CAST, "Chapter 1", audiobookBlockOptions({ reading: "cast" }, seams === undefined ? null : { seams }));

const record = (extra: Partial<ChapterAudiobook> = {}): ChapterAudiobook => ({ schemaVersion: 1, chapterVersion: 1, hash: "h", updatedAt: AT, takes: {}, flags: {}, direction: {}, ...extra });

describe("audiobookBlocks with seams", () => {
  it("lists every gap with what a press there does, a limit only where it bites", () => {
    const { blocks, seams } = narrator();
    assert.deepEqual(blocks.map((block) => block.key), ["title", "p0.0", "p1.0", "p3.0", "p4.0"]);
    assert.equal(seams.changed, 0);
    assert.deepEqual(
      seams.gaps.map((gap) => [gap.press, gap.block, gap.row ?? null, gap.limit ?? null]),
      [
        ["join", "p0.0", null, "title"],
        ["split", "p0.0", 0, null],
        ["split", "p0.0", 1, null],
        ["join", "p1.0", null, null],
        ["join", "p3.0", null, "scene break"],
        ["join", "p4.0", null, null],
      ],
    );
    assert.equal(seams.gaps[0]!.anchor, undefined, "the title's gap has nothing a press can name");
    assert.deepEqual(seams.gaps[5]!.anchor, { before: { paragraph: 3, turn: 0 }, after: { paragraph: 4, turn: 0 }, textHash: audiobookSeamHash(P3, P4) });
  });

  it("joins consecutive blocks into one with rows, keeping the first block's key", () => {
    const { blocks, seams } = narrator([join([3, 0], [4, 0], P3, P4)]);
    assert.deepEqual(blocks.map((block) => block.key), ["title", "p0.0", "p1.0", "p3.0"]);
    const joined = blocks[3]!;
    assert.equal(joined.text, `${P3}\n\n${P4}`, "each paragraph's own words");
    assert.deepEqual(joined.rows?.map((row) => row.text), [P3, P4]);
    assert.equal(joined.shaped, true);
    assert.deepEqual(joined.sources, ["p3.0", "p4.0"]);
    assert.deepEqual(joined.starts, ["p3.0", "p4.0"]);
    assert.equal(seams.changed, 1);
    assert.equal(blocks[1]!.shaped, undefined, "a block the reading cut on its own is not marked");
    // The gap the join took out is now inside the block: a Split there undoes it.
    const inside = seams.gaps.find((gap) => gap.anchor?.before.paragraph === 3);
    assert.deepEqual([inside?.press, inside?.block, inside?.row, inside?.seam, inside?.auto], ["split", "p3.0", 0, 0, true]);
  });

  it("splits a block between its lines, the first part keeping the key and a later one the next free key", () => {
    const { blocks, seams } = narrator([split([0, 1], [0, 2], "Ade said.", REPLY)]);
    assert.deepEqual(blocks.map((block) => block.key), ["title", "p0.0", "p0.1", "p1.0", "p3.0", "p4.0"]);
    assert.deepEqual(blocks[1]!.rows?.map((row) => row.speaker ?? "narration"), ["Ade", "narration"]);
    assert.equal(blocks[1]!.text, `${LINE} Ade said.`);
    assert.equal(blocks[2]!.text, REPLY);
    assert.equal(blocks[2]!.speaker, "Tunde", "a split never changes who speaks a line");
    assert.equal(blocks[2]!.rows, undefined);
    assert.deepEqual(blocks[2]!.sources, ["p0.0"]);
    assert.deepEqual(blocks[2]!.starts, []);
    assert.equal(seams.changed, 2);
  });

  it("drops a seam whose words changed, and the block returns to its automatic split", () => {
    const seam = join([3, 0], [4, 0], P3, P4);
    const edited = audiobookBlocks(BODY.replace(P4, "The night went on and on."), CAST, "Chapter 1", audiobookBlockOptions(null, { seams: [seam] }));
    assert.deepEqual(edited.blocks.map((block) => block.key), ["title", "p0.0", "p1.0", "p3.0", "p4.0"]);
    assert.equal(edited.seams.dropped, 1);
    assert.deepEqual(edited.seams.droppedSeams, [0]);
    assert.equal(audiobookSeamLabel(edited.seams), "1 seam dropped · words changed");
  });

  it("finds a seam by its words when a paragraph inserted above moved it, and never by guess", () => {
    const seam = join([3, 0], [4, 0], P3, P4);
    const moved = audiobookBlocks(`A new first paragraph.\n\n${BODY}`, null, "Chapter 1", audiobookBlockOptions(null, { seams: [seam] }));
    assert.equal(moved.seams.dropped, 0);
    assert.equal(moved.blocks.at(-1)!.key, "p4.0", "the join keeps the first block's key where it now is");
    assert.equal(moved.blocks.at(-1)!.text, `${P3}\n\n${P4}`);
    // Twice the same two lines: the words name two gaps, so the seam is placed at neither.
    const twice = audiobookBlocks(`${P3}\n\n${P4}\n\n${P3}\n\n${P4}`, null, "Chapter 1", audiobookBlockOptions(null, { seams: [{ ...seam, before: { paragraph: 9, turn: 0 }, after: { paragraph: 10, turn: 0 } }] }));
    assert.equal(twice.seams.dropped, 1);
    assert.equal(twice.blocks.some((block) => block.shaped === true), false);
  });

  it("holds a join of two voices under Cast and applies it again under one reader", () => {
    const seam = join([0, 2], [1, 0], REPLY, P1);
    const under = cast([seam]);
    assert.equal(under.seams.held, 1);
    assert.equal(under.seams.changed, 0);
    assert.equal(audiobookSeamLabel(under.seams), "1 held");
    assert.equal(under.seams.gaps.find((gap) => gap.seam === 0)?.limit, "two voices");
    const back = narrator([seam]);
    assert.equal(back.seams.held, 0);
    assert.deepEqual(back.blocks.map((block) => block.key), ["title", "p0.0", "p3.0", "p4.0"]);
    assert.equal(back.blocks[1]!.rows?.length, 4);
  });

  it("joins lines of one voice under Cast, and the joined block is that speaker's", () => {
    const body = `"One," Tunde said.\n\n"Two."`;
    const lines = { lines: [{ speaker: "Tunde", sheet: "tunde", paragraph: 0, occurrence: 0, quote: "\"One,\"" }, { speaker: "Tunde", sheet: "tunde", paragraph: 1, occurrence: 0, quote: "\"Two.\"" }] };
    const seam = join([0, 1], [1, 0], "Tunde said.", "\"Two.\"");
    const derived = audiobookBlocks(body, lines, "Chapter 1", audiobookBlockOptions({ reading: "cast" }, { seams: [seam] }));
    assert.equal(derived.seams.held, 1, "narration and a line are two voices");
    const same = join([0, 0], [0, 1], "\"One,\"", "Tunde said.");
    const gaps = audiobookBlocks(body, lines, "Chapter 1", audiobookBlockOptions({ reading: "cast" })).seams.gaps;
    assert.equal(gaps.find((gap) => gap.anchor?.textHash === same.textHash)?.limit, "two voices");
    const twoLines = audiobookBlocks(`"One."\n\n"Two."`, { lines: [{ speaker: "Tunde", sheet: "tunde", paragraph: 0, occurrence: 0, quote: "\"One.\"" }, { speaker: "Tunde", sheet: "tunde", paragraph: 1, occurrence: 0, quote: "\"Two.\"" }] }, "Chapter 1", audiobookBlockOptions({ reading: "cast" }, { seams: [join([0, 0], [1, 0], "\"One.\"", "\"Two.\"")] }));
    assert.equal(twoLines.seams.held, 0);
    assert.equal(twoLines.blocks[1]!.speaker, "Tunde");
    assert.equal(twoLines.blocks[1]!.sheet, "tunde");
  });

  it("applies a split under every reading", () => {
    const seam = split([0, 1], [0, 2], "Ade said.", REPLY);
    assert.equal(cast([seam]).seams.changed, 0, "Cast cuts there already");
    assert.equal(narrator([seam]).seams.changed, 2);
  });

  it("refuses a join past one read's five minutes, and holds one the words outgrew", () => {
    assert.equal(AUDIOBOOK_JOIN_MAX_SECONDS, GROUPED_READ_CAPS.speechSeconds, "the reader's request cap");
    const long = (word: string) => Array.from({ length: 500 }, () => word).join(" ") + ".";
    const a = long("alpha");
    const b = long("beta");
    const body = `${a}\n\n${b}`;
    const gaps = audiobookBlocks(body, null, "Chapter 1", audiobookBlockOptions(null)).seams.gaps;
    assert.equal(gaps.find((gap) => gap.press === "join" && gap.block === "p1.0")?.limit, "over 5 min");
    const held = audiobookBlocks(body, null, "Chapter 1", audiobookBlockOptions(null, { seams: [join([0, 0], [1, 0], a, b)] }));
    assert.equal(held.seams.held, 1);
    assert.equal(held.blocks.length, 3);
  });

  it("is kept on the record, which parses with it", () => {
    const parsed = ChapterAudiobookSchema.safeParse(record({ seams: [join([3, 0], [4, 0], P3, P4)] }));
    assert.equal(parsed.success, true);
    assert.equal(ChapterAudiobookSchema.safeParse(record({ seams: [{ ...join([3, 0], [4, 0], P3, P4), kind: "merge" as "join" }] })).success, false);
  });
});

describe("a changed block is marked, not read", () => {
  const take = (text: string) => ({ artifactId: "01J00000000000000000000001", textHash: audiobookTextHash(text), reader: NARRATOR, format: "wav" as const, characters: text.length, parts: 1, estimatedMicroUsd: 0, costMicroUsd: 0, madeAt: AT });

  it("is not made when its shape changed, and made again by its old take when the shape returns", () => {
    const held = record({ takes: { "p3.0": take(P3), "p4.0": take(P4) } });
    const joined = narrator([join([3, 0], [4, 0], P3, P4)]).blocks[3]!;
    assert.equal(audiobookBlockState(joined, held, NARRATOR), "not made", "not read, rather than stale");
    const back = narrator().blocks;
    assert.equal(audiobookBlockState(back[3]!, held, NARRATOR), "made");
    assert.equal(audiobookBlockState(back[4]!, held, NARRATOR), "made", "the neighbour's take was never touched");
  });

  it("carries the first block's delivery, note and speed and every block's markers to a join, writing nothing", () => {
    const direction = record({
      direction: {
        "p3.0": { textHash: audiobookTextHash(P3), text: P3, at: AT, plan: { schemaVersion: 1, sourceTextHash: "x", delivery: "whispered", speed: 0.9, note: "low", cues: [{ kind: "emphasis", span: { from: 15, to: 22, text: "quarter" }, level: "strong" }] } },
        "p4.0": { textHash: audiobookTextHash(P4), text: P4, at: AT, plan: { schemaVersion: 1, sourceTextHash: "x", delivery: "urgent", speed: 1.1, cues: [{ kind: "pause", at: 9, length: "long" }] } },
      },
    });
    const joined = narrator([join([3, 0], [4, 0], P3, P4)]).blocks[3]!;
    const carried = audiobookRekeyed(direction, joined);
    assert.equal(carried?.input.delivery, "whispered");
    assert.equal(carried?.input.speed, 0.9);
    assert.equal(carried?.input.note, "low");
    assert.deepEqual(carried?.input.cues.map((cue) => cue.kind), ["emphasis", "pause"]);
    assert.equal(carried?.dropped, 0);
    assert.equal(audiobookBlockPlan(direction, joined)?.delivery, "whispered");
    // Split: every part a copy of the block's delivery, its markers with their words.
    const whole = record({ direction: { "p0.0": { textHash: audiobookTextHash(P0), text: P0, at: AT, plan: { schemaVersion: 1, sourceTextHash: "x", delivery: "warm", speed: 1, cues: [{ kind: "emphasis", span: { from: P0.indexOf("goat"), to: P0.indexOf("goat") + 4, text: "goat" }, level: "moderate" }] } } } });
    const parts = narrator([split([0, 1], [0, 2], "Ade said.", REPLY)]).blocks;
    assert.equal(audiobookRekeyed(whole, parts[1]!)?.input.cues.length, 0);
    assert.equal(audiobookRekeyed(whole, parts[1]!)?.input.delivery, "warm");
    assert.equal(audiobookRekeyed(whole, parts[2]!)?.input.delivery, "warm");
    assert.deepEqual(audiobookRekeyed(whole, parts[2]!)?.input.cues.map((cue) => (cue.kind === "emphasis" ? cue.span.text : cue.kind)), ["goat"]);
  });

  it("shows the first picture among the joined blocks; a later one comes off and is kept, never lost", () => {
    const picture = (text: string, file: string) => ({ file, source: "world" as const, textHash: audiobookTextHash(text), at: AT });
    const blocks = narrator([join([3, 0], [4, 0], P3, P4)]).blocks;
    const both = placePictures(blocks, { "p3.0": picture(P3, "a.jpg"), "p4.0": picture(P4, "b.jpg") });
    assert.deepEqual(both.placed.map((entry) => [entry.key, blocks[entry.index]!.key]), [["p3.0", "p3.0"]]);
    assert.deepEqual(both.off, ["p4.0"]);
    assert.deepEqual(both.lost, []);
    const later = placePictures(blocks, { "p4.0": picture(P4, "b.jpg") });
    assert.deepEqual(later.placed.map((entry) => [entry.key, blocks[entry.index]!.key]), [["p4.0", "p3.0"]], "the first picture among them, wherever it was");
    const back = placePictures(narrator().blocks, { "p3.0": picture(P3, "a.jpg"), "p4.0": picture(P4, "b.jpg") });
    assert.equal(back.placed.length, 2, "split back, each block has its own again");
  });
});
