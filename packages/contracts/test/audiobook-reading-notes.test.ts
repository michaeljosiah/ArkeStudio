import assert from "node:assert/strict";
import { it } from "node:test";
import {
  AudiobookBookSchema,
  audiobookBlockState,
  audiobookDirectionHash,
  audiobookReadingNotes,
  audiobookTakeDirectionHash,
  audiobookTextHash,
  readingNotesLead,
  type CadencePlan,
  type ChapterAudiobook,
  type ManifestModel,
} from "../src/index.js";

// The book note and the chapter note (design turn 184, SPEC-047 R-53, R-54).
const plan: CadencePlan = { schemaVersion: 1, sourceTextHash: `sha256:${"a".repeat(64)}`, delivery: "measured", speed: 1, cues: [] };
const row = (phrase?: "best-effort-tag" | "best-effort-instruction") =>
  ({ cadence: { deliveries: ["measured"], speed: null, pause: "unsupported", emphasis: "unsupported", breath: "unsupported", outputTimestamps: "none", deliveryMappings: { measured: { settings: {} } }, ...(phrase ? { phrase } : {}) } }) as Pick<ManifestModel, "cadence">;

it("the notes name a take too, and with neither the name is the one before them", () => {
  assert.equal(audiobookTakeDirectionHash(plan, undefined, {}), audiobookDirectionHash(plan), "no take made before the notes goes stale");
  assert.equal(audiobookTakeDirectionHash(plan, "low", {}), audiobookTakeDirectionHash(plan, "low"));
  const booked = audiobookTakeDirectionHash(plan, undefined, { book: "unhurried" });
  assert.notEqual(booked, audiobookDirectionHash(plan));
  assert.notEqual(booked, audiobookTakeDirectionHash(plan, undefined, { book: "brisk" }), "a book note changed is another take");
  assert.notEqual(audiobookTakeDirectionHash(plan, undefined, { chapter: "night" }), audiobookTakeDirectionHash(plan, undefined, { book: "night" }), "a chapter note is not a book note");
  assert.notEqual(audiobookTakeDirectionHash(null, undefined, { book: "unhurried" }), undefined, "the notes alone direct a block");
});

it("a block made under a book note goes stale when it changes", () => {
  const block = { key: "p0.0", text: "The ledger is kept." };
  const reader = { provider: "kokoro", model: "kokoro-82m", voiceId: "af_heart" };
  const record: ChapterAudiobook = {
    schemaVersion: 1, chapterVersion: 1, hash: "h", updatedAt: "2026-10-03T09:00:00.000Z", flags: {}, direction: {},
    takes: { "p0.0": { artifactId: "art_01J8F3K2QW9VZX4N7M0RTYB6H4", textHash: audiobookTextHash(block.text), reader, format: "wav", characters: 19, parts: 1, estimatedMicroUsd: 0, costMicroUsd: 0, directionHash: audiobookTakeDirectionHash(null, undefined, { book: "unhurried" })!, madeAt: "2026-10-03T09:00:00.000Z" } },
  };
  assert.equal(audiobookBlockState(block, record, reader, undefined, false, undefined, { book: "unhurried" }), "made");
  assert.equal(audiobookBlockState(block, record, reader, undefined, false, undefined, { book: "brisk" }), "stale");
  assert.equal(audiobookBlockState(block, record, reader, undefined, false, undefined, { book: "unhurried", chapter: "night" }), "stale");
});

it("the book record holds a book note and chapter notes to 300, and a note's source", () => {
  assert.ok(AudiobookBookSchema.safeParse({ schemaVersion: 1, reading: "performed", note: "x".repeat(300), chapterNotes: { neap: "y".repeat(300) }, notes: { a: "b" }, noteSources: { a: "sheet" } }).success);
  assert.ok(!AudiobookBookSchema.safeParse({ schemaVersion: 1, reading: "narrator", note: "x".repeat(301) }).success);
  assert.ok(!AudiobookBookSchema.safeParse({ schemaVersion: 1, reading: "narrator", noteSources: { a: "you" } }).success, "absent is the author's; only the sheet is named");
  assert.deepEqual(audiobookReadingNotes({ note: "close", chapterNotes: { neap: "night" } }, "neap"), { book: "close", chapter: "night" });
  assert.deepEqual(audiobookReadingNotes({ note: "close", chapterNotes: { neap: "night" } }, "other"), { book: "close" });
  assert.deepEqual(audiobookReadingNotes(null, "neap"), {});
});

it("an instruction row takes both whole as sentences, a tag row tags a short one and holds a long one, a row with neither holds both", () => {
  const notes = { book: "Nigerian English, unhurried and close. Yoruba and Pidgin said as a Lagos native says them", chapter: "night, the rail desk" };
  assert.deepEqual(readingNotesLead(notes, row("best-effort-instruction")), { tags: [], instructions: "Nigerian English, unhurried and close. Yoruba and Pidgin said as a Lagos native says them. Night, the rail desk.", held: [] });
  const tagged = readingNotesLead(notes, row("best-effort-tag"));
  assert.deepEqual(tagged.tags, ["[night, the rail desk]"]);
  assert.deepEqual(tagged.held, [{ which: "book", length: notes.book.length, reason: "a tag takes 60 characters" }]);
  assert.equal(tagged.instructions, undefined);
  assert.deepEqual(readingNotesLead(notes, row()).held.map((held) => held.which), ["book", "chapter"]);
});
