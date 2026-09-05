import { orderedShots, masterAudioBinding, MasterAudioReviewSchema, type MasterAudioRequest, type FrozenMasterAudio } from "@arke-studio/contracts";
import { sha256 } from "../world/text-files.js";
import { readFile } from "node:fs/promises";
import { PreparedPerformanceAudioReviewSchema, PreparedReferenceAudioSchema, type ClientMessage, type PerformanceRecord } from "@arke-studio/contracts";
import { prepareAudio, acceptPreparedAudio, type PreparedAudioCandidate } from "./storage.js";
import type { AudioMediaTools } from "./media-tools.js";
import { type FrozenPerformanceAudio, type PerformanceAudioRequest } from "@arke-studio/contracts";
import { readPerformance, currentPerformanceTarget } from "./performances.js";
import { CharacterAudioPlanSchema, characterAudioRoute, referenceAudioAsset, type Job } from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import { audioWorldPath } from "./storage.js";
import { readAudioBytes } from "./media-tools.js";
import { appendAudioRights, readAudioRights } from "./rights.js";
import { clearAudioDispatch } from "./dispatch-gate.js";

/** Read frozen samples, never the character's possibly replaced current designation. */
export async function readCharacterAudioInputs(store: WorldStore, job: Pick<Job, "model" | "provider" | "params">, requireCurrent = false) {
  const plan = CharacterAudioPlanSchema.parse(job.params.audioReferences);
  if (plan.disabled) {
    if (plan.references.length) throw new Error("Disabled audio plan still carries samples.");
    return [];
  }
  if (plan.problems.length) throw new Error("Resolve the audio reference plan before dispatch.");
  if (!plan.references.length) return [];
  if (new Set(plan.references.map(ref => ref.intent)).size > 1) throw new Error("Mixed audio intents are unsupported.");
  const route = characterAudioRoute({ id: job.model, provider: job.provider }, typeof job.params.taskMode === "string" ? job.params.taskMode : "generate");
  if (!route || route.endpoint !== plan.route || (job.params.route !== undefined && job.params.route !== route.endpoint)) throw new Error("The selected route cannot carry these audio references.");
  const images = Array.isArray(job.params.references) ? job.params.references.length : 0;
  if (!images || images > route.maxImages || images + plan.references.length > route.maxCombinedReferences) throw new Error("The complete reference set exceeds the route budget or lacks imagery.");
  const rights = await readAudioRights(store);
  let seconds = 0;
  const result = [];
  for (const [index, ref] of plan.references.entries()) {
    if (ref.label !== `@Audio${index + 1}`) throw new Error("Audio reference bindings changed.");
    const sample = referenceAudioAsset(ref);
    if (requireCurrent) {
      if ("master" in ref) await requireCurrentMasterBinding(store, ref.master);
      else if ("sample" in ref) {
        const current = store.getBundle().referenceKits.find(k => k.sheetId === ref.sheetId)?.designatedVoiceSample;
        if (!current || !("schemaVersion" in current) || current.provenance.outputHash !== sample.provenance.outputHash) throw new Error("The assigned character sample changed. Review the dispatch again.");
      } else {
        const current = await readPerformance(store, ref.performance.target.productionId, ref.performance.id);
        const review = store.getBundle().productions.find(p => p.meta.id === current.target.productionId)?.performanceReview.reviews.filter(r => r.performanceId === current.id).at(-1);
        if (!currentPerformanceTarget(store, current.target) || current.provenance.outputHash !== ref.performance.provenance.outputHash ||
          review?.decision !== "accept" || review.ts !== ref.acceptedReviewAt) throw new Error("The accepted performance changed. Review the dispatch again.");
      }
    }
    const file = "master" in ref ? `productions/${ref.master.productionId}/${ref.prepared.file}` : "sample" in ref ? `references/${ref.sheetId}/${sample.file}`
      : ref.prepared ? `productions/${ref.performance.target.productionId}/${ref.prepared.file}`
      : `productions/${ref.performance.target.productionId}/performances/${ref.performance.id}/${sample.file}`;
    const bytes = await readAudioBytes(await audioWorldPath(store.dir, file), store.closingSignal, route.maxBytesPerFile);
    seconds += sample.provenance.outputTechnical.durationSec ?? Infinity;
    if (seconds > route.maxTotalDurationSec) throw new Error("Audio references exceed the combined duration limit.");
    clearAudioDispatch({ bytes, hash: sample.provenance.outputHash, report: sample.provenance.qualityReport,
      rights, scope: "cloud-reference-upload", warningCodes: sample.warningCodes, attestations: sample.attestations,
      requiredAttestations: "master" in ref ? [] : ["single-speaker", "no-music"], statementVersion: 1, acknowledgementId: sample.acknowledgementId });
    const mp3 = sample.file.endsWith(".mp3");
    result.push({ name: `audio-${index + 1}.${mp3 ? "mp3" : "wav"}`, contentType: mp3 ? "audio/mpeg" as const : "audio/wav" as const, data: bytes });
  }
  return result;
}

/** Explicit full-performance references reuse immutable media; no parallel asset store or preparation job. */
export async function resolvePerformanceAudioReferences(store: WorldStore, productionId: string, sceneId: string,
  requests: readonly PerformanceAudioRequest[], requestId: string): Promise<FrozenPerformanceAudio[]> {
  const references: FrozenPerformanceAudio[] = [];
  for (const [index, request] of requests.entries()) {
    const performance = await readPerformance(store, productionId, request.performanceId);
    const production = store.getBundle().productions.find(p => p.meta.id === productionId);
    const review = production?.performanceReview.reviews.filter(r => r.performanceId === performance.id).at(-1);
    const sheet = store.getBundle().sheets.find(s => s.id === performance.target.speakerSheetId && !s.retired);
    if (performance.target.sceneId !== sceneId || !currentPerformanceTarget(store, performance.target) || !sheet ||
      review?.decision !== "accept" || review.ts !== request.acceptedReviewAt || performance.provenance.outputHash !== request.hash) {
      throw new Error("The reviewed performance changed. Choose a currently accepted performance for this scene.");
    }
    if (requests.slice(0, index).some(r => r.performanceId === request.performanceId)) throw new Error("A performance reference was selected twice.");
    if (performance.kind !== "scratch" && (!sheet.voice || sheet.voice.provider !== performance.voiceAssignment.provider ||
      sheet.voice.voiceId !== performance.voiceAssignment.voiceId || sheet.voice.model !== performance.voiceAssignment.model ||
      sheet.voice.assignedAtVersion !== performance.voiceAssignment.assignedAtVersion)) throw new Error("The performance uses an earlier character voice assignment.");
    const prepared = request.prepared ? await acceptPerformanceAudioRange(store, performance, request.prepared, requestId) : undefined;
    const asset = prepared ?? performance;
    const dispatchHash = asset.provenance.outputHash;
    const acknowledgementId = `performance-reference/${requestId}/${index}`;
    const prior = (await readAudioRights(store)).find(r => r.action === "acknowledge" && r.id === acknowledgementId);
    const at = prior?.at ?? store.now();
    const attestations = (["single-speaker", "no-music"] as const).map(kind => ({ kind, audioHash: dispatchHash,
      statementVersion: 1, acknowledgedAt: at }));
    if (!request.singleSpeaker || !request.noMusic) throw new Error("Confirm a single speaker and no music.");
    await appendAudioRights(store, { schemaVersion: 1, action: "acknowledge", id: acknowledgementId, audioHash: dispatchHash,
      basis: request.cloudBasis, scopes: ["cloud-reference-upload"], statementVersion: 1, at });
    const bytes = await readAudioBytes(await audioWorldPath(store.dir,
      prepared ? `productions/${productionId}/${prepared.file}` : `productions/${productionId}/performances/${performance.id}/${performance.file}`), store.closingSignal, 15_000_000);
    clearAudioDispatch({ bytes, hash: dispatchHash, report: asset.provenance.qualityReport,
      rights: await readAudioRights(store), scope: "cloud-reference-upload", acknowledgementId,
      warningCodes: request.warningCodes, attestations, requiredAttestations: ["single-speaker", "no-music"], statementVersion: 1 });
    references.push({ intent: request.intent, sheetId: sheet.id, characterName: sheet.name, label: "@Audio1", performance, ...(prepared ? { prepared } : {}),
      acceptedReviewAt: review.ts, warningCodes: request.warningCodes, attestations, acknowledgementId });
  }
  return references;
}

export async function preparePerformanceAudioRange(store: WorldStore, tools: AudioMediaTools,
  request: Extract<ClientMessage, { kind: "prepare-performance-audio-reference" }>) {
  const performance = await readPerformance(store, request.productionId, request.performanceId);
  const review = store.getBundle().productions.find(p => p.meta.id === request.productionId)?.performanceReview.reviews.filter(r => r.performanceId === performance.id).at(-1);
  if (review?.decision !== "accept" || !currentPerformanceTarget(store, performance.target) || performance.provenance.outputHash !== request.expectedHash) throw new Error("Choose a currently accepted performance.");
  const candidate = await prepareAudio(store, tools, { kind: "performance", productionId: request.productionId,
    performanceId: performance.id, range: request.range });
  return PreparedPerformanceAudioReviewSchema.parse({ operationId: candidate.operationId, performanceId: performance.id,
    sourceHash: request.expectedHash, preparedFile: candidate.stagedFile, provenance: candidate.provenance });
}

async function acceptPerformanceAudioRange(store: WorldStore, performance: PerformanceRecord,
  prepared: NonNullable<PerformanceAudioRequest["prepared"]>, requestId: string) {
  const prefix = `productions/${performance.target.productionId}`;
  const receiptPath = `${prefix}/audio-inputs/${prepared.operationId}.json`;
  const receipt = await readFile(await store.ownedWrite(() => audioWorldPath(store.dir, receiptPath, true)), "utf8").catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error;
  });
  const verify = (asset: { provenance: PerformanceRecord["provenance"] }) => {
    const source = asset.provenance.source;
    if (source.kind !== "performance" || source.productionId !== performance.target.productionId ||
      source.performanceId !== performance.id || source.sourceMediaHash !== performance.provenance.outputHash ||
      asset.provenance.outputHash !== prepared.hash) throw new Error("The prepared performance range changed. Prepare and review it again.");
  };
  if (receipt) { const asset = PreparedReferenceAudioSchema.parse(JSON.parse(receipt)); verify(asset); return asset; }
  const candidate = JSON.parse(await readFile(await audioWorldPath(store.dir, `.staging/audio/${prepared.operationId}/candidate.json`), "utf8")) as PreparedAudioCandidate;
  verify(candidate);
  let asset: ReturnType<typeof PreparedReferenceAudioSchema.parse> | undefined;
  await acceptPreparedAudio(store, candidate, `${prefix}/audio-inputs`, (file, provenance) => {
    asset = PreparedReferenceAudioSchema.parse({ file: file.slice(prefix.length + 1), provenance });
    return { kind: "prepare-performance-reference", source: "user", requestId, files: [{ path: receiptPath,
      action: "create", baseHash: null, content: JSON.stringify(asset) + "\n" }] };
  });
  return asset!;
}

async function requireCurrentMasterBinding(store: WorldStore, binding: MasterAudioRequest["binding"]) {
  const production = store.getBundle().productions.find(p => p.meta.id === binding.productionId);
  if (!production || JSON.stringify(masterAudioBinding(production, binding.shotId)) !== JSON.stringify(binding)) throw new Error("The master playback binding changed. Prepare the current slice again.");
  const raw = await readFile(await audioWorldPath(store.dir, `productions/${binding.productionId}/timeline.json`), "utf8");
  if (sha256(raw) !== binding.timelineHash) throw new Error("The timeline changed. Refresh before preparing playback.");
}
export async function prepareMasterAudioReference(store: WorldStore, tools: AudioMediaTools, binding: MasterAudioRequest["binding"]) {
  await requireCurrentMasterBinding(store, binding);
  const candidate = await prepareAudio(store, tools, { kind: "artifact", artifactId: binding.artifactId, range: binding.range });
  await requireCurrentMasterBinding(store, binding);
  return MasterAudioReviewSchema.parse({ operationId: candidate.operationId, binding, preparedFile: candidate.stagedFile, provenance: candidate.provenance });
}
export async function resolveMasterAudioReferences(store: WorldStore, productionId: string, sceneId: string,
  requests: readonly MasterAudioRequest[], requestId: string): Promise<FrozenMasterAudio[]> {
  const references: FrozenMasterAudio[] = [];
  for (const [index, request] of requests.entries()) {
    const binding = request.binding;
    const production = store.getBundle().productions.find(p => p.meta.id === productionId);
    if (binding.productionId !== productionId || !production?.scenes.some(s => s.id === sceneId && orderedShots(s).some(shot => shot.id === binding.shotId))) throw new Error("The master slice belongs to another scene.");
    if (requests.slice(0, index).some(r => r.binding.shotId === binding.shotId)) throw new Error("A shot has more than one master slice.");
    await requireCurrentMasterBinding(store, binding);
    const prefix = `productions/${productionId}`;
    const receiptPath = `${prefix}/audio-inputs/${request.operationId}.json`;
    const receipt = await readFile(await store.ownedWrite(() => audioWorldPath(store.dir, receiptPath, true)), "utf8").catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error;
    });
    const verify = (asset: { provenance: PerformanceRecord["provenance"] }) => {
      const source = asset.provenance.source;
      if (source.kind !== "artifact" || source.artifactId !== binding.artifactId || JSON.stringify(source.range) !== JSON.stringify(binding.range) ||
        asset.provenance.outputHash !== request.hash) throw new Error("The prepared master slice changed. Prepare and review it again.");
    };
    let prepared;
    if (receipt) { prepared = PreparedReferenceAudioSchema.parse(JSON.parse(receipt)); verify(prepared); }
    else {
      const candidate = JSON.parse(await readFile(await audioWorldPath(store.dir, `.staging/audio/${request.operationId}/candidate.json`), "utf8")) as PreparedAudioCandidate;
      verify(candidate);
      await acceptPreparedAudio(store, candidate, `${prefix}/audio-inputs`, (file, provenance) => {
        prepared = PreparedReferenceAudioSchema.parse({ file: file.slice(prefix.length + 1), provenance });
        return { kind: "prepare-master-reference", source: "user", requestId, files: [{ path: receiptPath, action: "create", baseHash: null,
          content: JSON.stringify(prepared) + "\n" }] };
      });
    }
    if (!prepared) throw new Error("Master slice preparation did not finish.");
    const acknowledgementId = `master-reference/${requestId}/${index}`;
    const prior = (await readAudioRights(store)).find(r => r.action === "acknowledge" && r.id === acknowledgementId);
    await appendAudioRights(store, { schemaVersion: 1, action: "acknowledge", id: acknowledgementId, audioHash: request.hash,
      basis: request.cloudBasis, scopes: ["cloud-reference-upload"], statementVersion: 1, at: prior?.at ?? store.now() });
    const bytes = await readAudioBytes(await audioWorldPath(store.dir, `${prefix}/${prepared.file}`), store.closingSignal, 15_000_000);
    clearAudioDispatch({ bytes, hash: request.hash, report: prepared.provenance.qualityReport, rights: await readAudioRights(store),
      scope: "cloud-reference-upload", acknowledgementId, warningCodes: request.warningCodes, attestations: [], requiredAttestations: [], statementVersion: 1 });
    references.push({ intent: "performance-sync", characterName: `Shot ${binding.shotId} master playback`, label: "@Audio1", master: binding,
      prepared, warningCodes: request.warningCodes, acknowledgementId });
  }
  return references;
}
