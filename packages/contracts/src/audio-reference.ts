import { AUDIO_TRACK_KINDS, basePictureTrack } from "./timeline.js";
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
import type { Sheet, VoiceAssignment } from "./world.js";
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
  singleSpeaker: z.literal(true), noMusic: z.literal(true),
  /** Absent only for a read asked for by a local route, where no bytes leave the machine (SPEC-028). */
  cloudBasis: z.enum(["self", "authorized", "licensed"]).optional(),
  /** Where the choice was made: per dispatch (the Bench), or once on the scene's cast (SPEC-044 R-26). */
  source: z.enum(["explicit", "scene-cast"]).optional(),
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
  warningCodes: z.array(z.string()), attestations: z.array(AudioAttestationSchema),
  /** Absent for a read resolved for a local route: no cloud-upload right was written, and a cloud route finds none. */
  acknowledgementId: z.string().min(1).optional(),
  source: z.enum(["explicit", "scene-cast"]).optional(),
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
  const source = timeline.tracks.flatMap(track => AUDIO_TRACK_KINDS.has(track.kind) ? track.clips : []).find(c => c.id === picture.performanceSourceClipId);
  if (!source || source.source.kind !== "artifact" || picture.startFrame < source.startFrame ||
    picture.startFrame + picture.durationFrames > source.startFrame + source.durationFrames) throw new Error("The selected master soundtrack no longer covers this shot.");
  const inSec = (source.sourceInFrames + picture.startFrame - source.startFrame) / timeline.frameRate;
  return MasterAudioBindingSchema.parse({ productionId: production.meta.id, shotId, timelineHash: state.hash,
    timelineRevision: timeline.revision, sourceClipId: source.id, artifactId: source.source.artifactId,
    range: { inSec, outSec: inSec + picture.durationFrames / timeline.frameRate } });
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
  const local = model.provider === "comfyui" && model.id === "comfyui-h3-reference-video";
  if (!(["generate", "keyframe-sequence"].includes(taskMode)) || (!local && (model.provider !== "fal" ||
    !["seedance-2.0", "seedance-2.0-fast"].includes(model.id)))) return null;
  return { endpoint: local ? model.id : model.id === "seedance-2.0-fast" ? "bytedance/seedance-2.0/fast/reference-to-video" : "bytedance/seedance-2.0/reference-to-video", field: local ? "ref_audios" : "audio_urls", maxFiles: 3,
    local, requiresImages: !local, supportsPerformanceSync: !local, maxFileDurationSec: local ? 5.2 : 15,
    maxBytesPerFile: 15_000_000, maxTotalDurationSec: 15, maxImages: 9, maxCombinedReferences: local ? 15 : 12,
    formats: ["audio/wav", "audio/mpeg"], incrementalInputMicroUsd: 0, providerDurationMode: "requested",
    effects: { wording: "prompt-guided", timing: "not-preserved", identity: "guidance", cadence: "guidance",
      lipSync: "generated", generatedAudio: true, suppliedAudioPreserved: false, separateAudioArtifact: false } } as const;
}

/** Who speaks in these shots, in coverage order: authored speaking roles, never incidental mentions. */
export function shotSpeakers(scene: SceneRecord, shots: readonly Shot[]): { speakers: string[]; problems: string[] } {
  const speakers: string[] = [], problems: string[] = [];
  const add = (speaker: string | undefined) => {
    if (!speaker) problems.push("Resolve the speaker for the covered dialogue before dispatch.");
    else if (!speakers.includes(speaker)) speakers.push(speaker);
  };
  for (const shot of shots) {
    const covered = shot.covers?.map(c => scene.script?.blocks.find(b => b.id === c.blockId));
    if (covered?.length) {
      for (const block of covered) {
        if (!block) problems.push("A covered script block is missing. Repair shot coverage before dispatch.");
        else if (block.kind === "dialogue") add(block.speaker);
      }
    } else if (shot.audio?.kind === "dialogue" || shot.audio?.kind === "vo") add(shot.audio.speaker);
  }
  return { speakers, problems };
}

export interface CastVoiceNotSent { sheetId: string; name: string; reason: string }

/**
 * The scene's cast as performance requests (SPEC-044 R-26): one voice reference per member whose
 * voice is a read. What a per-dispatch picker used to ask — the accept, the hash, the
 * attestations, the cloud basis — is read off the record and the review history, because the
 * read was chosen once and its Keep said those things. A member whose read cannot be asked for
 * is returned with one clause, never thrown; the plan card and the Bench both say it from here,
 * so the two cannot drift.
 */
/** The assignment a read was made with is the sheet's current one: provider, voice, model and the version it was assigned at. */
export function sameVoiceAssignment(current: VoiceAssignment | undefined, made: VoiceAssignment): boolean {
  return current !== undefined && current.provider === made.provider && current.voiceId === made.voiceId
    && current.model === made.model && current.assignedAtVersion === made.assignedAtVersion;
}
export function castVoiceRequests(sheets: readonly Sheet[], production: ProductionBundle, scene: SceneRecord, shotIds?: readonly string[], local = false):
  { requests: PerformanceAudioRequest[]; notSent: CastVoiceNotSent[] } {
  const requests: PerformanceAudioRequest[] = [], notSent: CastVoiceNotSent[] = [];
  // Asked for a subject narrower than the scene (a Bench shot or board; codex round 2), only the
  // members who speak in it are asked for: a read nobody there speaks is neither cleared nor
  // refused, and says nothing on the card.
  const asked = shotIds === undefined ? undefined : new Set(shotSpeakers(scene, orderedShots(scene).filter(s => shotIds.includes(s.id))).speakers);
  for (const [sheetId, member] of Object.entries(scene.cast ?? {})) {
    const voice = member.voice;
    if (voice?.kind !== "performance" || (asked !== undefined && !asked.has(sheetId))) continue;
    const name = sheets.find(s => s.id === sheetId)?.name ?? sheetId;
    const skip = (reason: string) => notSent.push({ sheetId, name, reason });
    const record = production.performances.find(p => p.id === voice.performanceId);
    if (!record || record.provenance.outputHash !== voice.hash) { skip("read missing"); continue; }
    const review = production.performanceReview.reviews.filter(r => r.performanceId === record.id).at(-1);
    if (review?.decision !== "accept") { skip("read not accepted"); continue; }
    // A read made with an earlier voice assignment is another voice's (codex round 4): the
    // resolver would refuse it at clearance, so it is said here, in the card's words.
    if (record.kind !== "scratch" && !sameVoiceAssignment(sheets.find(s => s.id === sheetId)?.voice, record.voiceAssignment)) { skip("voice changed"); continue; }
    const attested = new Set(record.attestations?.filter(a => a.audioHash === record.provenance.outputHash).map(a => a.kind));
    if (!attested.has("single-speaker") || !attested.has("no-music")) { skip("attest one speaker and no music"); continue; }
    // A read kept for local use only rides a local route, where no bytes leave the machine
    // (SPEC-028; codex round 3); a cloud route needs the basis it was kept under.
    if (!record.cloudBasis && !local) { skip("no permission to send it"); continue; }
    // Choosing the read is the acknowledgement of its QC report: the person kept it after hearing
    // it and made it the voice in the same press (R-15). A second sign-off on the same warnings,
    // asked at every dispatch, is what the per-dispatch picker was retired for.
    requests.push({ performanceId: record.id, hash: record.provenance.outputHash, acceptedReviewAt: review.ts, intent: "voice-reference",
      warningCodes: Object.values(record.provenance.qualityReport.checks).filter(c => c.outcome === "warning").map(c => c.code),
      singleSpeaker: true, noMusic: true, ...(record.cloudBasis === undefined ? {} : { cloudBasis: record.cloudBasis }), source: "scene-cast" });
  }
  return { requests, notSent };
}

/** Resolve authored speaking roles, never incidental mentions. Ordering follows reviewed script coverage. */
export function planCharacterAudio(input: { scene: SceneRecord; shots: readonly Shot[]; sheets: readonly Sheet[];
  kits: readonly ReferenceKit[]; model: ManifestModel; imageCount: number; taskMode?: string; disabled?: boolean; performanceReferences?: readonly FrozenPerformanceAudio[]; masterReferences?: readonly FrozenMasterAudio[] }): CharacterAudioPlan {
  const route = characterAudioRoute(input.model, input.taskMode);
  const plan: CharacterAudioPlan = { version: 1, disabled: input.disabled === true, route: route?.endpoint ?? null, references: [], problems: [] };
  if (plan.disabled || input.model.capability !== "video" || (!input.kits.some(k => k.designatedVoiceSample) && !input.performanceReferences?.length && !input.masterReferences?.length)) return plan;
  // A master slice rides when a caller supplies one; a cut clip that came from a read no longer
  // demands its slice (SPEC-044; codex round 1). The scene page sends none and offers no way to,
  // so the demand refused every dispatch of such a scene with nothing to press. The scene's cast
  // voice is what rides by default.
  const masters = (input.masterReferences ?? []).filter(ref => input.shots.some(shot => shot.id === ref.master.shotId));
  const spoken = shotSpeakers(input.scene, input.shots.filter(shot => !masters.some(ref => ref.master.shotId === shot.id)));
  const speakers = spoken.speakers;
  plan.problems.push(...spoken.problems);
  for (const ref of masters) {
    if (!route) plan.problems.push("This route cannot carry master performance playback.");
    plan.references.push({ ...ref, label: `@Audio${plan.references.length + 1}` });
  }
  // A read chosen on the scene's cast rides in every pass where its character speaks (SPEC-044
  // R-27); one chosen per dispatch stays bound to the shot it was recorded against.
  const explicit = (input.performanceReferences ?? []).filter(ref => ref.source === "scene-cast"
    ? speakers.includes(ref.sheetId)
    : input.shots.some(shot => shot.id === ref.performance.target.shotId));
  for (const ref of explicit) {
    // A route that takes no audio takes no read either: the scene's choice is said as not sent
    // (R-28, R-31) rather than refusing the pass; one chosen per dispatch keeps its refusal.
    if (!route && ref.source === "scene-cast") continue;
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
    if (!route.local && !sample.acknowledgementId) plan.problems.push(`${sheet.name}: the sample is local-only; authorize cloud reference reuse before dispatch.`);
    if (sample.provenance.outputTechnical.sizeBytes > route.maxBytesPerFile) plan.problems.push(`${sheet.name}: sample exceeds the route's 15 MB file limit.`);
    plan.references.push({ intent: "voice-reference", sheetId: id, characterName: sheet.name, label: `@Audio${plan.references.length + 1}`, sample });
  }
  if (new Set(plan.references.map(ref => ref.intent)).size > 1) plan.problems.push("A dispatch cannot mix voice guidance and performance synchronization. Disable assigned samples or use one intent throughout the pass.");
  if (plan.references.length && route) {
    if (!route.supportsPerformanceSync && plan.references.some(ref => ref.intent === "performance-sync")) plan.problems.push("This route provides voice guidance, not performance synchronization.");
    plan.effects = { ...route.effects, generatedAudio: plan.references[0]!.intent !== "performance-sync" };
    for (const ref of plan.references) {
      if (referenceAudioAsset(ref).provenance.outputTechnical.sizeBytes > route.maxBytesPerFile) plan.problems.push(`${ref.characterName}: audio exceeds the route's 15 MB file limit.`);
      if ((referenceAudioAsset(ref).provenance.outputTechnical.durationSec ?? Infinity) > route.maxFileDurationSec) plan.problems.push(`${ref.characterName}: audio exceeds the route's ${route.maxFileDurationSec} second file limit.`);
    }
    if (route.requiresImages && !input.imageCount) plan.problems.push("Voice references require character imagery on this route.");
    if (input.imageCount > route.maxImages || plan.references.length > route.maxFiles || plan.references.length + input.imageCount > route.maxCombinedReferences) plan.problems.push("The complete character reference set exceeds this route's shared input budget.");
    if (plan.references.reduce((n, r) => n + (referenceAudioAsset(r).provenance.outputTechnical.durationSec ?? Infinity), 0) > 15) plan.problems.push("Voice samples exceed the route's combined 15 second limit. Review shorter samples or explicitly disable references.");
  }
  return plan;
}

export function characterAudioInstructions(plan: CharacterAudioPlan): string {
  return plan.references.map(r => r.intent === "performance-sync"
    ? "master" in r ? `Use ${r.label} as the playback for ${r.characterName}. Synchronize visible performance to the supplied soundtrack; do not invent competing music or dialogue. External master audio remains final.` : `${r.characterName} performs the supplied ${r.label} audio. Synchronize visible speech and movement to that performance. The supplied external audio remains the final soundtrack.`
    : `${r.characterName} uses ${r.label} as voice guidance. Speak the scene's authored dialogue; do not repeat the audio reference's words.`).join("\n");
}

/**
 * The reads the scene's cast has chosen for the speakers in a subject (SPEC-044 R-29, R-31),
 * as the Bench names them beside the plan. The renderer cannot freeze a read — rights are
 * acknowledged on the coordinator — so a read that will be asked for is handed back as a
 * preview reference for the Bench's own plan, and one that will not carries the same clause the
 * plan card would.
 */
export interface CastVoiceLine { sheetId: string; name: string; line: string; reason?: string; preview?: FrozenPerformanceAudio }
export function castVoiceSummary(world: WorldBundle, subject: { productionId: string; sceneId: string; shotId?: string; members?: readonly { shotId: string }[] }): CastVoiceLine[] {
  const production = world.productions.find(p => p.meta.id === subject.productionId);
  const scene = production?.scenes.find(s => s.id === subject.sceneId);
  if (!production || !scene) return [];
  const shots = orderedShots(scene);
  const ids = new Set(subject.shotId ? [subject.shotId] : subject.members?.map(m => m.shotId) ?? shots.map(s => s.id));
  const speakers = shotSpeakers(scene, shots.filter(s => ids.has(s.id))).speakers;
  const { requests, notSent } = castVoiceRequests(world.sheets, production, scene);
  return Object.entries(scene.cast ?? {}).flatMap(([sheetId, member]): CastVoiceLine[] => {
    if (member.voice?.kind !== "performance" || !speakers.includes(sheetId)) return [];
    const name = world.sheets.find(s => s.id === sheetId)?.name ?? sheetId;
    const request = requests.find(r => production.performances.find(p => p.id === r.performanceId)?.target.speakerSheetId === sheetId);
    const record = request && production.performances.find(p => p.id === request.performanceId);
    if (!request || !record) return [{ sheetId, name, line: "read", reason: notSent.find(n => n.sheetId === sheetId)?.reason ?? "not cleared" }];
    const number = shots.find(s => s.id === record.target.shotId)?.number;
    return [{ sheetId, name, line: number === undefined ? "read" : `read · shot ${number}`, preview: { intent: "voice-reference", sheetId, characterName: name,
      label: "@Audio1", performance: record, acceptedReviewAt: request.acceptedReviewAt, warningCodes: request.warningCodes, attestations: [], acknowledgementId: "preview-only", source: "scene-cast" } }];
  });
}

export function planSubjectCharacterAudio(input: { world: WorldBundle; subject: { productionId: string; sceneId: string;
  kind: string; shotId?: string; members?: readonly { shotId: string }[] }; model: ManifestModel;
  imageCount: number; taskMode?: string; disabled?: boolean; performanceReferences?: readonly FrozenPerformanceAudio[] }): CharacterAudioPlan {
  const production = input.world.productions.find(p => p.meta.id === input.subject.productionId);
  const scene = production?.scenes.find(s => s.id === input.subject.sceneId);
  if (!scene) return { version: 1, disabled: input.disabled === true, route: null, references: [], problems: ["The scene is no longer available."] };
  const ids = new Set(input.subject.shotId ? [input.subject.shotId] : input.subject.members?.map(m => m.shotId) ?? []);
  return planCharacterAudio({ ...input, scene, shots: orderedShots(scene).filter(s => ids.has(s.id)), sheets: input.world.sheets, kits: input.world.referenceKits });
}
