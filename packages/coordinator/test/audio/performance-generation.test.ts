import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ulid, orderedShots, resolvePerformanceLine, normalizeSpeechText, CLONED_VOICES_PATH, CLONED_VOICE_MODEL, CLONED_VOICE_PROVIDER,
  type PerformanceGenerationQuote } from "@arke-studio/contracts";
import { WorldStore } from "../../src/world/store.js";
import { VoiceService } from "../../src/voice/service.js";
import { preparePerformanceGeneration, validatePerformanceGeneration, finalizeGeneratedPerformance, readPerformanceGenerationQuote, generatedVoiceCloudBasis } from "../../src/audio/performance-generation.js";
import { analyzePcmWav, audioHash } from "../../src/audio/qc.js";
import { appendAudioRights } from "../../src/audio/rights.js";
import { SHIPPED_MANIFEST } from "../../../providers/src/manifest-data.js";
import { makeTempWorld } from "../world/helpers.js";
import { wav } from "./helpers.js";

it("quotes exact decorated wording and keeps paid output with unknown duration through replay and restart", async t => {
  const dir = await makeTempWorld(); let store = await WorldStore.open(dir); t.after(() => store.close());
  const production = store.getBundle().productions.find(p => p.scenes.some(s => orderedShots(s).some(shot => {
    const line = resolvePerformanceLine(s, shot.id); return line.ok && line.speakerSheetId === "maren-kest";
  })))!;
  const scene = production.scenes.find(s => orderedShots(s).some(shot => { const line = resolvePerformanceLine(s, shot.id); return line.ok && line.speakerSheetId === "maren-kest"; }))!;
  const shot = orderedShots(scene).find(shot => { const line = resolvePerformanceLine(scene, shot.id); return line.ok && line.speakerSheetId === "maren-kest"; })!;
  const line = resolvePerformanceLine(scene, shot.id); assert.ok(line.ok);
  const model = SHIPPED_MANIFEST.models.find(m => m.id === "eleven-v3")!;
  const quote = await preparePerformanceGeneration(store, model, { kind: "prepare-performance-generation", requestId: ulid(), worldId: store.worldId,
    productionId: production.meta.id, sceneId: scene.id, shotId: shot.id, expectedSceneVersion: scene.version, expectedVoiceId: "v_8Kq2", modelId: model.id,
    cadencePlan: { schemaVersion: 1, sourceTextHash: audioHash(Buffer.from(normalizeSpeechText(line.text))), delivery: "whispered", speed: 1,
      cues: [{ kind: "pause", at: 0, length: "short" }] } });
  assert.equal(quote.mapping.providerModel, "eleven_v3");
  assert.equal(quote.estimatedMicroUsd, quote.mapping.providerText.length * 100);
  assert.deepEqual(await readPerformanceGenerationQuote(store, quote.operationId), quote);
  validatePerformanceGeneration(store, model, quote, quote.estimatedMicroUsd);
  assert.throws(() => validatePerformanceGeneration(store, model, quote, quote.estimatedMicroUsd + 1), /stale/);
  const bytes = wav(Array.from({ length: 24000 }, (_, i) => Math.round(Math.sin(i / 10) * 2000)));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); view.setUint32(24, 24000, true); view.setUint32(28, 48000, true);
  const requestId = ulid(), id = `pf_${requestId}`, jobId = `jb_${requestId}`;
  const cost = { estimatedMicroUsd: quote.estimatedMicroUsd, actualMicroUsd: null };
  const record = await finalizeGeneratedPerformance(store, undefined, quote, id, bytes, "wav", cost, jobId);
  assert.equal(record.kind, "generated-tts"); assert.equal(record.provenance.outputTechnical.durationSec, null);
  assert.equal(record.provenance.qualityReport.checks.decode.outcome, "unavailable");
  assert.deepEqual(await finalizeGeneratedPerformance(store, undefined, quote, id, bytes, "wav", cost, jobId), record);
  assert.deepEqual(await readFile(join(dir, `productions/${production.meta.id}/performances/${id}/${record.file}`)), Buffer.from(bytes));
  const current = store.getBundle().productions.find(p => p.meta.id === production.meta.id)!;
  assert.deepEqual(current.selections, production.selections); assert.deepEqual(current.performanceReview.reviews, []);
  await store.close(); store = await WorldStore.open(dir);
  assert.deepEqual(store.getBundle().productions.find(p => p.meta.id === production.meta.id)!.performances.find(p => p.id === id), record);
});
it("explicit local retakes synthesize again and forward cancellation and mapped pace", async () => {
  let calls = 0;
  const signal = new AbortController().signal;
  const service = new VoiceService({ sidecar: { async health() { return { engineStatus: { kokoro: { ready: true } } }; }, async listVoices() { return []; },
    async transcribe() { return ""; }, async synthesize(input, options) { calls++; assert.equal(input.params?.speed, 0.92); assert.equal(options?.signal, signal); return wav([1, 2, 3, 4]); } },
    localPresets: [], cloudSources: [], getKey: async () => null, emit: () => {} });
  await service.synthesizePerformance("af_bella", "Hello", { speed: 0.92 }, signal);
  await service.synthesizePerformance("af_bella", "Hello", { speed: 0.92 }, signal);
  assert.equal(calls, 2);
  await assert.rejects(service.synthesizePerformance("af_bella", "Hello", {}, AbortSignal.abort()), /cancelled/);
  assert.equal(calls, 2);
});

it("a generated read's cloud basis is the voice's own: licensed stock, the sample's standing basis for a clone of its recording, nothing otherwise (SPEC-044 R-14; codex round 1)", async t => {
  const dir = await makeTempWorld();
  const AT = "2026-09-10T09:00:00.000Z";
  const tone = (step: number) => Array.from({ length: 4800 }, (_, i) => Math.round(Math.sin(i / step) * 8000));
  const clip = wav(tone(7)), sample = wav(tone(11)), other = wav(tone(13));
  await mkdir(join(dir, "voice"), { recursive: true });
  await mkdir(join(dir, "voices"), { recursive: true });
  await writeFile(join(dir, "voice", "clone.wav"), clip);
  await writeFile(join(dir, "voice", "other.wav"), other);
  await writeFile(join(dir, CLONED_VOICES_PATH), JSON.stringify({ voices: [
    { id: "vc_own", name: "Maren", clip: "voice/clone.wav", consent: true, created: AT },
    { id: "vc_other", name: "Someone else", clip: "voice/other.wav", consent: true, created: AT }] }));
  // The sample was prepared from the clone's recording, so its source names the recording's bytes.
  const kitPath = join(dir, "references", "maren-kest", "kit.json");
  const kit = JSON.parse(await readFile(kitPath, "utf8")) as Record<string, unknown>;
  const report = analyzePcmWav(sample, AT), outputHash = audioHash(sample);
  kit.designatedVoiceSample = { schemaVersion: 1, file: `voice/${outputHash.replace(":", "-")}.wav`, operationId: randomUUID(), designatedAt: AT, warningCodes: [], attestations: [],
    provenance: { schemaVersion: 1, source: { kind: "legacy-character-sample", sheetId: "maren-kest", sourceFile: "voice/clone.wav", legacySource: "cloning-recording",
      legacyDesignatedAt: AT, sourceMediaHash: audioHash(clip) }, sourceTechnical: report.technical, outputHash, outputTechnical: report.technical, preparation: [], qualityReport: report, createdAt: AT } };
  await writeFile(kitPath, JSON.stringify(kit, null, 2) + "\n");
  const store = await WorldStore.open(dir); t.after(() => store.close());
  assert.ok(store.getBundle().referenceKits.find(k => k.sheetId === "maren-kest")?.designatedVoiceSample, "the sample reads back");
  const quoteFor = (provider: string, model: string, voiceId: string) =>
    ({ mapping: { provider, model }, voiceAssignment: { voiceId }, target: { speakerSheetId: "maren-kest" } }) as unknown as PerformanceGenerationQuote;
  const cloned = (voiceId: string) => quoteFor(CLONED_VOICE_PROVIDER, CLONED_VOICE_MODEL, voiceId);
  assert.equal(await generatedVoiceCloudBasis(store, quoteFor("elevenlabs", "eleven-v3", "v_8Kq2")), "licensed", "a catalogue voice is the provider's licensed stock");
  assert.equal(await generatedVoiceCloudBasis(store, cloned("vc_own")), undefined, "nothing acknowledged yet, so nothing carries");
  await appendAudioRights(store, { schemaVersion: 1, action: "acknowledge", id: "ack-sample", audioHash: outputHash, basis: "self", scopes: ["cloud-reference-upload"], statementVersion: 1, at: AT });
  assert.equal(await generatedVoiceCloudBasis(store, cloned("vc_own")), "self", "the sample's basis carries to a clone of its recording");
  assert.equal(await generatedVoiceCloudBasis(store, cloned("vc_other")), undefined, "a clone of another recording borrows nothing from the sample");
  assert.equal(await generatedVoiceCloudBasis(store, cloned("vc_gone")), undefined, "a clone the library no longer holds says nothing");
  await appendAudioRights(store, { schemaVersion: 1, action: "withdraw", acknowledgementId: "ack-sample", audioHash: outputHash, at: AT });
  assert.equal(await generatedVoiceCloudBasis(store, cloned("vc_own")), undefined, "a withdrawal folds the basis away");
});
