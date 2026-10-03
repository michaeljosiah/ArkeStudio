import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeWav, isWavContentType, VoxaClient } from "@arke-studio/voice";
import { audioHash } from "../../src/audio/qc.js";
import { writeSpeechWav, type SpeechPcm } from "../../src/audio/speech-wav.js";
import { cachedAudioTranscript } from "../../src/audio/transcript-comparison.js";
import { timeWords } from "../../src/voice/word-times.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";

/**
 * Speech at any rate reaches local transcription (SPEC-011 R-17): Voxa's `/stt` answers 415 to
 * any WAV but 16 kHz mono 16-bit PCM, and Gemini reads at 24 kHz, prepared takes are 48 kHz. Every
 * caller went through the client's transcribe and every one was refused — the grouped split heard
 * nothing, and a take's transcript check filed `stt-failed` in silence (the turn 185 probe).
 */

/** A sidecar that answers as Voxa does, and what it was sent. */
function voxa(answer: (seconds: number) => string) {
  const sent: Array<{ rate: number; seconds: number }> = [];
  const fetch = async (_url: string, init?: RequestInit) => {
    const type = String((init!.headers as Record<string, string>)["Content-Type"]);
    const decoded = isWavContentType(type) ? decodeWav(new Uint8Array(init!.body as Buffer)) : null;
    if (decoded === null || decoded.rate !== 16_000 || decoded.channels !== 1 || decoded.encoding !== "pcm16") {
      return new Response(JSON.stringify({ detail: "WAV input must be 16 kHz mono PCM16." }), { status: 415 });
    }
    sent.push({ rate: decoded.rate, seconds: decoded.mono.length / decoded.rate });
    return new Response(JSON.stringify({ text: answer(decoded.mono.length / decoded.rate) }), { status: 200 });
  };
  return { sent, client: new VoxaClient(fetch, "http://127.0.0.1:9") };
}

const at = (rate: number, ...parts: Array<[seconds: number, amplitude: number]>): SpeechPcm => {
  const samples = new Float32Array(Math.round(parts.reduce((sum, [seconds]) => sum + seconds, 0) * rate));
  let offset = 0;
  for (const [seconds, amplitude] of parts) {
    const length = Math.round(seconds * rate);
    for (let i = 0; i < length; i++) samples[offset + i] = amplitude * Math.sin((2 * Math.PI * 300 * i) / rate);
    offset += length;
  }
  return { rate, samples };
};

describe("speech at any rate reaches local transcription (R-17)", () => {
  it("times a 24 kHz request's words in its own seconds, each stretch heard at 16 kHz", async () => {
    const { client, sent } = voxa((seconds) => (seconds < 1.2 ? "First block here." : "The last block, longer now."));
    const pcm = at(24_000, [0.3, 0], [1, 0.3], [0.5, 0], [1.4, 0.3], [0.3, 0]);
    const timed = await timeWords(writeSpeechWav(pcm), (bytes, type) => client.transcribe(bytes, type));
    assert.equal(sent.length, 2, "both stretches were heard, none refused");
    assert.ok(sent.every((request) => request.rate === 16_000));
    assert.deepEqual(timed.words.map((word) => word.text), ["First", "block", "here.", "The", "last", "block,", "longer", "now."]);
    // The source's timebase: 24 kHz seconds, not the 16 kHz copy's samples.
    assert.ok(Math.abs(timed.seconds - 3.5) < 0.01);
    assert.ok(Math.abs(timed.words[0]!.start - 0.3) < 0.02, `first word at ${timed.words[0]!.start}`);
    assert.ok(Math.abs(timed.words[3]!.start - 1.8) < 0.02, `second stretch at ${timed.words[3]!.start}`);
    assert.ok(Math.abs(timed.words.at(-1)!.end - 3.2) < 0.02, `last word ends at ${timed.words.at(-1)!.end}`);
  });

  it("compares a 48 kHz take's words, which filed stt-failed before", async (t) => {
    const dir = await makeTempWorld();
    const store = await WorldStore.open(dir);
    t.after(() => store.close());
    const { client } = voxa(() => "Hello there");
    const bytes = writeSpeechWav(at(48_000, [0.2, 0], [1, 0.3], [0.2, 0]));
    const comparison = await cachedAudioTranscript(store, {
      bytes,
      expectedHash: audioHash(bytes),
      authoredText: "Hello there",
      transcriber: { id: "voxa-whisper", version: "1", transcribe: (audio, type) => client.transcribe(audio, type) },
    });
    assert.equal(comparison.status, "compared");
    assert.equal(comparison.status === "compared" ? comparison.result : null, "exact");
  });
});
