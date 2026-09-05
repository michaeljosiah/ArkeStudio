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
      if ("sample" in ref) {
        const current = store.getBundle().referenceKits.find(k => k.sheetId === ref.sheetId)?.designatedVoiceSample;
        if (!current || !("schemaVersion" in current) || current.provenance.outputHash !== sample.provenance.outputHash) throw new Error("The assigned character sample changed. Review the dispatch again.");
      } else {
        const current = await readPerformance(store, ref.performance.target.productionId, ref.performance.id);
        const review = store.getBundle().productions.find(p => p.meta.id === current.target.productionId)?.performanceReview.reviews.filter(r => r.performanceId === current.id).at(-1);
        if (!currentPerformanceTarget(store, current.target) || current.provenance.outputHash !== sample.provenance.outputHash ||
          review?.decision !== "accept" || review.ts !== ref.acceptedReviewAt) throw new Error("The accepted performance changed. Review the dispatch again.");
      }
    }
    const file = "sample" in ref ? `references/${ref.sheetId}/${sample.file}`
      : `productions/${ref.performance.target.productionId}/performances/${ref.performance.id}/${sample.file}`;
    const bytes = await readAudioBytes(await audioWorldPath(store.dir, file), store.closingSignal, route.maxBytesPerFile);
    seconds += sample.provenance.outputTechnical.durationSec ?? Infinity;
    if (seconds > route.maxTotalDurationSec) throw new Error("Audio references exceed the combined duration limit.");
    clearAudioDispatch({ bytes, hash: sample.provenance.outputHash, report: sample.provenance.qualityReport,
      rights, scope: "cloud-reference-upload", warningCodes: sample.warningCodes, attestations: sample.attestations,
      requiredAttestations: ["single-speaker", "no-music"], statementVersion: 1, acknowledgementId: sample.acknowledgementId });
    const mp3 = sample.file.endsWith(".mp3");
    result.push({ name: `${ref.sheetId}.${mp3 ? "mp3" : "wav"}`, contentType: mp3 ? "audio/mpeg" as const : "audio/wav" as const, data: bytes });
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
    const acknowledgementId = `performance-reference/${requestId}/${index}`;
    const prior = (await readAudioRights(store)).find(r => r.action === "acknowledge" && r.id === acknowledgementId);
    const at = prior?.at ?? store.now();
    const attestations = (["single-speaker", "no-music"] as const).map(kind => ({ kind, audioHash: request.hash,
      statementVersion: 1, acknowledgedAt: at }));
    if (!request.singleSpeaker || !request.noMusic) throw new Error("Confirm a single speaker and no music.");
    await appendAudioRights(store, { schemaVersion: 1, action: "acknowledge", id: acknowledgementId, audioHash: request.hash,
      basis: request.cloudBasis, scopes: ["cloud-reference-upload"], statementVersion: 1, at });
    const bytes = await readAudioBytes(await audioWorldPath(store.dir,
      `productions/${productionId}/performances/${performance.id}/${performance.file}`), store.closingSignal, 15_000_000);
    clearAudioDispatch({ bytes, hash: request.hash, report: performance.provenance.qualityReport,
      rights: await readAudioRights(store), scope: "cloud-reference-upload", acknowledgementId,
      warningCodes: request.warningCodes, attestations, requiredAttestations: ["single-speaker", "no-music"], statementVersion: 1 });
    references.push({ intent: request.intent, sheetId: sheet.id, characterName: sheet.name, label: "@Audio1", performance,
      acceptedReviewAt: review.ts, warningCodes: request.warningCodes, attestations, acknowledgementId });
  }
  return references;
}
