import { readFile } from "node:fs/promises";
import { atomicWriteFile } from "../world/atomic.js";
import { requireUnpurgedPerformance, removePartialPerformance } from "./performance-purge.js";
import { randomUUID } from "node:crypto";
import { PerformanceIdSchema, PerformanceRecordSchema, PerformanceTargetSchema, resolvePerformanceLine, SlugSchema,
  PerformanceConversionInputSchema, estimateMicroUsd,
  type ClientMessage, type PerformanceRecord, type PerformanceTarget, type ManifestModel, type Job, type TakeCost } from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import type { AudioMediaTools } from "./media-tools.js";
import { readAudioBytes } from "./media-tools.js";
import { acceptPreparedAudio, audioWorldPath, prepareAudio } from "./storage.js";
import { audioHash } from "./qc.js";
import { compareAudioTranscript } from "./transcript-comparison.js";
import { appendAudioRights, readAudioRights } from "./rights.js";
import { clearAudioDispatch } from "./dispatch-gate.js";
import type { EnqueueInput } from "../queue/dispatcher.js";

export interface PerformanceSpool {
  claim(id: string): Promise<{ absolutePath: string; contentType: string; sizeBytes: number } | null>;
  discard(id: string): Promise<void>;
}
export function performanceTarget(store: WorldStore, input: { productionId: string; sceneId: string; shotId: string; blockId?: string }) {
  SlugSchema.parse(input.productionId);
  const scene = store.getBundle().productions.find(p => p.meta.id === input.productionId)?.scenes.find(s => s.id === input.sceneId);
  if (!scene) throw new Error("This scene is no longer available.");
  const line = resolvePerformanceLine(scene, input.shotId, input.blockId);
  if (!line.ok) throw new Error(line.reason);
  const sheet = store.getBundle().sheets.find(s => s.id === line.speakerSheetId && s.type === "character");
  if (!sheet) throw new Error("The line's speaking character is missing.");
  const target = PerformanceTargetSchema.parse({ productionId: input.productionId, sceneId: input.sceneId, shotId: input.shotId, sceneVersion: scene.version, speakerSheetId: sheet.id,
    ...(line.blockId ? { blockId: line.blockId } : {}), authoredTextHash: audioHash(Buffer.from(line.text)) });
  return { target, text: line.text, sheet };
}
export function currentPerformanceTarget(store: WorldStore, target: PerformanceTarget): boolean {
  try { return JSON.stringify(performanceTarget(store, target).target) === JSON.stringify(target); } catch { return false; }
}

export async function keepPerformanceRecording(store: WorldStore, tools: AudioMediaTools, spool: PerformanceSpool,
  request: Extract<ClientMessage, { kind: "keep-performance-recording" }>,
  transcribe?: (bytes: Uint8Array) => Promise<string>): Promise<PerformanceRecord> {
  SlugSchema.parse(request.productionId);
  const id = PerformanceIdSchema.parse(`pf_${request.requestId}`);
  await requireUnpurgedPerformance(store, request.productionId, id);
  const prefix = `productions/${request.productionId}/performances/${id}`;
  const recordPath = await store.ownedWrite(() => audioWorldPath(store.dir, `${prefix}/performance.json`, true));
  const already = await readFile(recordPath, "utf8").catch(() => null);
  if (already) return PerformanceRecordSchema.parse(JSON.parse(already));
  const resolved = performanceTarget(store, request);
  if (resolved.target.sceneVersion !== request.expectedSceneVersion) throw new Error("The scene changed since capture. Review the current line before recording again.");
  const at = new Date().toISOString();
  let accepting = false;
  try {
  const sourcePath = await store.ownedWrite(() => audioWorldPath(store.dir, `${prefix}/source.json`, true));
  const existingSource = await readFile(sourcePath, "utf8").catch(() => null);
  if (!existingSource) {
    const source = await spool.claim(request.spoolId);
    if (!source) throw new Error("The recording spool is unavailable. Capture a fresh recording.");
    {
      const bytes = await readAudioBytes(source.absolutePath, store.closingSignal, 128 * 1024 * 1024);
      const file = source.contentType === "audio/mp4" ? "source.m4a" : "source.webm";
      await store.ownedWrite(async () => {
        await atomicWriteFile(await audioWorldPath(store.dir, `${prefix}/${file}`, true), bytes);
        await atomicWriteFile(await audioWorldPath(store.dir, `${prefix}/source.json`, true), JSON.stringify({ file, hash: audioHash(bytes), target: resolved.target }));
      });
    }
  } else {
    const recorded = JSON.parse(existingSource) as { target: PerformanceTarget };
    if (JSON.stringify(recorded.target) !== JSON.stringify(resolved.target)) throw new Error("The captured line changed. Keep cannot retarget a recording.");
  }
  const candidate = await prepareAudio(store, tools, { kind: "performance-recording", productionId: request.productionId, performanceId: id });
  const bytes = await readAudioBytes(await audioWorldPath(store.dir, candidate.stagedFile), store.closingSignal);
  let observedText: string | undefined;
  if (transcribe) { try { observedText = await transcribe(bytes); } catch { /* Keep remains local and available. */ } }
  const transcript = compareAudioTranscript({ audioHash: candidate.provenance.outputHash, authoredText: resolved.text,
    transcriber: { id: "voxa-whisper", version: "runtime-unreported" },
    ...(observedText === undefined ? { unavailableReason: transcribe ? "stt-failed" as const : "stt-not-configured" as const } : { observedText }) });
  let record: PerformanceRecord | undefined;
  accepting = true;
  await acceptPreparedAudio(store, candidate, prefix, (file, provenance) => {
    if (!currentPerformanceTarget(store, resolved.target)) throw new Error("The authored target changed while audio was being prepared.");
    record = PerformanceRecordSchema.parse({ id, kind: "scratch", target: resolved.target, file: file.slice(prefix.length + 1),
      provenance, createdAt: at, recordedAt: at, transcript,
      captureAcknowledgement: { basis: request.captureBasis, statementVersion: 1, at } });
    return { kind: "keep-performance-recording", source: "user", requestId: request.requestId,
      files: [{ path: `${prefix}/performance.json`, action: "create", baseHash: null, content: JSON.stringify(record, null, 2) + "\n" }] };
  });
  await spool.discard(request.spoolId);
  return record!;
  } catch (error) {
    // Once metadata commit starts, its journal owns crash recovery. Never remove uncertain durable bytes.
    if (!accepting) await removePartialPerformance(store, request.productionId, id);
    await spool.discard(request.spoolId).catch(() => {});
    throw error;
  }
}

export async function readPerformance(store: WorldStore, productionId: string, id: string): Promise<PerformanceRecord> {
  SlugSchema.parse(productionId); PerformanceIdSchema.parse(id);
  await requireUnpurgedPerformance(store, productionId, id);
  const record = PerformanceRecordSchema.parse(JSON.parse(await readFile(await audioWorldPath(store.dir,
    `productions/${productionId}/performances/${id}/performance.json`), "utf8")));
  if (record.id !== id || record.target.productionId !== productionId) throw new Error("Performance identity changed.");
  return record;
}

export async function performanceConversionRequest(store: WorldStore, model: ManifestModel,
  request: Extract<ClientMessage, { kind: "convert-performance" }>): Promise<EnqueueInput> {
  const source = await readPerformance(store, request.productionId, request.performanceId);
  if (source.kind !== "scratch") throw new Error("Choose a scratch recording for speech-to-speech conversion.");
  if (source.provenance.outputHash !== request.expectedHash || !currentPerformanceTarget(store, source.target)) throw new Error("The performance or authored line changed. Review the current target.");
  const voice = store.getBundle().sheets.find(s => s.id === source.target.speakerSheetId)?.voice;
  if (voice?.provider !== "elevenlabs" || voice.voiceId !== request.expectedVoiceId) throw new Error("Choose the character's current ElevenLabs TTS voice before conversion.");
  if (model.capability !== "voice-conversion" || model.id !== request.modelId || model.provider !== "elevenlabs") throw new Error("No verified conversion model is selected.");
  const durationSec = source.provenance.outputTechnical.durationSec;
  if (!durationSec || durationSec > 300) throw new Error("Conversion requires measured audio of at most five minutes.");
  const estimatedMicroUsd = estimateMicroUsd(model, { durationSec });
  if (estimatedMicroUsd !== request.confirmedMicroUsd) throw new Error("Review the current duration-based conversion price.");
  if (!request.singleSpeaker || !request.wordingConfirmed) throw new Error("Confirm the source speaker and reviewed wording before conversion.");
  const hash = source.provenance.outputHash, at = new Date().toISOString(), acknowledgementId = randomUUID();
  const attestations = [{ kind: "single-speaker" as const, audioHash: hash, statementVersion: 1, acknowledgedAt: at }];
  await appendAudioRights(store, { schemaVersion: 1, action: "acknowledge", id: acknowledgementId, audioHash: hash,
    basis: request.cloudBasis, scopes: ["cloud-voice-conversion"], statementVersion: 1, at });
  const input = PerformanceConversionInputSchema.parse({ sourcePerformanceId: source.id, sourceHash: hash,
    outputPerformanceId: `pf_${request.requestId}`, target: source.target, voiceAssignment: voice, acknowledgementId,
    warningCodes: request.warningCodes, attestations, wordingConfirmedAt: at, retention: request.retention });
  const job: EnqueueInput = { idempotencyKey: request.requestId, worldId: store.worldId, productionId: request.productionId,
    target: { kind: "performance-conversion", id: input.outputPerformanceId }, capability: "voice-conversion", provider: model.provider, model: model.id,
    params: { performanceConversion: input, voiceId: voice.voiceId, retention: request.retention }, estimatedMicroUsd,
    landing: { dir: `productions/${request.productionId}/performances/${input.outputPerformanceId}/incoming`, name: "conversion.mp3" } };
  await readPerformanceConversionInputs(store, job);
  return job;
}

export async function readPerformanceConversionInputs(store: WorldStore, job: Pick<Job, "params" | "model" | "provider" | "capability" | "productionId">) {
  const input = PerformanceConversionInputSchema.parse(job.params.performanceConversion);
  if (job.capability !== "voice-conversion" || job.provider !== "elevenlabs" || job.model !== "eleven_multilingual_sts_v2" ||
    job.productionId !== input.target.productionId || job.params.voiceId !== input.voiceAssignment.voiceId || job.params.retention !== input.retention) throw new Error("Conversion route or target changed.");
  const source = await readPerformance(store, input.target.productionId, input.sourcePerformanceId);
  if (source.kind !== "scratch" || source.provenance.outputHash !== input.sourceHash) throw new Error("Conversion source identity changed.");
  if (source.provenance.outputHash !== input.sourceHash || JSON.stringify(source.target) !== JSON.stringify(input.target) || !currentPerformanceTarget(store, input.target)) throw new Error("The performance target is stale.");
  const bytes = await readAudioBytes(await audioWorldPath(store.dir,
    `productions/${input.target.productionId}/performances/${source.id}/${source.file}`), store.closingSignal);
  clearAudioDispatch({ bytes, hash: input.sourceHash, report: source.provenance.qualityReport, scope: "cloud-voice-conversion",
    rights: await readAudioRights(store), warningCodes: input.warningCodes, attestations: input.attestations,
    requiredAttestations: ["single-speaker"], statementVersion: 1, acknowledgementId: input.acknowledgementId });
  const durationSec = source.provenance.outputTechnical.durationSec;
  if (!durationSec || durationSec > 300) throw new Error("Conversion source exceeds the provider duration limit.");
  return [{ name: `${input.sourceHash.slice(7)}.wav`, contentType: "audio/wav" as const, hash: input.sourceHash, durationSec, data: bytes }];
}

/** Local replay after paid output arrival. Never resubmits or auto-selects a performance. */
export async function finalizePerformanceConversion(store: WorldStore, tools: AudioMediaTools, job: Job, cost: TakeCost): Promise<void> {
  const input = PerformanceConversionInputSchema.parse(job.params.performanceConversion);
  if (input.outputPerformanceId !== `pf_${job.id.slice(3)}`) throw new Error("Conversion job identity changed.");
  await requireUnpurgedPerformance(store, input.target.productionId, input.outputPerformanceId);
  const prefix = `productions/${input.target.productionId}/performances/${input.outputPerformanceId}`;
  const existing = await readPerformance(store, input.target.productionId, input.outputPerformanceId).catch(() => null);
  if (existing) {
    if (existing.kind !== "speech-to-speech" || existing.jobId !== job.id) throw new Error("Performance finalization identity conflict.");
    return;
  }
  const source = await readPerformance(store, input.target.productionId, input.sourcePerformanceId);
  if (source.kind !== "scratch" || source.provenance.outputHash !== input.sourceHash) throw new Error("Conversion source identity changed.");
  const landed = job.landedFiles?.[0]; if (!landed) throw new Error("Conversion audio has not landed.");
  const bytes = await readAudioBytes(await audioWorldPath(store.dir, landed), store.closingSignal);
  await store.ownedWrite(async () => {
    const sourcePath = await audioWorldPath(store.dir, `${prefix}/source.mp3`, true);
    const prior = await readFile(sourcePath).catch(() => null);
    if (prior && audioHash(prior) !== audioHash(bytes)) throw new Error("Conversion bytes changed during finalization.");
    if (!prior) await atomicWriteFile(sourcePath, bytes);
    const metadata = await audioWorldPath(store.dir, `${prefix}/source.json`, true);
    const sourceJson = JSON.stringify({ file: "source.mp3", hash: audioHash(bytes), jobId: job.id });
    const previous = await readFile(metadata, "utf8").catch(() => null);
    if (previous && previous !== sourceJson) throw new Error("Conversion source identity conflict.");
    if (!previous) await atomicWriteFile(metadata, sourceJson);
  });
  const candidate = await prepareAudio(store, tools, { kind: "performance-recording", productionId: input.target.productionId, performanceId: input.outputPerformanceId });
  await acceptPreparedAudio(store, candidate, prefix, (file, provenance) => ({ kind: "performance-converted", source: "system",
    files: [{ path: `${prefix}/performance.json`, action: "create", baseHash: null, content: JSON.stringify(PerformanceRecordSchema.parse({
      id: input.outputPerformanceId, kind: "speech-to-speech", target: input.target, file: file.slice(prefix.length + 1), provenance,
      createdAt: new Date().toISOString(), captureAcknowledgement: source.captureAcknowledgement,
      wordingConfirmedAt: input.wordingConfirmedAt, sourcePerformanceId: input.sourcePerformanceId, sourcePerformanceHash: input.sourceHash,
      jobId: job.id, voiceAssignment: input.voiceAssignment, cost,
      conversion: { provider: "elevenlabs", model: job.model, retention: input.retention, preservesTiming: true, preservesProsody: true },
    }), null, 2) + "\n" }] }));
}
