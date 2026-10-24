import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { audiobookTextHash, ChapterAudiobookSchema } from "../src/audiobook.js";
import {
  AudiobookListeningSchema,
  AudiobookScopeSchema,
  audiobookScopeKey,
  ListeningChapterSchema,
  blockSentences,
  bookPlace,
  listeningChapter,
  pictureSpans,
  placePictures,
  retimePictureMarks,
  sentenceHashes,
  sentenceOffsets,
  sentenceStart,
  sentencesOf,
  type ListeningInputBlock,
} from "../src/audiobook-listening.js";
import { pictureKeyParts, pictureMarkKey, type AudiobookPicture } from "../src/audiobook-pictures.js";

/**
 * The book as a listener hears it (design turn 186, SPEC-047 R-66..R-71): the plan the player in
 * the app and the package both play — the made takes on one clock, the blocks not made as gaps,
 * the pictures placed and held, and what a chapter opens on.
 */

const AT = "2026-10-03T09:00:00.000Z";
it("requires an explicit chapter identity and keeps scope keys distinct", () => {
  assert.equal(AudiobookScopeSchema.safeParse({ kind: "chapter" }).success, false);
  assert.equal(AudiobookScopeSchema.safeParse({ kind: "chapter", chapterId: "" }).success, false);
  assert.equal(AudiobookScopeSchema.safeParse({ kind: "book", chapterId: "neap" }).success, false);
  assert.equal(audiobookScopeKey(undefined), "book");
  assert.notEqual(audiobookScopeKey({ kind: "chapter", chapterId: "neap" }), audiobookScopeKey({ kind: "book" }));
});
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
      { key: "p1.0", number: 3, file: "artifacts/stair.png", at: 16, seconds: 3 },
      { key: "p2.0", number: 4, file: "references/odile/main.png", at: 19, seconds: 40 },
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

  it("follows exact surviving words before an old key reused inside another join", () => {
    const blocks = [
      { key: "p0.0", text: "New first. New second.", starts: ["p0.0", "p1.0"] },
      { key: "p2.0", text: "Odile did not answer.", starts: ["p2.0", "p3.0"] },
    ];
    const held = { ...picture("Odile did not answer.", "artifacts/odile.png"), focus: { x: 0.3, y: 0.7 } };
    const records: Array<Record<string, AudiobookPicture>> = [{ "p1.0": held }, { "p0.0": picture(blocks[0]!.text, "artifacts/new.png"), "p1.0": held }];
    for (const pictures of records) {
      const result = placePictures(blocks, pictures);
      const moved = result.placed.find(entry => entry.key === "p1.0")!;
      assert.equal(moved.index, 1);
      assert.equal(moved.moved, true);
      assert.equal(moved.picture, held, "the original metadata is preserved without rewriting the record");
      assert.deepEqual(result.off, []);
      assert.deepEqual(result.lost, []);
    }
  });

  it("does not guess between repeated text when an old picture belongs to a join", () => {
    const blocks = [
      { key: "p0.0", text: "Before. Repeated.", starts: ["p0.0", "p1.0"] },
      { key: "p2.0", text: "Repeated." },
      { key: "p3.0", text: "Repeated." },
    ];
    const result = placePictures(blocks, { "p0.0": picture("Before.", "artifacts/first.png"), "p1.0": picture("Repeated.", "artifacts/later.png") });
    assert.deepEqual(result.placed.map(entry => [entry.key, entry.index]), [["p0.0", 0]]);
    assert.deepEqual(result.off, ["p1.0"]);
    assert.deepEqual(result.lost, []);
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

  it("says a picture's start is estimated only when a block before it was, not for a block not read after it (194a)", () => {
    const timed = (unread: string) => BLOCKS.map((block) => ({ key: block.key, text: block.text, seconds: block.key === unread ? null : block.take!.seconds }));
    const pictures = { "p1.0": picture(BLOCKS[2]!.text, "artifacts/stair.png"), "p3.0": picture(BLOCKS[4]!.text, "artifacts/quarter.png") };
    const after = pictureSpans(timed("p2.0"), pictures);
    assert.equal(after.estimated, true, "the chapter still holds an estimate");
    assert.deepEqual(after.spans.map((span) => [span.key, span.startEstimated]), [["p1.0", false], ["p3.0", true]], "measured up to 0:16; the block after it was not");
    const before = pictureSpans(timed("p0.0"), pictures);
    assert.deepEqual(before.spans.map((span) => span.startEstimated), [true, true]);
    assert.deepEqual(pictureSpans(timed("none"), pictures).spans.map((span) => span.startEstimated), [false, false]);
  });
});

describe("a made picture keeps its shot (design turn 194g)", () => {
  it("reads a picture with the shot it was made from, and one without", () => {
    const base = { schemaVersion: 1, chapterVersion: 1, hash: "h", updatedAt: AT, takes: {}, flags: {} };
    const shot = { frame: "Medium two-shot · across the table", inFrame: ["ife"], notInFrame: ["tunde"], expressions: {}, details: [], checks: [{ id: "frame" as const, ok: true, label: "Frame" }] };
    const read = ChapterAudiobookSchema.parse({ ...base, pictures: { "p0.0": { ...picture("x", "artifacts/a.png"), source: "generated", shot } } });
    assert.deepEqual(read.pictures?.["p0.0"]?.shot, shot);
    assert.equal(ChapterAudiobookSchema.parse({ ...base, pictures: { "p0.0": picture("x", "artifacts/a.png") } }).pictures?.["p0.0"]?.shot, undefined);
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

/**
 * Picture marks (design turn 237, SPEC-047 R-202 – R-207): a picture set at a sentence inside its
 * block, so a beat read as one take changes picture as it goes. Na love or Juju's goat story is the
 * turn's sample: the goat-face picture belongs to "Tunde widened his eyes", not the beat's start.
 */
describe("picture marks (turn 237)", () => {
  const GOAT = "Tunde was telling the goat story again. Ade had been in the car the first time it happened. Tunde widened his eyes and lowered his chin. Around them the club pressed on.";
  const [, , widened, around] = sentencesOf(GOAT);
  const beat: ListeningInputBlock = { key: "p0.0", text: GOAT, take: take(40) };
  const mark = (sentence: string, file: string): [string, AudiobookPicture] => [pictureMarkKey("p0.0", audiobookTextHash(sentence)), { ...picture(GOAT, file), mark: { sentence: audiobookTextHash(sentence) } }];

  it("keys a mark by its block and its sentence, and reads the key back", () => {
    const key = pictureMarkKey("p0.0", audiobookTextHash(widened!));
    assert.match(key, /^p0\.0@[0-9a-f]{16}$/);
    assert.deepEqual(pictureKeyParts(key), { block: "p0.0", sentence: audiobookTextHash(widened!) });
    assert.deepEqual(pictureKeyParts("p0.0"), { block: "p0.0" });
    assert.ok(key.length <= 40, "a mark's key fits every command that names a picture by its block");
  });

  it("places marks at their sentences beside the block's own picture, in reading order", () => {
    const pictures = Object.fromEntries([mark(around!, "artifacts/club.png"), ["p0.0", picture(GOAT, "artifacts/booth.png")], mark(widened!, "artifacts/goat-face.png")]);
    const { placed, lost } = placePictures([beat], pictures);
    assert.deepEqual(placed.map((entry) => [entry.picture.file, entry.index, entry.sentence]), [["artifacts/booth.png", 0, 0], ["artifacts/goat-face.png", 0, 2], ["artifacts/club.png", 0, 3]]);
    assert.deepEqual(lost, []);
  });

  it("follows its sentence when the blocks change, and is lost only when the sentence is gone", () => {
    const pictures = Object.fromEntries([mark(widened!, "artifacts/goat-face.png")]);
    // Split: the sentence now opens a block of its own, under another key.
    const split = [{ key: "p0.0", text: sentencesOf(GOAT).slice(0, 2).join(" ") }, { key: "p0.1", text: sentencesOf(GOAT).slice(2).join(" ") }];
    const moved = placePictures(split, pictures).placed[0]!;
    assert.deepEqual([moved.index, moved.sentence, moved.moved], [1, 0, true]);
    // Reworded: the sentence says something else now.
    const reworded = [{ key: "p0.0", text: GOAT.replace("lowered his chin", "dropped his chin") }];
    assert.deepEqual(placePictures(reworded, pictures).lost, [pictureMarkKey("p0.0", audiobookTextHash(widened!))]);
  });

  it("starts a mark at its words' share of the take, then on its first word once the take is timed", () => {
    const pictures = Object.fromEntries([["p0.0", picture(GOAT, "artifacts/booth.png")], mark(widened!, "artifacts/goat-face.png")]);
    const chapter = listeningChapter({ chapterId: "chapter-1", order: 1, title: "Gold on Gold", blocks: [{ key: "title", text: "Chapter 1 · Gold on Gold", take: take(3) }, beat], pictures, cover: null });
    const start = sentenceStart(GOAT, 2);
    const goat = chapter.pictures.find((entry) => entry.file === "artifacts/goat-face.png")!;
    assert.equal(goat.at, Math.round((3 + 40 * start.share) * 1000) / 1000, "the estimate: its share of the 40 s take");
    assert.equal(goat.word, start.word);
    assert.equal(chapter.pictures[0]!.seconds, goat.at - 3, "the beat's own picture holds until the mark");
    assert.ok(ListeningChapterSchema.safeParse(chapter).success);
    // The take's validated words on the chapter's clock: the mark moves onto "Tunde".
    const tokens = GOAT.split(/\s+/);
    chapter.blocks[1]!.words = tokens.map((text, index) => ({ text, startSec: 3 + index, endSec: 3.9 + index, probability: 0.99 }));
    retimePictureMarks(chapter);
    assert.equal(chapter.pictures[1]!.at, 3 + start.word, "on its first word");
    assert.equal(tokens[start.word], "Tunde");
    assert.equal(chapter.pictures[1]!.seconds, chapter.seconds - chapter.pictures[1]!.at, "and holds to the chapter's end");
  });

  it("holds a picture until the next however soon, with no shortest hold (R-207)", () => {
    const pictures = Object.fromEntries([["p0.0", picture(GOAT, "artifacts/booth.png")], mark(sentencesOf(GOAT)[1]!, "artifacts/car.png")]);
    const chapter = listeningChapter({ chapterId: "chapter-1", order: 1, title: "Gold on Gold", blocks: [beat], pictures, cover: null });
    assert.ok(chapter.pictures[0]!.seconds < 20);
    assert.equal(chapter.pictures.length, 2, "both stand");
  });

  it("times a chip from the take's word timing when it is current, else estimates it and says so", () => {
    const pictures = Object.fromEntries([mark(widened!, "artifacts/goat-face.png")]);
    const words = GOAT.split(/\s+/).map((_, index) => index * 0.5);
    const timed = pictureSpans([{ key: "p0.0", text: GOAT, seconds: 40, words }], pictures).spans[0]!;
    assert.deepEqual([timed.at, timed.startEstimated], [sentenceStart(GOAT, 2).word * 0.5, false]);
    const guessed = pictureSpans([{ key: "p0.0", text: GOAT, seconds: 40 }], pictures).spans[0]!;
    assert.equal(guessed.startEstimated, true);
    assert.equal(sentenceHashes(GOAT)[2], audiobookTextHash(widened!));
  });

  it("finds each sentence's start in the words as written, for the view to draw its mark", () => {
    const written = "  “Ade, I am telling you.”\n\nTunde widened his eyes.   The goat was in the boot.";
    const offsets = sentenceOffsets(written);
    assert.deepEqual(offsets.map((at) => written.slice(at, at + 5)), ["“Ade,", "Tunde", "The g"]);
  });

  it("keeps emphasis closed after a stop with its sentence, so a mark never opens on a stray `**`", () => {
    const written = "Written above it: **a hand-span high.** Under it, smaller: *called it back. paid.* Then _the line._";
    assert.deepEqual(sentencesOf(written), ["Written above it: **a hand-span high.**", "Under it, smaller: *called it back.", "paid.*", "Then _the line._"]);
    assert.deepEqual(sentenceOffsets(written).map((at) => written.slice(at, at + 5)), ["Writt", "Under", "paid.", "Then "]);
  });
});
