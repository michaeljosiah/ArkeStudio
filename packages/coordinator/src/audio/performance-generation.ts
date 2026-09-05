import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PerformanceGenerationQuoteSchema, PerformanceRecordSchema, PerformanceIdSchema, AudioAssetProvenanceSchema,
  estimateMicroUsd, mapCadence, normalizeSpeechText, type ClientMessage, type ManifestModel, type PerformanceGenerationQuote, type Job, type TakeCost } from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import { atomicWriteFile } from "../world/atomic.js";
import { audioWorldPath, prepareAudio, acceptPreparedAudio } from "./storage.js";
import { performanceTarget, currentPerformanceTarget, readPerformance } from "./performances.js";
import { audioHash, analyzePcmWav, unavailableAudioReport } from "./qc.js";
import { requireUnpurgedPerformance } from "./performance-purge.js";
import { readAudioBytes, type AudioMediaTools } from "./media-tools.js";
import { verifyArtifact } from "../queue/verify.js";
import type { EnqueueInput } from "../queue/dispatcher.js";

const digest = (value: unknown) => audioHash(Buffer.from(JSON.stringify(value)));
export async function preparePerformanceGeneration(store: WorldStore, model: ManifestModel,
  request: Extract<ClientMessage, { kind: "prepare-performance-generation" }>) {
  const { target, text, sheet } = performanceTarget(store, request);
  if (target.sceneVersion !== request.expectedSceneVersion || !sheet.voice || sheet.voice.voiceId !== request.expectedVoiceId ||
    model.id !== request.modelId || model.provider !== sheet.voice.provider || model.capability !== "voice-tts" || !["kokoro", "elevenlabs"].includes(model.provider)) throw new Error("The authored line, voice or model changed.");
  const mapped = mapCadence(text, audioHash(Buffer.from(normalizeSpeechText(text))), request.cadencePlan, model);
  if (mapped.controls.some(c => c.status === "unsupported")) throw new Error("Remove unsupported cadence controls or choose a compatible model.");
  if (model.limits.maxPromptChars !== undefined && mapped.providerText.length > model.limits.maxPromptChars) throw new Error("The decorated line exceeds this model's character limit.");
  const quote = PerformanceGenerationQuoteSchema.parse({ operationId: randomUUID(), target, authoredText: text, voiceAssignment: sheet.voice,
    cadencePlan: request.cadencePlan, cadencePlanHash: digest(request.cadencePlan), mapping: { ...mapped, providerTextHash: audioHash(Buffer.from(mapped.providerText)) },
    modelHash: digest(model), estimatedMicroUsd: estimateMicroUsd(model, { characters: mapped.providerText.length }), local: model.provider === "kokoro", createdAt: store.now() });
  await store.ownedWrite(async () => atomicWriteFile(await audioWorldPath(store.dir, `.staging/performances/${quote.operationId}/quote.json`, true), JSON.stringify(quote)));
  return quote;
}
export async function readPerformanceGenerationQuote(store: WorldStore, operationId: string): Promise<PerformanceGenerationQuote> {
  // The command schema owns UUID validation; the filesystem boundary independently rejects traversal.
  const quote = PerformanceGenerationQuoteSchema.parse(JSON.parse(await readFile(await audioWorldPath(store.dir, `.staging/performances/${operationId}/quote.json`), "utf8")));
  if (quote.operationId !== operationId || Date.now() - Date.parse(quote.createdAt) > 86_400_000) throw new Error("Prepare a fresh generation estimate.");
  return quote;
}
export function validatePerformanceGeneration(store: WorldStore, model: ManifestModel, quote: PerformanceGenerationQuote, confirmedMicroUsd: number) {
  const voice = store.getBundle().sheets.find(s => s.id === quote.target.speakerSheetId)?.voice;
  if (!currentPerformanceTarget(store, quote.target) || JSON.stringify(voice) !== JSON.stringify(quote.voiceAssignment) || digest(model) !== quote.modelHash || confirmedMicroUsd !== quote.estimatedMicroUsd) throw new Error("Generation confirmation is stale. Prepare a fresh estimate.");
}
export function performanceGenerationJob(store: WorldStore, quote: PerformanceGenerationQuote, requestId: string): EnqueueInput {
  const id = PerformanceIdSchema.parse(`pf_${requestId}`);
  return { worldId: store.worldId, productionId: quote.target.productionId, idempotencyKey: requestId,
    target: { kind: "performance-generation", id }, capability: "voice-tts", provider: quote.mapping.provider, model: quote.mapping.model,
    params: { performanceGeneration: quote, voiceId: quote.voiceAssignment.voiceId, text: quote.mapping.providerText,
      voiceSettings: quote.mapping.voiceSettings }, estimatedMicroUsd: quote.estimatedMicroUsd,
    landing: { dir: `productions/${quote.target.productionId}/performances/${id}/incoming`, name: "speech.mp3" } };
}

/** Keeps paid output even without a decoder; the unavailable QC report blocks later reference upload. */
export async function finalizeGeneratedPerformance(store: WorldStore, tools: AudioMediaTools | undefined, quote: PerformanceGenerationQuote,
  id: string, bytes: Uint8Array, format: "wav" | "mp3", cost: TakeCost, jobId?: string, signal = store.closingSignal) {
  PerformanceIdSchema.parse(id);
  await requireUnpurgedPerformance(store, quote.target.productionId, id);
  const existing = await readPerformance(store, quote.target.productionId, id).catch(() => null);
  if (existing) {
    if (existing.kind !== "generated-tts" || existing.operationId !== quote.operationId || existing.jobId !== jobId) throw new Error("Performance generation identity conflict.");
    return existing;
  }
  if (signal.aborted) throw new Error("Performance generation cancelled.");
  const contentType = format === "wav" ? "audio/wav" : "audio/mpeg";
  const problem = verifyArtifact({ name: `speech.${format}`, contentType, data: bytes });
  if (problem) throw new Error("Generation returned invalid audio.");
  const prefix = `productions/${quote.target.productionId}/performances/${id}`;
  const sourceFile = `source.${format}`, sourceHash = audioHash(bytes);
  await store.ownedWrite(async () => {
    const path = await audioWorldPath(store.dir, `${prefix}/${sourceFile}`, true);
    const prior = await readFile(path).catch(() => null);
    if (prior && audioHash(prior) !== sourceHash) throw new Error("Performance generation bytes changed.");
    if (!prior) await atomicWriteFile(path, bytes);
    await atomicWriteFile(await audioWorldPath(store.dir, `${prefix}/source.json`, true), JSON.stringify({ file: sourceFile, hash: sourceHash, operationId: quote.operationId, ...(jobId ? { jobId } : {}) }));
  });
  let candidate: Awaited<ReturnType<typeof prepareAudio>> | undefined;
  if (tools) { try { candidate = await prepareAudio(store, tools, { kind: "performance-recording", productionId: quote.target.productionId, performanceId: id }); } catch { /* Preserve verified provider output; unavailable QC is truthful. */ } }
  if (signal.aborted) throw new Error("Performance generation cancelled.");
  const makeRecord = (file: string, provenance: unknown) => PerformanceRecordSchema.parse({
    id, kind: "generated-tts", operationId: quote.operationId, target: quote.target, authoredText: quote.authoredText,
    voiceAssignment: quote.voiceAssignment, cadencePlan: quote.cadencePlan, cadencePlanHash: quote.cadencePlanHash,
    mapping: quote.mapping, file, provenance, cost, ...(jobId ? { jobId } : {}), createdAt: store.now() });
  let record: ReturnType<typeof makeRecord>;
  if (candidate) {
    await acceptPreparedAudio(store, candidate, prefix, (file, provenance) => {
      if (signal.aborted) throw new Error("Performance generation cancelled.");
      record = makeRecord(file.slice(prefix.length + 1), provenance);
      return { kind: "performance-generated", source: "system", files: [{ path: `${prefix}/performance.json`, action: "create", baseHash: null, content: JSON.stringify(record, null, 2) + "\n" }] };
    });
    return record!;
  }
  const technical = { container: format, codec: null, sampleFormat: null, sampleRateHz: null, channels: null, bitDepth: null, durationSec: null, sizeBytes: bytes.length };
  let report;
  try { report = analyzePcmWav(bytes); } catch { report = unavailableAudioReport(bytes, technical); }
  const provenance = AudioAssetProvenanceSchema.parse({ schemaVersion: 1,
    source: { kind: "performance-recording", productionId: quote.target.productionId, performanceId: id, sourceFile, sourceMediaHash: sourceHash },
    sourceTechnical: report.technical, outputHash: sourceHash, outputTechnical: report.technical, preparation: [], qualityReport: report, createdAt: store.now() });
  const file = `${sourceHash.replace(":", "-")}.${format}`;
  record = makeRecord(file, provenance);
  await store.gateOp(async () => {
    if (signal.aborted) throw new Error("Performance generation cancelled.");
    await atomicWriteFile(await audioWorldPath(store.dir, `${prefix}/${file}`, true), bytes);
    await store.commitUnserialised({ kind: "performance-generated", source: "system", files: [{ path: `${prefix}/performance.json`, action: "create", baseHash: null, content: JSON.stringify(record, null, 2) + "\n" }] });
  });
  return record;
}
export async function finalizePerformanceGenerationJob(store: WorldStore, tools: AudioMediaTools | undefined, job: Job, cost: TakeCost) {
  const quote = PerformanceGenerationQuoteSchema.parse(job.params.performanceGeneration);
  if (job.target.id !== `pf_${job.id.slice(3)}` || job.provider !== quote.mapping.provider || job.model !== quote.mapping.model) throw new Error("Performance job identity changed.");
  const landed = job.landedFiles?.[0]; if (!landed) throw new Error("Performance output has not landed.");
  const bytes = await readAudioBytes(await audioWorldPath(store.dir, landed), store.closingSignal);
  await finalizeGeneratedPerformance(store, tools, quote, job.target.id, bytes, "mp3", cost, job.id);
}
