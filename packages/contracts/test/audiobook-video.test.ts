import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AudiobookVideoOptionsSchema,
  BOOK_PART_CAP_SEC,
  bookParts,
  burnedCues,
  captionFontPx,
  captionLineChars,
  chapterCues,
  clockTime,
  cueAt,
  DEFAULT_VIDEO_OPTIONS,
  defaultVideoSubtitles,
  roughTime,
  segmentAt,
  segmentFades,
  titleCardSeconds,
  verticalCrop,
  videoEstimate,
  videoFileName,
  videoFolderName,
  videoSegments,
  computeRunning,
  videoPlaceLine,
  type ClientState,
  type ListeningChapter,
} from "../src/index.js";

/**
 * The audiobook as a video (design turn 197): the plan both the render and the preview read —
 * what shows when, the words and their times, the files, the price before Render.
 */
function chapter(overrides: Partial<ListeningChapter> = {}): ListeningChapter {
  return {
    chapterId: "neap",
    order: 1,
    title: "Chapter 1",
    state: "read",
    seconds: 100,
    blocks: [
      { key: "title", number: 1, file: "artifacts/a.wav", at: 0, seconds: 2, sentences: [{ at: 0, text: "Chapter 1" }] },
      {
        key: "p0.0",
        number: 2,
        file: "artifacts/b.wav",
        at: 2,
        seconds: 48,
        sentences: [
          { at: 2, text: "Tunde was telling the goat story again." },
          { at: 20, text: "Your friend says it loudly. Every time he finishes a joke, and every time the whole table laughs as though it were the first." },
        ],
      },
      { key: "p1.0", number: 3, file: "artifacts/c.wav", at: 50, seconds: 50, sentences: [{ at: 50, text: "She did not." }] },
    ],
    gaps: [],
    pictures: [
      { key: "p0.0", number: 2, file: "artifacts/walk.jpg", at: 2, seconds: 48, short: false, focus: { x: 0.62, y: 0.42 } },
      { key: "p1.0", number: 3, file: "artifacts/booth.jpg", at: 50, seconds: 50, short: false },
    ],
    opening: "cover.jpg",
    mix: { file: ".cache/audiobook-mix/x/r2-k.wav", seconds: 100 },
    ...overrides,
  };
}

describe("the audiobook as a video (turn 197)", () => {
  it("defaults as the owner answered: one a chapter, 1920 × 1080, Slow push on, Sidecar at 16:9 and Both at vertical", () => {
    assert.deepEqual(AudiobookVideoOptionsSchema.parse(DEFAULT_VIDEO_OPTIONS), DEFAULT_VIDEO_OPTIONS);
    assert.equal(DEFAULT_VIDEO_OPTIONS.slowPush, true);
    assert.equal(defaultVideoSubtitles("1920x1080"), "sidecar");
    assert.equal(defaultVideoSubtitles("1080x1920"), "burn-in+sidecar");
    assert.throws(() => AudiobookVideoOptionsSchema.parse({ ...DEFAULT_VIDEO_OPTIONS, shape: "640x480" }));
  });

  it("holds a card while the title is read, the cover blurred before the first picture, each picture until the next", () => {
    const withCover = videoSegments(chapter({ pictures: [{ key: "p1.0", number: 3, file: "artifacts/booth.jpg", at: 50, seconds: 50, short: false }] }), "cover.jpg", true);
    assert.deepEqual(
      withCover.map((segment) => [segment.kind, segment.file, segment.from, segment.to]),
      [
        ["card", "artifacts/booth.jpg", 0, 3],
        ["cover", "cover.jpg", 3, 50],
        ["picture", "artifacts/booth.jpg", 50, 100],
      ],
      "the card on the chapter's first picture blurred, at least three seconds; the cover until the first picture",
    );
    assert.equal(withCover[0]!.title, "Chapter 1");
    const noCards = videoSegments(chapter(), "cover.jpg", false);
    assert.deepEqual(noCards.map((segment) => [segment.kind, segment.from, segment.to]), [["cover", 0, 2], ["picture", 2, 50], ["picture", 50, 100]]);
    assert.deepEqual(noCards[1]!.focus, { x: 0.62, y: 0.42 }, "the focus rides with the picture");
    assert.deepEqual(videoSegments(chapter({ pictures: [] }), null, false).map((segment) => segment.kind), ["black"], "nothing to show is black");
    assert.equal(titleCardSeconds(chapter({ blocks: [{ key: "title", number: 1, file: "a", at: 0, seconds: 7, sentences: [{ at: 0, text: "A long title" }] }] })), 7, "held while a long title is read");
  });

  it("folds a flash into the piece before it and fades over a second, or less beside a short piece", () => {
    const segments = videoSegments(chapter({ pictures: [{ key: "p0.0", number: 2, file: "a.jpg", at: 3.2, seconds: 1, short: true }, { key: "p1.0", number: 3, file: "b.jpg", at: 4.2, seconds: 95.8, short: false }] }), "cover.jpg", true);
    assert.deepEqual(segments.map((segment) => [segment.kind, segment.from, segment.to]), [["card", 0, 3.2], ["picture", 3.2, 4.2], ["picture", 4.2, 100]], "the cover's 0.2 s goes to the card");
    assert.deepEqual(segmentFades(segments), [0, 0.5, 0.5], "half the one-second piece at each side");
    assert.equal(segmentAt(segments, 4)!.file, "a.jpg");
    assert.equal(segmentAt(segments, 500)!.file, "b.jpg");
  });

  it("times the words as the player's Text does, at most two lines of 42 in a sidecar cue", () => {
    const cues = chapterCues(chapter());
    assert.deepEqual(cues[0], { text: "Chapter 1", startSec: 0, endSec: 2 });
    assert.deepEqual(cues[1], { text: "Tunde was telling the goat story again.", startSec: 2, endSec: 20 });
    const long = cues.filter((cue) => cue.startSec >= 20 && cue.endSec <= 50);
    assert.equal(long.length, 2, "a long sentence is cut at a line break into two cues");
    assert.equal(long[0]!.startSec, 20);
    assert.equal(long[1]!.endSec, 50, "sharing its time by length, ending where the block ends");
    for (const cue of cues) {
      const lines = cue.text.split("\n");
      assert.ok(lines.length <= 2 && lines.every((line) => line.length <= 42), cue.text);
    }
    assert.equal(cueAt(cues, 10)!.text, "Tunde was telling the goat story again.");
  });

  it("burns only the sentence being read, broken to the frame, and none over the card", () => {
    const burned = burnedCues(chapter(), "1920x1080", "m", 4);
    assert.equal(burned[0]!.startSec, 4, "a sentence begun under the card shows once the card has gone");
    assert.ok(!burned.some((cue) => cue.text === "Chapter 1"), "the title is on the card");
    assert.equal(captionLineChars("1920x1080", "m"), 61);
    assert.ok(captionLineChars("1080x1920", "m") < 30, "a vertical line is a third as long");
    assert.equal(captionFontPx("1920x1080", "s"), 38.88);
    assert.equal(captionFontPx("1920x1080", "m"), 47.52);
    assert.equal(captionFontPx("1920x1080", "l"), 58.32);
    assert.equal(Math.round(captionFontPx("1920x1080", "m", 405)), 18, "197b's 16:9 preview at M is --text-lg");
    assert.equal(Math.round(captionFontPx("1080x1920", "m", 405)), 15, "and its 9:16 is --text-md");
  });

  it("crops a full-height 9:16 column around the focus, kept inside the picture", () => {
    assert.deepEqual(verticalCrop(1920, 1080, 0.5), { left: 0.3418, width: 0.3164 });
    assert.deepEqual(verticalCrop(1920, 1080, 0.98), { left: 0.6836, width: 0.3164 }, "never past the edge");
    assert.deepEqual(verticalCrop(1920, 1080, 0), { left: 0, width: 0.3164 });
    assert.deepEqual(verticalCrop(900, 1600, 0.5), { left: 0, width: 1 }, "a picture already narrow keeps its width");
  });

  it("splits a book over twelve hours into parts at the last chapter boundary under the cap; a chapter over it is a part alone", () => {
    const hours = (h: number) => ({ seconds: h * 3600 });
    const parts = bookParts([hours(4), hours(4), hours(3.5), hours(5), hours(6.8), hours(6)]);
    assert.deepEqual(parts.map((part) => part.chapters.length), [3, 2, 1]);
    assert.ok(parts.every((part) => part.seconds <= BOOK_PART_CAP_SEC));
    assert.deepEqual(bookParts([hours(13), hours(1)]).map((part) => part.chapters.length), [1, 1], "a chapter longer than the cap is its own part");
    assert.equal(bookParts([hours(1)]).length, 1);
    assert.equal(bookParts([hours(1)])[0]!.seconds, 3605, "the opening's five seconds count");
  });

  it("names files from the book and the chapter, in one dated folder", () => {
    assert.equal(videoFileName("Na love or Juju", { kind: "chapter", order: 1, title: "Chapter 1" }), "na-love-or-juju-01-chapter-1.mp4");
    assert.equal(videoFileName("Na love or Juju", { kind: "book", part: null }), "na-love-or-juju.mp4");
    assert.equal(videoFileName("Na love or Juju", { kind: "book", part: 2 }), "na-love-or-juju-part-2.mp4");
    assert.equal(videoFolderName("Na love or Juju", "2026-10-04T20:41:00.000Z"), "na-love-or-juju-video-20261004");
    assert.equal(videoFileName("Café · Ñandú!", { kind: "chapter", order: 12, title: "" }), "cafe-nandu-12-audiobook.mp4");
  });

  it("prices a render before it is made, with ~ until this machine has measured one", () => {
    const first = videoEstimate({ shape: "1920x1080", slowPush: true, videoSec: 1900, renderSec: 1900, rates: {} });
    assert.equal(first.measured, false);
    assert.ok(first.bytes > 100_000_000 && first.bytes < 400_000_000, String(first.bytes));
    const measured = videoEstimate({ shape: "1920x1080", slowPush: true, videoSec: 100, renderSec: 50, rates: { "1920x1080/push": { bytesPerSec: 1000, speed: 5 } } });
    assert.deepEqual(measured, { bytes: 100_000, seconds: 10, measured: true });
    assert.equal(clockTime(1900), "31:40");
    assert.equal(clockTime(3725), "1:02:05");
    assert.equal(roughTime(300), "5 min");
    assert.equal(roughTime(21900), "6 h 05 m");
  });

  it("is one Activity row while it renders: the book, a percent of the chapters' length, where it is (197d)", () => {
    const video = { title: "Na love or Juju", chapter: 1, of: 1, doneSec: 724, totalSec: 1900, leftSec: 180 };
    assert.equal(videoPlaceLine(video), "Chapter 1 of 1 · 12:04 of 31:40 · ~3 min left");
    assert.equal(videoPlaceLine({ ...video, leftSec: null }, false), "Chapter 1 of 1");
    const [row] = computeRunning({ app: { jobs: [] } } as unknown as ClientState, { exports: { vb_1: { productionId: "nloj", status: "running", percent: 41, video } } });
    assert.deepEqual(row, { kind: "export", title: "Video · Na love or Juju", detail: "Chapter 1 of 1 · 12:04 of 31:40 · ~3 min left", percent: 41, ref: "vb_1", cancellable: true, video });
  });
});
