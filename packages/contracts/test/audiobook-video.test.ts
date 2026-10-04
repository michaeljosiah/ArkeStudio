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
  coverCrop,
  pushWindow,
  burnedLineChars,
  CUE_MAX_SEC,
  CUE_MIN_SEC,
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
    assert.deepEqual(cues[1], { text: "Tunde was telling the goat story again.", startSec: 2, endSec: 8 }, "a short sentence over a long pause clears after six seconds");
    const long = cues.filter((cue) => cue.startSec >= 20 && cue.endSec <= 50);
    assert.equal(long[0]!.startSec, 20);
    // Sharing its time by length; a cue that ends a sentence over a long pause clears early, so only there may a gap open.
    long.slice(1).forEach((cue, at) => assert.ok(cue.startSec === long[at]!.endSec || (/[.!?]$/.test(long[at]!.text) && cue.startSec > long[at]!.endSec), cue.text));
    assert.ok(long.at(-1)!.endSec <= 50, "never past the block");
    for (const cue of cues) {
      const lines = cue.text.split("\n");
      assert.ok(lines.length <= 2 && lines.every((line) => line.length <= 42), cue.text);
    }
    assert.equal(cueAt(cues, 5)!.text, "Tunde was telling the goat story again.");
    assert.equal(cueAt(cues, 10), null);
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

  it("fills the frame: a picture scaled to cover and cropped around its focus, kept inside, at 16:9 and at 9:16", () => {
    // Na love or Juju's pictures are 3:2; 16:9 loses a strip top and bottom, never a black bar.
    assert.deepEqual(coverCrop(1536, 1024, 1920, 1080), { x: 0, y: 80, width: 1536, height: 864, focusX: 0.5, focusY: 0.5 });
    assert.deepEqual(coverCrop(1536, 1024, 1280, 720, { x: 0.3, y: 0.1 }), { x: 0, y: 0, width: 1536, height: 864, focusX: 0.3, focusY: 0.1185 }, "kept inside: the focus near the top keeps the top");
    assert.deepEqual(coverCrop(1536, 1024, 1080, 1920), { x: 480, y: 0, width: 576, height: 1024, focusX: 0.5, focusY: 0.5 }, "9:16 is a full-height column");
    assert.deepEqual(coverCrop(1536, 1024, 1080, 1920, { x: 0.95, y: 0.5 }), { x: 960, y: 0, width: 576, height: 1024, focusX: 0.8667, focusY: 0.5 }, "never past the edge");
    assert.deepEqual(coverCrop(1920, 1080, 1920, 1080, { x: 0.9, y: 0.9 }), { x: 0, y: 0, width: 1920, height: 1080, focusX: 0.9, focusY: 0.9 }, "a picture of the frame's shape is whole");
    assert.deepEqual(coverCrop(900, 1600, 1920, 1080), { x: 0, y: 547, width: 900, height: 506, focusX: 0.5, focusY: 0.5 }, "a tall picture gives a band of its middle");
  });

  it("pushes toward the focus inside the crop and never past its edge", () => {
    assert.deepEqual(pushWindow({ focusX: 0.5, focusY: 0.5 }, 0), { left: 0, top: 0, size: 1 });
    for (const focus of [{ focusX: 0, focusY: 0 }, { focusX: 1, focusY: 1 }, { focusX: 0.3, focusY: 0.8 }]) {
      for (const progress of [0, 0.4, 1, 3]) {
        const window = pushWindow(focus, progress);
        assert.ok(window.left >= 0 && window.top >= 0 && window.left + window.size <= 1 + 1e-9 && window.top + window.size <= 1 + 1e-9, JSON.stringify({ focus, progress, window }));
        // The focus stands where it stood: the push moves toward it, not past it.
        assert.ok(Math.abs((focus.focusX - window.left) / window.size - focus.focusX) < 1e-9);
      }
    }
    assert.equal(Math.round(1 / pushWindow({ focusX: 0.5, focusY: 0.5 }, 1).size * 100) / 100, 1.06, "6% closer by the end of the hold");
  });

  it("cuts Na love or Juju's chapter 1 into short cues: two lines at most, at the phrases, on screen 1.2 to 6 s", () => {
    // The opening of the real chapter as its render timed it (the .srt of 0.5.60-local.20), each
    // block read alone save the grouped take whose quote runs over a sentence's end.
    const block = (key: string, at: number, to: number, ...sentences: Array<[number, string]>) => ({ key, number: 1, file: `artifacts/${key}.wav`, at, seconds: to - at, sentences: sentences.map(([start, text]) => ({ at: start, text })) });
    const opening: Pick<ListeningChapter, "blocks"> = {
      blocks: [
        block("title", 0, 1.6, [0, "Chapter 1"]),
        block("p0", 1.6, 4.785, [1.6, "Tunde was telling the goat story again."]),
        block("p1", 4.785, 29.18, [4.785, "Ade had been in the car the first time it happened, on the Ibadan expressway in 2004, and he had heard it told since at two weddings, one naming ceremony and Tunde's fortieth, and every time the goat grew larger and the customs officer more corrupt and Tunde's cousin from Ilesha more heroic. Tonight the goat had learned to open doors."]),
        block("p2", 29.18, 33.09, [29.18, "\"It is not possible,\" Ade said."]),
        block("p3", 33.09, 46.743, [33.09, "\"Ade, I am telling you."], [34.449, "The goat looked at me like this —\" Tunde widened his eyes and lowered his chin, and the effect, under the purple lights of the club, was so exactly that of an offended goat that Ade had to put his glass down."]),
        block("p4", 46.743, 48.575, [46.743, "\"— like say na me get the car.\""]),
        block("p5", 48.575, 57.82, [48.575, "\"The goat was in the boot.\""], [51.205, "\"The goat was in the boot spiritually."], [54.957, "Physically, he was in front.\""]),
      ],
    };
    const cues = chapterCues(opening);
    const lines = cues.map((cue) => cue.text.split("\n"));
    for (const [index, cue] of cues.entries()) {
      assert.ok(lines[index]!.length <= 2 && lines[index]!.every((line) => line.length <= 42), `two lines of 42: ${JSON.stringify(cue.text)}`);
      const seconds = cue.endSec - cue.startSec;
      assert.ok(seconds >= CUE_MIN_SEC - 0.001 && seconds <= CUE_MAX_SEC + 0.001, `on screen ${seconds} s: ${JSON.stringify(cue.text)}`);
    }
    // The cue the render showed as three lines ending "…an offended goat that Ade" is cut at its
    // clauses, and the quote ends a line before its dialogue tag.
    const goat = cues.filter((cue) => cue.startSec >= 34.4 && cue.endSec <= 46.75);
    assert.deepEqual(
      goat.map((cue) => cue.text),
      ["The goat looked at me like this —\"\nTunde widened his eyes", "and lowered his chin, and the effect,\nunder the purple lights of the club,", "was so exactly that of an offended goat\nthat Ade had to put his glass down."],
    );
    assert.ok(!cues.some((cue) => /\bthat Ade$/m.test(cue.text)), "never a line ending mid-phrase on a name before its verb");
    // No cue or line ends on an article, a preposition or a possessive.
    for (const line of lines.flat()) assert.doesNotMatch(line, /\b(a|an|the|of|to|for|with|from|his|her|their|in|on|at)$/i, line);
    // The long sentence of p1 is cut at its commas and its conjunctions, each cue continuing the last at once.
    const p1 = cues.filter((cue) => cue.startSec >= 4.785 && cue.endSec <= 29.18);
    assert.ok(p1.length >= 5, String(p1.length));
    assert.equal(p1[0]!.startSec, 4.785);
    assert.equal(p1.at(-1)!.endSec, 29.18);
    for (let at = 1; at < p1.length; at++) {
      assert.equal(p1[at]!.startSec, p1[at - 1]!.endSec, "no gap inside a sentence");
      assert.match(`${p1[at - 1]!.text} | ${p1[at]!.text}`, /([,.] \| )|( \| (and|on|from|to) )/, `cut at a phrase: ${p1[at - 1]!.text} | ${p1[at]!.text}`);
    }
    // A short block that could not be read in its own time borrows from the cue beside it.
    const short = chapterCues({ blocks: [block("a", 0, 0.6, [0, "\"Nothing.\""]), block("b", 0.6, 4, [0.6, "Tunde was grinning at him across the table."])] });
    assert.deepEqual(short.map((cue) => [cue.startSec, cue.endSec]), [[0, 1.2], [1.2, 4]]);
  });

  it("burns two lines at most at every shape and size: the vertical frame's line is shorter, so its cues are", () => {
    assert.equal(burnedLineChars("1920x1080", "l"), 42, "never longer than 42 at 16:9");
    assert.ok(burnedLineChars("1080x1920", "l") < 42);
    const text = "It was the laugh only Tunde could get out of him: undignified, helpless, a laugh that belonged to the boy he had been at Unilag, sharing a room in Mariere Hall with a boy who could not cook and would not stop talking.";
    const long: Pick<ListeningChapter, "blocks"> = { blocks: [{ key: "p", number: 1, file: "a.wav", at: 60.477, seconds: 17.473, sentences: [{ at: 60.477, text }] }] };
    for (const shape of ["1920x1080", "1280x720", "1080x1920"] as const) {
      for (const size of ["s", "m", "l"] as const) {
        const cues = burnedCues(long, shape, size);
        const width = burnedLineChars(shape, size);
        for (const cue of cues) {
          const lines = cue.text.split("\n");
          assert.ok(lines.length <= 2 && lines.every((line) => line.length <= width), `${shape} ${size}: ${JSON.stringify(cue.text)}`);
        }
        assert.equal(cues.map((cue) => cue.text.replace(/\n/g, " ")).join(" "), text, "every word, in order");
      }
    }
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
