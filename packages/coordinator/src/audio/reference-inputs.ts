import { CharacterAudioPlanSchema, characterAudioRoute, type Job } from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import { audioWorldPath } from "./storage.js";
import { readAudioBytes } from "./media-tools.js";
import { readAudioRights } from "./rights.js";
import { clearAudioDispatch } from "./dispatch-gate.js";

/** Read frozen samples, never the character's possibly replaced current designation. */
export async function readCharacterAudioInputs(store: WorldStore, job: Pick<Job, "model" | "provider" | "params">) {
  const plan = CharacterAudioPlanSchema.parse(job.params.audioReferences);
  if (plan.disabled) {
    if (plan.references.length) throw new Error("Disabled audio plan still carries samples.");
    return [];
  }
  if (plan.problems.length) throw new Error("Resolve the audio reference plan before dispatch.");
  if (!plan.references.length) return [];
  const route = characterAudioRoute({ id: job.model, provider: job.provider }, typeof job.params.taskMode === "string" ? job.params.taskMode : "generate");
  if (!route || route.endpoint !== plan.route || (job.params.route !== undefined && job.params.route !== route.endpoint)) throw new Error("The selected route cannot carry these audio references.");
  const images = Array.isArray(job.params.references) ? job.params.references.length : 0;
  if (!images || images + plan.references.length > route.maxCombinedReferences) throw new Error("The complete reference set exceeds the route budget or lacks imagery.");
  const rights = await readAudioRights(store);
  let seconds = 0;
  const result = [];
  for (const [index, ref] of plan.references.entries()) {
    if (ref.label !== `@Audio${index + 1}`) throw new Error("Audio reference bindings changed.");
    const sample = ref.sample;
    const file = `references/${ref.sheetId}/${sample.file}`;
    const bytes = await readAudioBytes(await audioWorldPath(store.dir, file), store.closingSignal, route.maxBytesPerFile);
    seconds += sample.provenance.outputTechnical.durationSec ?? Infinity;
    if (seconds > route.maxTotalDurationSec) throw new Error("Audio references exceed the combined duration limit.");
    clearAudioDispatch({ bytes, hash: sample.provenance.outputHash, report: sample.provenance.qualityReport,
      rights, scope: "cloud-reference-upload", warningCodes: sample.warningCodes, attestations: sample.attestations,
      requiredAttestations: ["single-speaker", "no-music"], statementVersion: 1, acknowledgementId: sample.acknowledgementId });
    result.push({ name: `${ref.sheetId}.wav`, contentType: "audio/wav" as const, data: bytes });
  }
  return result;
}
