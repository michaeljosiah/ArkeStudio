import { z } from "zod";
import { PictureBlendModeSchema, defaultEffectClip, type EffectClip } from "./editor-effects.js";
import { EffectProtectionPassageSchema, captureEffectProtectionRule, checkEffectProtection, type EffectProtectionRule } from "./editor-effect-protection.js";
import type { TimelineClip, TimelineTrack, ProductionTimeline } from "./timeline.js";

const clipId = z.string().regex(/^cl_[A-Za-z0-9][A-Za-z0-9_-]*$/), ruleId = z.string().regex(/^vp_[A-Za-z0-9][A-Za-z0-9_-]*$/);
export const PictureAppearancePropertySchema = z.enum(["blendMode", "opacity"]);
export const PictureAppearanceRuleSchema = z.object({ id: ruleId, property: PictureAppearancePropertySchema,
  scope: z.union([z.object({ kind: z.literal("whole") }).strict(), EffectProtectionPassageSchema]) }).strict();
export type PictureAppearanceRule = z.infer<typeof PictureAppearanceRuleSchema>;
export const PictureAppearanceSchema = z.object({ blendMode: PictureBlendModeSchema.optional(), opacity: z.number().finite().min(0).max(1).optional(),
  protection: z.array(PictureAppearanceRuleSchema).max(64).optional() }).strict();
export type PictureAppearance = z.infer<typeof PictureAppearanceSchema>;
export const PictureAppearancePatchSchema = PictureAppearanceSchema.omit({ protection: true }).refine(value => Object.keys(value).length > 0, "choose a picture appearance setting");
export const PictureAppearanceCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("picture-appearance"), clipId, patch: PictureAppearancePatchSchema }).strict(),
  z.object({ kind: z.literal("picture-protect"), clipId, rule: PictureAppearanceRuleSchema }).strict(),
  z.object({ kind: z.literal("picture-release"), ruleId }).strict(),
]);
export type PictureAppearanceCommand = z.infer<typeof PictureAppearanceCommandSchema>;
export const isPictureAppearanceCommand = (value: { kind: string }): value is PictureAppearanceCommand =>
  ["picture-appearance", "picture-protect", "picture-release"].includes(value.kind);
export const pictureAppearanceValue = (clip: TimelineClip, property: "blendMode" | "opacity") => property === "blendMode" ? clip.visual?.blendMode ?? "normal" : clip.visual?.opacity ?? 1;
export const pictureAppearanceOrigin = (clip: TimelineClip): TimelineClip["id"] => clip.visualOriginId ?? clip.id;

/** Generic chat history never acquires the authority to install or release picture rules. */
export function timelineCarriesPictureAppearance(timeline: ProductionTimeline): boolean {
  // Split identity alone carries no appearance or rule; ordinary chat Undo stays available.
  const carries = (clip: TimelineClip | null) => clip?.visual !== undefined;
  return timeline.tracks.some(track => track.clips.some(carries)) || [...timeline.history.undo, ...timeline.history.redo]
    .some(entry => entry.kind === "change" && entry.clips.some(change => carries(change.before) || carries(change.after)));
}

export function applyPictureAppearanceCommand(tracks: readonly TimelineTrack[], command: PictureAppearanceCommand, authority: "human" | "suggestion"): TimelineTrack[] {
  if (command.kind === "picture-release") {
    if (authority !== "human") throw new Error("Picture protection Release requires an explicit human action");
    if (!tracks.some(track => track.clips.some(clip => clip.visual?.protection?.some(rule => rule.id === command.ruleId)))) throw new Error("That picture protection is no longer present");
    return tracks.map(track => ({ ...track, clips: track.clips.map(clip => clip.visual?.protection?.some(rule => rule.id === command.ruleId)
      ? { ...clip, visual: { ...clip.visual, protection: clip.visual.protection.filter(rule => rule.id !== command.ruleId) } } : clip) }));
  }
  const track = tracks.find(row => row.clips.some(clip => clip.id === command.clipId)), clip = track?.clips.find(row => row.id === command.clipId);
  if (track?.kind !== "picture" || !clip) throw new Error("Choose an existing picture clip for appearance");
  if (command.kind === "picture-appearance") {
    // Keep Current must not materialize implicit defaults and create a spurious render layer.
    const patch = Object.fromEntries(Object.entries(command.patch).filter(([key, value]) => value !== pictureAppearanceValue(clip, key as "blendMode" | "opacity")));
    if (!Object.keys(patch).length) return [...tracks];
    return tracks.map(row => row.id !== track.id ? row : { ...row, clips: row.clips.map(value => value.id !== clip.id ? value :
      { ...value, visual: PictureAppearanceSchema.parse({ ...value.visual, ...patch }) }) });
  }
  if (authority !== "human") throw new Error("Picture protection requires an explicit human action");
  if (tracks.some(row => row.clips.some(value => value.visual?.protection?.some(rule => rule.id === command.rule.id)))) throw new Error("Picture protection already exists; Release the named rule before replacing it");
  const origin = pictureAppearanceOrigin(clip);
  return tracks.map(row => ({ ...row, clips: row.clips.map(value => row.kind !== "picture" || pictureAppearanceOrigin(value) !== origin ? value :
    { ...value, visualOriginId: origin, visual: { ...value.visual, protection: [...value.visual?.protection ?? [], command.rule] } }) }));
}

/** Reuse the proven passage/function comparator; these transient projections are never authored or rendered. */
function protectionProjection(tracks: readonly TimelineTrack[]): { values: EffectClip[]; rules: EffectProtectionRule[] } {
  const clips = tracks.filter(track => track.kind === "picture").flatMap(track => track.clips);
  const values = clips.map(clip => {
    const value = defaultEffectClip({ id: clip.id, lineageId: `ef_visual_${pictureAppearanceOrigin(clip).slice(3)}`, seed: 0, startFrame: clip.startFrame, durationFrames: clip.durationFrames });
    value.simulationOriginFrame = clip.startFrame - clip.sourceInFrames;
    value.appearance.opacity = clip.visual?.opacity ?? 1; value.appearance.blendMode = clip.visual?.blendMode ?? "normal";
    return value;
  });
  const inputs = new Map(clips.flatMap(clip => (clip.visual?.protection ?? []).map(rule => [rule.id, {
    id: `pr_visual_${rule.id.slice(3)}`, lineageId: `ef_visual_${pictureAppearanceOrigin(clip).slice(3)}`, kind: "property" as const,
    property: rule.property === "opacity" ? "appearance.opacity" as const : "appearance.blendMode" as const, scope: rule.scope,
  }] as const)));
  return { values, rules: [...inputs.values()].map(rule => captureEffectProtectionRule(rule, values, 0)) };
}

export function pictureAppearanceProtectionProblem(before: Pick<ProductionTimeline, "tracks">, after: Pick<ProductionTimeline, "tracks">): string | null {
  for (const track of before.tracks) if (track.clips.some(clip => clip.visual?.protection?.length)) {
    const next = after.tracks.find(row => row.id === track.id);
    if (next && next.muted !== track.muted) return "Track visibility cannot bypass protected picture appearance";
  }
  const old = protectionProjection(before.tracks), next = protectionProjection(after.tracks);
  // A suggestion may not rewrite the authority baseline. Compare creative state against the old rules.
  const rules = next.rules.map(rule => {
    const previous = old.rules.find(value => value.id === rule.id);
    return previous ? { ...rule, baselineRevision: previous.baselineRevision, baselineFingerprint: previous.baselineFingerprint } : rule;
  });
  const conflicts = checkEffectProtection(old.values, next.values, old.rules, rules);
  return conflicts.length ? conflicts.map(value => value.message.replaceAll("effect", "picture")).join("; ") : null;
}

/** A pending Release names the protected value/scope the person actually saw. */
export function pictureProtectionFingerprint(timeline: Pick<ProductionTimeline, "tracks">, ruleId: string): string | null {
  return protectionProjection(timeline.tracks).rules.find(rule => rule.id === `pr_visual_${ruleId.slice(3)}`)?.baselineFingerprint ?? null;
}

export function duplicatePictureAppearance(clip: TimelineClip, id: TimelineClip["id"], delta: number): Pick<TimelineClip, "visual" | "visualOriginId"> {
  if (!clip.visual) return clip.visualOriginId ? { visualOriginId: id } : {};
  return { visualOriginId: id, visual: { ...clip.visual, ...(clip.visual.protection ? { protection: clip.visual.protection.map((rule, index) => ({
    ...rule, id: `vp_${id.slice(3)}_${index}`, scope: rule.scope.kind === "whole" ? rule.scope : {
      ...rule.scope, startFrame: Math.max(0, rule.scope.startFrame + delta), endFrame: Math.max(1, rule.scope.endFrame + delta),
    },
  })) } : {}) } };
}

export function pictureAppearanceStructureProblem(tracks: readonly TimelineTrack[]): string | null {
  const owners = new Map<string, string>();
  for (const track of tracks) for (const clip of track.clips) {
    if ((clip.visual || clip.visualOriginId) && track.kind !== "picture") return "Picture appearance belongs only to picture clips";
    const ids = new Set<string>();
    for (const rule of clip.visual?.protection ?? []) {
      const signature = JSON.stringify([pictureAppearanceOrigin(clip), rule]);
      if (ids.has(rule.id) || owners.has(rule.id) && owners.get(rule.id) !== signature) return "Picture protection IDs must identify one rule and lineage";
      ids.add(rule.id); owners.set(rule.id, signature);
    }
  }
  return null;
}
