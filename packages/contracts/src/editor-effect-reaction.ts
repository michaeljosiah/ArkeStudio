import { effectCurveAt, type EffectClip, type EffectReaction } from "./editor-effects.js";
import { EFFECT_ANALYSIS_PROFILE, effectAnalysisCanonicalJson, type EffectCueConflict, type EffectFeatureManifest } from "./editor-effect-analysis.js";
import { effectPresetDefinition } from "./editor-effect-catalogue.js";

type SimpleResponse = Exclude<EffectReaction["preset"], "custom">;
type Mapping = Pick<EffectReaction, "preset" | "version" | "beat" | "bass" | "energy" | "property" | "limit" | "smoothingFrames">;
/** Strength and On/Off are independent controls; selecting a mapping never overwrites them. */
export const EFFECT_RESPONSE_PRESETS: Readonly<Record<SimpleResponse, Readonly<Mapping>>> = Object.freeze({
  "gentle-shimmer": Object.freeze({ preset: "gentle-shimmer", version: 1, beat: 0, bass: 0, energy: 0.3, property: "brightness", limit: 0.3, smoothingFrames: 10 }),
  "beat-pulse": Object.freeze({ preset: "beat-pulse", version: 1, beat: 1, bass: 0, energy: 0, property: "emission", limit: 0.6, smoothingFrames: 2 }),
  "build-with-energy": Object.freeze({ preset: "build-with-energy", version: 1, beat: 0, bass: 0, energy: 1, property: "emission", limit: 0.5, smoothingFrames: 12 }),
});
export function effectReactionPresetPatch(preset: SimpleResponse): Mapping { return { ...EFFECT_RESPONSE_PRESETS[preset] }; }

export interface PreparedEffectReaction {
  effectId: string;
  manifestKey: string;
  sourceFingerprint: string;
  mappingFingerprint: string;
  frameRate: number;
  /** The intended render window; preparation also includes finite particle/smoothing lookback. */
  evaluationStartFrame: number;
  evaluationEndFrame: number;
  startFrame: number;
  values: Float64Array;
  /** Prefix sum of added speed in 1e-8 units; integer sums preserve scoped/split identity. */
  speedIntegral: Float64Array;
  cueConflicts: EffectCueConflict[];
}
export type PreparedEffectReactions = Readonly<Record<string, PreparedEffectReaction>>;
export function effectReactionFingerprintMaterial(effect: EffectClip, manifestKey: string): string {
  return effectAnalysisCanonicalJson({ manifestKey, reaction: effect.reaction, cues: effect.cueOverrides, curve: effect.reactionCurve,
    origin: effect.simulationOriginFrame, baseSpeed: effect.motion.speed });
}

/** Cue positions remain authored even when a new physical source window can no longer hold them. */
export function effectCueConflicts(effect: EffectClip, manifest: EffectFeatureManifest): EffectCueConflict[] {
  if (effect.cueOverrides.length === 0) return [];
  const windows: Array<{ startSec: number; endSec: number }> = [];
  for (const window of [...manifest.descriptor.placedWindows].sort((a, b) => a.startSec - b.startSec)) {
    const previous = windows.at(-1);
    if (previous && previous.endSec + 1e-9 >= window.startSec) previous.endSec = Math.max(previous.endSec, window.endSec);
    else windows.push({ ...window });
  }
  const fps = manifest.descriptor.frameRate;
  return effect.cueOverrides.flatMap(cue => {
    const start = cue.frame / fps, end = (cue.frame + cue.durationFrames) / fps;
    let low = 0, high = windows.length;
    while (low < high) { const middle = (low + high) >>> 1; if (windows[middle]!.startSec <= start + 1e-9) low = middle + 1; else high = middle; }
    if (low > 0 && windows[low - 1]!.endSec + 1e-9 >= end) return [];
    return [{ cueId: cue.id, frame: cue.frame, kind: "outside-source-window" as const, reason: "The authored cue extends outside this source's placed sound window. Move or remove it explicitly." }];
  });
}

/**
 * Preparation is bounded by frames + cue pulse lengths, never particles × cues × smoothing.
 * All evaluated values use the production clock; a scoped export does not rebase automation.
 */
export function prepareEffectReaction(effect: EffectClip, manifest: EffectFeatureManifest,
  range: { startFrame: number; endFrame: number } = manifest.features): PreparedEffectReaction {
  const features = manifest.features, fps = manifest.descriptor.frameRate;
  if (manifest.profileId !== EFFECT_ANALYSIS_PROFILE.id || features.beat.length !== features.endFrame - features.startFrame || features.bass.length !== features.beat.length || features.energy.length !== features.beat.length || features.beat.length > EFFECT_ANALYSIS_PROFILE.maxFrames) throw new RangeError("Reaction needs a supported complete feature manifest");
  if (!Number.isSafeInteger(range.startFrame) || !Number.isSafeInteger(range.endFrame) || range.startFrame < 0 || range.endFrame < range.startFrame) throw new RangeError("Reaction preparation needs whole production-frame bounds");
  if (effect.audioInput === undefined || effectAnalysisCanonicalJson(effect.audioInput) !== effectAnalysisCanonicalJson(manifest.descriptor.binding)) throw new RangeError("Reaction manifest belongs to a different audio binding");
  const evaluationStartFrame = Math.max(range.startFrame, effect.startFrame), evaluationEndFrame = Math.min(range.endFrame, effect.startFrame + effect.durationFrames);
  const smoothing = Math.max(1, effect.reaction.smoothingFrames);
  const startFrame = Math.max(features.startFrame, evaluationStartFrame - Math.ceil(effectPresetDefinition(effect.preset).maximumLifetimeSec * fps) - smoothing);
  const endFrame = Math.max(startFrame, Math.min(features.endFrame, evaluationEndFrame));
  const length = evaluationEndFrame > evaluationStartFrame ? endFrame - startFrame : 0;
  if (length > EFFECT_ANALYSIS_PROFILE.maxPreparedFrames) throw new RangeError("Prepared reaction exceeds its frame budget");
  const values = new Float64Array(length), speedIntegral = new Float64Array(length + 1);
  const prepared: PreparedEffectReaction = { effectId: effect.id, manifestKey: manifest.manifestKey, sourceFingerprint: manifest.sourceFingerprint,
    mappingFingerprint: effectReactionFingerprintMaterial(effect, manifest.manifestKey), frameRate: fps, evaluationStartFrame, evaluationEndFrame,
    startFrame, values, speedIntegral, cueConflicts: effectCueConflicts(effect, manifest) };
  if (!length || !effect.reaction.enabled || effect.reaction.strength === 0 || effect.reaction.limit === 0 || effect.reaction.beat + effect.reaction.bass + effect.reaction.energy === 0) return prepared;
  const suppressed = new Int32Array(length + 1), accents = new Float64Array(length), weightedPrefix = new Float64Array(length + 1);
  for (const cue of effect.cueOverrides) {
    const from = Math.max(0, cue.frame - startFrame), to = Math.min(length, cue.frame + cue.durationFrames - startFrame);
    if (to <= from) continue;
    if (cue.kind === "suppress") { suppressed[from]!++; suppressed[to]!--; }
    else for (let index = from; index < to; index++) accents[index] = Math.max(accents[index]!, cue.strength * (1 - (startFrame + index - cue.frame) / cue.durationFrames));
  }
  let depth = 0;
  const windows = [...manifest.descriptor.audibleWindows].sort((a, b) => a.startSec - b.startSec);
  let windowIndex = 0;
  for (let index = 0; index < length; index++) {
    const at = startFrame + index - features.startFrame;
    const energy = features.energy[at]!, bass = features.bass[at]!, derivedBeat = features.beat[at]!;
    if (![energy, bass, derivedBeat].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) throw new RangeError("Reaction features must be finite normalized values");
    const frameStart = (startFrame + index) / fps, frameEnd = (startFrame + index + 1) / fps;
    while (windowIndex < windows.length && windows[windowIndex]!.endSec <= frameStart) windowIndex++;
    const audible = windowIndex < windows.length && windows[windowIndex]!.startSec < frameEnd;
    depth += suppressed[index]!;
    const beat = Math.max(depth > 0 ? 0 : derivedBeat, accents[index]!);
    const input = energy === 0 || !audible ? 0 : Math.min(1, effect.reaction.beat * beat + effect.reaction.bass * bass + effect.reaction.energy * energy);
    weightedPrefix[index + 1] = weightedPrefix[index]! + Math.round(input * 1e8);
    const sum = weightedPrefix[index + 1]! - weightedPrefix[Math.max(0, index + 1 - smoothing)]!;
    // Silence gates the final smoothed response too; its history cannot overcome a cut/mute.
    values[index] = energy === 0 || !audible ? 0 : Math.round(effect.reaction.limit * effect.reaction.strength * effectCurveAt(effect.reactionCurve, startFrame + index - effect.simulationOriginFrame) * (sum / 1e8 / smoothing) * 1e8) / 1e8;
    const addedSpeed = effect.reaction.property === "speed" ? Math.min(1 - effect.motion.speed, values[index]!) : 0;
    speedIntegral[index + 1] = speedIntegral[index]! + Math.round(addedSpeed * 1e8);
  }
  return prepared;
}

export function preparedEffectModulationAt(prepared: PreparedEffectReaction, absoluteFrame: number): number {
  return prepared.values[Math.floor(absoluteFrame) - prepared.startFrame] ?? 0;
}
export function preparedEffectExtraSpeedSeconds(prepared: PreparedEffectReaction, fromFrame: number, toFrame: number): number {
  const from = Math.max(0, Math.min(prepared.values.length, fromFrame - prepared.startFrame));
  const to = Math.max(0, Math.min(prepared.values.length, toFrame - prepared.startFrame));
  const first = Math.floor(from), last = Math.floor(to);
  const firstRate = (prepared.speedIntegral[first + 1] ?? prepared.speedIntegral[first]!) - prepared.speedIntegral[first]!;
  const lastRate = (prepared.speedIntegral[last + 1] ?? prepared.speedIntegral[last]!) - prepared.speedIntegral[last]!;
  return (prepared.speedIntegral[last]! - prepared.speedIntegral[first]! + (to - last) * lastRate - (from - first) * firstRate) / 1e8 / prepared.frameRate;
}

export function prepareEffectReactions(effects: readonly EffectClip[], manifestsByKey: Readonly<Record<string, EffectFeatureManifest>>,
  manifestKeyByEffectId: Readonly<Record<string, string>>, range: { startFrame: number; endFrame: number }): PreparedEffectReactions {
  const result: Record<string, PreparedEffectReaction> = {};
  let frames = 0, bytes = 0;
  const seen = new Set<string>();
  for (const effect of effects) {
    if (!effect.reaction.enabled || effect.startFrame >= range.endFrame || effect.startFrame + effect.durationFrames <= range.startFrame) continue;
    const key = manifestKeyByEffectId[effect.id];
    if (!key) continue; // Missing analysis is explicitly base-only in the projection's readiness.
    const manifest = manifestsByKey[key];
    if (!manifest || manifest.manifestKey !== key) throw new RangeError("Reaction manifest identity is missing or changed");
    if (!seen.has(key)) { bytes += new TextEncoder().encode(JSON.stringify(manifest)).length; seen.add(key); }
    if (bytes > EFFECT_ANALYSIS_PROFILE.maxFrozenManifestBytes) throw new RangeError("Frozen effect analysis exceeds its 32 MiB budget");
    const prepared = prepareEffectReaction(effect, manifest, range);
    frames += prepared.values.length;
    if (frames > EFFECT_ANALYSIS_PROFILE.maxPreparedFrames) throw new RangeError("Prepared reactions exceed their shared frame budget");
    result[effect.id] = prepared;
  }
  return result;
}
