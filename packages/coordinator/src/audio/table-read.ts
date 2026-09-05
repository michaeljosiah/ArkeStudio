import { readFile } from "node:fs/promises";
import { deriveRehearsalLines, TableReadPlanSchema, normalizeSpeechText, estimateMicroUsd, legacyVoiceModel, providerModelId,
  type ModelManifest, type Job, type ProviderStatus, type TableReadPlan } from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import { speechCacheFile, cachedVoiceAudioLooksRight, type SpeechSpec, type VoiceService } from "../voice/service.js";
import { currentPerformanceTarget, readPerformance } from "./performances.js";
import { audioWorldPath } from "./storage.js";
import { audioHash } from "./qc.js";
import { readAudioBytes } from "./media-tools.js";
import { atomicWriteFile } from "../world/atomic.js";
import type { EnqueueInput } from "../queue/dispatcher.js";

export async function planTableRead(store: WorldStore, productionId: string, sceneId: string, manifest: ModelManifest,
  jobs: readonly Job[], providers: readonly ProviderStatus[]) {
  const production = store.getBundle().productions.find(p => p.meta.id === productionId), scene = production?.scenes.find(s => s.id === sceneId);
  if (!production || !scene) throw new Error("This rehearsal scene is unavailable.");
  const items: TableReadPlan["items"] = [], cloud: EnqueueInput[] = [], local: Array<{ file: string; spec: SpeechSpec }> = [], bindings: unknown[] = [];
  for (const line of deriveRehearsalLines(scene, store.getBundle().sheets)) {
    const item: TableReadPlan["items"][number] = { lineId: line.id, shotId: line.shotId, ...(line.blockId ? { blockId: line.blockId } : {}),
      ...(line.speakerSheetId ? { speakerSheetId: line.speakerSheetId } : {}), route: "unavailable", estimatedMicroUsd: 0 };
    if (line.text) item.textHash = audioHash(Buffer.from(line.text));
    items.push(item);
    if (line.reason) { item.reason = line.reason; continue; }
    const selection = production.performanceReview.selections[line.id];
    if (selection?.performanceId) {
      try {
        const record = await readPerformance(store, productionId, selection.performanceId);
        const review = production.performanceReview.reviews.filter(r => r.performanceId === record.id).at(-1);
        if (review?.decision !== "accept" || !currentPerformanceTarget(store, record.target) || record.target.shotId !== line.shotId || record.target.blockId !== line.blockId) throw new Error("stale selection");
        if (record.kind !== "scratch") {
          const current = store.getBundle().sheets.find(s => s.id === record.target.speakerSheetId)?.voice;
          if (!current || current.provider !== record.voiceAssignment.provider || current.voiceId !== record.voiceAssignment.voiceId || current.assignedAtVersion !== record.voiceAssignment.assignedAtVersion) throw new Error("stale voice");
        }
        const file = `productions/${productionId}/performances/${record.id}/${record.file}`;
        const bytes = await readAudioBytes(await audioWorldPath(store.dir, file), store.closingSignal);
        if (audioHash(bytes) !== record.provenance.outputHash) throw new Error("changed source");
        Object.assign(item, { route: "existing", file, performanceId: record.id, sourceHash: record.provenance.outputHash });
        bindings.push({ selection, review, hash: record.provenance.outputHash });
      } catch { item.reason = "Selected source unavailable or stale. Repair or clear the performance selection first."; }
      continue;
    }
    const sheet = store.getBundle().sheets.find(s => s.id === line.speakerSheetId), voice = sheet?.voice;
    if (!voice || !["kokoro", "elevenlabs"].includes(voice.provider)) { item.reason = "No supported TTS assignment for this character."; continue; }
    const model = manifest.models.find(m => m.id === (voice.model ?? legacyVoiceModel(voice.provider, voice.voiceId)) && m.provider === voice.provider && m.capability === "voice-tts");
    if (!model) { item.reason = "The assigned TTS model is unavailable."; continue; }
    const spec: SpeechSpec = { provider: model.provider, model: providerModelId(model), voiceId: voice.voiceId, text: normalizeSpeechText(line.text), format: model.provider === "kokoro" ? "wav" : "mp3" };
    const file = speechCacheFile(spec);
    const inputHash = audioHash(Buffer.from(JSON.stringify({ spec, assignment: voice })));
    Object.assign(item, { provider: model.provider, model: model.id, voiceId: voice.voiceId });
    bindings.push({ lineId: line.id, textHash: audioHash(Buffer.from(line.text)), voice, model, file });
    try {
      const bytes = await readAudioBytes(await audioWorldPath(store.dir, file), store.closingSignal);
      if (cachedVoiceAudioLooksRight(bytes, spec.format)) { Object.assign(item, { route: "cached", file, sourceHash: audioHash(bytes) }); continue; }
    } catch { /* A missing or invalid derived cache is prepared explicitly. */ }
    bindings.push({ priorJobs: jobs.filter(job => job.worldId === store.worldId && job.params.tableReadInputHash === inputHash).map(job => ({ id: job.id, status: job.status })) });
    const running = jobs.find(job => job.worldId === store.worldId && job.target.kind === "table-read-cache" && job.params.tableReadInputHash === inputHash &&
      !["succeeded", "failed", "cancelled"].includes(job.status));
    if (running) { item.route = "generating"; item.reason = `Existing preparation: ${running.status}.`; bindings.push({ jobId: running.id }); continue; }
    const status = providers.find(p => p.id === model.provider);
    if (!status?.configured || status.fault !== null || status.validation !== "valid" || !status.probes.some(p => p.capability === "voice-tts" && p.available)) { item.reason = "Validate this voice provider in Settings before preparation."; continue; }
    if (model.limits.maxPromptChars !== undefined && spec.text.length > model.limits.maxPromptChars) { item.reason = "The line exceeds this model's character limit."; continue; }
    if (model.provider === "kokoro") { item.route = "local"; local.push({ file, spec }); continue; }
    item.route = "cloud"; item.estimatedMicroUsd = estimateMicroUsd(model, { characters: spec.text.length });
    cloud.push({ worldId: store.worldId, productionId, target: { kind: "table-read-cache", id: line.id }, capability: "voice-tts", provider: model.provider, model: model.id,
      params: { voiceId: voice.voiceId, text: spec.text, tableReadSceneId: sceneId, tableReadInputHash: inputHash, tableReadCacheFile: file, tableReadSpec: spec,
        tableReadVoiceAssignment: voice, tableReadSpeakerSheetId: line.speakerSheetId, tableReadSceneVersion: scene.version }, estimatedMicroUsd: item.estimatedMicroUsd,
      landing: { dir: ".cache/voice-previews", name: file.split("/").at(-1)! } });
  }
  const totalEstimatedMicroUsd = items.reduce((sum, item) => sum + item.estimatedMicroUsd, 0);
  const confirmationToken = audioHash(Buffer.from(JSON.stringify({ worldId: store.worldId, productionId, sceneId, version: scene.version,
    manifestVersion: manifest.manifestVersion, generated: manifest.generated, items, bindings })));
  cloud.forEach((job, index) => { job.idempotencyKey = `table-read/${confirmationToken}/${index}`; });
  return { plan: TableReadPlanSchema.parse({ productionId, sceneId, sceneVersion: scene.version, confirmationToken, totalEstimatedMicroUsd, items }), cloud, local };
}
export async function prepareLocalTableRead(store: WorldStore, voice: VoiceService, inputs: readonly { file: string; spec: SpeechSpec }[]) {
  const failures: string[] = [];
  for (const input of inputs) {
    try {
      const bytes = await voice.synthesizePerformance(input.spec.voiceId, input.spec.text, input.spec.params ?? {}, store.closingSignal);
      if (!cachedVoiceAudioLooksRight(bytes, input.spec.format)) throw new Error("invalid audio");
      await store.ownedWrite(async () => atomicWriteFile(await audioWorldPath(store.dir, input.file, true), bytes));
    } catch { failures.push("A local line could not be prepared. Check Kokoro readiness."); }
  }
  return failures;
}
export async function finalizeTableReadCache(store: WorldStore, job: Job) {
  const spec = job.params.tableReadSpec as SpeechSpec;
  if (!spec || spec.provider !== job.provider || spec.voiceId !== job.params.voiceId || spec.text !== job.params.text || !["wav", "mp3"].includes(spec.format)) throw new Error("Table read cache identity changed.");
  const file = speechCacheFile(spec);
  if (file !== job.params.tableReadCacheFile || job.landedFiles?.[0] !== file) throw new Error("Table read cache destination changed.");
  const bytes = await readFile(await audioWorldPath(store.dir, file));
  if (!cachedVoiceAudioLooksRight(bytes, spec.format)) throw new Error("The prepared table read audio is invalid.");
}
