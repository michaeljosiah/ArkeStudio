import { effectCurveAt, effectVisibilityAt, type EffectClip } from "./editor-effects.js";
import { EDITOR_EFFECT_RENDERER_VERSION, EFFECT_RENDER_PROFILE, effectPresetDefinition, type EffectPresetDefinition } from "./editor-effect-catalogue.js";

/** Frozen normalized features on the production frame grid; missing frames are silence. */
export interface EffectFrameFeatures {
  startFrame: number;
  beat: readonly number[];
  bass: readonly number[];
  energy: readonly number[];
}

export interface EffectParticle {
  /** Stable for this seed and birth slot; seeks never mint a fresh identity. */
  id: number;
  x: number;
  y: number;
  /** Radii are fractions of the shorter target dimension. */
  radius: number;
  stretch: number;
  directionX: number;
  directionY: number;
  opacity: number;
  colour: readonly [number, number, number];
  shape: EffectPresetDefinition["shape"];
}

export interface EffectFrame {
  rendererVersion: typeof EDITOR_EFFECT_RENDERER_VERSION;
  effectId: string;
  absoluteFrame: number;
  targetAspectRatio: number;
  /** False means a clearly labelled base-only preview; export must require ready features. */
  reactionReady: boolean;
  particles: readonly EffectParticle[];
}

export interface EvaluateEffectFrameInput {
  effect: EffectClip;
  absoluteFrame: number;
  frameRate: number;
  targetAspectRatio: number;
  features?: EffectFrameFeatures;
}

const clamp = (value: number, low = 0, high = 1): number => Math.min(high, Math.max(low, value));

/** Integer mixing uses only specified 32-bit operations, including negative pre-roll slots. */
export function effectRandom(seed: number, birthSlot: number, channel: number): number {
  const high = Math.floor(birthSlot / 0x100000000);
  let value = (seed ^ Math.imul(birthSlot | 0, 0x9e3779b1) ^ Math.imul(high | 0, 0x85ebca6b) ^ Math.imul(channel + 1, 0xc2b2ae35)) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d) >>> 0;
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b) >>> 0;
  return ((value ^ (value >>> 16)) >>> 0) / 0x100000000;
}

/** A versioned rational approximation avoids platform trigonometric library differences. */
function sineDegrees(degrees: number): number {
  let wrapped = ((degrees % 360) + 360) % 360;
  const sign = wrapped > 180 ? -1 : 1;
  if (wrapped > 180) wrapped -= 180;
  const product = wrapped * (180 - wrapped);
  return sign * 4 * product / (40500 - product);
}

function featureAt(values: readonly number[], index: number): number {
  if (index < 0 || index >= values.length) return 0;
  const value = values[index]!;
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError("Effect features must be finite normalized values");
  return value;
}

function reactionInput(effect: EffectClip, features: EffectFrameFeatures, absoluteFrame: number): number {
  const index = absoluteFrame - features.startFrame;
  const activeCues = effect.cueOverrides.filter(cue => absoluteFrame >= cue.frame && absoluteFrame < cue.frame + cue.durationFrames);
  let beat = activeCues.some(cue => cue.kind === "suppress") ? 0 : featureAt(features.beat, index);
  for (const cue of activeCues) {
    if (cue.kind === "accent") beat = Math.max(beat, cue.strength * (1 - (absoluteFrame - cue.frame) / cue.durationFrames));
  }
  return clamp(effect.reaction.beat * beat + effect.reaction.bass * featureAt(features.bass, index) + effect.reaction.energy * featureAt(features.energy, index));
}

export function effectModulationAt(effect: EffectClip, absoluteFrame: number, features?: EffectFrameFeatures): number {
  if (!effect.reaction.enabled || !features || effect.reaction.strength === 0) return 0;
  if (!Number.isSafeInteger(features.startFrame) || features.beat.length !== features.bass.length || features.beat.length !== features.energy.length) throw new RangeError("Effect feature arrays must share one whole-frame window");
  const count = Math.max(1, effect.reaction.smoothingFrames);
  let input = 0;
  for (let index = 0; index < count; index++) input += reactionInput(effect, features, absoluteFrame - index);
  return effect.reaction.limit * effect.reaction.strength * effectCurveAt(effect.reactionCurve, absoluteFrame - effect.simulationOriginFrame) * (input / count);
}

function colourBytes(effect: EffectClip, tint: readonly number[], brightness: number): readonly [number, number, number] {
  const colour = effect.appearance.colour;
  return [0, 1, 2].map(index => Math.round(clamp(Number.parseInt(colour.slice(1 + index * 2, 3 + index * 2), 16) * tint[index]! * brightness, 0, 255))) as [number, number, number];
}

/**
 * Only births within a preset's finite lifetime are inspected. Counter randomness and analytic
 * motion make random access identical to sequential playback without a song-length replay.
 * A fixed pre-roll supplies continuous atmosphere at the first authored frame (SPEC-053 R-18).
 */
export function evaluateEffectFrame(input: EvaluateEffectFrameInput): EffectFrame {
  const { effect, absoluteFrame, frameRate, targetAspectRatio, features } = input;
  if (!Number.isSafeInteger(absoluteFrame) || absoluteFrame < 0 || ![24, 25, 30].includes(frameRate)) throw new RangeError("Effect evaluation requires a whole production frame at 24, 25 or 30 fps");
  if (!Number.isFinite(targetAspectRatio) || targetAspectRatio > EFFECT_RENDER_PROFILE.maxWidth || targetAspectRatio < 1 / EFFECT_RENDER_PROFILE.maxHeight) throw new RangeError("Effect target aspect ratio is outside the supported range");
  const preset = effectPresetDefinition(effect.preset);
  const frame: EffectFrame = { rendererVersion: EDITOR_EFFECT_RENDERER_VERSION, effectId: effect.id, absoluteFrame, targetAspectRatio,
    reactionReady: !effect.reaction.enabled || features !== undefined, particles: [] };
  const visibility = effectVisibilityAt(effect, absoluteFrame);
  if (visibility === 0) return frame;
  const phaseSec = (absoluteFrame - effect.simulationOriginFrame) / frameRate;
  const lastBirth = Math.floor(phaseSec * preset.birthsPerSecond);
  const firstBirth = Math.ceil((phaseSec - preset.maximumLifetimeSec) * preset.birthsPerSecond);
  if (!Number.isSafeInteger(firstBirth) || !Number.isSafeInteger(lastBirth) || lastBirth - firstBirth + 1 > EFFECT_RENDER_PROFILE.maxCandidateBirths) throw new RangeError("Effect birth window exceeds the supported frame budget");
  const modulation = effectModulationAt(effect, absoluteFrame, features);
  const amountAt = (at: number): number => clamp(effect.appearance.amount + (effect.reaction.property === "emission" ? effectModulationAt(effect, at, features) : 0));
  const size = clamp(effect.appearance.size + (effect.reaction.property === "size" ? modulation : 0));
  const speed = clamp(effect.motion.speed + (effect.reaction.property === "speed" ? modulation : 0));
  const brightness = 1 + (effect.reaction.property === "brightness" ? modulation : 0);
  const colour = colourBytes(effect, preset.tint, brightness);
  const xUnit = 1 / Math.max(1, targetAspectRatio), yUnit = Math.min(1, targetAspectRatio);
  const direction = preset.directionDegrees + effect.motion.direction;
  const dx = sineDegrees(direction + 90), dy = sineDegrees(direction);
  const particles: EffectParticle[] = [];
  for (let slot = firstBirth; slot <= lastBirth; slot++) {
    const random = (channel: number) => effectRandom(effect.seed, slot, channel);
    const birthSec = slot / preset.birthsPerSecond;
    const ageSec = phaseSec - birthSec;
    const lifetime = preset.minimumLifetimeSec + random(0) * (preset.maximumLifetimeSec - preset.minimumLifetimeSec);
    if (ageSec < 0 || ageSec >= lifetime) continue;
    const birthFrame = effect.simulationOriginFrame + Math.floor(birthSec * frameRate);
    if (random(1) >= amountAt(birthFrame)) continue;
    const age = ageSec / lifetime;
    const area = effect.motion.area;
    const originX = area.x + random(2) * area.width, originY = area.y + random(3) * area.height;
    const travel = preset.speedPerSecond * 2 * speed * ageSec * (0.7 + random(4) * 0.6);
    const drift = preset.drift * speed * 2 * (sineDegrees(random(5) * 360 + ageSec * 60) - sineDegrees(random(5) * 360));
    const x = originX + (dx * travel - dy * drift) * xUnit;
    const y = originY + (dy * travel + dx * drift) * yUnit;
    const baseRadius = preset.minimumRadius + random(6) * (preset.maximumRadius - preset.minimumRadius);
    const growth = preset.shape === "smoke" ? 0.5 + age : 1;
    const radius = baseRadius * (0.2 + size * 0.8) * growth;
    const lifeFade = Math.min(1, age * 6) * Math.min(1, (1 - age) * 4);
    const opacity = visibility * preset.opacity * lifeFade * (0.65 + random(7) * 0.35);
    const stretch = preset.id === "rain" ? 9 + speed * 12 : preset.id === "embers" ? 1.5 + speed * 2 : preset.shape === "smoke" ? 0.75 + random(8) * 0.5 : 1;
    // Particles outside the canvas remain in the deterministic population; raster clipping is separate.
    particles.push({ id: slot, x, y, radius, stretch, directionX: dx, directionY: dy, opacity, colour, shape: preset.shape });
  }
  if (particles.length > EFFECT_RENDER_PROFILE.maxParticlesPerEffect) throw new RangeError("Effect particle population exceeds the supported profile");
  return { ...frame, particles };
}
