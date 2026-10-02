import assert from "node:assert/strict";
import { it } from "node:test";
import { cloudSpeechPreference, DEFAULT_NARRATOR, deliveryParams, modelForCapability, rankVoices, supportsPerformanceGeneration, type VoiceCandidate } from "@arke-studio/contracts";
import { GEMINI_PRESETS, SHIPPED_MANIFEST, cloudVoiceSources, createProviderClients } from "../src/index.js";

it("offers both Gemini rows ahead of ElevenLabs for new cloud choices, preserving explicit routes and local narration", () => {
  const cloud = SHIPPED_MANIFEST.models.filter(m => m.capability === "voice-tts" && ["google", "elevenlabs"].includes(m.provider));
  assert.deepEqual(cloud.slice(0, 2).map(m => m.id), ["gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts"]);
  for (const model of cloud.slice(0, 2)) {
    assert.ok(supportsPerformanceGeneration(model));
    assert.equal(model.pricing.kind, "perToken");
    assert.equal(model.limits.audioFormat, "wav");
    assert.deepEqual(deliveryParams(model, "whispered"), { ok: true, params: {} });
  }
  assert.equal(modelForCapability(SHIPPED_MANIFEST, { "voice-tts": "eleven-v3" }, "voice-tts")?.id, "eleven-v3");
  assert.equal(DEFAULT_NARRATOR.provider, "kokoro");
});

it("prefers Flash for equal character matches and Lite for routine cloud choices without mutating candidates", () => {
  const voice = (provider: string, model: string, attributes = ["warm"]): VoiceCandidate => ({ provider, model, voiceId: "same-id", label: "Voice", attributes, local: false, canClone: false });
  const eleven = voice("elevenlabs", "eleven-v3");
  const flash = voice("google", "gemini-3.8-flash-tts");
  const lite = voice("google", "gemini-3.8-flash-lite-tts");
  const original = [eleven, lite, flash];
  assert.deepEqual(rankVoices(["warm"], original).map(v => v.candidate.model), [flash.model, lite.model, eleven.model]);
  assert.deepEqual([...original].sort((a,b) => cloudSpeechPreference(a, "routine") - cloudSpeechPreference(b, "routine")).map(v => v.model), [lite.model, flash.model, eleven.model]);
  assert.deepEqual(original, [eleven, lite, flash]);
  assert.equal(rankVoices(["warm"], [eleven, { ...flash, attributes: ["bright"] }])[0]!.candidate.provider, "elevenlabs", "written character fit is still respected");
});

it("all hosts can list captured Google presets read-only and only for models on the active key", async () => {
  const requests: string[] = [];
  const clients = createProviderClients({ fetch: async (url, init) => {
    requests.push(String(url));
    assert.equal(init?.method ?? "GET", "GET");
    if (String(url).includes("/voices?")) return Response.json({ voices: GEMINI_PRESETS.map(([id]) => ({ id, type: "prebuilt" })) });
    const key = new Headers(init?.headers).get("x-goog-api-key");
    return Response.json({ models: [{ name: `models/${key === "first-project" ? "gemini-3.8-flash-tts" : "gemini-3.8-flash-lite-tts"}` }] });
  } });
  const sources = cloudVoiceSources(clients);
  assert.deepEqual(sources.map(s => s.provider), ["google", "elevenlabs", "mistral", "breezeblue", "fishaudio"]);
  assert.equal(requests.length, 0, "assembly does not contact a provider or synthesize");
  const google = sources.find(s => s.provider === "google")!;
  const first = await google.list("first-project");
  const next = await google.list("different-project");
  assert.equal(first.length, 30);
  assert.ok(first.every(v => v.model === "gemini-3.8-flash-tts"));
  assert.ok(next.every(v => v.model === "gemini-3.8-flash-lite-tts"));
  assert.equal(requests.length, 4);
});
