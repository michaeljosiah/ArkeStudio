import { effectAnalysisCanonicalJson, effectPresetDefinition, EffectProtectedPropertySchema,
  type ConversationActionCard, type EffectAudioInput, type EffectClip, type EffectFinalDelta, type EffectHumanDecision,
  type EffectProposalFamilyView, type EffectProposalVersion, type EffectProtectionInput, type EffectStickyScope, type EffectTarget,
  type EffectVersionRef, type HumanDecisionCard, type ProductionTimeline } from "@arke-studio/contracts";
import { EFFECT_PROTECTION_LABELS, effectProtectionValue } from "../screens/editor-effect-protection.js";
import { effectTargetLabel } from "../screens/editor-effect-target.js";
import { formatTimecode } from "./timeline-drag.js";

export const effectProposalCardId = (ref: Pick<EffectVersionRef, "familyId" | "versionId">): string => `effects:${ref.familyId}:${ref.versionId}`;
export const sameEffectProposalVersion = (a: Pick<EffectVersionRef, "familyId" | "versionId" | "candidateHash"> | null | undefined,
  b: Pick<EffectVersionRef, "familyId" | "versionId" | "candidateHash">): boolean => !!a && a.familyId === b.familyId && a.versionId === b.versionId && a.candidateHash === b.candidateHash;
export const effectCardRef = (family: EffectProposalFamilyView, version: EffectProposalVersion): EffectVersionRef => ({
  familyId: family.id, versionId: version.id, candidateHash: version.candidateHash, decisionRevision: family.decisionRevision,
});
export function effectCardDecisions(family: EffectProposalFamilyView, version: EffectProposalVersion): EffectHumanDecision[] {
  const decisions = new Map(family.decisions.map(decision => [decision.id, decision]));
  return version.decisionIds.flatMap(id => { const decision = decisions.get(id); return decision ? [decision] : []; });
}

/** Preparation/failure stays visible until the corresponding native composite card exists. */
export function effectCompositeReplacesAction(action: Pick<ConversationActionCard, "actionKind" | "actionId" | "worldId" | "conversationId">, cards: readonly HumanDecisionCard[]): boolean {
  return action.actionKind === "world-chat-effect-proposal" && cards.some(card => card.actionId === action.actionId &&
    card.worldId === action.worldId && card.conversationId === action.conversationId && card.body.control.kind === "effect-proposal");
}

export function effectFrameLabel(frame: number, fps: number): string {
  return `${frame < 0 ? "−" : ""}${formatTimecode(Math.abs(frame) / fps, fps)}`;
}
export const effectRangeLabel = (start: number, end: number, fps: number): string => `${effectFrameLabel(start, fps)}–${effectFrameLabel(end, fps)}`;
export const effectName = (effect: EffectClip): string => effectPresetDefinition(effect.preset).label;

export function effectCardTargetLabel(target: EffectTarget, timeline: ProductionTimeline | null): string {
  if (timeline) return effectTargetLabel(target, timeline);
  return target.kind === "composition" ? "Whole composition" : target.kind === "picture-track" ? `Picture track · ${target.trackId} (Current unavailable)` : `Visual clip · ${target.clipId} (Current unavailable)`;
}

export function effectAudioInputLabel(input: EffectAudioInput, timeline: ProductionTimeline | null): string {
  if (input.kind === "composition-mix") return "Composition mix";
  if (input.kind === "audio-track") return `Audio track · ${timeline?.tracks.find(track => track.id === input.trackId)?.name ?? (timeline ? `Missing ${input.trackId}` : `${input.trackId} (Current unavailable)`)}`;
  const clip = timeline?.tracks.flatMap(track => track.clips).find(value => value.id === input.clipId);
  return `${input.kind === "video-sound" ? "Video sound" : "Audio clip"} · ${clip?.source.label ?? (timeline ? `Missing ${input.clipId}` : `${input.clipId} (Current unavailable)`)}`;
}

export function effectAudioLabel(effect: EffectClip, timeline: ProductionTimeline | null): string {
  const source = effect.audioInput ? effectAudioInputLabel(effect.audioInput, timeline) : "No audio source";
  return effect.reaction.enabled ? source : `Off${effect.audioInput ? ` · ${source} retained` : ""}`;
}

export function effectRuleLabel(rule: EffectProtectionInput, fps: number): string {
  if (rule.kind === "boundary") return `Exact ${rule.boundary === "start" ? "Start" : "End"} · outer boundary`;
  if (rule.kind === "passage-coverage") return `Passage coverage · ${effectRangeLabel(rule.startFrame, rule.endFrame, fps)}`;
  return `${EFFECT_PROTECTION_LABELS[rule.property]} · ${rule.scope.kind === "whole" ? "whole effect" : effectRangeLabel(rule.scope.startFrame, rule.scope.endFrame, fps)}`;
}

export function effectStickyLabel(scope: EffectStickyScope): string {
  if (scope.kind === "property") return EFFECT_PROTECTION_LABELS[scope.property];
  if (scope.kind === "point") return `${scope.curve === "intensityCurve" ? "Intensity" : "Reaction"} point · ${scope.fields.join(", ")}`;
  if (scope.kind === "cue") return `Cue · ${scope.fields.join(", ")}`;
  if (scope.kind === "placement") return scope.fields.map(field => ({ "outer-start": "Start", "outer-end": "End", "simulation-origin": "Motion phase", "fade-start": "Fade envelope Start", "fade-end": "Fade envelope End", order: "Stacking order" })[field]).join(", ");
  return scope.kind === "presence" ? "Effect presence" : "Whole effect";
}

export interface EffectPropertyDifference { key: string; label: string; before: string; after: string; keepScope?: EffectStickyScope }
const equal = (a: unknown, b: unknown) => effectAnalysisCanonicalJson(a ?? null) === effectAnalysisCanonicalJson(b ?? null);
const atPath = (effect: EffectClip, path: string): unknown => path.split(".").reduce<unknown>((value, key) => value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined, effect);

/** Field and point rows preserve exact identities; the UI pages them rather than truncating. */
export function effectPropertyDifferences(delta: Extract<EffectFinalDelta, { kind: "effect-result" }>, family: EffectProposalFamilyView,
  timeline: ProductionTimeline | null, fps: number): EffectPropertyDifference[] {
  const before = delta.before, after = delta.after, effect = after ?? before;
  if (!effect) return [];
  const rows: EffectPropertyDifference[] = [];
  const add = (key: string, label: string, left: unknown, right: unknown, format: (value: unknown) => string, keepScope?: EffectStickyScope) => {
    if (before && after && equal(left, right)) return;
    rows.push({ key, label, before: before && left !== undefined ? format(left) : "Not present", after: after && right !== undefined ? format(right) : "Not present",
      ...(before && keepScope ? { keepScope } : {}) });
  };
  for (const property of EffectProtectedPropertySchema.options) {
    if (["intensityCurve", "reactionCurve", "cueOverrides"].includes(property)) continue;
    const format = (value: unknown) => {
      const chosen = before && equal(value, atPath(before, property)) ? before : after ?? before!;
      if (property === "target") return effectCardTargetLabel(chosen.target, timeline);
      if (property === "preset") return `${effectName(chosen)} · v${chosen.preset.version}`;
      if (typeof value === "number") {
        const percentage = ["appearance.amount", "appearance.size", "appearance.opacity", "motion.speed", "reaction.strength", "reaction.beat", "reaction.bass", "reaction.energy", "reaction.limit"].includes(property);
        return percentage ? `${Number((value * 100).toPrecision(12))}%` : `${value}${property === "motion.direction" ? "°" : " frames"}`;
      }
      return effectProtectionValue(chosen, property, timeline ?? undefined);
    };
    add(property, EFFECT_PROTECTION_LABELS[property], before && atPath(before, property), after && atPath(after, property), format, { kind: "property", property });
  }
  const frame = (value: unknown) => effectFrameLabel(Number(value), fps);
  add("start", "Start", before?.startFrame, after?.startFrame, frame, { kind: "placement", fields: ["outer-start"] });
  add("end", "End", before ? before.startFrame + before.durationFrames : undefined, after ? after.startFrame + after.durationFrames : undefined, frame, { kind: "placement", fields: ["outer-end"] });
  add("simulationOriginFrame", "Motion phase origin", before?.simulationOriginFrame, after?.simulationOriginFrame, frame, { kind: "placement", fields: ["simulation-origin"] });
  add("fades.startFrame", "Fade envelope Start", before?.fades.startFrame, after?.fades.startFrame, frame, { kind: "placement", fields: ["fade-start"] });
  add("fades.endFrame", "Fade envelope End", before?.fades.endFrame, after?.fades.endFrame, frame, { kind: "placement", fields: ["fade-end"] });
  add("order", "Stacking order", before?.order, after?.order, String, { kind: "placement", fields: ["order"] });
  add("seed", "Variation seed", before?.seed, after?.seed, String);
  const originId = family.identities.origins.find(origin => origin.lineageId === effect.lineageId)?.originId;
  for (const curve of ["intensityCurve", "reactionCurve"] as const) {
    const oldPoints = before?.[curve].points ?? [], newPoints = after?.[curve].points ?? [];
    if (!equal(oldPoints, newPoints) || !before || !after) rows.push({ key: curve, label: curve === "intensityCurve" ? "Intensity curve" : "Reaction curve",
      before: before ? oldPoints.length ? `${oldPoints.length} points; exact values below` : "Constant 100%" : "Not present",
      after: after ? newPoints.length ? `${newPoints.length} points; exact values below` : "Constant 100%" : "Not present",
      ...(before ? { keepScope: { kind: "property" as const, property: curve } } : {}) });
    for (const id of new Set([...oldPoints, ...newPoints].map(point => point.id))) {
      const oldPoint = oldPoints.find(point => point.id === id), newPoint = newPoints.find(point => point.id === id);
      const identity = family.identities.points.find(point => point.originId === originId && point.authoredId === id && point.kind === (curve === "intensityCurve" ? "intensity-point" : "reaction-point"));
      const fields: Extract<EffectStickyScope, { kind: "point" }>["fields"] = !oldPoint || !newPoint ? ["presence", "offsetFrames", "value", "interpolation"]
        : (["offsetFrames", "value", "interpolation"] as const).filter(key => oldPoint[key] !== newPoint[key]);
      if (!fields.length) continue;
      const describe = (value: unknown) => { const point = value as NonNullable<typeof oldPoint>;
        return `${point.offsetFrames} frames from phase origin · ${Math.round(point.value * 10000) / 100}% · ${point.interpolation}`; };
      add(`${curve}:${id}`, `${curve === "intensityCurve" ? "Intensity" : "Reaction"} point ${id}`, oldPoint, newPoint, describe,
        identity ? { kind: "point", curve, entityId: identity.entityId, fields } : undefined);
    }
  }
  for (const id of new Set([...(before?.cueOverrides ?? []), ...(after?.cueOverrides ?? [])].map(cue => cue.id))) {
    const oldCue = before?.cueOverrides.find(cue => cue.id === id), newCue = after?.cueOverrides.find(cue => cue.id === id);
    const identity = family.identities.points.find(point => point.originId === originId && point.authoredId === id && point.kind === "cue");
    const fields: Extract<EffectStickyScope, { kind: "cue" }>["fields"] = !oldCue || !newCue ? ["presence", "frame", "strength", "durationFrames", "kind"]
      : (["frame", "strength", "durationFrames", "kind"] as const).filter(key => oldCue[key] !== newCue[key]);
    if (!fields.length) continue;
    const describe = (value: unknown) => { const cue = value as NonNullable<typeof oldCue>;
      return `${cue.kind} at ${effectFrameLabel(cue.frame, fps)} · ${Math.round(cue.strength * 10000) / 100}% · ${cue.durationFrames} frames`; };
    add(`cue:${id}`, `Cue ${id}`, oldCue, newCue, describe, identity ? { kind: "cue", entityId: identity.entityId, fields } : undefined);
  }
  return rows;
}

export function effectCardStatus(family: EffectProposalFamilyView, version: EffectProposalVersion, active: boolean): string {
  if (family.status === "discarded") return "Discarded";
  if (family.receipt) return family.receipt.versionId === version.id ? family.receipt.undoneAt ? "Applied · undone in Current" : "Applied" : "Earlier version · arrangement applied";
  if (version.conflicts.length) return "Needs your decision";
  if (version.decisionRevision !== family.decisionRevision) return "Earlier human decisions · inspection only";
  if (version.dependencies.issues.length || version.dependencies.reactions.some(row => row.status !== "off" && row.status !== "ready")) return "Preview not ready";
  if (!version.delta.length) return "No changes to apply";
  return active ? "Reviewing this version" : "Ready · not previewing";
}
