import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { VoxaClient } from "@arke-studio/voice";
import { AGENT_TRANSCRIPT_LIMITS, AgentMediaObservationSchema, WorldChatCheckReceiptSchema, type AcousticWords } from "@arke-studio/contracts";
import { recognizeAgentSpeech } from "../../src/media/agent-speech.js";
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
    { ...heard, engine: { ...heard.engine, model: "" } }, { ...heard, words: [] }, { ...heard, words: Array(1001).fill(heard.words[0]) },
    { ...heard, words: [{ ...heard.words[0]!, startSec: .7, endSec: .3 }] },
    { ...heard, words: [{ ...heard.words[0]!, endSec: 1.1 }] },
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
  const service = new VoiceService({ sidecar: { health: async () => { await ready; return { engineStatus: { kokoro: { ready: false } }, wordTiming: { ready: true } }; },
    listVoices: async () => [], synthesize: async () => bytes, transcribe: async () => "unused", transcribeWords: async () => { calls++; return heard; } },
    localPresets: [], cloudSources: [], getKey: async () => null, emit: () => {} });
  const stop = new AbortController(), pending = service.transcribeWords(bytes, stop.signal);
  stop.abort(); finish(); await assert.rejects(pending); assert.equal(calls, 0);
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
