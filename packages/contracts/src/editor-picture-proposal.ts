import { z } from "zod";
import { ConversationActionIdSchema, ConversationIdSchema, SlugSchema, UlidSchema } from "./ids.js";
import { PictureAppearanceSchema, PictureAppearanceCommandSchema, pictureAppearanceValue, pictureProtectionFingerprint, type PictureAppearanceCommand } from "./editor-picture-appearance.js";
import { TimelineClipIdSchema, compileTrustedTimelineSteps, type ProductionTimeline, type TrustedTimelineCompileOptions } from "./timeline.js";
import { EffectProposalDependenciesSchema } from "./editor-effect-proposal.js";
import { effectAnalysisCanonicalJson as canonical } from "./editor-effect-analysis.js";

const id = z.string().min(1).max(128), hash = z.string().min(1).max(128);
export const PictureAppearanceStateSchema = z.object({ clipId: TimelineClipIdSchema, visual: PictureAppearanceSchema.optional(), visualOriginId: TimelineClipIdSchema.optional() }).strict();
export type PictureAppearanceState = z.infer<typeof PictureAppearanceStateSchema>;
export function pictureAppearanceState(timeline: Pick<ProductionTimeline, "tracks">): PictureAppearanceState[] {
  return timeline.tracks.filter(track => track.kind === "picture").flatMap(track => track.clips.map(clip => ({ clipId: clip.id, visual: clip.visual, visualOriginId: clip.visualOriginId })));
}
export function withPictureAppearance(timeline: ProductionTimeline, pictures: readonly PictureAppearanceState[]): ProductionTimeline {
  return { ...timeline, tracks: timeline.tracks.map(track => ({ ...track, clips: track.clips.map(clip => {
    const value = pictures.find(row => row.clipId === clip.id); return value ? { ...clip, visual: value.visual, visualOriginId: value.visualOriginId } : clip;
  }) })) };
}
export const ModelPictureProposalSchema = z.object({ summary: z.string().min(1).max(500),
  commands: z.array(PictureAppearanceCommandSchema.options[0]).min(1).max(50),
  family: z.object({ id, parentVersionId: id, candidateHash: hash }).strict().optional() }).strict();
export type ModelPictureProposal = z.infer<typeof ModelPictureProposalSchema>;
export const PictureVersionRefSchema = z.object({ familyId: id, versionId: id, candidateHash: hash }).strict();
export type PictureVersionRef = z.infer<typeof PictureVersionRefSchema>;
export const PictureStickySchema = z.object({ key: id, commands: z.array(PictureAppearanceCommandSchema).max(4), baseline: PictureAppearanceStateSchema.optional(), releaseBaseline: z.string().max(4_000_000).nullable().optional() }).strict();
export type PictureSticky = z.infer<typeof PictureStickySchema>;
export const PictureProposalVersionSchema = z.object({ id, number: z.number().int().min(1), parentVersionId: id.optional(), actionId: ConversationActionIdSchema.optional(),
  origin: z.enum(["model", "adjustment", "release", "update", "history"]), summary: z.string().min(1).max(500), createdAt: z.string(),
  baseRevision: z.number().int().nonnegative(), baseHash: hash, candidateHash: hash, model: ModelPictureProposalSchema, sticky: z.array(PictureStickySchema).max(200),
  before: z.array(PictureAppearanceStateSchema).max(4000), pictures: z.array(PictureAppearanceStateSchema).max(4000),
  conflicts: z.array(z.string().max(500)).max(100), notes: z.array(z.string().max(500)).max(100), dependencies: EffectProposalDependenciesSchema,
}).strict();
export type PictureProposalVersion = z.infer<typeof PictureProposalVersionSchema>;
export const PictureProposalFamilySchema = z.object({ id, productionId: SlugSchema, conversationId: ConversationIdSchema, status: z.enum(["pending", "applied", "discarded"]),
  versions: z.array(PictureProposalVersionSchema).min(1).max(100), headVersionId: id, undo: z.array(id).max(100), redo: z.array(id).max(100),
  grants: z.array(z.object({ id, versionId: id, candidateHash: hash }).strict()).max(100),
  receipt: z.object({ versionId: id, candidateHash: hash, resultRevision: z.number().int(), historyEntryDigest: hash, appliedAt: z.string(), undoneAt: z.string().optional() }).strict().optional(),
}).strict();
export type PictureProposalFamily = z.infer<typeof PictureProposalFamilySchema>;
export const pictureVersionRef = (familyId: string, version: PictureProposalVersion): PictureVersionRef => ({ familyId, versionId: version.id, candidateHash: version.candidateHash });
export function pictureAppearanceDelta(before: readonly PictureAppearanceState[], after: readonly PictureAppearanceState[]) {
  return [...new Set([...before, ...after].map(value => value.clipId))].flatMap(clipId => {
    const left = before.find(value => value.clipId === clipId), right = after.find(value => value.clipId === clipId);
    return canonical(left) === canonical(right) ? [] : [{ clipId, before: left, after: right }];
  });
}
export function pictureStickyEdits(commands: readonly PictureAppearanceCommand[], sticky: readonly PictureSticky[], candidate: readonly PictureAppearanceState[], current?: ProductionTimeline): PictureSticky[] {
  let next = [...sticky];
  for (const command of commands) {
    if (command.kind === "picture-release" && !candidate.some(row => row.visual?.protection?.some(rule => rule.id === command.ruleId))) throw new Error("The named picture protection is no longer present");
    if (command.kind === "picture-protect" && !candidate.some(row => row.clipId === command.clipId)) throw new Error("The picture clip is no longer present");
    if (command.kind === "picture-appearance") {
      for (const property of Object.keys(command.patch) as Array<keyof typeof command.patch>) {
        const key = `${command.clipId}/${property}`;
        next = [...next.filter(row => row.key !== key), { key, commands: [{ ...command, patch: { [property]: command.patch[property] } }] }];
      }
    } else {
      const key = command.kind === "picture-release" ? command.ruleId : command.rule.id;
      next = [...next.filter(row => row.key !== key), { key, commands: [command], ...(command.kind === "picture-protect" ? { baseline: candidate.find(row => row.clipId === command.clipId) }
        : { releaseBaseline: current ? pictureProtectionFingerprint(current, command.ruleId) : null }) }];
    }
  }
  return next;
}
/** Only human commands can install/release rules; model fields are individually admitted. */
export function compilePictureProposal(base: ProductionTimeline, model: ModelPictureProposal, sticky: readonly PictureSticky[], options: TrustedTimelineCompileOptions) {
  const notes: string[] = [], conflicts: string[] = [];
  const human: PictureAppearanceCommand[] = [];
  for (const row of sticky) for (const command of row.commands) if (command.kind === "picture-release" && row.releaseBaseline !== pictureProtectionFingerprint(base, command.ruleId)) {
    return { reduction: null, candidate: base, notes, conflicts: ["The protected picture setting changed after Release. Review this version and explicitly release the named rule again."] };
  }
  for (const row of sticky) for (const command of row.commands) if (command.kind === "picture-release" && base.tracks.some(track => track.clips.some(clip => clip.visual?.protection?.some(rule => rule.id === command.ruleId)))) human.push(command);
  for (const row of sticky) if (row.baseline) for (const command of row.commands) if (command.kind === "picture-protect") {
    const value = row.baseline.visual?.[command.rule.property] ?? (command.rule.property === "opacity" ? 1 : "normal");
    human.push({ kind: "picture-appearance", clipId: command.clipId, patch: { [command.rule.property]: value } });
  }
  human.push(...sticky.flatMap(row => row.commands.filter(command => command.kind === "picture-appearance")));
  human.push(...sticky.flatMap(row => row.commands.filter(command => command.kind === "picture-protect" && !base.tracks.some(track => track.clips.some(clip => clip.visual?.protection?.some(rule => rule.id === command.rule.id))))));
  const steps: Array<Parameters<typeof compileTrustedTimelineSteps>[1][number]> = [{ id: "picture-human", authority: "human", commands: human }];
  try {
    let reduction = compileTrustedTimelineSteps(base, steps, options);
    for (const command of model.commands) for (const property of Object.keys(command.patch) as Array<keyof typeof command.patch>) {
      if (sticky.some(row => row.key === `${command.clipId}/${property}`)) { notes.push(`${command.clipId} ${property}: adjusted by you, retained`); continue; }
      const step = { id: `picture-model-${steps.length}`, authority: "suggestion" as const, commands: [{ ...command, patch: { [property]: command.patch[property] } }] };
      try { const next = compileTrustedTimelineSteps(base, [...steps, step], options); reduction = next; steps.push(step); }
      catch (error) {
        const reason = error instanceof Error ? error.message : "Invalid picture setting";
        if (/protect/i.test(reason)) notes.push(`${command.clipId} ${property}: protected setting kept`); else throw error;
      }
    }
    return { reduction, candidate: reduction.timeline, notes: [...new Set(notes)].slice(0, 100), conflicts };
  } catch (error) { conflicts.push(error instanceof Error ? error.message.slice(0, 500) : "Picture appearance is invalid"); return { reduction: null, candidate: base, notes, conflicts }; }
}
export function keepPictureAppearance(base: ProductionTimeline, clipId: string, sticky: readonly PictureSticky[]): PictureSticky[] {
  const clip = base.tracks.flatMap(track => track.clips).find(row => row.id === clipId);
  if (!clip) throw new Error("The picture clip is no longer present");
  return pictureStickyEdits([{ kind: "picture-appearance", clipId: clip.id, patch: { blendMode: pictureAppearanceValue(clip, "blendMode") as "normal" | "screen" | "add", opacity: pictureAppearanceValue(clip, "opacity") as number } }], sticky, []);
}
export const PictureReviewOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("review"), ref: PictureVersionRefSchema }).strict(),
  z.object({ kind: z.literal("edit"), ref: PictureVersionRefSchema, commands: z.array(PictureAppearanceCommandSchema).min(1).max(50) }).strict(),
  z.object({ kind: z.literal("keep"), ref: PictureVersionRefSchema, clipId: TimelineClipIdSchema }).strict(),
  z.object({ kind: z.literal("history"), ref: PictureVersionRefSchema, direction: z.enum(["undo", "redo"]) }).strict(),
  z.object({ kind: z.literal("update"), ref: PictureVersionRefSchema }).strict(),
  z.object({ kind: z.literal("discard"), ref: PictureVersionRefSchema }).strict(),
  z.object({ kind: z.literal("apply"), ref: PictureVersionRefSchema, reviewId: id }).strict(),
]);
export const PictureReviewCommandSchema = z.object({ kind: z.literal("editor-picture-proposal"), worldId: UlidSchema, productionId: SlugSchema, requestId: id, operation: PictureReviewOperationSchema }).strict();
export type PictureReviewCommand = z.infer<typeof PictureReviewCommandSchema>;
export type PictureReviewOperation = z.infer<typeof PictureReviewOperationSchema>;
export const PictureReviewResultSchema = z.object({ type: z.literal("editor-picture.proposal-result"), at: z.string(), worldId: UlidSchema, productionId: SlugSchema,
  requestId: id, outcome: z.enum(["reviewed", "updated", "applied", "discarded", "refused"]), ref: PictureVersionRefSchema, reviewId: id.optional(), reason: z.string().max(1000).optional() }).strict();
export type PictureReviewResult = z.infer<typeof PictureReviewResultSchema>;
