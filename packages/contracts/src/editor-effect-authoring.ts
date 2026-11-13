import { EffectCueOverridesSchema, type EffectClip, type EffectCue } from "./editor-effects.js";
import { effectReactionPresetPatch } from "./editor-effect-reaction.js";
import type { EffectProtectionRule } from "./editor-effect-protection.js";
import { EFFECT_ANALYSIS_PROFILE, type EffectFeatureManifest } from "./editor-effect-analysis.js";

/** A multi-field preset never silently overwrites an independently protected mapping. */
export function effectResponsePresetConflicts(effect: EffectClip, rules: readonly EffectProtectionRule[],
  preset: Exclude<EffectClip["reaction"]["preset"], "custom">): string[] {
  const patch = effectReactionPresetPatch(preset);
  return [...new Set(rules.flatMap(rule => {
    if (rule.lineageId !== effect.lineageId || rule.kind !== "property" || !rule.property.startsWith("reaction.")) return [];
    const key = rule.property.slice(9) as keyof typeof patch;
    return key in patch && patch[key] !== effect.reaction[key] ? [rule.property] : [];
  }))];
}

/** Likely beats are derived; correction records suppress the original pulse and add an accent. */
export function correctEffectLikelyBeat(effect: EffectClip, beat: { frame: number; strength: number }, frameRate: number,
  moveToFrame: number | null, mint: () => string): EffectCue[] {
  const durationFrames = Math.max(1, Math.min(300, Math.ceil(EFFECT_ANALYSIS_PROFILE.beatPulseMs * frameRate / 1000)));
  const cues: EffectCue[] = [...effect.cueOverrides, { id: mint(), kind: "suppress", frame: beat.frame, strength: 1, durationFrames }];
  if (moveToFrame !== null) cues.push({ id: mint(), kind: "accent", frame: moveToFrame, strength: beat.strength, durationFrames });
  return EffectCueOverridesSchema.parse(cues);
}

export function remainingEffectLikelyBeats(effect: EffectClip, manifest: EffectFeatureManifest): EffectFeatureManifest["likelyBeats"] {
  const suppressed = effect.cueOverrides.filter(cue => cue.kind === "suppress").sort((a, b) => a.frame - b.frame);
  let index = 0, through = -1;
  return manifest.likelyBeats.filter(beat => {
    while (index < suppressed.length && suppressed[index]!.frame <= beat.frame) {
      const cue = suppressed[index++]!; through = Math.max(through, cue.frame + cue.durationFrames);
    }
    return beat.frame >= through;
  });
}

/** Fixed passages stay on the production clock when a person edits/moves a protected effect. */
export function uncoveredEffectPassages(effects: readonly EffectClip[], lineageId: string, startFrame: number, endFrame: number): Array<{ startFrame: number; endFrame: number }> {
  const holes: Array<{ startFrame: number; endFrame: number }> = [];
  let cursor = startFrame;
  for (const effect of effects.filter(value => value.lineageId === lineageId).sort((a, b) => a.startFrame - b.startFrame)) {
    if (effect.startFrame >= endFrame) break;
    if (effect.startFrame > cursor) holes.push({ startFrame: cursor, endFrame: Math.min(effect.startFrame, endFrame) });
    cursor = Math.max(cursor, effect.startFrame + effect.durationFrames);
  }
  if (cursor < endFrame) holes.push({ startFrame: cursor, endFrame });
  return holes;
}
