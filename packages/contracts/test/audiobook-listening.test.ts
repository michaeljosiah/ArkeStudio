import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { audiobookTextHash, ChapterAudiobookSchema } from "../src/audiobook.js";
import {
  AudiobookListeningSchema,
  ListeningChapterSchema,
  blockSentences,
  bookPlace,
  listeningChapter,
  pictureSpans,
  placePictures,
  sentencesOf,
  type ListeningInputBlock,
} from "../src/audiobook-listening.js";
import type { AudiobookPicture } from "../src/audiobook-pictures.js";

/**
 * The book as a listener hears it (design turn 186, SPEC-047 R-66..R-71): the plan the player in
 * the app and the package both play — the made takes on one clock, the blocks not made as gaps,
 * the pictures placed and held, and what a chapter opens on.
 */

const AT = "2026-10-03T09:00:00.000Z";
const take = (seconds: number, grouped = false) => ({ file: `artifacts/take-${seconds}.wav`, seconds, grouped });
const picture = (text: string, file: string): AudiobookPicture => ({ file, source: "world", textHash: audiobookTextHash(text), at: AT });

const BLOCKS: ListeningInputBlock[] = [
  { key: "title", text: "Chapter 7 · The Tenth Key", take: take(4) },
  { key: "p0.0", text: "The bell under the harbour rang twice before Maren reached the stair, and by the third she had stopped counting.", take: take(12, true) },
  { key: "p1.0", text: "“It’s the tenth key.”", take: take(3) },
  { key: "p2.0", text: "Odile did not answer.", take: take(30) },
  { key: "p3.0", text: "Below them the quarter opened like a held breath.", take: take(10) },
];

describe("a chapter on one clock (R-67)", () => {
  it("plays the made takes back to back with nothing added, the title first", () => {
    const chapter = listeningChapter({ chapterId: "neap", order: 7, title: "The Tenth Key", blocks: BLOCKS, cover: null });
    assert.equal(chapter.state, "read");
    assert.equal(chapter.seconds, 59);
    assert.deepEqual(chapter.blocks.map((block) => [block.key, block.at, block.number]), [["title", 0, 1], ["p0.0", 4, 2], ["p1.0", 16, 3], ["p2.0", 19, 4], ["p3.0", 49, 5]]);
    assert.deepEqual(chapter.gaps, []);
  });

  it("plays a chapter read in part: its made blocks in order, each run of unread blocks a gap where it falls", () => {
    const blocks = BLOCKS.map((block, index) => (index === 2 || index === 3 ? { key: block.key, text: block.text } : block));
    const chapter = listeningChapter({ chapterId: "neap", order: 7, title: "The Tenth Key", blocks, cover: null });
    assert.equal(chapter.state, "part");
    assert.equal(chapter.seconds, 26);
    assert.deepEqual(chapter.blocks.map((block) => block.key), ["title", "p0.0", "p3.0"]);
    assert.deepEqual(chapter.gaps, [{ at: 16, from: 3, to: 4 }], "blocks 3–4 not read, at 0:16");
  });

  it("lists a chapter with no take as not read, with nothing to play", () => {
    const chapter = listeningChapter({ chapterId: "neap", order: 7, title: "The Tenth Key", blocks: BLOCKS.map(({ key, text }) => ({ key, text })), cover: "world-art.png" });
    assert.equal(chapter.state, "not read");
    assert.equal(chapter.seconds, 0);
    assert.deepEqual(chapter.gaps, [{ at: 0, from: 1, to: 5 }]);
    assert.equal(chapter.opening, "world-art.png");
  });

  it("says the book's place: the chapter, and what is left of it and after it", () => {
    assert.deepEqual(bookPlace([{ seconds: 100 }, { seconds: 200 }, { seconds: 0 }, { seconds: 50 }], 1, 60), { chapter: 2, of: 4, leftSeconds: 190 });
  });
});

describe("the words, if wanted (R-70)", () => {
  it("splits a grouped take into sentences by length, and shows a block read alone whole", () => {
    assert.deepEqual(sentencesOf("She held the lamp lower. The water took its light! And kept it…"), ["She held the lamp lower.", "The water took its light!", "And kept it…"]);
    const grouped = blockSentences("One two three. Four five six.", 10, true);
    assert.deepEqual(grouped.map((sentence) => sentence.text), ["One two three.", "Four five six."]);
    assert.equal(grouped[0]!.at, 0);
    assert.ok(Math.abs(grouped[1]!.at - 5) < 0.01);
    assert.deepEqual(blockSentences("One two three. Four five six.", 10, false), [{ at: 0, text: "One two three. Four five six." }]);
  });

  it("puts each sentence on the chapter's clock", () => {
    const chapter = listeningChapter({ chapterId: "neap", order: 7, title: "The Tenth Key", blocks: [BLOCKS[0]!, { key: "p0.0", text: "A first. A second one here.", take: take(10, true) }], cover: null });
    assert.deepEqual(chapter.blocks[1]!.sentences.map((sentence) => sentence.at), [4, 7.077]);
  });
});

describe("pictures that follow the words (R-69)", () => {
  it("shows a picture from its block until the next, flags one held under twenty seconds, and opens on the cover when the first block has none", () => {
    const pictures = { "p1.0": picture(BLOCKS[2]!.text, "artifacts/stair.png"), "p2.0": picture(BLOCKS[3]!.text, "references/odile/main.png") };
    const chapter = listeningChapter({ chapterId: "neap", order: 7, title: "The Tenth Key", blocks: BLOCKS, pictures, cover: "world-art.png" });
    assert.deepEqual(chapter.pictures, [
      { key: "p1.0", number: 3, file: "artifacts/stair.png", at: 16, seconds: 3, short: true },
      { key: "p2.0", number: 4, file: "references/odile/main.png", at: 19, seconds: 40, short: false },
    ]);
    assert.equal(chapter.opening, "world-art.png", "cover at the start");
  });

  it("opens on a picture set on the opening block, and on the first picture when the book has no cover", () => {
    const opened = listeningChapter({ chapterId: "neap", order: 7, title: "T", blocks: BLOCKS, pictures: { title: picture(BLOCKS[0]!.text, "artifacts/a.png") }, cover: "world-art.png" });
    assert.equal(opened.opening, "artifacts/a.png");
    const coverless = listeningChapter({ chapterId: "neap", order: 7, title: "T", blocks: BLOCKS, pictures: { "p2.0": picture(BLOCKS[3]!.text, "artifacts/b.png") }, cover: null });
    assert.equal(coverless.opening, "artifacts/b.png");
    assert.equal(listeningChapter({ chapterId: "neap", order: 7, title: "T", blocks: BLOCKS, cover: null }).opening, null);
  });

  it("follows its words when a paragraph inserted above moves the key, and is lost only when its block and words are gone", () => {
    const moved = [{ key: "title", text: "Chapter 7" }, { key: "p0.0", text: "A new paragraph." }, { key: "p1.0", text: "Odile did not answer." }];
    const result = placePictures(moved, { "p0.0": picture("Odile did not answer.", "artifacts/x.png"), "p9.0": picture("Gone words.", "artifacts/y.png") });
    assert.deepEqual(result.placed.map((entry) => [entry.key, entry.index, entry.moved]), [["p0.0", 2, true]]);
    assert.deepEqual(result.lost, ["p9.0"]);
    // Words changed in place: the picture stays on its block.
    const edited = placePictures([{ key: "p0.0", text: "Odile said nothing." }], { "p0.0": picture("Odile did not answer.", "artifacts/x.png") });
    assert.deepEqual(edited.placed.map((entry) => [entry.key, entry.index, entry.moved]), [["p0.0", 0, false]]);
  });

  it("skips a picture whose file is no longer usable, rather than showing a blank", () => {
    const chapter = listeningChapter({ chapterId: "neap", order: 7, title: "T", blocks: BLOCKS, pictures: { "p2.0": picture(BLOCKS[3]!.text, "artifacts/gone.png") }, cover: null, usable: () => false });
    assert.deepEqual(chapter.pictures, []);
  });

  it("places a picture on an unread block where the clock stands, and estimates spans before the chapter is read", () => {
    const blocks = BLOCKS.map((block, index) => (index === 3 ? { key: block.key, text: block.text } : block));
    const chapter = listeningChapter({ chapterId: "neap", order: 7, title: "T", blocks, pictures: { "p2.0": picture(BLOCKS[3]!.text, "artifacts/b.png") }, cover: null });
    assert.deepEqual(chapter.pictures.map((entry) => [entry.at, entry.seconds]), [[19, 10]]);
    const spans = pictureSpans(BLOCKS.map((block) => ({ key: block.key, text: block.text, seconds: block.key === "p3.0" ? null : block.take!.seconds })), { "p1.0": picture(BLOCKS[2]!.text, "artifacts/stair.png") });
    assert.equal(spans.estimated, true);
    assert.equal(spans.spans[0]!.at, 16);
    assert.equal(spans.spans[0]!.until, null, "holds to the chapter's end");
  });
});

describe("the record and the wire (R-73)", () => {
  it("reads a record with pictures and one without, and the plan's schema holds a computed chapter", () => {
    const base = { schemaVersion: 1, chapterVersion: 1, hash: "h", updatedAt: AT, takes: {}, flags: {} };
    assert.equal(ChapterAudiobookSchema.parse(base).pictures, undefined);
    assert.equal(ChapterAudiobookSchema.parse({ ...base, pictures: { "p0.0": picture("x", "artifacts/a.png") } }).pictures?.["p0.0"]?.file, "artifacts/a.png");
    const chapter = listeningChapter({ chapterId: "neap", order: 7, title: "The Tenth Key", blocks: BLOCKS, cover: null });
    assert.ok(AudiobookListeningSchema.safeParse({ productionId: "the-ledger", title: "The Undersong", cover: null, chapters: [chapter] }).success);
  });
});

describe("a chapter with timing plays its one mix (turn 187, R-85)", () => {
  it("places the blocks on the mix's clock, a block not made where it stands, and carries the mix", () => {
    const blocks = BLOCKS.map((block) => (block.key === "p2.0" ? { key: block.key, text: block.text } : block));
    const timed = {
      // p1.0 cuts in half a second before p0.0 ends; p2.0 is not made; p3.0 after a pause.
      bars: [{ key: "title", at: 0, seconds: 4 }, { key: "p0.0", at: 4, seconds: 12 }, { key: "p1.0", at: 15.5, seconds: 3 }, { key: "p3.0", at: 19, seconds: 10 }],
      seconds: 29,
      mix: { file: ".cache/audiobook-mix/the-ledger/01-neap/r2-abc.wav", seconds: 29.2 },
    };
    const chapter = listeningChapter({ chapterId: "neap", order: 7, title: "The Tenth Key", blocks, cover: null, timed });
    assert.deepEqual(chapter.blocks.map((block) => [block.key, block.at]), [["title", 0], ["p0.0", 4], ["p1.0", 15.5], ["p3.0", 19]]);
    assert.deepEqual(chapter.gaps, [{ at: 19, from: 4, to: 4 }], "the block not made stands where the clock goes on");
    assert.deepEqual(chapter.mix, timed.mix);
    assert.equal(chapter.seconds, 29.2, "as long as the mix is");
    assert.ok(ListeningChapterSchema.safeParse(chapter).success);
  });
});
