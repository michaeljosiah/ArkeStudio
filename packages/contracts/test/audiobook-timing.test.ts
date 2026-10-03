import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { audiobookTextHash, ChapterAudiobookSchema } from "../src/audiobook.js";
import {
  audiobookTimingHash,
  bedFade,
  chapterMix,
  duckEnvelope,
  formatTimingSeconds,
  hasTiming,
  isWorldAudioPath,
  mixKey,
  nextReactionKey,
  placeAnchor,
  timeChapter,
  type AudiobookBed,
  type AudiobookBlockSound,
  type AudiobookReaction,
  type BlockTiming,
  type TimingInputBlock,
  type TimingTake,
} from "../src/audiobook-timing.js";

/**
 * Timing held to the blocks (design turn 187, SPEC-047 R-80..R-89): the chapter's clock with each
 * block's start, trim, `under` and nudge, reactions under their hosts, beds and sounds held to
 * their blocks, and the mix plan one renderer plays.
 */

const AT = "2026-10-03T12:00:00.000Z";
const take = (id: string, seconds: number, grouped?: TimingTake["grouped"]): TimingTake => ({ artifactId: `ar_${id.padEnd(26, "0").toUpperCase().slice(0, 26)}`, file: `artifacts/${id}.wav`, seconds, ...(grouped !== undefined ? { grouped } : {}) });
const hash = (text: string) => audiobookTextHash(text);

const TEXT = {
  title: "Chapter 1 · The Goat",
  p0: "Tunde was telling the goat story again.",
  p1: "“Ade, I am telling you. The goat looked at me like this —”",
  p2: "“Tunde —”",
  p3: "“The goat was in the boot.”",
};
const blocks = (takes: Partial<Record<keyof typeof TEXT, TimingTake>> = {}): TimingInputBlock[] => [
  { key: "title", text: TEXT.title, lane: "narration", ...(takes.title ? { take: takes.title } : {}) },
  { key: "p0.0", text: TEXT.p0, lane: "narration", ...(takes.p0 ? { take: takes.p0 } : {}) },
  { key: "p1.0", text: TEXT.p1, lane: "tunde", ...(takes.p1 ? { take: takes.p1 } : {}) },
  { key: "p2.0", text: TEXT.p2, lane: "ade", ...(takes.p2 ? { take: takes.p2 } : {}) },
  { key: "p3.0", text: TEXT.p3, lane: "ade", ...(takes.p3 ? { take: takes.p3 } : {}) },
];
const ALL = { title: take("t", 2), p0: take("a", 2.4), p1: take("b", 3), p2: take("c", 1.6), p3: take("d", 2) };
const timing = (key: keyof typeof TEXT, entry: Partial<BlockTiming>): BlockTiming => ({ textHash: hash(TEXT[key]), by: "author", at: AT, ...entry });
const at = (result: ReturnType<typeof timeChapter>, key: string) => result.bars.find((bar) => bar.key === key)!;

describe("the clock (R-80)", () => {
  it("runs the blocks back to back with nothing set, as the player does", () => {
    const result = timeChapter({ blocks: blocks(ALL), record: {}, reading: "narrator", unmade: "skip" });
    assert.deepEqual(result.bars.map((bar) => [bar.key, bar.at]), [["title", 0], ["p0.0", 2], ["p1.0", 4.4], ["p2.0", 7.4], ["p3.0", 9]]);
    assert.equal(result.seconds, 11);
    assert.deepEqual(result.overlaps, []);
    assert.equal(at(result, "p1.0").pauseAfter, 0);
  });

  it("a negative start cuts in on the block before, and the overlap is mixed under it", () => {
    const record = { timing: { "p2.0": timing("p2", { start: -0.4 }) } };
    const result = timeChapter({ blocks: blocks(ALL), record, reading: "narrator", unmade: "skip" });
    assert.equal(at(result, "p2.0").at, 7);
    assert.equal(at(result, "p2.0").start, -0.4);
    assert.equal(at(result, "p1.0").pauseAfter, -0.4, "the block before's Pause after is the same value");
    assert.deepEqual(result.overlaps, [{ from: 7, to: 7.4 }]);
    assert.ok(at(result, "p1.0").overlaps && at(result, "p2.0").overlaps);
    const mix = chapterMix(result);
    assert.equal(mix.voices.find((voice) => voice.key === "p2.0")!.at, 7, "the mix plays it where the clock puts it, under the line it cuts");
  });

  it("never starts a block before the one it cuts in on", () => {
    const short = { ...ALL, p2: take("c", 0.5) };
    const record = { timing: { "p3.0": timing("p3", { start: -1.5 }) } };
    const result = timeChapter({ blocks: blocks(short), record, reading: "narrator", unmade: "skip" });
    assert.equal(at(result, "p3.0").at, at(result, "p2.0").at);
  });

  it("a pause is a positive start", () => {
    const result = timeChapter({ blocks: blocks(ALL), record: { timing: { "p0.0": timing("p0", { start: 1.2 }) } }, reading: "narrator", unmade: "skip" });
    assert.equal(at(result, "p0.0").at, 3.2);
    assert.equal(at(result, "title").pauseAfter, 1.2);
  });

  it("a block under another plays at its host's start and leaves the run to the blocks either side", () => {
    const record = { timing: { "p2.0": timing("p2", { under: { host: { key: "p1.0", textHash: hash(TEXT.p1) }, offset: 1 } }) } };
    const result = timeChapter({ blocks: blocks(ALL), record, reading: "narrator", unmade: "skip" });
    assert.equal(at(result, "p2.0").at, 5.4);
    assert.deepEqual(at(result, "p2.0").under, { host: "p1.0", offset: 1 });
    assert.equal(at(result, "p3.0").at, 7.4, "the block after runs on from the host");
  });

  it("skips a block not made, the clock standing, and estimates it for the view", () => {
    const partial = { ...ALL, p1: undefined };
    const skipped = timeChapter({ blocks: blocks(partial), record: {}, reading: "narrator", unmade: "skip" });
    assert.equal(skipped.bars.some((bar) => bar.key === "p1.0"), false);
    assert.equal(at(skipped, "p2.0").at, 4.4);
    const estimated = timeChapter({ blocks: blocks(partial), record: {}, reading: "narrator", unmade: "estimate" });
    assert.equal(at(estimated, "p1.0").made, false);
    assert.ok(estimated.estimated);
  });
});

describe("the take trimmed and a grouped cut nudged (R-81, R-82)", () => {
  it("applies a trim set on this take", () => {
    const record = { timing: { "p1.0": timing("p1", { trim: { artifactId: ALL.p1.artifactId, head: 0.28, tail: 0.41 } }) } };
    const bar = at(timeChapter({ blocks: blocks(ALL), record, reading: "narrator", unmade: "skip" }), "p1.0");
    assert.deepEqual(bar.trim, { head: 0.28, tail: 0.41 });
    assert.equal(bar.seconds, 2.31);
    assert.deepEqual(bar.segments, [{ file: "artifacts/b.wav", from: 0.28, to: 2.59 }]);
  });

  it("a new take keeps its start and drops its trim", () => {
    const record = { timing: { "p1.0": timing("p1", { start: 0.5, trim: { artifactId: ALL.p1.artifactId, head: 0.3, tail: 0 } }) } };
    const retaken = { ...ALL, p1: take("b2", 3.2) };
    const bar = at(timeChapter({ blocks: blocks(retaken), record, reading: "narrator", unmade: "skip" }), "p1.0");
    assert.equal(bar.start, 0.5);
    assert.equal(bar.trim, null);
    assert.equal(bar.trimDropped, true);
    assert.equal(bar.seconds, 3.2);
  });

  it("a nudge moves the cut between two cuts of one request", () => {
    const grouped = { ...ALL, p0: take("g0", 2, { request: "rq", offsetSec: 0, durationSec: 2 }), p1: take("g1", 3, { request: "rq", offsetSec: 2, durationSec: 3 }) };
    const record = { timing: { "p0.0": timing("p0", { nudge: 0.06 }) } };
    const result = timeChapter({ blocks: blocks(grouped), record, reading: "narrator", unmade: "skip" });
    assert.ok(at(result, "p0.0").nudgeable);
    assert.deepEqual(at(result, "p0.0").segments, [{ file: "artifacts/g0.wav", from: 0, to: 2 }, { file: "artifacts/g1.wav", from: 0, to: 0.06 }]);
    assert.deepEqual(at(result, "p1.0").segments, [{ file: "artifacts/g1.wav", from: 0.06, to: 3 }]);
    assert.equal(at(result, "p1.0").at, 4.06, "the total holds; only the cut moved");
    const back = timeChapter({ blocks: blocks(grouped), record: { timing: { "p0.0": timing("p0", { nudge: -0.1 }) } }, reading: "narrator", unmade: "skip" });
    assert.deepEqual(at(back, "p1.0").segments, [{ file: "artifacts/g0.wav", from: 1.9, to: 2 }, { file: "artifacts/g1.wav", from: 0, to: 3 }]);
  });

  it("ignores a nudge between takes of different requests", () => {
    const record = { timing: { "p0.0": timing("p0", { nudge: 0.2 }) } };
    const bar = at(timeChapter({ blocks: blocks(ALL), record, reading: "narrator", unmade: "skip" }), "p0.0");
    assert.equal(bar.nudgeable, false);
    assert.equal(bar.nudge, 0);
  });
});

describe("under Performed a grouped request is the reader's (R-85)", () => {
  const grouped = {
    ...ALL,
    p1: take("g1", 3, { request: "rq", offsetSec: 0, durationSec: 3 }),
    p2: take("g2", 1.6, { request: "rq", offsetSec: 3, durationSec: 1.6 }),
    p3: take("g3", 2, { request: "rq", offsetSec: 4.6, durationSec: 2 }),
  };
  const record = { timing: { "p1.0": timing("p1", { start: 0.4 }), "p2.0": timing("p2", { start: -0.4 }), "p3.0": timing("p3", { start: 1 }) } };

  it("holds the starts inside the group, and lets the group's first start be set", () => {
    const result = timeChapter({ blocks: blocks(grouped), record, reading: "performed", unmade: "skip" });
    assert.equal(at(result, "p1.0").start, 0.4);
    assert.equal(at(result, "p1.0").locked.start, false);
    assert.equal(at(result, "p2.0").start, 0);
    assert.ok(at(result, "p2.0").locked.start);
    assert.ok(at(result, "p1.0").locked.pauseAfter);
    assert.equal(at(result, "p3.0").start, 0);
  });

  it("keeps a block inside the group in the reader's turn though it was set to play under another (codex on PR 1497)", () => {
    const under = { timing: { "p2.0": timing("p2", { under: { host: { key: "title", textHash: hash(TEXT.title) }, offset: 0 } }) } };
    const result = timeChapter({ blocks: blocks(grouped), record: under, reading: "performed", unmade: "skip" });
    assert.equal(at(result, "p2.0").under, null);
    assert.equal(at(result, "p2.0").at, at(result, "p1.0").at + 3);
  });

  it("leaves the same group's timing settable under another reading", () => {
    const result = timeChapter({ blocks: blocks(grouped), record, reading: "narrator", unmade: "skip" });
    assert.equal(at(result, "p2.0").start, -0.4);
    assert.equal(at(result, "p2.0").locked.start, false);
  });
});

describe("reactions (R-83)", () => {
  const reaction = (offset: number, words?: string): AudiobookReaction => ({ host: { key: "p3.0", textHash: hash(TEXT.p3) }, speaker: "tunde", ...(words !== undefined ? { words } : { sound: "laughs" as const }), offset, by: "author", at: AT });

  it("plays under its host in the speaker's lane", () => {
    const result = timeChapter({ blocks: blocks(ALL), record: { reactions: { x1: reaction(0.5) } }, reactions: [{ key: "x1", lane: "tunde", take: take("r", 0.8) }], reading: "narrator", unmade: "skip" });
    const bar = at(result, "x1");
    assert.equal(bar.kind, "reaction");
    assert.equal(bar.lane, "tunde");
    assert.equal(bar.at, 9.5);
    assert.deepEqual(result.overlaps, [{ from: 9.5, to: 10.3 }]);
  });

  it("is drawn at an estimate before it is read, and is not in the mix", () => {
    const record = { reactions: { x1: reaction(0, "mm") } };
    const estimated = timeChapter({ blocks: blocks(ALL), record, reactions: [{ key: "x1", lane: "tunde" }], reading: "narrator", unmade: "estimate" });
    assert.equal(at(estimated, "x1").made, false);
    const mixed = chapterMix(timeChapter({ blocks: blocks(ALL), record, reactions: [{ key: "x1", lane: "tunde" }], reading: "narrator", unmade: "skip" }));
    assert.equal(mixed.voices.some((voice) => voice.key === "x1"), false);
  });

  it("names the next free key", () => {
    assert.equal(nextReactionKey(undefined), "x1");
    assert.equal(nextReactionKey({ x1: 0, x4: 0 }), "x5");
  });

  it("refuses a reaction that is both a sound and words", () => {
    const record = { schemaVersion: 1, chapterVersion: 1, hash: "h", updatedAt: AT, takes: {}, flags: {}, reactions: { x1: { ...reaction(0, "mm"), sound: "laughs" } } };
    assert.equal(ChapterAudiobookSchema.safeParse(record).success, false);
  });
});

describe("timing holds to the blocks (R-82)", () => {
  it("a block's words changed keep its timing on it", () => {
    const record = { timing: { "p2.0": timing("p2", { start: -0.4 }) } };
    const edited = blocks(ALL).map((block) => (block.key === "p2.0" ? { ...block, text: "“Tunde, wait —”" } : block));
    assert.equal(at(timeChapter({ blocks: edited, record, reading: "narrator", unmade: "skip" }), "p2.0").start, -0.4);
  });

  it("follows its words when a paragraph inserted above moves the keys", () => {
    const record = { timing: { "p2.0": timing("p2", { start: -0.4 }) }, takes: { "p2.0": { textHash: hash(TEXT.p2) } } };
    const shifted: TimingInputBlock[] = [
      ...blocks(ALL).slice(0, 2),
      { key: "p1.0", text: "A new paragraph.", lane: "narration", take: take("n", 1) },
      ...blocks(ALL).slice(2).map((block) => ({ ...block, key: block.key.replace(/^p(\d+)/, (_, n: string) => `p${Number(n) + 1}`) })),
    ];
    const result = timeChapter({ blocks: shifted, record, reading: "narrator", unmade: "skip" });
    assert.equal(at(result, "p3.0").start, -0.4);
    assert.equal(at(result, "p2.0").start, 0);
  });

  it("a removed block ends a bed at the block before it and flags a sound on it", () => {
    const bed: AudiobookBed = { from: { key: "p0.0", textHash: hash(TEXT.p0) }, to: { key: "p2.0", textHash: hash(TEXT.p2) }, source: { file: "artifacts/club.wav", origin: "world", label: "Club" }, levelDb: -14, fadeInSec: 2, fadeOutSec: 4, duckDb: 10, by: "author", at: AT };
    const sound: AudiobookBlockSound = { block: { key: "p2.0", textHash: hash(TEXT.p2) }, source: { file: "artifacts/door.wav", origin: "world", label: "door" }, levelDb: -6, by: "author", at: AT };
    const record = { beds: { b1: bed }, sounds: { s1: sound }, takes: { "p2.0": { textHash: hash(TEXT.p2) }, "p3.0": { textHash: hash(TEXT.p3) } } };
    const whole = timeChapter({ blocks: blocks(ALL), record, reading: "narrator", unmade: "skip" });
    assert.deepEqual([whole.beds[0]!.at, whole.beds[0]!.seconds, whole.beds[0]!.cut], [2, 7, null]);
    assert.deepEqual(whole.sounds.map((s) => [s.id, s.at]), [["s1", 7.4]]);
    // p2.0 removed: the paragraphs close up and p3.0's words now sit at p2.0.
    const removed = blocks(ALL).filter((block) => block.key !== "p2.0").map((block) => (block.key === "p3.0" ? { ...block, key: "p2.0" } : block));
    const result = timeChapter({ blocks: removed, record, reading: "narrator", unmade: "skip" });
    assert.equal(result.beds[0]!.cut, "to");
    assert.equal(result.beds[0]!.toIndex, 2, "ends at the block before the removed one");
    assert.equal(result.beds[0]!.seconds, 5.4);
    assert.deepEqual(result.lost.sounds, ["s1"]);
    assert.deepEqual(result.sounds, []);
  });

  it("never plays a bed or a sound from outside the world (codex on PR 1497)", () => {
    const outside = { file: "../../private.wav", origin: "world" as const, label: "x" };
    const record = {
      beds: { b1: { from: { key: "p0.0", textHash: hash(TEXT.p0) }, to: { key: "p3.0", textHash: hash(TEXT.p3) }, source: outside, levelDb: -14, fadeInSec: 2, fadeOutSec: 4, duckDb: 10, by: "author" as const, at: AT } },
      sounds: { s1: { block: { key: "p1.0", textHash: hash(TEXT.p1) }, source: { ...outside, file: "C:/Windows/media/ding.wav" }, levelDb: -6, by: "author" as const, at: AT } },
    };
    const result = timeChapter({ blocks: blocks(ALL), record, reading: "narrator", unmade: "skip" });
    assert.deepEqual(result.beds, []);
    assert.deepEqual(result.sounds, []);
    assert.deepEqual(result.lost, { sounds: ["s1"], reactions: [], beds: ["b1"] });
    assert.ok(isWorldAudioPath("artifacts/club.mp3"));
    assert.ok(isWorldAudioPath("artifacts/rain.mp4"), "an audio-only container the shelf files as audio (codex on PR 1503)");
    assert.equal(isWorldAudioPath("artifacts/../club.wav"), false);
  });

  it("places an anchor by the take's former key", () => {
    const list = [{ key: "p0.0", textHash: "a" }, { key: "p1.0", textHash: "c" }];
    assert.deepEqual(placeAnchor(list, { key: "p1.0", textHash: "b" }, (h) => (h === "c" ? "p2.0" : undefined)), { index: -1, state: "gone", near: 1 });
    assert.deepEqual(placeAnchor(list, { key: "p1.0", textHash: "b" }), { index: 1, state: "changed" });
    assert.deepEqual(placeAnchor(list, { key: "p5.0", textHash: "z" }), { index: -1, state: "gone", near: 2 });
  });
});

describe("the mix (R-85)", () => {
  it("ducks a bed under speech, down ahead of a voice and back up after it", () => {
    const envelope = duckEnvelope([{ from: 1, to: 2 }], 3, 0.01, 0.15, 0.5);
    assert.equal(envelope[50], 0);
    assert.ok(envelope[93]! > 0 && envelope[93]! < 1);
    assert.equal(envelope[150], 1);
    assert.ok(envelope[230]! > 0 && envelope[230]! < 1);
    assert.equal(envelope[260], 0);
  });

  it("fades a bed in and out", () => {
    const bed = { at: 10, seconds: 20, fadeInSec: 2, fadeOutSec: 4 };
    assert.equal(bedFade(9, bed), 0);
    assert.equal(bedFade(11, bed), 0.5);
    assert.equal(bedFade(20, bed), 1);
    assert.equal(bedFade(28, bed), 0.5);
  });

  it("names the same plan the same, and a changed one otherwise", () => {
    const base = chapterMix(timeChapter({ blocks: blocks(ALL), record: {}, reading: "narrator", unmade: "skip" }));
    const moved = chapterMix(timeChapter({ blocks: blocks(ALL), record: { timing: { "p2.0": timing("p2", { start: -0.4 }) } }, reading: "narrator", unmade: "skip" }));
    assert.equal(mixKey(base), mixKey(chapterMix(timeChapter({ blocks: blocks(ALL), record: {}, reading: "narrator", unmade: "skip" }))));
    assert.notEqual(mixKey(base), mixKey(moved));
  });
});

describe("the record and the copy (R-87, R-88)", () => {
  it("reads a record with timing, and one without as before", () => {
    const record = { schemaVersion: 1, chapterVersion: 1, hash: "h", updatedAt: AT, takes: {}, flags: {}, timing: { "p2.0": timing("p2", { start: -0.4 }) } };
    assert.ok(ChapterAudiobookSchema.safeParse(record).success);
    assert.ok(hasTiming(ChapterAudiobookSchema.parse(record)));
    assert.equal(hasTiming(ChapterAudiobookSchema.parse({ ...record, timing: undefined })), false);
    assert.equal(ChapterAudiobookSchema.safeParse({ ...record, timing: { "p2.0": timing("p2", { start: -2 }) } }).success, false, "no earlier than −1.5 s");
  });

  it("follows words by the take's own fingerprint", () => {
    assert.equal(audiobookTimingHash("a  b\n c"), audiobookTextHash("a b c"));
  });

  it("says seconds as data", () => {
    assert.equal(formatTimingSeconds(-0.4), "−0.4 s");
    assert.equal(formatTimingSeconds(0.06, true), "+0.06 s");
    assert.equal(formatTimingSeconds(2), "2.0 s");
    assert.equal(formatTimingSeconds(0), "0.0 s");
  });
});
