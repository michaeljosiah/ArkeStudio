import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENT_LISTENING_LIMITS, AgentMediaObservationSchema, ListenAudioArgsSchema, WorldChatCheckReceiptSchema } from "@arke-studio/contracts";
import { listenToAgentAudio, type AgentAudioListener } from "../../src/media/agent-listening.js";
import { writeSpeechWav, readSpeechWav } from "../../src/audio/speech-wav.js";
const engine = { id: "local-qwen2-audio-v1" as const, model: "Qwen2-Audio-7B-Instruct" as const, modelHash: "sha256:" + "a".repeat(64), runtime: "fixture" };
const review = "A restrained musical texture. The voice sounds breathy and hesitant; this is an impression.";
const bytes = writeSpeechWav({ rate: 16000, samples: Float32Array.from({ length: 16000 }, (_, i) => .25 * Math.sin(i / 5)) });
const input = { bytes, durationSec: 1, streamIndex: 2, focuses: ["music", "emotion", "voice-delivery"] as Array<"music" | "emotion" | "voice-delivery">, signal: new AbortController().signal };
const listener: AgentAudioListener = { ready: async () => true, listen: async () => ({ engine, review }) };

test("listening receives actual waveform bytes, separate from ASR, and retains exact derivative/model identity", async () => {
  const result = await listenToAgentAudio({ ...input, listener: { ...listener, listen: async (audio, focuses) => {
    assert.deepEqual(audio, bytes); assert.deepEqual(focuses, input.focuses);
    assert.ok(readSpeechWav(audio).samples.some(sample => Math.abs(sample) > .1));
    return { engine, review };
  } } });
  assert.equal(result.basis, "audio-model-interpretation"); assert.equal(result.timing, "no-measured-event-times");
  assert.match(result.derivative.hash, /^sha256:[a-f0-9]{64}$/); assert.equal(result.engine.modelHash, engine.modelHash);
  assert.equal(result.review, review); assert.ok(!JSON.stringify(result).includes("base64"));
  const media = { profile: "arke-media-evidence-v1", decoderVersion: "ffmpeg version fixture", probeVersion: "ffprobe version fixture",
    source: { kind: "artifact", id: "audio" }, sourceHash: "sha256:" + "b".repeat(64), byteLength: 100,
    sourceStartSec: 5, sourceEndSec: 10, inventory: { durationSec: 10, streams: [{ index: 2, kind: "audio", codec: "wav", durationSec: 10, startTimeSec: 0 }] },
    range: { startSec: 2, endSec: 3 }, listening: result, coverage: "model-audio-listening", limitations: ["Subjective impressions only"] };
  assert.ok(AgentMediaObservationSchema.safeParse(media).success);
  for (const invalid of [{ ...media, coverage: "recognized-speech" }, { ...media, range: { startSec: 0, endSec: 2 } },
    { ...media, listening: { ...result, streamIndex: 3 } }, { ...media, listening: undefined }]) assert.equal(AgentMediaObservationSchema.safeParse(invalid).success, false);
  const receipt = { id: "check_01J8F0000000000000000000C1", runId: "run_01J8F0000000000000000000C1", tool: "listen-audio", status: "complete", consulted: [], media, at: "2026-10-14T00:00:00Z" };
  assert.ok(WorldChatCheckReceiptSchema.safeParse(receipt).success);
  for (const tool of ["transcribe-audio", "review-audio-content", "analyze-audio-signal", "inspect-media"]) assert.equal(WorldChatCheckReceiptSchema.safeParse({ ...receipt, tool }).success, false);
});

test("listening refuses oversized, noncanonical, duplicate-focus and transcript-shaped inputs/results before creating evidence", async () => {
  let calls = 0;
  const counted = { ...listener, listen: async () => { calls++; return { engine, review }; } };
  for (const invalid of [{ durationSec: 31 }, { bytes: Buffer.from("not WAV") }, { focuses: ["music", "music"] as Array<"music"> },
    { bytes: writeSpeechWav({ rate: 24000, samples: new Float32Array(24000) }) }, { durationSec: 2 }]) await assert.rejects(listenToAgentAudio({ ...input, ...invalid, listener: counted }));
  assert.equal(calls, 0);
  await assert.rejects(listenToAgentAudio({ ...input, listener: { ...listener, listen: async () => ({ engine, review: "x".repeat(8001) }) } }));
  const source = { kind: "artifact", id: "audio" }, range = { startSec: 0, endSec: 30 }, focuses = ["music"];
  assert.ok(ListenAudioArgsSchema.safeParse({ source, range, focuses }).success);
  for (const invalid of [{ source: { path: "private.wav" }, range, focuses }, { source, range: { startSec: 0, endSec: 31 }, focuses },
    { source, range, focuses, expectedText: "a transcript cannot replace listening" }]) assert.equal(ListenAudioArgsSchema.safeParse(invalid).success, false);
});

test("Stop rejects a noncooperative listening reader and cancels its signal", async () => {
  let finish!: (result: { engine: typeof engine; review: string }) => void, active!: AbortSignal;
  const stop = new AbortController(), pending = listenToAgentAudio({ ...input, signal: stop.signal,
    listener: { ...listener, listen: async (_audio, _focus, signal) => { active = signal; return new Promise(resolve => { finish = resolve; }); } } });
  stop.abort(); await assert.rejects(pending, /stopped/); assert.ok(active.aborted); finish({ engine, review });
});

test("listening deadline cancels a stalled reader", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let active!: AbortSignal;
  const pending = listenToAgentAudio({ ...input, listener: { ...listener, listen: async (_audio, _focus, signal) => { active = signal; return new Promise(() => {}); } } });
  t.mock.timers.tick(AGENT_LISTENING_LIMITS.timeoutMs);
  await assert.rejects(pending, /deadline/); assert.ok(active.aborted);
});
