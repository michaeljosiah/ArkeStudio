import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentMediaObservationSchema, AnalyzeAudioArgsSchema, ReviewAudioContentArgsSchema } from "../src/agent-media.js";
import { AGENT_SPEECH_STRETCH_READER, AGENT_TRANSCRIPT_LIMITS, AgentSpeechTranscriptSchema, AgentTranscriptTextSchema } from "../src/agent-audio.js";
import { MEASURED_WORD_TIMING_ENGINE } from "../src/audiobook-word-timing.js";

test("speech references are explicit bounded text, never file paths or arbitrary extras", () => {
  const args = { source: { kind: "artifact", id: "ar-one" }, range: { startSec: 0, endSec: 60 }, expectedText: "Do not leave." };
  assert.ok(ReviewAudioContentArgsSchema.safeParse(args).success);
  for (const invalid of [{ ...args, expectedText: " " }, { ...args, expectedText: undefined },
    { ...args, expectedText: "a".repeat(12001) }, { ...args, expectedText: "word ".repeat(1001) },
    { ...args, source: { kind: "path", path: "C:/private.wav" } }, { ...args, language: "auto" },
    { ...args, range: { startSec: 0, endSec: 61 } }]) assert.equal(ReviewAudioContentArgsSchema.safeParse(invalid).success, false);
  assert.equal(AnalyzeAudioArgsSchema.safeParse(args).success, false, "transcription cannot silently accept a review script");
  assert.equal(AgentTranscriptTextSchema.parse("  Stay here  "), "Stay here");
});

// A ten-second interval that starts two seconds into its take, which starts five seconds into its source.
const sha = (letter: string) => `sha256:${letter.repeat(64)}`;
const at = (startSec: number, endSec: number) => ({ startSec, endSec, viewStartSec: 2 + startSec, viewEndSec: 2 + endSec });
const word = (text: string, startSec: number, endSec: number) => ({ text, probability: .9, ...at(startSec, endSec), sourceStartSec: 7 + startSec, sourceEndSec: 7 + endSec });
const stretch = (startSec: number, endSec: number, read: "timed" | "text-only" | "silent", text = "") => ({ ...at(startSec, endSec), read, text });
const engine = { id: MEASURED_WORD_TIMING_ENGINE, version: "1", model: "fixture" };
const base = { streamIndex: 1, derivative: { profile: "arke-stt-16khz-mono-v1", hash: sha("a"), byteLength: 320044, sampleRate: 16000, channels: 1, format: "pcm-s16le-wav", durationSec: 10 },
  wordTimeOrigin: "inspection-interval-start", confidence: "uncalibrated-word-probabilities" };
const whole = { ...base, engine, text: "Stay here", words: [word("Stay", .1, .3), word("here", .4, .8)] };
const mixed = { ...base, engine, text: "Stay here Not yet", words: [word("Stay", .8, 1), word("here", 1.1, 1.5)],
  stretches: [stretch(.7, 2.3, "timed", "Stay here"), stretch(4, 5, "text-only", "Not yet"), stretch(7, 8.2, "silent")] };
/** Refused, and for the reason meant: a case that fails some other rule first proves nothing about this one. */
const refused = (value: unknown, why: RegExp) => {
  const result = AgentSpeechTranscriptSchema.safeParse(value);
  assert.equal(result.success, false, JSON.stringify(value).slice(0, 300));
  assert.match(result.error!.issues.map(issue => issue.message).join("; "), why);
};

test("a transcript from before stretches still parses, and is still held to an engine, text and a timed word", () => {
  assert.ok(AgentSpeechTranscriptSchema.safeParse(whole).success);
  const { engine: _engine, ...unnamed } = whole;
  refused(unnamed, /names its recognizer/);
  for (const invalid of [{ ...whole, words: [] }, { ...whole, text: "" }, { ...whole, text: "Do not stay here" }]) refused(invalid, /text and timed words disagree/);
});

test("a read in stretches keeps timed words, text alone and silence apart; no stretches is no voice", () => {
  const parsed = AgentSpeechTranscriptSchema.parse(mixed);
  assert.deepEqual(parsed.stretches!.map(value => value.read), ["timed", "text-only", "silent"]);
  assert.ok(AgentSpeechTranscriptSchema.safeParse({ ...base, text: "", words: [], stretches: [] }).success, "nothing found to read");
  assert.ok(AgentSpeechTranscriptSchema.safeParse({ ...base, text: "Not yet", words: [], stretches: [stretch(4, 5, "text-only", "Not yet"), stretch(7, 8, "silent")] }).success, "nothing timed needs no engine");
  // Two pieces of one long line meet at the cut between them.
  assert.ok(AgentSpeechTranscriptSchema.safeParse({ ...mixed, text: "Stay here", words: [word("Stay", .8, 1), word("here", 2.4, 2.8)],
    stretches: [stretch(.7, 2.3, "timed", "Stay"), stretch(2.3, 4, "timed", "here")] }).success);
});

test("a stretch cannot claim words it does not hold, text it did not hear or an engine that timed nothing", () => {
  const { engine: _engine, ...unnamed } = mixed, [timed, textOnly, silent] = mixed.stretches as [ReturnType<typeof stretch>, ReturnType<typeof stretch>, ReturnType<typeof stretch>];
  // A word in a stretch that was not timed, and a word in no stretch at all.
  refused({ ...mixed, words: [...mixed.words, word("yet", 4.2, 4.6)] }, /^A speech stretch's text and timed words must match how it was read$/);
  refused({ ...mixed, words: [word("Stay", .2, .4), word("here", 1.1, 1.5)] }, /Every timed word must lie inside a timed stretch/);
  for (const text of ["Stay here", "Not yet Stay here"]) refused({ ...mixed, text }, /^Recognized text must be its stretches' text in order$/);
  refused({ ...mixed, text: "Stay here Not yet hm", stretches: [timed, textOnly, stretch(7, 8.2, "silent", "hm")] }, /^A speech stretch's text and timed words must match how it was read$/);
  refused({ ...mixed, text: "Stay here", stretches: [timed, stretch(4, 5, "text-only"), silent] }, /^A speech stretch's text and timed words must match how it was read$/);
  refused({ ...mixed, text: "Stay here now Not yet", stretches: [stretch(.7, 2.3, "timed", "Stay here now"), textOnly, silent] }, /^A speech stretch's text and timed words must match how it was read$/);
  refused({ ...mixed, text: "Not yet", words: [], stretches: [textOnly, silent] }, /^A recognizer is named exactly when a stretch was timed$/);
  refused(unnamed, /^A recognizer is named exactly when a stretch was timed$/);
  for (const stretches of [[timed, stretch(2, 5, "text-only", "Not yet"), silent], [timed, textOnly, stretch(9, 10.1, "silent")], [timed, textOnly, stretch(8, 8, "silent")]]) {
    refused({ ...mixed, stretches }, /^Speech stretches must be ordered, apart and inside decoded audio$/);
  }
  refused({ ...base, text: "", words: [], stretches: Array.from({ length: AGENT_TRANSCRIPT_LIMITS.stretches + 1 }, (_, i) => stretch(i * .5, i * .5 + .4, "silent")) }, /at most 12/);
  assert.equal(AgentSpeechTranscriptSchema.safeParse({ ...base, text: " ", words: [], stretches: [] }).success, false, "blank text is not no text");
});

test("a stretch read's script comparison names the stretch reader, since two readers can make its text", () => {
  const review = (transcriber: { id: string; version: string }, observedText: string) => ({ basis: "recognized-speech-text", expectedText: "Stay", expectedTextHash: sha("b"),
    comparison: { status: "compared", audioHash: sha("a"), targetTextHash: sha("b"), transcriber: { id: transcriber.id, version: transcriber.version, normalizationVersion: 1 }, observedText,
      result: "mismatch", differences: [], boundaryAlignment: "unavailable" } });
  assert.ok(AgentSpeechTranscriptSchema.safeParse({ ...mixed, contentReview: review(AGENT_SPEECH_STRETCH_READER, mixed.text) }).success);
  assert.ok(AgentSpeechTranscriptSchema.safeParse({ ...base, text: "", words: [], stretches: [], contentReview: review(AGENT_SPEECH_STRETCH_READER, "") }).success, "nothing heard is still compared");
  refused({ ...mixed, contentReview: review(engine, mixed.text) }, /^Speech comparison must cite the recognized derivative and its reader$/);
  refused({ ...mixed, contentReview: review(AGENT_SPEECH_STRETCH_READER, "Stay here") }, /^Speech comparison must cite the recognized derivative and its reader$/);
  assert.ok(AgentSpeechTranscriptSchema.safeParse({ ...whole, contentReview: review(engine, whole.text) }).success, "an older receipt still cites its engine");
  refused({ ...whole, contentReview: review(AGENT_SPEECH_STRETCH_READER, whole.text) }, /^Speech comparison must cite the recognized derivative and its reader$/);
});

test("an observation holds a stretch's view times to its interval, as it holds a word's", () => {
  const media = { profile: "arke-media-evidence-v1", decoderVersion: "ffmpeg version test", probeVersion: "ffprobe version test",
    source: { kind: "artifact", id: "ar-one" }, sourceHash: sha("c"), byteLength: 100, sourceStartSec: 5, sourceEndSec: 30,
    inventory: { durationSec: 30, streams: [{ index: 1, kind: "audio", codec: "pcm", sampleRate: 48000, channels: 2, durationSec: 30, startTimeSec: 0 }] },
    range: { startSec: 2, endSec: 12 }, transcript: mixed, coverage: "recognized-speech", limitations: ["Speech recognition only"] };
  assert.ok(AgentMediaObservationSchema.safeParse(media).success);
  const moved = { ...mixed, stretches: [mixed.stretches[0]!, { ...mixed.stretches[1]!, viewStartSec: 4, viewEndSec: 5 }, mixed.stretches[2]!] };
  assert.equal(AgentMediaObservationSchema.safeParse({ ...media, transcript: moved }).success, false);
});
