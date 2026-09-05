import { basePictureTrack } from "./timeline.js";
import type { ProductionBundle } from "./client-state.js";
import { z } from "zod";
import { AudioRangeSchema, AudioAssetProvenanceSchema, AudioAttestationSchema, FullSha256Schema } from "./audio.js";
import { ArtifactIdSchema, ShotIdSchema, IsoDateTimeSchema, SlugSchema } from "./ids.js";
import { PerformanceIdSchema, PerformanceRecordSchema } from "./performance.js";
import { CharacterVoiceSampleSchema } from "./voice-sample.js";
import type { ManifestModel } from "./manifest.js";
import type { ReferenceKit } from "./reference.js";
import type { Shot } from "./scene.js";
import { orderedShots, type SceneRecord } from "./scene-flow.js";
import type { Sheet } from "./world.js";
import type { WorldBundle } from "./client-state.js";

const performanceSource = z.object({ kind: z.literal("performance"), performanceId: PerformanceIdSchema, hash: FullSha256Schema }).strict();
export const AudioUseRequestSchema = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("voice-reference"), source: z.union([
    z.object({ kind: z.literal("character-sample"), sheetId: SlugSchema, hash: FullSha256Schema }).strict(), performanceSource,
  ]) }).strict(),
  z.object({ intent: z.literal("performance-sync"), source: z.union([
    performanceSource, z.object({ kind: z.literal("master-slice"), sliceId: z.string().min(1), hash: FullSha256Schema }).strict(),
  ]) }).strict(),
]);
export const FrozenCharacterAudioSchema = z.object({
  intent: z.literal("voice-reference"), sheetId: SlugSchema, characterName: z.string().min(1),
  label: z.string().regex(/^@Audio[1-3]$/), sample: CharacterVoiceSampleSchema,
}).strict();
export const PerformanceAudioRequestSchema = z.object({
  prepared: z.object({ operationId: z.string().uuid(), hash: FullSha256Schema }).strict().optional(),
  performanceId: PerformanceIdSchema, hash: FullSha256Schema, acceptedReviewAt: IsoDateTimeSchema,
  intent: z.enum(["voice-reference", "performance-sync"]), warningCodes: z.array(z.string()),
  singleSpeaker: z.literal(true), noMusic: z.literal(true), cloudBasis: z.enum(["self", "authorized", "licensed"]),
}).strict();
export type PerformanceAudioRequest = z.infer<typeof PerformanceAudioRequestSchema>;
export const PreparedPerformanceAudioReviewSchema = z.object({
  operationId: z.string().uuid(), performanceId: PerformanceIdSchema, sourceHash: FullSha256Schema,
  preparedFile: z.string().min(1), provenance: AudioAssetProvenanceSchema,
}).strict();
export type PreparedPerformanceAudioReview = z.infer<typeof PreparedPerformanceAudioReviewSchema>;
export const PreparedReferenceAudioSchema = z.object({ file: z.string().regex(/^audio-inputs\/sha256-[a-f0-9]{64}\.wav$/),
  provenance: AudioAssetProvenanceSchema }).strict();
export const FrozenPerformanceAudioSchema = z.object({
  intent: z.enum(["voice-reference", "performance-sync"]), sheetId: SlugSchema, characterName: z.string().min(1),
  prepared: PreparedReferenceAudioSchema.optional(),
  label: z.string().regex(/^@Audio[1-3]$/), performance: PerformanceRecordSchema, acceptedReviewAt: IsoDateTimeSchema,
  warningCodes: z.array(z.string()), attestations: z.array(AudioAttestationSchema), acknowledgementId: z.string().min(1),
}).strict();
export type FrozenPerformanceAudio = z.infer<typeof FrozenPerformanceAudioSchema>;
export const MasterAudioBindingSchema = z.object({
  productionId: SlugSchema, shotId: ShotIdSchema, timelineHash: FullSha256Schema, timelineRevision: z.number().int().nonnegative(),
  sourceClipId: z.string().min(1), artifactId: ArtifactIdSchema, range: AudioRangeSchema,
}).strict();
export const MasterAudioReviewSchema = z.object({ operationId: z.string().uuid(), binding: MasterAudioBindingSchema,
  preparedFile: z.string().min(1), provenance: AudioAssetProvenanceSchema }).strict();
export type MasterAudioReview = z.infer<typeof MasterAudioReviewSchema>;
export const MasterAudioRequestSchema = z.object({ operationId: z.string().uuid(), hash: FullSha256Schema,
  binding: MasterAudioBindingSchema, warningCodes: z.array(z.string()), cloudBasis: z.enum(["self", "authorized", "licensed"]) }).strict();
export type MasterAudioRequest = z.infer<typeof MasterAudioRequestSchema>;
export const FrozenMasterAudioSchema = z.object({ intent: z.literal("performance-sync"), sheetId: z.undefined().optional(),
  characterName: z.string().min(1), label: z.string().regex(/^@Audio[1-3]$/), master: MasterAudioBindingSchema,
  prepared: PreparedReferenceAudioSchema, warningCodes: z.array(z.string()), acknowledgementId: z.string().min(1),
}).strict();
export type FrozenMasterAudio = z.infer<typeof FrozenMasterAudioSchema>;

/** Physical soundtrack time derives from the placed music, never a picture take's trim. */
export function masterAudioBinding(production: ProductionBundle, shotId: string): z.infer<typeof MasterAudioBindingSchema> {
  const state = production.timeline;
  if (state?.status !== "ready" || !state.hash) throw new Error("Save the production timeline before preparing master playback.");
  const timeline = state.timeline;
  const clips = basePictureTrack(timeline)?.clips.filter(c => c.source.kind === "shot" && c.source.shotId === shotId) ?? [];
  const picture = clips[0];
  if (clips.length !== 1 || !picture?.performanceSourceClipId) throw new Error("Choose one Picture slot with an enabled performance soundtrack.");
  const source = timeline.tracks.flatMap(track => track.kind === "music" ? track.clips : []).find(c => c.id === picture.performanceSourceClipId);
  if (!source || source.source.kind !== "artifact" || picture.startFrame < source.startFrame ||
    picture.startFrame + picture.durationFrames > source.startFrame + source.durationFrames) throw new Error("The selected master soundtrack no longer covers this shot.");
  const inSec = (source.sourceInFrames + picture.startFrame - source.startFrame) / timeline.frameRate;
  return MasterAudioBindingSchema.parse({ productionId: production.meta.id, shotId, timelineHash: state.hash,
    timelineRevision: timeline.revision, sourceClipId: source.id, artifactId: source.source.artifactId,
    range: { inSec, outSec: inSec + picture.durationFrames / timeline.frameRate } });
}
export function masterPerformanceShotIds(production?: ProductionBundle): string[] {
  return production?.timeline?.status === "ready" ? (basePictureTrack(production.timeline.timeline)?.clips ?? [])
    .flatMap(c => c.source.kind === "shot" && c.performanceSourceClipId ? [c.source.shotId] : []) : [];
}
export const AudioReferenceEffectsSchema = z.object({
  wording: z.literal("prompt-guided"), timing: z.literal("not-preserved"), identity: z.literal("guidance"),
  cadence: z.literal("guidance"), lipSync: z.literal("generated"), generatedAudio: z.boolean(),
  suppliedAudioPreserved: z.literal(false), separateAudioArtifact: z.literal(false),
}).strict();
export const CharacterAudioPlanSchema = z.object({
  version: z.literal(1), disabled: z.boolean(), route: z.string().nullable(),
  effects: AudioReferenceEffectsSchema.optional(),
  references: z.array(z.union([FrozenCharacterAudioSchema, FrozenPerformanceAudioSchema, FrozenMasterAudioSchema])).max(3), problems: z.array(z.string()),
}).strict();
export type CharacterAudioPlan = z.infer<typeof CharacterAudioPlanSchema>;
export function referenceAudioAsset(ref: CharacterAudioPlan["references"][number]) {
  if ("master" in ref) return { ...ref.prepared, warningCodes: ref.warningCodes, attestations: [], acknowledgementId: ref.acknowledgementId };
  return "sample" in ref ? ref.sample : { ...(ref.prepared ?? ref.performance), warningCodes: ref.warningCodes,
    attestations: ref.attestations, acknowledgementId: ref.acknowledgementId };
}


/** Verified fal reference-to-video contract; neither frame nor continuation routes declare audio. */
export function characterAudioRoute(model: { provider: string; id: string }, taskMode = "generate") {
  if (model.provider !== "fal" || !["generate", "keyframe-sequence"].includes(taskMode) ||
    !["seedance-2.0", "seedance-2.0-fast"].includes(model.id)) return null;
  return { endpoint: model.id === "seedance-2.0-fast" ? "bytedance/seedance-2.0/fast/reference-to-video" : "bytedance/seedance-2.0/reference-to-video", field: "audio_urls", maxFiles: 3,
    maxBytesPerFile: 15_000_000, maxTotalDurationSec: 15, maxImages: 9, maxCombinedReferences: 12,
    formats: ["audio/wav", "audio/mpeg"], incrementalInputMicroUsd: 0, providerDurationMode: "requested",
    effects: { wording: "prompt-guided", timing: "not-preserved", identity: "guidance", cadence: "guidance",
      lipSync: "generated", generatedAudio: true, suppliedAudioPreserved: false, separateAudioArtifact: false } } as const;
}

/** Resolve authored speaking roles, never incidental mentions. Ordering follows reviewed script coverage. */
export function planCharacterAudio(input: { scene: SceneRecord; shots: readonly Shot[]; sheets: readonly Sheet[];
  kits: readonly ReferenceKit[]; model: ManifestModel; imageCount: number; taskMode?: string; disabled?: boolean; performanceReferences?: readonly FrozenPerformanceAudio[]; masterReferences?: readonly FrozenMasterAudio[]; requiredMasterShots?: readonly string[] }): CharacterAudioPlan {
  const route = characterAudioRoute(input.model, input.taskMode);
  const plan: CharacterAudioPlan = { version: 1, disabled: input.disabled === true, route: route?.endpoint ?? null, references: [], problems: [] };
  if (plan.disabled || input.model.capability !== "video" || (!input.kits.some(k => k.designatedVoiceSample) && !input.performanceReferences?.length && !input.masterReferences?.length && !input.requiredMasterShots?.length)) return plan;
  const speakers: string[] = [];
  const add = (speaker: string | undefined) => {
    if (!speaker) plan.problems.push("Resolve the speaker for the covered dialogue before dispatch.");
    else if (!speakers.includes(speaker)) speakers.push(speaker);
  };
  const masters = (input.masterReferences ?? []).filter(ref => input.shots.some(shot => shot.id === ref.master.shotId));
  for (const shot of input.shots) {
    if (input.requiredMasterShots?.includes(shot.id) && !masters.some(ref => ref.master.shotId === shot.id)) plan.problems.push("An enabled performance shot needs its prepared master slice. Prepare it or explicitly disable audio references.");
    if (masters.some(ref => ref.master.shotId === shot.id)) continue;
    const covered = shot.covers?.map(c => input.scene.script?.blocks.find(b => b.id === c.blockId));
    if (covered?.length) {
      for (const block of covered) {
        if (!block) plan.problems.push("A covered script block is missing. Repair shot coverage before dispatch.");
        else if (block.kind === "dialogue") add(block.speaker);
      }
    } else if (shot.audio?.kind === "dialogue" || shot.audio?.kind === "vo") add(shot.audio.speaker);
  }
  for (const ref of masters) {
    if (!route) plan.problems.push("This route cannot carry master performance playback.");
    plan.references.push({ ...ref, label: `@Audio${plan.references.length + 1}` });
  }
  const explicit = (input.performanceReferences ?? []).filter(ref => input.shots.some(shot => shot.id === ref.performance.target.shotId));
  for (const ref of explicit) {
    if (!route) plan.problems.push("This route cannot carry the selected performance audio.");
    if (masters.some(master => master.master.shotId === ref.performance.target.shotId)) plan.problems.push("Choose a master slice or character performances for a shot, not both.");
    if (!speakers.includes(ref.sheetId)) plan.problems.push("The performance does not match a speaking character in this shot.");
    plan.references.push({ ...ref, label: `@Audio${plan.references.length + 1}` });
  }
  for (const id of speakers) {
    if (explicit.some(ref => ref.sheetId === id)) continue;
    const sheet = input.sheets.find(s => s.id === id && s.type === "character");
    if (!sheet) { plan.problems.push(`Speaking character ${id} is missing.`); continue; }
    const sample = input.kits.find(k => k.sheetId === id)?.designatedVoiceSample;
    if (!sample) continue;
    if (!route) { plan.problems.push(`${sheet.name}: this route cannot carry the assigned voice reference. Choose a compatible route or explicitly continue without audio references.`); continue; }
    if (!("schemaVersion" in sample)) { plan.problems.push(`${sheet.name}: revalidate the legacy sample before cloud reuse.`); continue; }
    if (!sample.acknowledgementId) plan.problems.push(`${sheet.name}: the sample is local-only; authorize cloud reference reuse before dispatch.`);
    if (sample.provenance.outputTechnical.sizeBytes > route.maxBytesPerFile) plan.problems.push(`${sheet.name}: sample exceeds the route's 15 MB file limit.`);
    plan.references.push({ intent: "voice-reference", sheetId: id, characterName: sheet.name, label: `@Audio${plan.references.length + 1}`, sample });
  }
  if (new Set(plan.references.map(ref => ref.intent)).size > 1) plan.problems.push("A dispatch cannot mix voice guidance and performance synchronization. Disable assigned samples or use one intent throughout the pass.");
  if (plan.references.length && route) {
    plan.effects = { ...route.effects, generatedAudio: plan.references[0]!.intent !== "performance-sync" };
    for (const ref of plan.references) {
      if (referenceAudioAsset(ref).provenance.outputTechnical.sizeBytes > route.maxBytesPerFile) plan.problems.push(`${ref.characterName}: audio exceeds the route's 15 MB file limit.`);
    }
    if (!input.imageCount) plan.problems.push("Voice references require character imagery on this route.");
    if (input.imageCount > route!.maxImages || plan.references.length > 3 || plan.references.length + input.imageCount > 12) plan.problems.push("The complete character reference set exceeds this route's shared input budget.");
    if (plan.references.reduce((n, r) => n + (referenceAudioAsset(r).provenance.outputTechnical.durationSec ?? Infinity), 0) > 15) plan.problems.push("Voice samples exceed the route's combined 15 second limit. Review shorter samples or explicitly disable references.");
  }
  return plan;
}

export function characterAudioInstructions(plan: CharacterAudioPlan): string {
  return plan.references.map(r => r.intent === "performance-sync"
    ? "master" in r ? `Use ${r.label} as the playback for ${r.characterName}. Synchronize visible performance to the supplied soundtrack; do not invent competing music or dialogue. External master audio remains final.` : `${r.characterName} performs the supplied ${r.label} audio. Synchronize visible speech and movement to that performance. The supplied external audio remains the final soundtrack.`
    : `${r.characterName} uses ${r.label} as voice guidance. Speak the scene's authored dialogue; do not repeat the audio reference's words.`).join("\n");
}

export function planSubjectCharacterAudio(input: { world: WorldBundle; subject: { productionId: string; sceneId: string;
  kind: string; shotId?: string; members?: readonly { shotId: string }[] }; model: ManifestModel;
  imageCount: number; taskMode?: string; disabled?: boolean }): CharacterAudioPlan {
  const production = input.world.productions.find(p => p.meta.id === input.subject.productionId);
  const scene = production?.scenes.find(s => s.id === input.subject.sceneId);
  if (!scene) return { version: 1, disabled: input.disabled === true, route: null, references: [], problems: ["The scene is no longer available."] };
  const ids = new Set(input.subject.shotId ? [input.subject.shotId] : input.subject.members?.map(m => m.shotId) ?? []);
  return planCharacterAudio({ ...input, requiredMasterShots: masterPerformanceShotIds(production), scene, shots: orderedShots(scene).filter(s => ids.has(s.id)), sheets: input.world.sheets, kits: input.world.referenceKits });
}
