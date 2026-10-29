import assert from "node:assert/strict";
import { it } from "node:test";
import { localCandidates, KOKORO_PRESETS, encodePcm16Wav } from "@arke-studio/voice";
import { VoiceService } from "../../src/voice/service.js";

it("revalidates selected local authority after catalogue waits and never enters cloud, world caching or a disabled model", async () => {
  for (const change of ["voice", "model", "missing", "unhealthy", "invalid-audio"] as const) {
    let allowed = true, enabled = true, calls = 0;
    const service = new VoiceService({ localPresets: localCandidates(KOKORO_PRESETS), cloudSources: [], getKey: async () => { throw Error("No cloud key"); }, emit: () => { throw Error("No shared voice event"); }, modelEnabled: () => enabled,
      sidecar: { health: async () => ({ engineStatus: { kokoro: { ready: change !== "unhealthy" } } }),
        listVoices: async () => { if (change === "voice") allowed = false; if (change === "model") enabled = false; return change === "missing" ? [] : KOKORO_PRESETS; },
        synthesize: async (_input, options) => { calls++; assert.equal(options?.maxAudioBytes, 6_000_000); return change === "invalid-audio" ? new Uint8Array(60) : encodePcm16Wav(new Float32Array(24), 24000); },
        transcribe: async () => { throw Error("No dictation"); } } });
    await assert.rejects(service.privateLocalSpeech("bm_george", "Private reply.", new AbortController().signal, () => allowed));
    assert.equal(calls, change === "invalid-audio" ? 1 : 0, change);
  }
});
it("shares the existing local synthesis lane and cancels a queued private part without passing its predecessor", async () => {
  let finish!: () => void, entered!: () => void; const calls: string[] = [], ready = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<Uint8Array>(resolve => { finish = () => resolve(encodePcm16Wav(new Float32Array(24), 24000)); });
  const service = new VoiceService({ localPresets: localCandidates(KOKORO_PRESETS), cloudSources: [], getKey: async () => null, emit: () => {}, sidecar: {
    health: async () => ({ engineStatus: { kokoro: { ready: true } } }), listVoices: async () => KOKORO_PRESETS,
    synthesize: async input => { calls.push(input.text); entered(); return held; }, transcribe: async () => "",
  } });
  const first = service.synthesizeOnce({ voiceId: "bm_george", text: "An admitted read" }); await ready;
  const abort = new AbortController(), pending = service.privateLocalSpeech("bm_george", "Private queued reply", abort.signal, () => true);
  abort.abort(); await assert.rejects(pending, /stopped/); assert.deepEqual(calls, ["An admitted read"]);
  finish(); await first;
});
