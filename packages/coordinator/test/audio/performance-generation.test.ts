import assert from "node:assert/strict";
import { it } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ulid, orderedShots, resolvePerformanceLine, normalizeSpeechText } from "@arke-studio/contracts";
import { WorldStore } from "../../src/world/store.js";
import { VoiceService } from "../../src/voice/service.js";
import { preparePerformanceGeneration, validatePerformanceGeneration, finalizeGeneratedPerformance, readPerformanceGenerationQuote } from "../../src/audio/performance-generation.js";
import { audioHash } from "../../src/audio/qc.js";
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
