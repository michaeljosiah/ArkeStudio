import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AUDIOBOOK_TITLE_KEY,
  AudiobookDirectionSchema,
  audiobookBlocks,
  audiobookSpeakerColours,
  audiobookSpeakerKey,
  retailLevel,
  audiobookBlockState,
  audiobookChapterComplete,
  audiobookCounts,
  audiobookDirectionFor,
  audiobookDirectionHash,
  audiobookDoorLine,
  audiobookHeading,
  audiobookRowLabel,
  audiobookTextHash,
  AudiobookDoorSchema,
  ChapterAudiobookSchema,
  formatRunningTime,
  summariseAudiobook,
  type AudiobookDirection,
  type AudiobookReader,
  type AudiobookRow,
  type ChapterAudiobook,
} from "../src/audiobook.js";
import type { CadencePlan } from "../src/cadence.js";

/**
 * The audiobook's blocks and states (design turn 146, SPEC-047 R-2, R-13, R-14): the title
 * first, a scene break silent, a chapter with no prose empty; and a state derived every time
 * from the take's text hash and the reader the block is meant for now.
 */
const GEORGE: AudiobookReader = { provider: "kokoro", model: "kokoro-82m", voiceId: "bm_george", label: "George" };
const ANNA: AudiobookReader = { provider: "elevenlabs", model: "eleven_multilingual_v2", voiceId: "v_anna", label: "Anna" };
const BODY = "Maren counted the bells.\n\n***\n\n“That is not how it works,” she said.\n\nOdile found her there.";
const CAST = { lines: [{ speaker: "Maren Kest", sheet: "maren-kest", paragraph: 2, occurrence: 0, quote: "“That is not how it works,”" }] };
const AT = "2026-09-14T09:00:00.000Z";

function record(takes: ChapterAudiobook["takes"], flags: ChapterAudiobook["flags"] = {}, direction: ChapterAudiobook["direction"] = {}): ChapterAudiobook {
  return { schemaVersion: 1, chapterVersion: 4, hash: "sha256:body", updatedAt: AT, takes, flags, direction };
}
const SOURCE = `sha256:${"a".repeat(64)}`;
const plan = (extra: Partial<CadencePlan> = {}): CadencePlan => ({ schemaVersion: 1, sourceTextHash: SOURCE, delivery: "measured", speed: 1, cues: [], ...extra });
const directed = (text: string, p: CadencePlan): AudiobookDirection => ({ textHash: audiobookTextHash(text), plan: p, at: AT });

const take = (text: string, reader: AudiobookReader, extra: Partial<ChapterAudiobook["takes"][string]> = {}) => ({
  artifactId: "ar_01J8F3K2QW9VZX4N7M0RTYB6H1",
  textHash: audiobookTextHash(text),
  reader,
  format: "wav" as const,
  characters: text.length,
  parts: 1,
  estimatedMicroUsd: 0,
  costMicroUsd: null,
  madeAt: AT,
  ...extra,
});

describe("audiobook blocks (R-2)", () => {
  it("puts the title first, keys blocks by paragraph and split, and drops a scene break", () => {
    const { blocks, ambiguous } = audiobookBlocks(BODY, CAST, audiobookHeading(7, "The counting of bells"));
    assert.equal(ambiguous, 0);
    assert.deepEqual(
      blocks.map((block) => [block.key, block.paragraph, block.speaker ?? null]),
      [
        [AUDIOBOOK_TITLE_KEY, -1, null],
        ["p0.0", 0, null],
        ["p2.0", 2, "Maren Kest"],
        ["p2.1", 2, null],
        ["p3.0", 3, null],
      ],
      "the stars in paragraph 1 are a separator, not a block",
    );
    assert.equal(blocks[0]!.text, "Chapter 7 · The counting of bells");
  });

  it("a chapter with no prose has no blocks at all, not even the title", () => {
    assert.deepEqual(audiobookBlocks("", null, "Chapter 8 · Her own hand").blocks, []);
    assert.deepEqual(audiobookBlocks("\n\n***\n\n", null, "Chapter 8 · Her own hand").blocks, [], "a chapter that is only a break holds nothing to read");
  });
});

describe("a block's state (R-13, R-14)", () => {
  const { blocks } = audiobookBlocks(BODY, CAST, "Chapter 7 · The counting of bells");
  const narration = blocks[1]!;
  const line = blocks[2]!;

  it("is not made with no record and no take", () => {
    assert.equal(audiobookBlockState(narration, null, GEORGE), "not made");
    assert.equal(audiobookBlockState(narration, record({}), GEORGE), "not made");
  });

  it("is made when the take's words and reader are the block's, stale when the words moved", () => {
    const made = record({ [narration.key]: take(narration.text, GEORGE) });
    assert.equal(audiobookBlockState(narration, made, GEORGE), "made");
    assert.equal(audiobookBlockState({ key: narration.key, text: `${narration.text} Again.` }, made, GEORGE), "stale");
  });

  it("folds whitespace before comparing, since the file wraps where the reader did not", () => {
    const made = record({ [narration.key]: take("Maren counted\nthe bells.", GEORGE) });
    assert.equal(audiobookBlockState(narration, made, GEORGE), "made");
  });

  it("is stale when the reader the block is meant for changed, unless the take stood in for that reader", () => {
    const anna = record({ [line.key]: take(line.text, ANNA) });
    assert.equal(audiobookBlockState(line, anna, ANNA), "made");
    assert.equal(audiobookBlockState(line, anna, GEORGE), "stale", "the reading switched to the narrator");
    const stoodIn = record({ [line.key]: take(line.text, GEORGE, { assigned: ANNA, substituted: "voice unavailable" }) });
    assert.equal(audiobookBlockState(line, stoodIn, ANNA), "made", "the narrator stood in for Anna, and Anna is still what the block is meant for");
    assert.equal(audiobookBlockState(line, stoodIn, GEORGE), "stale", "the book now reads in the narrator's voice by choice, which is a different take");
  });

  it("is not made when the take it names is gone from the shelf, whatever the record says (codex on PR 1180)", () => {
    const made = record({ [narration.key]: take(narration.text, GEORGE) });
    assert.equal(audiobookBlockState(narration, made, GEORGE, () => true), "made");
    assert.equal(audiobookBlockState(narration, made, GEORGE, () => false), "not made", "the record is an index, never authoritative over the files it names");
    assert.equal(audiobookBlockState({ key: narration.key, text: "other words" }, made, GEORGE, () => false), "not made", "gone beats stale: there is nothing to keep");
    const counts = audiobookCounts(blocks, made, () => GEORGE, () => false);
    assert.equal(counts.made, 0);
    assert.ok(counts.toMake.includes(narration.key));
  });

  it("is stale when the direction changed since the take, and a direction authored for other words is none (R-9, R-14)", () => {
    const made = record({ [narration.key]: take(narration.text, GEORGE) });
    assert.equal(audiobookBlockState(narration, made, GEORGE), "made", "no direction, a take made with none");
    const withDirection = record({ [narration.key]: take(narration.text, GEORGE) }, {}, { [narration.key]: directed(narration.text, plan({ delivery: "urgent" })) });
    assert.equal(audiobookBlockState(narration, withDirection, GEORGE), "stale", "a direction added since the take");
    const hash = audiobookDirectionHash(plan({ delivery: "urgent" }));
    const under = record({ [narration.key]: take(narration.text, GEORGE, { directionHash: hash }) }, {}, { [narration.key]: directed(narration.text, plan({ delivery: "urgent" })) });
    assert.equal(audiobookBlockState(narration, under, GEORGE), "made", "the take was made under the direction that stands");
    const changed = record({ [narration.key]: take(narration.text, GEORGE, { directionHash: hash }) }, {}, { [narration.key]: directed(narration.text, plan({ delivery: "urgent", phrase: "flat" })) });
    assert.equal(audiobookBlockState(narration, changed, GEORGE), "stale", "a phrase added is a different direction");
    const dropped = record({ [narration.key]: take(narration.text, GEORGE, { directionHash: hash }) });
    assert.equal(audiobookBlockState(narration, dropped, GEORGE), "stale", "the direction cleared since the take");
    const otherWords = record({ [narration.key]: take(narration.text, GEORGE) }, {}, { [narration.key]: directed("other words entirely", plan({ delivery: "urgent" })) });
    assert.equal(audiobookDirectionFor(otherWords, narration), null, "a direction keyed to another hash is no direction");
    assert.equal(audiobookBlockState(narration, otherWords, GEORGE), "made", "and the undirected take stands");
  });

  it("names a direction the same whatever order its fields came in, and differently for any change", () => {
    const a = audiobookDirectionHash({ schemaVersion: 1, sourceTextHash: SOURCE, delivery: "cold", speed: 0.9, cues: [{ kind: "pause", at: 4, length: "long" }], phrase: "flat" });
    const b = audiobookDirectionHash({ phrase: "flat", cues: [{ length: "long", at: 4, kind: "pause" }], speed: 0.9, delivery: "cold", sourceTextHash: SOURCE, schemaVersion: 1 } as CadencePlan);
    assert.equal(a, b);
    assert.notEqual(a, audiobookDirectionHash(plan({ delivery: "cold", speed: 0.9, cues: [{ kind: "pause", at: 4, length: "short" }], phrase: "flat" })));
    assert.notEqual(a, audiobookDirectionHash(plan({ delivery: "cold", speed: 0.9, cues: [{ kind: "pause", at: 4, length: "long" }] })));
  });

  it("is flagged while the flag is newer than any take, and made once a later take replaces it", () => {
    const flagged = record({}, { [line.key]: { reason: "the reader refused", at: AT } });
    assert.equal(audiobookBlockState(line, flagged, ANNA), "flagged");
    const later = record({ [line.key]: take(line.text, ANNA, { madeAt: "2026-09-14T10:00:00.000Z" }) }, { [line.key]: { reason: "the reader refused", at: AT } });
    assert.equal(audiobookBlockState(line, later, ANNA), "made");
  });

  it("counts every state and lists what a run makes, and a chapter is complete only when every block is made", () => {
    const rec = record(
      { [AUDIOBOOK_TITLE_KEY]: take(blocks[0]!.text, GEORGE), [narration.key]: take("other words", GEORGE) },
      { [line.key]: { reason: "failed", at: AT } },
    );
    const counts = audiobookCounts(blocks, rec, (block) => (block.sheet === "maren-kest" ? ANNA : GEORGE));
    assert.deepEqual({ ...counts, toMake: undefined }, { total: 5, made: 1, stale: 1, flagged: 1, notMade: 2, toMake: undefined });
    assert.deepEqual(counts.toMake, ["p0.0", "p2.0", "p2.1", "p3.0"], "everything that is not made, in reading order");
    assert.equal(audiobookChapterComplete(counts), false);
    assert.equal(audiobookChapterComplete({ total: 5, made: 5 }), true);
    assert.equal(audiobookChapterComplete({ total: 0, made: 0 }), false, "a chapter with no blocks is never complete");
  });
});

describe("the record", () => {
  it("parses, and its summary carries the counts alone", () => {
    const rec = record({ p0: take("words", GEORGE) }, { p1: { reason: "x", at: AT } });
    assert.ok(ChapterAudiobookSchema.safeParse(rec).success);
    const { direction: _none, ...firstBuild } = rec;
    const parsed = ChapterAudiobookSchema.safeParse(firstBuild);
    assert.ok(parsed.success && Object.keys(parsed.data.direction).length === 0, "a record the first build wrote, with no direction field, reads with none");
    assert.ok(!AudiobookDirectionSchema.safeParse({ textHash: "text-v1:x", plan: plan({ phrase: "x".repeat(61) }), at: AT }).success, "a phrase over 60 characters is refused");
    assert.ok(!AudiobookDirectionSchema.safeParse({ textHash: "text-v1:x", plan: plan({ speed: 1.3 }), at: AT }).success, "speed is the plan's own 0.7–1.2");
    assert.deepEqual(summariseAudiobook(rec), { chapterVersion: 4, hash: "sha256:body", updatedAt: AT, takes: 1, flagged: 1 });
    assert.ok(!ChapterAudiobookSchema.safeParse({ ...rec, extra: true }).success, "strict: a field this build does not know is not a record");
  });
});

describe("the door's words (turn 146, R-15, R-29)", () => {
  const row = (over: Partial<AudiobookRow>): AudiobookRow => ({
    chapterId: "neap", file: "02-neap", order: 2, title: "Neap", version: 4, planned: false, total: 26, made: 22, stale: 0, flagged: 0, notMade: 4, seconds: 1200, ...over,
  });

  it("writes a running time as hours only once there are hours", () => {
    assert.equal(formatRunningTime(0), "0:00");
    assert.equal(formatRunningTime(64), "1:04");
    assert.equal(formatRunningTime(1864), "31:04");
    assert.equal(formatRunningTime(7768.4), "2:09:28");
    assert.equal(formatRunningTime(3600), "1:00:00", "the minutes take two figures once an hour stands before them");
  });

  it("labels a row by what stands in the way of it being read", () => {
    assert.equal(audiobookRowLabel(row({ planned: true, total: 0, made: 0, notMade: 0, seconds: 0 })), "planned");
    assert.equal(audiobookRowLabel(row({ castTrouble: "cast not current" })), "cast not current", "the cast's trouble outranks the count");
    assert.equal(audiobookRowLabel(row({ made: 26, notMade: 0, seconds: 1864 })), "read · 31:04");
    assert.equal(audiobookRowLabel(row({ made: 26, notMade: 0, seconds: null })), "read", "a take with no measured length is read, with no time claimed");
    assert.equal(audiobookRowLabel(row({ made: 0, notMade: 26 })), "not read");
    assert.equal(audiobookRowLabel(row({ made: 23, stale: 3, notMade: 0 })), "moved · 3 of 26 stale", "stale takes alone is the prose having moved");
    assert.equal(audiobookRowLabel(row({ flagged: 1, notMade: 3 })), "22 of 26 made · 1 flagged");
    assert.equal(audiobookRowLabel(row({ made: 20, stale: 2, flagged: 1, notMade: 3 })), "20 of 26 made · 2 stale · 1 flagged");
  });

  it("counts the chapters read of those with prose, sums the time of the read ones, and keeps the planned apart", () => {
    const rows = [row({ chapterId: "a", made: 26, notMade: 0, seconds: 1864 }), row({ chapterId: "b" }), row({ chapterId: "c", planned: true, total: 0, made: 0, notMade: 0, seconds: 0 })];
    assert.deepEqual(audiobookDoorLine(rows), { read: 1, withProse: 2, planned: 1, seconds: 1864, line: "1 of 2 chapters read · 31:04 · 1 planned" });
    assert.equal(audiobookDoorLine([]).line, "0 of 0 chapters read");
    assert.equal(audiobookDoorLine([row({ made: 26, notMade: 0, seconds: null })]).line, "1 of 1 chapter read", "an unmeasured take keeps the time off the line rather than understating it");
    assert.equal(audiobookDoorLine([rows[1]!]).line, "0 of 1 chapter read");
  });

  it("the door parses strict, a row with a cast's trouble and a speaker with no voice among it", () => {
    const door = {
      reading: "cast",
      voices: [
        { name: "George", voice: { label: "George", provider: "kokoro", local: true }, state: "narrator", blocks: 19 },
        { sheet: "odile-sarn", name: "Odile Sarn", state: "no voice", blocks: 3 },
      ],
      unattributed: 2,
      rows: [row({ castTrouble: "cast not current" })],
      price: { chapters: 1, blocks: 4, cloudBlocks: 0, characters: 0, estimatedMicroUsd: 0, voices: [{ label: "George", provider: "kokoro", local: true, characters: 610, estimatedMicroUsd: 0 }] },
    };
    assert.ok(AudiobookDoorSchema.safeParse(door).success);
    assert.ok(!AudiobookDoorSchema.safeParse({ ...door, export: {} }).success, "strict: the export waits for its slice");
    assert.ok(!AudiobookDoorSchema.safeParse({ ...door, voices: [{ name: "x", state: "reads", blocks: -1 }] }).success);
  });
});

describe("speaker colours (SPEC-047 R-33)", () => {
  const stamp = (...sheets: (string | undefined)[]) => ({ speakers: sheets.map((sheet, i) => ({ speaker: sheet ?? `name-${i}`, ...(sheet !== undefined ? { sheet } : {}) })) });
  it("numbers the book's speakers by chapter order and keeps one colour a speaker across chapters", () => {
    const colours = audiobookSpeakerColours([
      { order: 2, voices: stamp("odile", "maren") },
      { order: 1, voices: stamp("maren") },
      { order: 3, retired: true, voices: stamp("tam") },
      { order: 4, voices: { unreadable: true } },
    ]);
    assert.deepEqual([...colours], [["maren", 1], ["odile", 2]], "chapter 1 speaks first; a retired or unreadable chapter adds nobody");
  });
  it("leaves a name with no sheet uncoloured, wraps past six, and numbers extra speakers last", () => {
    const colours = audiobookSpeakerColours([{ order: 1, voices: stamp("a", undefined, "b", "c", "d", "e", "f", "g") }], ["h", "a"]);
    assert.equal(colours.size, 8);
    assert.equal(colours.get("g"), 1, "the seventh wraps to the first colour");
    assert.equal(colours.get("h"), 2, "a speaker the stamps do not hold yet comes after them");
    assert.equal(audiobookSpeakerKey({}), null);
    assert.equal(audiobookSpeakerKey({ speaker: "the harbourmaster" }), "the harbourmaster");
    assert.equal(audiobookSpeakerKey({ speaker: "Odile", sheet: "odile-sarn" }), "odile-sarn");
  });
});

describe("a recording's level against Retail (SPEC-047 R-23, R-35)", () => {
  it("passes within the window, warns outside it, and says nothing of what was not measured", () => {
    assert.deepEqual(retailLevel({ rmsDbfs: -20, samplePeakDbfs: -4 }), { loudness: "pass", peak: "pass" });
    assert.deepEqual(retailLevel({ rmsDbfs: -35, samplePeakDbfs: -1 }), { loudness: "warning", peak: "warning" });
    assert.deepEqual(retailLevel({ rmsDbfs: null, samplePeakDbfs: null }), { loudness: "unavailable", peak: "unavailable" });
  });
});
