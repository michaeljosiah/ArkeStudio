import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { VoxaClient } from "@arke-studio/voice";
import { AGENT_SPEECH_STRETCH_READER, AGENT_TRANSCRIPT_LIMITS, AgentMediaObservationSchema, WorldChatCheckReceiptSchema, type AcousticWords } from "@arke-studio/contracts";
import { readAgentSpeech, recognizeAgentSpeech } from "../../src/media/agent-speech.js";
import { writeSpeechWav } from "../../src/audio/speech-wav.js";
import { VoiceService } from "../../src/voice/service.js";

const bytes = writeSpeechWav({ rate: 16000, samples: new Float32Array(16000) });
const input = { bytes, durationSec: 1, streamIndex: 2, sourceStartSec: 7, viewStartSec: 2, signal: new AbortController().signal };
const heard: AcousticWords = { text: "Stay here", seconds: 1, engine: { id: "whisper.cpp/dtw-word-boundaries-v1", version: "test-1", model: "test-model" },
  words: [{ text: "Stay", startSec: .1, endSec: .3, probability: .95 }, { text: "here", startSec: .4, endSec: .8, probability: .3 }] };
const recognize = (value = heard, expectedText?: string) => recognizeAgentSpeech({ ...input, expectedText, read: async () => value });

test("the exact hashed canonical derivative reaches Voxa, with measured source/view word times and engine identity", async () => {
  const client = new VoxaClient(async (_url, init) => {
    assert.equal(String(_url).endsWith("/stt/words"), true);
    assert.deepEqual(new Uint8Array(init!.body as Buffer), bytes);
    assert.ok(init!.signal);
    return new Response(JSON.stringify(heard));
  }, "http://127.0.0.1:9");
  const value = await recognizeAgentSpeech({ ...input, read: (wav, signal) => client.transcribeWords(wav, { signal }) });
  assert.equal(value.derivative.hash, `sha256:${createHash("sha256").update(bytes).digest("hex")}`);
  assert.deepEqual(value.engine, heard.engine); assert.equal(value.words[0]!.sourceStartSec, 7.1);
  assert.equal(value.words[1]!.viewEndSec, 2.8); assert.equal(value.words[1]!.probability, .3);
  assert.equal(value.confidence, "uncalibrated-word-probabilities");
});

test("script wording comparison retains an exact target and keeps a negation change reviewable", async () => {
  const value = await recognize(heard, "Do not stay here"), review = value.contentReview!;
  assert.equal(review.basis, "recognized-speech-text");
  assert.equal(review.expectedText, "Do not stay here");
  assert.equal(review.comparison.status, "compared");
  if (review.comparison.status === "compared") {
    assert.equal(review.comparison.result, "mismatch");
    assert.ok(review.comparison.differences.some(diff => diff.authored.includes("not")));
    assert.equal(review.comparison.boundaryAlignment, "unavailable");
  }
  const exact = await recognize(heard, "Stay here");
  assert.equal(exact.contentReview!.comparison.status === "compared" && exact.contentReview!.comparison.result, "exact");
});

test("malformed, missing, excessive and out-of-range speech never becomes valid evidence", async () => {
  for (const value of [{ ...heard, text: "" }, { ...heard, text: "a".repeat(12001) }, { ...heard, seconds: 4 },
    { ...heard, engine: { ...heard.engine, model: "" } }, { ...heard, engine: { ...heard.engine, id: "sentence-duration-estimate" } },
    { ...heard, text: "Do not stay here" }, { ...heard, words: [{ ...heard.words[0]!, text: " " }] },
    { ...heard, text: "nowhere", words: [{ ...heard.words[0]!, text: "now" }, { ...heard.words[1]!, text: "here" }] },
    { ...heard, text: "...", words: [{ ...heard.words[0]!, text: "..." }] },
    { ...heard, words: [] }, { ...heard, words: Array(1001).fill(heard.words[0]) },
    { ...heard, words: [{ ...heard.words[0]!, startSec: .7, endSec: .3 }] },
    { ...heard, words: [{ ...heard.words[0]!, endSec: 1.1 }] },
    { ...heard, words: [{ ...heard.words[0]!, endSec: .9 }, { ...heard.words[1]!, startSec: .2 }] },
    { ...heard, words: [heard.words[1]!, heard.words[0]!] }, { ...heard, words: [{ ...heard.words[0]!, probability: 1.1 }] }]) {
    await assert.rejects(recognize(value));
  }
});

test("Stop promptly aborts local requests and ignores a non-cooperative recognizer's late result", async () => {
  const stop = new AbortController(); let finish!: (value: AcousticWords) => void;
  let active!: AbortSignal;
  const pending = recognizeAgentSpeech({ ...input, signal: stop.signal, read: async (_bytes, signal) => { active = signal; return new Promise(resolve => { finish = resolve; }); } });
  stop.abort(); await assert.rejects(pending, /stopped/); assert.equal(active.aborted, true);
  finish(heard);
});

test("the recognition deadline cancels a stalled local request without waiting for it", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let active!: AbortSignal;
  const pending = recognizeAgentSpeech({ ...input, read: async (_bytes, signal) => { active = signal; return new Promise(() => {}); } });
  t.mock.timers.tick(AGENT_TRANSCRIPT_LIMITS.timeoutMs);
  await assert.rejects(pending, /deadline/); assert.equal(active.aborted, true);
});

test("cancellation during local runtime health never launches word recognition afterwards", async () => {
  let finish!: () => void, calls = 0;
  const ready = new Promise<void>(resolve => { finish = resolve; });
  let healthSignal: AbortSignal | undefined;
  const service = new VoiceService({ sidecar: { health: async options => { healthSignal = options?.signal; await ready; return { engineStatus: { kokoro: { ready: false } }, wordTiming: { ready: true } }; },
    listVoices: async () => [], synthesize: async () => bytes, transcribe: async () => "unused", transcribeWords: async () => { calls++; return heard; } },
    localPresets: [], cloudSources: [], getKey: async () => null, emit: () => {} });
  const stop = new AbortController(), pending = service.transcribeWords(bytes, stop.signal);
  stop.abort(); finish(); await assert.rejects(pending); assert.equal(calls, 0); assert.equal(healthSignal, stop.signal);
});

test("speech receipts cannot masquerade as signal QC or a completed script review", async () => {
  const transcript = await recognize(), media = { profile: "arke-media-evidence-v1", decoderVersion: "ffmpeg version test", probeVersion: "ffprobe version test",
    source: { kind: "artifact", id: "ar-one" }, sourceHash: "sha256:" + "b".repeat(64), byteLength: 100, sourceStartSec: 5, sourceEndSec: 10,
    inventory: { durationSec: 10, streams: [{ index: 2, kind: "audio", codec: "pcm", sampleRate: 48000, channels: 2, durationSec: 10, startTimeSec: 0 }] },
    range: { startSec: 2, endSec: 3 }, transcript, coverage: "recognized-speech", limitations: ["Speech recognition only"] };
  assert.ok(AgentMediaObservationSchema.safeParse(media).success);
  for (const invalid of [{ ...media, coverage: "decoded-audio-samples" }, { ...media, transcript: { ...transcript, streamIndex: 3 } },
    { ...media, sourceStartSec: 0 }, { ...media, range: { startSec: 0, endSec: 1 } }]) assert.equal(AgentMediaObservationSchema.safeParse(invalid).success, false);
  const receipt = { id: "check_01J8F0000000000000000000C1", runId: "run_01J8F0000000000000000000C1", tool: "transcribe-audio", status: "complete", consulted: [], media, at: "2026-10-14T00:00:00Z" };
  assert.ok(WorldChatCheckReceiptSchema.safeParse(receipt).success);
  assert.equal(WorldChatCheckReceiptSchema.safeParse({ ...receipt, tool: "review-audio-content" }).success, false);
  assert.equal(WorldChatCheckReceiptSchema.safeParse({ ...receipt, tool: "analyze-audio-signal" }).success, false);
});

/**
 * Film sound as the speech tools meet it: a room that is never silent, with lines in it. The
 * measured reader here does what the real one does with that: it places the words of a short
 * stretch, and refuses anything with a long pause in it.
 */
function scene(lines: Array<[number, number]>, seconds = 10) {
  let state = 7;
  const noise = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2147483648 - 1; };
  const samples = new Float32Array(seconds * 16000).map(() => .008 * noise());
  for (const [from, to] of lines) for (let i = from * 16000; i < to * 16000; i++) samples[i]! += .15 * Math.sin(2 * Math.PI * 220 * i / 16000);
  return writeSpeechWav({ rate: 16000, samples });
}
const seconds = (wav: Uint8Array) => (wav.length - 44) / 2 / 16000;
const spoken = (text: string, wav: Uint8Array): AcousticWords => ({ text, seconds: seconds(wav), engine: heard.engine,
  words: text.split(" ").map((word, i) => ({ text: word, startSec: .3 + i * .3, endSec: .5 + i * .3, probability: .9 })) });
const unplaced = () => new Error("a word has no usable timing or an unresolved pause");
const film = { ...input, bytes: scene([[1, 2], [6, 7]]), durationSec: 10 };
const close = (actual: number[], expected: number[]) => {
  assert.equal(actual.length, expected.length, JSON.stringify(actual));
  actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]!) < 1e-9, `${JSON.stringify(actual)} is not ${JSON.stringify(expected)}`));
};

test("film sound the measured reader refuses whole is read a stretch at a time, with every word on the interval's clock", async () => {
  const calls: number[] = [], lines = ["Stay here", "Not yet"];
  const read = async (wav: Uint8Array) => {
    calls.push(seconds(wav));
    if (seconds(wav) > 5) throw unplaced();
    return spoken(lines[calls.length - 1]!, wav);
  };
  await assert.rejects(recognizeAgentSpeech({ ...film, read }), /unresolved pause/);
  calls.length = 0;
  const value = await readAgentSpeech({ ...film, read });
  close(calls, [1.6, 1.6]);
  assert.deepEqual(value.stretches!.map(stretch => [stretch.read, stretch.text]), [["timed", "Stay here"], ["timed", "Not yet"]]);
  close(value.stretches!.flatMap(stretch => [stretch.startSec, stretch.endSec, stretch.viewStartSec, stretch.viewEndSec]), [.7, 2.3, 2.7, 4.3, 5.7, 7.3, 7.7, 9.3]);
  assert.equal(value.text, "Stay here Not yet"); assert.deepEqual(value.words.map(word => word.text), ["Stay", "here", "Not", "yet"]);
  close(value.words.flatMap(word => [word.startSec, word.endSec]), [1, 1.2, 1.3, 1.5, 6, 6.2, 6.3, 6.5]);
  close(value.words.map(word => word.viewStartSec), [3, 3.3, 8, 8.3]); close(value.words.map(word => word.sourceEndSec), [8.2, 8.5, 13.2, 13.5]);
  // The evidence is still of the one interval that was asked for: its hash, not a slice's.
  assert.equal(value.derivative.hash, `sha256:${createHash("sha256").update(film.bytes).digest("hex")}`); assert.equal(value.derivative.durationSec, 10);
  assert.deepEqual(value.engine, heard.engine);
});

test("sound with no pause to leave out reaches the reader whole, byte for byte, and reads as it always did", async () => {
  const steady = writeSpeechWav({ rate: 16000, samples: Float32Array.from({ length: 16000 }, (_, i) => .1 * Math.sin(2 * Math.PI * 220 * i / 16000)) });
  let given: Uint8Array | undefined;
  const value = await readAgentSpeech({ ...input, bytes: steady, read: async wav => { given = wav; return heard; } });
  assert.deepEqual(given, steady);
  const whole = await recognizeAgentSpeech({ ...input, bytes: steady, read: async () => heard });
  assert.deepEqual(value.words, whole.words); assert.equal(value.text, whole.text); assert.deepEqual(value.derivative, whole.derivative);
  assert.deepEqual(value.stretches, [{ startSec: 0, endSec: 1, viewStartSec: 2, viewEndSec: 3, read: "timed", text: "Stay here" }]);
});

test("a stretch the measured reader still refuses keeps the plain reader's text without times, or is silent when that hears no words", async () => {
  let reads = 0;
  const read = async (wav: Uint8Array) => { if (++reads % 2 === 0) throw unplaced(); return spoken("Stay here", wav); };
  const given: number[] = [];
  const value = await readAgentSpeech({ ...film, read, readText: async wav => { given.push(seconds(wav)); return "  Not yet.\n"; }, expectedText: "Stay here. Not yet." });
  assert.deepEqual(value.stretches!.map(stretch => [stretch.read, stretch.text]), [["timed", "Stay here"], ["text-only", "Not yet."]]);
  assert.equal(value.text, "Stay here Not yet."); assert.equal(value.words.length, 2); close(given, [1.6]);
  const review = value.contentReview!.comparison;
  assert.ok(review.status === "compared" && review.result === "mismatch" && review.observedText === value.text);
  assert.deepEqual(review.status === "compared" && [review.transcriber.id, review.transcriber.version], [AGENT_SPEECH_STRETCH_READER.id, AGENT_SPEECH_STRETCH_READER.version]);
  for (const nothing of ["", "  \n", "..."]) {
    const quiet = await readAgentSpeech({ ...film, read, readText: async () => nothing });
    assert.deepEqual(quiet.stretches!.map(stretch => [stretch.read, stretch.text]), [["timed", "Stay here"], ["silent", ""]], JSON.stringify(nothing));
    assert.equal(quiet.text, "Stay here");
  }
  const untimed = await readAgentSpeech({ ...film, read: async () => { throw unplaced(); }, readText: async () => "Not yet" });
  assert.deepEqual(untimed.stretches!.map(stretch => stretch.read), ["text-only", "text-only"]);
  assert.equal(untimed.engine, undefined, "no engine timed anything"); assert.deepEqual(untimed.words, []); assert.equal(untimed.text, "Not yet Not yet");
});

test("a long stretch the measured reader refuses is halved at its quietest point and each half timed, before any text is kept without times", async () => {
  // Seven seconds of talk over a room, with a breath in it too short to end the stretch: the reader cannot place its words whole.
  const talk = { ...input, bytes: scene([[1, 4.4], [4.6, 8]]), durationSec: 10 }, calls: number[] = [];
  const read = async (wav: Uint8Array) => { calls.push(seconds(wav)); if (seconds(wav) > 5) throw unplaced(); return spoken(calls.length === 2 ? "Stay here" : "Not yet", wav); };
  const value = await readAgentSpeech({ ...talk, read, readText: async () => { throw new Error("the plain reader is not needed"); } });
  const [first, second] = value.stretches!;
  assert.deepEqual(value.stretches!.map(stretch => [stretch.read, stretch.text]), [["timed", "Stay here"], ["timed", "Not yet"]]);
  // Cut inside the breath, the two halves meeting there; the whole stretch was tried first, then each half.
  assert.ok(first!.endSec >= 4.4 - 1e-9 && first!.endSec < 4.6, String(first!.endSec)); assert.equal(second!.startSec, first!.endSec);
  close([first!.startSec, second!.endSec], [.7, 8.3]); close(calls, [7.6, first!.endSec - .7, 8.3 - first!.endSec]);
  close(value.words.map(word => word.startSec), [1, 1.3, first!.endSec + .3, first!.endSec + .6]);
  // A stretch under six seconds is not halved: its halves would be a word or two.
  let reads = 0;
  const short = await readAgentSpeech({ ...film, read: async () => { reads++; throw unplaced(); }, readText: async () => "Not yet" });
  assert.equal(reads, 2); assert.deepEqual(short.stretches!.map(stretch => stretch.read), ["text-only", "text-only"]);
});

test("a refused stretch is halved only while the transcript has room for one stretch more", async () => {
  // A long line and then short ones, two seconds apart: with eleven short ones the transcript is full at twelve stretches.
  const lines = (short: number): Array<[number, number]> => [[1, 4.4], [4.6, 8], ...Array.from({ length: short }, (_, i): [number, number] => [10 + i * 2, 10.5 + i * 2])];
  const read = async (wav: Uint8Array) => { if (seconds(wav) > 5) throw unplaced(); return spoken("Yes", wav); };
  const full = await readAgentSpeech({ ...input, bytes: scene(lines(11), 34), durationSec: 34, read, readText: async () => "Stay here not yet" });
  assert.equal(full.stretches!.length, AGENT_TRANSCRIPT_LIMITS.stretches); assert.deepEqual(full.stretches!.slice(0, 2).map(stretch => stretch.read), ["text-only", "timed"]);
  const room = await readAgentSpeech({ ...input, bytes: scene(lines(10), 34), durationSec: 34, read, readText: async () => "Stay here not yet" });
  assert.equal(room.stretches!.length, AGENT_TRANSCRIPT_LIMITS.stretches); assert.ok(room.stretches!.every(stretch => stretch.read === "timed"));
});

test("an interval with no voice in it is answered without calling a reader, and a review of it is still compared", async () => {
  let calls = 0;
  const value = await readAgentSpeech({ ...input, bytes: writeSpeechWav({ rate: 16000, samples: new Float32Array(3 * 16000) }), durationSec: 3,
    read: async () => { calls++; return heard; }, readText: async () => { calls++; return "invented"; }, expectedText: "Stay here" });
  assert.equal(calls, 0); assert.deepEqual(value.stretches, []); assert.equal(value.text, ""); assert.deepEqual(value.words, []); assert.equal(value.engine, undefined);
  const review = value.contentReview!.comparison;
  assert.ok(review.status === "compared" && review.result === "mismatch" && review.observedText === "");
});

test("with no plainer reader a refused stretch refuses the read; when the plain reader fails too, the first refusal is the one reported", async () => {
  let reads = 0;
  await assert.rejects(readAgentSpeech({ ...film, read: async wav => { if (++reads === 2) throw unplaced(); return spoken("Stay here", wav); } }), /unresolved pause/);
  assert.equal(reads, 2);
  await assert.rejects(readAgentSpeech({ ...film, read: async () => { throw unplaced(); }, readText: async () => { throw new Error("PRIVATE transcript /secret/path"); } }), /^Error: a word has no usable timing or an unresolved pause$/);
  await assert.rejects(readAgentSpeech({ ...film, read: async () => { throw unplaced(); }, readText: async () => "a".repeat(AGENT_TRANSCRIPT_LIMITS.characters + 1) }), /unresolved pause/);
  await assert.rejects(readAgentSpeech({ ...film, bytes: film.bytes.slice(0, -2), read: async () => heard }), /canonical/);
});

test("Stop during the plain reader ends the read at once and ignores its late text", async () => {
  const stop = new AbortController(); let active!: AbortSignal, entered!: () => void, finish!: (text: string) => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const pending = readAgentSpeech({ ...film, signal: stop.signal, read: async () => { throw unplaced(); },
    readText: (_wav, signal) => { active = signal; entered(); return new Promise(resolve => { finish = resolve; }); } });
  await reading; stop.abort();
  await assert.rejects(pending, /stopped/); assert.equal(active.aborted, true);
  finish("late");
});

test("one deadline covers every stretch of an interval, not each stretch its own", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reads = 0, finish!: () => void, second!: AbortSignal, entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const pending = readAgentSpeech({ ...film, read: (wav, signal) => ++reads === 1
    ? new Promise(resolve => { finish = () => resolve(spoken("Stay here", wav)); })
    : new Promise(() => { second = signal; entered(); }) });
  t.mock.timers.tick(100_000); finish(); await waiting;
  t.mock.timers.tick(AGENT_TRANSCRIPT_LIMITS.timeoutMs - 100_000);
  await assert.rejects(pending, /deadline/); assert.equal(second.aborted, true);
});

test("a stretch read replays as speech evidence, and a review of it only with its comparison", async () => {
  let reads = 0;
  const read = async (wav: Uint8Array) => { if (++reads % 2 === 0) throw unplaced(); return spoken("Stay here", wav); };
  const observed = async (expectedText?: string) => ({ profile: "arke-media-evidence-v1", decoderVersion: "ffmpeg version test", probeVersion: "ffprobe version test",
    source: { kind: "artifact", id: "ar-one" }, sourceHash: "sha256:" + "b".repeat(64), byteLength: 100, sourceStartSec: 5, sourceEndSec: 20,
    inventory: { durationSec: 20, streams: [{ index: 2, kind: "audio", codec: "pcm", sampleRate: 48000, channels: 2, durationSec: 20, startTimeSec: 0 }] },
    range: { startSec: 2, endSec: 12 }, transcript: await readAgentSpeech({ ...film, read, readText: async () => "Not yet", expectedText }),
    coverage: "recognized-speech", limitations: ["Speech recognition only"] });
  const receipt = { id: "check_01J8F0000000000000000000C1", runId: "run_01J8F0000000000000000000C1", status: "complete", consulted: [], at: "2026-10-14T00:00:00Z" };
  assert.ok(WorldChatCheckReceiptSchema.safeParse({ ...receipt, tool: "transcribe-audio", media: await observed() }).success);
  assert.ok(WorldChatCheckReceiptSchema.safeParse({ ...receipt, tool: "review-audio-content", media: await observed("Stay here") }).success);
  assert.equal(WorldChatCheckReceiptSchema.safeParse({ ...receipt, tool: "review-audio-content", media: await observed() }).success, false);
  const media = await observed();
  assert.equal(AgentMediaObservationSchema.safeParse({ ...media, range: { startSec: 3, endSec: 13 } }).success, false, "its times belong to the interval it was read from");
});
