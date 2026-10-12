import { z } from "zod";
import { effectCurveAt, EffectLineageIdSchema, type EffectClip } from "./editor-effects.js";
import { effectAuthoredValue } from "./editor-effect-setting.js";

const frame = z.number().int().nonnegative().safe();
const ruleId = z.string().regex(/^pr_[A-Za-z0-9][A-Za-z0-9_-]*$/);
export const EffectProtectedPropertySchema = z.enum([
  "target", "preset", "seed", "appearance.amount", "appearance.size", "appearance.opacity", "appearance.colour",
  "appearance.texture", "appearance.softness", "appearance.depth", "appearance.blendMode",
  "motion.airflow", "motion.particleDeflections", "motion.boundary",
  "motion.direction", "motion.speed", "motion.area", "fades.inFrames", "fades.outFrames", "intensityCurve",
  "audioInput", "reaction.enabled", "reaction.preset", "reaction.strength", "reaction.beat", "reaction.bass",
  "reaction.energy", "reaction.property", "reaction.limit", "reaction.smoothingFrames", "reactionCurve", "cueOverrides",
]);
export type EffectProtectedProperty = z.infer<typeof EffectProtectedPropertySchema>;
export const EffectProtectionPassageSchema = z.object({ kind: z.literal("passage"), startFrame: frame, endFrame: frame }).strict()
  .refine(value => value.endFrame > value.startFrame, "a protected passage must contain at least one frame");
const scope = z.union([z.object({ kind: z.literal("whole") }).strict(), EffectProtectionPassageSchema]);
const identity = { id: ruleId, lineageId: EffectLineageIdSchema };
const property = z.object({ ...identity, kind: z.literal("property"), property: EffectProtectedPropertySchema, scope }).strict();
const boundary = z.object({ ...identity, kind: z.literal("boundary"), boundary: z.enum(["start", "end"]) }).strict();
const coverage = z.object({ ...identity, kind: z.literal("passage-coverage"), startFrame: frame, endFrame: frame }).strict();

/** Boundary values and passage coverage are deliberately different command shapes (SPEC-053 R-22). */
export const EffectProtectionInputSchema = z.discriminatedUnion("kind", [property, boundary, coverage]).superRefine((rule, ctx) => {
  if (rule.kind === "passage-coverage" && rule.endFrame <= rule.startFrame) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a protected passage must contain at least one frame" });
});
export type EffectProtectionInput = z.infer<typeof EffectProtectionInputSchema>;
const baseline = { baselineRevision: frame, baselineFingerprint: z.string().min(1).max(4_000_000) };
export const EffectProtectionRuleSchema = z.discriminatedUnion("kind", [property.extend(baseline), boundary.extend(baseline), coverage.extend(baseline)]).superRefine((rule, ctx) => {
  if (rule.kind === "passage-coverage" && rule.endFrame <= rule.startFrame) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a protected passage must contain at least one frame" });
});
export type EffectProtectionRule = z.infer<typeof EffectProtectionRuleSchema>;

export interface EffectProtectionConflict {
  ruleId: string;
  lineageId: string;
  code: "rule-added" | "rule-removed" | "rule-changed" | "effect-removed" | "boundary-changed" | "coverage-changed" | "property-changed";
  message: string;
}

export class EffectProtectionRefused extends Error {
  constructor(readonly conflicts: readonly EffectProtectionConflict[]) {
    super(conflicts.map(conflict => conflict.message).join(" "));
    this.name = "EffectProtectionRefused";
  }
}

/** Canonical JSON is an exact fingerprint, without collisions or a browser-specific crypto port. */
function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function lineage(effects: readonly EffectClip[], id: string): EffectClip[] {
  return effects.filter(effect => effect.lineageId === id).sort((a, b) => a.startFrame - b.startFrame || a.id.localeCompare(b.id));
}
function end(effect: EffectClip): number { return effect.startFrame + effect.durationFrames; }
function bounds(effects: readonly EffectClip[]): { start: number; end: number } | null {
  if (!effects.length) return null;
  return { start: Math.min(...effects.map(effect => effect.startFrame)), end: Math.max(...effects.map(end)) };
}
function active(effects: readonly EffectClip[], at: number): EffectClip[] {
  return effects.filter(effect => at >= effect.startFrame && at < end(effect));
}
function clamp(value: number): number { return Math.min(1, Math.max(0, value)); }

/** Selected authored functions are compared, never the combined image or unprotected response. */
function propertyAt(effect: EffectClip, path: EffectProtectedProperty, at: number): unknown {
  switch (path) {
    case "intensityCurve": return effectCurveAt(effect.intensityCurve, at - effect.simulationOriginFrame);
    case "reactionCurve": return effectCurveAt(effect.reactionCurve, at - effect.simulationOriginFrame);
    case "fades.inFrames": return effect.fades.inFrames === 0 ? 1 : clamp((at - effect.fades.startFrame) / effect.fades.inFrames);
    case "fades.outFrames": return effect.fades.outFrames === 0 ? 1 : clamp((effect.fades.endFrame - at) / effect.fades.outFrames);
    case "cueOverrides": return effect.cueOverrides.filter(cue => at >= cue.frame && at < cue.frame + cue.durationFrames)
      .map(cue => ({ ...cue, frame: cue.frame - at })).sort((a, b) => a.id.localeCompare(b.id));
    default: {
      const value = effectAuthoredValue(effect, path);
      return path === "appearance.colour" && typeof value === "string" ? value.toLowerCase() : value;
    }
  }
}

function edges(effect: EffectClip, path?: EffectProtectedProperty): number[] {
  const values = [effect.startFrame, end(effect)];
  if (path === "intensityCurve" || path === "reactionCurve") values.push(...effect[path].points.map(point => effect.simulationOriginFrame + point.offsetFrames));
  if (path === "fades.inFrames") values.push(effect.fades.startFrame, effect.fades.startFrame + effect.fades.inFrames);
  if (path === "fades.outFrames") values.push(effect.fades.endFrame - effect.fades.outFrames, effect.fades.endFrame);
  if (path === "cueOverrides") for (const cue of effect.cueOverrides) values.push(cue.frame, cue.frame + cue.durationFrames);
  return values.filter(Number.isSafeInteger);
}

/**
 * Between the union of authored knots, supported curves are polynomials of degree at most
 * three. Four distinct production frames prove their equality there without walking a song.
 * Short intervals check every frame. Sampling only endpoints would miss a changed Smooth arc.
 */
function witnesses(from: number, to: number): number[] {
  const length = to - from;
  if (length <= 4) return Array.from({ length }, (_, index) => from + index);
  return [from, from + Math.floor((length - 1) / 3), from + Math.floor(2 * (length - 1) / 3), to - 1];
}
function sameValue(a: unknown, b: unknown): boolean {
  // Re-parameterising a mathematically identical linear segment can differ at floating epsilon.
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= 1e-12;
  return canonical(a) === canonical(b);
}
function sameAt(before: readonly EffectClip[], after: readonly EffectClip[], at: number, path?: EffectProtectedProperty): boolean {
  const old = active(before, at), next = active(after, at);
  if (old.length !== next.length) return false;
  if (path === undefined) return true;
  const oldValues = old.map(effect => propertyAt(effect, path, at));
  const nextValues = next.map(effect => propertyAt(effect, path, at));
  // A lineage should normally have one active segment. Compare multisets if old data overlaps,
  // so adding a duplicate segment cannot turn one protected contribution into two.
  const remaining = [...nextValues];
  for (const value of oldValues) {
    const index = remaining.findIndex(candidate => sameValue(value, candidate));
    if (index < 0) return false;
    remaining.splice(index, 1);
  }
  return true;
}
function samePassage(before: readonly EffectClip[], after: readonly EffectClip[], from: number, to: number, path?: EffectProtectedProperty): boolean {
  const knots = [...new Set([from, to, ...[...before, ...after].flatMap(effect => edges(effect, path)).filter(at => at > from && at < to)])].sort((a, b) => a - b);
  for (let index = 1; index < knots.length; index++) for (const at of witnesses(knots[index - 1]!, knots[index]!)) {
    if (!sameAt(before, after, at, path)) return false;
  }
  return true;
}

/** Whole-effect settings travel with a move; only an explicitly fixed passage owns absolute time. */
function sameWholeProperty(before: readonly EffectClip[], after: readonly EffectClip[], path: EffectProtectedProperty): boolean {
  // Cues remain on the selected sound's production clock when the effect itself moves.
  if (path === "cueOverrides") return canonical(cueRecords(before)) === canonical(cueRecords(after));
  const phaseStart = (effect: EffectClip) => effect.startFrame - effect.simulationOriginFrame;
  const phaseEnd = (effect: EffectClip) => end(effect) - effect.simulationOriginFrame;
  const old = [...before].sort((a, b) => phaseStart(a) - phaseStart(b));
  const referenceAt = (phase: number): EffectClip => old.find(effect => phase >= phaseStart(effect) && phase < phaseEnd(effect))
    ?? [...old].reverse().find(effect => phaseStart(effect) <= phase) ?? old[0]!;
  for (const effect of after) {
    const from = phaseStart(effect), to = phaseEnd(effect);
    const knots = [...new Set([from, to, ...old.flatMap(item => edges(item, path).map(at => at - item.simulationOriginFrame)),
      ...edges(effect, path).map(at => at - effect.simulationOriginFrame)].filter(at => at >= from && at <= to))].sort((a, b) => a - b);
    for (let index = 1; index < knots.length; index++) for (const phase of witnesses(knots[index - 1]!, knots[index]!)) {
      const reference = referenceAt(phase);
      if (path === "fades.inFrames" && (reference.fades.inFrames !== effect.fades.inFrames || (reference.fades.inFrames > 0 &&
        reference.fades.startFrame - reference.simulationOriginFrame !== effect.fades.startFrame - effect.simulationOriginFrame))) return false;
      if (path === "fades.outFrames" && (reference.fades.outFrames !== effect.fades.outFrames || (reference.fades.outFrames > 0 &&
        reference.fades.endFrame - reference.simulationOriginFrame !== effect.fades.endFrame - effect.simulationOriginFrame))) return false;
      if (!sameValue(propertyAt(reference, path, phase + reference.simulationOriginFrame), propertyAt(effect, path, phase + effect.simulationOriginFrame))) return false;
    }
  }
  return true;
}

function inputOf(rule: EffectProtectionRule): EffectProtectionInput {
  const { baselineRevision: _revision, baselineFingerprint: _fingerprint, ...input } = rule;
  return input;
}
function cueRecords(effects: readonly EffectClip[]): unknown[] {
  const records = new Map(effects.flatMap(effect => effect.cueOverrides).map(cue => [canonical(cue), cue]));
  return [...records.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
}
function segmentDescription(effect: EffectClip, path: EffectProtectedProperty, at: number): unknown {
  if (path === "intensityCurve" || path === "reactionCurve") {
    const points = effect[path].points, phase = at - effect.simulationOriginFrame;
    if (!points.length) return 1;
    if (phase < points[0]!.offsetFrames) return points[0]!.value;
    for (let index = 1; index < points.length; index++) {
      const left = points[index - 1]!, right = points[index]!;
      if (phase >= right.offsetFrames) continue;
      if (left.interpolation === "hold" || left.value === right.value) return left.value;
      return { interpolation: left.interpolation, from: left.offsetFrames + effect.simulationOriginFrame,
        to: right.offsetFrames + effect.simulationOriginFrame, left: left.value, right: right.value };
    }
    return points.at(-1)!.value;
  }
  if (path === "fades.inFrames" || path === "fades.outFrames") {
    const value = propertyAt(effect, path, at);
    const fade = effect.fades;
    if (path === "fades.inFrames" && fade.inFrames > 0 && at >= fade.startFrame && at < fade.startFrame + fade.inFrames)
      return { interpolation: "linear", from: fade.startFrame, to: fade.startFrame + fade.inFrames, left: 0, right: 1 };
    if (path === "fades.outFrames" && fade.outFrames > 0 && at >= fade.endFrame - fade.outFrames && at < fade.endFrame)
      return { interpolation: "linear", from: fade.endFrame - fade.outFrames, to: fade.endFrame, left: 1, right: 0 };
    return value;
  }
  if (path === "cueOverrides") return effect.cueOverrides.filter(cue => at >= cue.frame && at < cue.frame + cue.durationFrames)
    .map(cue => ({ ...cue })).sort((a, b) => a.id.localeCompare(b.id));
  return propertyAt(effect, path, at);
}
function fingerprint(input: EffectProtectionInput, effects: readonly EffectClip[]): string {
  const selected = lineage(effects, input.lineageId);
  if (input.kind === "boundary") return canonical({ rule: input, value: bounds(selected)?.[input.boundary] ?? null });
  if (input.kind === "property" && input.scope.kind === "whole") {
    if (input.property === "cueOverrides") return canonical({ rule: input, value: cueRecords(selected) });
    const descriptions = selected.map(effect => {
      let value: unknown;
      if (input.property === "intensityCurve" || input.property === "reactionCurve") value = effect[input.property].points.map(({ id: _id, ...point }) => point);
      else if (input.property === "fades.inFrames") value = { frames: effect.fades.inFrames, ...(effect.fades.inFrames > 0 ? { start: effect.fades.startFrame - effect.simulationOriginFrame } : {}) };
      else if (input.property === "fades.outFrames") value = { frames: effect.fades.outFrames, ...(effect.fades.outFrames > 0 ? { end: effect.fades.endFrame - effect.simulationOriginFrame } : {}) };
      else value = propertyAt(effect, input.property, effect.startFrame);
      return { from: effect.startFrame - effect.simulationOriginFrame, to: end(effect) - effect.simulationOriginFrame, value };
    });
    const unique = new Map(descriptions.map(record => [canonical(record.value), record.value]));
    // Splitting, trimming or moving a uniform setting does not change what its rule protects.
    // This also keeps a later explicit Release from going stale after unrelated Amount edits.
    if (unique.size === 1) return canonical({ rule: input, value: [...unique.values()][0] });
    const merged: typeof descriptions = [];
    for (const record of descriptions.sort((a, b) => a.from - b.from)) {
      const last = merged.at(-1);
      if (last && last.to === record.from && canonical(last.value) === canonical(record.value)) last.to = record.to;
      else merged.push({ ...record });
    }
    return canonical({ rule: input, records: merged });
  }
  const passage = input.kind === "passage-coverage" ? input : input.scope.kind === "passage" ? input.scope : null;
  if (passage === null) throw new Error("a protected passage is required");
  const records: Array<{ from: number; to: number; value?: unknown }> = [];
  for (const effect of selected) {
    const from = Math.max(effect.startFrame, passage.startFrame), to = Math.min(end(effect), passage.endFrame);
    if (to <= from) continue;
    const path = input.kind === "property" ? input.property : undefined;
    const knots = [...new Set([from, to, ...edges(effect, path).filter(at => at > from && at < to)])].sort((a, b) => a - b);
    for (let index = 1; index < knots.length; index++) {
      const a = knots[index - 1]!, b = knots[index]!;
      const value = path === undefined ? undefined : segmentDescription(effect, path, a);
      const last = records.at(-1);
      if (last && last.to === a && canonical(last.value) === canonical(value)) last.to = b;
      else records.push({ from: a, to: b, ...(value !== undefined ? { value } : {}) });
    }
  }
  return canonical({ rule: input, records });
}

export function captureEffectProtectionRule(input: EffectProtectionInput, effects: readonly EffectClip[], revision: number): EffectProtectionRule {
  const parsed = EffectProtectionInputSchema.parse(input);
  if (!effects.some(effect => effect.lineageId === parsed.lineageId)) throw new Error("that effect no longer exists");
  return EffectProtectionRuleSchema.parse({ ...parsed, baselineRevision: revision, baselineFingerprint: fingerprint(parsed, effects) });
}

/** Trusted compiler-only rebasing after a validated edit. Fixed passage bounds never move here. */
export function refreshEffectProtectionRules(effects: readonly EffectClip[], rules: readonly EffectProtectionRule[], revision: number,
  options: { retireLineages?: readonly string[] } = {}): EffectProtectionRule[] {
  const retired = new Set(options.retireLineages ?? []);
  return rules.filter(rule => !retired.has(rule.lineageId)).map(rule => {
    if (!effects.some(effect => effect.lineageId === rule.lineageId)) throw new Error("removing a protected effect requires an explicit human deletion");
    const captured = captureEffectProtectionRule(inputOf(rule), effects, revision);
    return captured.baselineFingerprint === rule.baselineFingerprint ? rule : captured;
  });
}

export function duplicateEffectProtectionRules(rules: readonly EffectProtectionRule[], fromLineage: string, toLineage: string,
  delta: number, effects: readonly EffectClip[], revision: number, mint: () => string): EffectProtectionRule[] {
  if (fromLineage === toLineage || !Number.isSafeInteger(delta)) throw new Error("a duplicate needs a new lineage and a whole-frame offset");
  return rules.filter(rule => rule.lineageId === fromLineage).map(rule => {
    let input: EffectProtectionInput = { ...inputOf(rule), id: mint(), lineageId: toLineage };
    if (input.kind === "passage-coverage") input = { ...input, startFrame: input.startFrame + delta, endFrame: input.endFrame + delta };
    if (input.kind === "property" && input.scope.kind === "passage") input = { ...input, scope: {
      kind: "passage", startFrame: input.scope.startFrame + delta, endFrame: input.scope.endFrame + delta,
    } };
    return captureEffectProtectionRule(input, effects, revision);
  });
}

/**
 * SPEC-053 R-26: this checks the authority's before/after records. A payload cannot declare its
 * own edit human, remove a rule, replace a lineage or overwrite the baseline it is checked against.
 * Callers supply all authored effect records. Track mute transitions are checked by the timeline
 * compiler separately, so a previously human-muted effect can retain and enforce its settings.
 */
export function checkEffectProtection(beforeEffects: readonly EffectClip[], afterEffects: readonly EffectClip[],
  beforeRules: readonly EffectProtectionRule[], afterRules: readonly EffectProtectionRule[] = beforeRules): EffectProtectionConflict[] {
  const conflicts: EffectProtectionConflict[] = [];
  const add = (rule: EffectProtectionRule, code: EffectProtectionConflict["code"], message: string) => conflicts.push({ ruleId: rule.id, lineageId: rule.lineageId, code, message });
  const nextRules = new Map(afterRules.map(rule => [rule.id, rule]));
  for (const rule of afterRules) if (!beforeRules.some(old => old.id === rule.id)) add(rule, "rule-added", `Protection ${rule.id} needs an explicit human action.`);
  for (const rule of beforeRules) {
    const next = nextRules.get(rule.id);
    if (next === undefined) add(rule, "rule-removed", `Protection ${rule.id} needs an explicit Release.`);
    else if (canonical(rule) !== canonical(next) || afterRules.filter(candidate => candidate.id === rule.id).length !== 1)
      add(rule, "rule-changed", `Protection ${rule.id} cannot be changed by a suggestion.`);
    const before = lineage(beforeEffects, rule.lineageId), after = lineage(afterEffects, rule.lineageId);
    if (!before.length || !after.length) {
      // A human can have left an uncovered fixed passage, but suppressing the whole surviving
      // lineage is still a deletion, not a way to satisfy an empty sampled range.
      if (before.length !== after.length || !after.length) add(rule, "effect-removed", `Protected effect ${rule.lineageId} cannot be removed or hidden.`);
      continue;
    }
    if (rule.kind === "boundary") {
      if (bounds(before)![rule.boundary] !== bounds(after)![rule.boundary]) add(rule, "boundary-changed", `Protected ${rule.boundary} value of ${rule.lineageId} would change.`);
    } else if (rule.kind === "passage-coverage") {
      if (!samePassage(before, after, rule.startFrame, rule.endFrame)) add(rule, "coverage-changed", `Protected coverage in ${rule.startFrame}–${rule.endFrame} would change.`);
    } else {
      const equal = rule.scope.kind === "whole" ? sameWholeProperty(before, after, rule.property)
        : samePassage(before, after, rule.scope.startFrame, rule.scope.endFrame, rule.property);
      if (!equal) add(rule, "property-changed", `Protected ${rule.property} of ${rule.lineageId} would change.`);
    }
  }
  return conflicts;
}

export function assertEffectProtection(beforeEffects: readonly EffectClip[], afterEffects: readonly EffectClip[],
  beforeRules: readonly EffectProtectionRule[], afterRules: readonly EffectProtectionRule[] = beforeRules): void {
  const conflicts = checkEffectProtection(beforeEffects, afterEffects, beforeRules, afterRules);
  if (conflicts.length) throw new EffectProtectionRefused(conflicts);
}
