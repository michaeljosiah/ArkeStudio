import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AUDIOBOOK_TITLE_KEY,
  audiobookBlocks,
  audiobookBlockState,
  audiobookChapterComplete,
  audiobookCounts,
  audiobookHeading,
  audiobookTextHash,
  ChapterAudiobookSchema,
  summariseAudiobook,
  type AudiobookReader,
  type ChapterAudiobook,
} from "../src/audiobook.js";

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

function record(takes: ChapterAudiobook["takes"], flags: ChapterAudiobook["flags"] = {}): ChapterAudiobook {
  return { schemaVersion: 1, chapterVersion: 4, hash: "sha256:body", updatedAt: AT, takes, flags };
}

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
    assert.deepEqual(summariseAudiobook(rec), { chapterVersion: 4, hash: "sha256:body", updatedAt: AT, takes: 1, flagged: 1 });
    assert.ok(!ChapterAudiobookSchema.safeParse({ ...rec, extra: true }).success, "strict: a field this build does not know is not a record");
  });
});
