import type { EffectClip, PictureBlendMode } from "./editor-effects.js";
import { airParticleCoverage } from "./editor-particle-texture.js";
import { assertEffectRasterSize, EDITOR_EFFECT_RENDERER_VERSION, EFFECT_RENDER_PROFILE } from "./editor-effect-catalogue.js";
import { evaluateEffectFrame, type EffectFrame, type EffectParticle } from "./editor-effect-evaluator.js";
import { partitionEffectBlendLayers } from "./editor-effect-render-plan.js";
import type { PreparedEffectReactions } from "./editor-effect-reaction.js";

function overPixel(destination: Uint8ClampedArray, offset: number, red: number, green: number, blue: number, alpha: number): void {
  if (alpha === 0) return;
  const previousAlpha = destination[offset + 3]!;
  const inverse = 255 - alpha;
  const numerator = alpha * 255 + previousAlpha * inverse;
  destination[offset] = Math.round((red * alpha * 255 + destination[offset]! * previousAlpha * inverse) / numerator);
  destination[offset + 1] = Math.round((green * alpha * 255 + destination[offset + 1]! * previousAlpha * inverse) / numerator);
  destination[offset + 2] = Math.round((blue * alpha * 255 + destination[offset + 2]! * previousAlpha * inverse) / numerator);
  destination[offset + 3] = Math.round(numerator / 255);
}

/**
 * Straight RGBA in, straight RGBA out. Atop preserves the destination/source-picture matte;
 * multiplying effect alpha then using Over would incorrectly make translucent pictures opaque.
 */
export function pictureBlendChannel(backdrop: number, source: number, mode: PictureBlendMode): number {
  return mode === "screen" ? 255 - (255 - backdrop) * (255 - source) / 255 : mode === "add" ? Math.min(255, backdrop + source) : source;
}

export function compositeRgba(destination: Uint8ClampedArray, source: Uint8ClampedArray, mode: "over" | "atop" = "over", blend: PictureBlendMode = "normal", opacity = 1): Uint8ClampedArray {
  if (source.length !== destination.length || source.length % 4 !== 0) throw new RangeError("RGBA surfaces must have equal whole-pixel lengths");
  if (mode !== "over" && mode !== "atop") throw new RangeError("Unknown RGBA compositing operation");
  if (!["normal", "screen", "add"].includes(blend) || !Number.isFinite(opacity) || opacity < 0 || opacity > 1) throw new RangeError("Invalid picture blend or opacity");
  for (let offset = 0; offset < source.length; offset += 4) {
    const alpha = Math.round(source[offset + 3]! * opacity), backdropAlpha = destination[offset + 3]! / 255;
    const channel = (i: number) => {
      const raw = source[offset + i]!;
      if (blend === "normal") return raw;
      const mixed = pictureBlendChannel(destination[offset + i]!, raw, blend);
      return mode === "atop" ? mixed : raw * (1 - backdropAlpha) + mixed * backdropAlpha;
    };
    if (mode === "over") overPixel(destination, offset, channel(0), channel(1), channel(2), alpha);
    else if (destination[offset + 3] === 0) {
      destination[offset] = destination[offset + 1] = destination[offset + 2] = 0;
    } else if (alpha !== 0) {
      const inverse = 255 - alpha;
      destination[offset] = Math.round((channel(0) * alpha + destination[offset]! * inverse) / 255);
      destination[offset + 1] = Math.round((channel(1) * alpha + destination[offset + 1]! * inverse) / 255);
      destination[offset + 2] = Math.round((channel(2) * alpha + destination[offset + 2]! * inverse) / 255);
    }
  }
  return destination;
}

/** SPEC-054 R-4: add weighted premultiplied pictures on one track, then Over once. */
export function addWeightedPicture(destination: Float32Array, pixels: Uint8ClampedArray, weight: number,
  rect: { x: number; y: number; width: number; height: number }, width: number, backdrop?: Uint8ClampedArray, blend: PictureBlendMode = "normal", opacity = 1): void {
  if (!Number.isFinite(weight) || weight < 0 || weight > 1) throw new RangeError("Invalid picture blend weight");
  if (!["normal", "screen", "add"].includes(blend) || !Number.isFinite(opacity) || opacity < 0 || opacity > 1) throw new RangeError("Invalid picture blend or opacity");
  if (backdrop && backdrop.length !== destination.length) throw new RangeError("Picture backdrop dimensions differ");
  for (let y = 0; y < rect.height; y++) for (let x = 0; x < rect.width; x++) {
    const source = (y * rect.width + x) * 4, target = ((y + rect.y) * width + x + rect.x) * 4;
    const alpha = pixels[source + 3]! / 255 * weight * opacity;
    for (let channel = 0; channel < 3; channel++) {
      const raw = pixels[source + channel]!, ba = backdrop ? backdrop[target + 3]! / 255 : 0;
      const value = backdrop ? raw * (1 - ba) + pictureBlendChannel(backdrop[target + channel]!, raw, blend) * ba : raw;
      destination[target + channel] = destination[target + channel]! + value * alpha;
    }
    destination[target + 3] = destination[target + 3]! + alpha;
  }
}
export function compositeWeightedTrack(destination: Uint8ClampedArray, track: Float32Array): void {
  if (destination.length !== track.length) throw new RangeError("Picture track dimensions differ");
  for (let at = 0; at < track.length; at += 4) {
    const alpha = Math.min(1, track[at + 3]!);
    if (alpha <= 0) continue;
    overPixel(destination, at, track[at]! / alpha, track[at + 1]! / alpha, track[at + 2]! / alpha, Math.round(alpha * 255));
  }
}

function particleCoverage(particle: EffectParticle, localX: number, localY: number, radius: number): number {
  const along = localX * particle.directionX + localY * particle.directionY;
  const across = -localX * particle.directionY + localY * particle.directionX;
  const x = across / radius, y = along / (radius * particle.stretch);
  if (particle.shape === "air-texture") return airParticleCoverage(x, y, particle.texture ?? .75, particle.softness ?? .55, particle.textureSeed ?? 0, particle.rim ?? false);
  const squared = x * x + y * y;
  if (squared >= 1) return 0;
  if (particle.shape === "flake") {
    // Six spokes with a small filled centre, bounded by the same radius as every other stamp.
    const spoke = Math.min(Math.abs(x), Math.abs(0.8660254037844386 * y + x * 0.5), Math.abs(0.8660254037844386 * y - x * 0.5));
    return squared < 0.12 ? 1 : Math.max(0, 1 - spoke * 6) * (1 - squared);
  }
  const falloff = 1 - squared;
  return particle.shape === "smoke" ? falloff * falloff : particle.shape === "soft-disc" ? falloff * falloff * falloff : falloff;
}

function drawParticle(surface: Uint8ClampedArray, particle: EffectParticle, width: number, height: number): void {
  const nominalRadius = Math.min(width, height) * particle.radius * (particle.shape === "air-texture" ? 1.65 : 1);
  // Sub-pixel particles keep their coverage energy without vanishing between pixel centres.
  const radius = Math.max(0.75, nominalRadius);
  const energy = Math.min(1, nominalRadius * nominalRadius / (radius * radius));
  const outerRadius = radius * Math.max(1, particle.stretch);
  if (!Number.isFinite(outerRadius) || outerRadius > EFFECT_RENDER_PROFILE.maxRasterRadius) throw new RangeError("Effect stamp exceeds the supported raster radius");
  const centreX = particle.x * width, centreY = particle.y * height;
  const left = Math.max(0, Math.floor(centreX - outerRadius));
  const right = Math.min(width - 1, Math.ceil(centreX + outerRadius));
  const top = Math.max(0, Math.floor(centreY - outerRadius));
  const bottom = Math.min(height - 1, Math.ceil(centreY + outerRadius));
  for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
    const coverage = particleCoverage(particle, x + 0.5 - centreX, y + 0.5 - centreY, radius);
    const alpha = Math.round(255 * particle.opacity * energy * coverage);
    if (alpha > 0) overPixel(surface, (y * width + x) * 4, particle.colour[0], particle.colour[1], particle.colour[2], alpha);
  }
}

export function rasterizeEffectFrame(frame: EffectFrame, width: number, height: number): Uint8ClampedArray {
  assertEffectRasterSize(width, height);
  if (frame.rendererVersion !== EDITOR_EFFECT_RENDERER_VERSION) throw new RangeError(`Unsupported effect renderer ${frame.rendererVersion}`);
  if (frame.particles.length > EFFECT_RENDER_PROFILE.maxParticlesPerEffect) throw new RangeError("Effect population exceeds the supported profile");
  const surface = new Uint8ClampedArray(width * height * 4);
  for (const particle of frame.particles) drawParticle(surface, particle, width, height);
  return surface;
}

export function compositeEffectFrames(frames: readonly EffectFrame[], width: number, height: number): Uint8ClampedArray {
  assertEffectRasterSize(width, height);
  if (frames.length > EFFECT_RENDER_PROFILE.maxEffects) throw new RangeError(`At most ${EFFECT_RENDER_PROFILE.maxEffects} simultaneous effects are supported`);
  const output = new Uint8ClampedArray(width * height * 4);
  for (const frame of frames) compositeRgba(output, rasterizeEffectFrame(frame, width, height), "over", frame.blendMode);
  return output;
}

/** Blend each authored layer against its actual target; flattening first loses blend semantics. */
export function applyEffectLayersRgba(destination: Uint8ClampedArray, effects: readonly EffectClip[], absoluteFrame: number, frameRate: number,
  width: number, height: number, operation: "over" | "atop" = "over", preparedByEffectId?: PreparedEffectReactions): Uint8ClampedArray {
  assertEffectRasterSize(width, height);
  if (destination.length !== width * height * 4) throw new RangeError("Effect target raster dimensions differ");
  const active = effects.filter(effect => absoluteFrame >= effect.startFrame && absoluteFrame < effect.startFrame + effect.durationFrames);
  if (active.length > EFFECT_RENDER_PROFILE.maxEffects) throw new RangeError("Too many simultaneous effects");
  // Match the native intermediate boundaries, including their 8-bit rounding. Consecutive
  // Normal layers retain the legacy flattened result; Screen/Add keep their real backdrop.
  for (const group of partitionEffectBlendLayers(effects)) {
    if (!group.effects.some(effect => active.includes(effect))) continue;
    compositeRgba(destination, renderEffectLayersRgba(group.effects, absoluteFrame, frameRate, width, height, preparedByEffectId), operation, group.blendMode);
  }
  return destination;
}

/** One target group, in the frozen plan's compositing order. Geometry/matte are host-owned. */
export function renderEffectLayersRgba(effects: readonly EffectClip[], absoluteFrame: number, frameRate: number, width: number, height: number, preparedByEffectId?: PreparedEffectReactions): Uint8ClampedArray {
  assertEffectRasterSize(width, height);
  const active = effects.filter(effect => absoluteFrame >= effect.startFrame && absoluteFrame < effect.startFrame + effect.durationFrames);
  if (active.length > EFFECT_RENDER_PROFILE.maxEffects) throw new RangeError(`At most ${EFFECT_RENDER_PROFILE.maxEffects} simultaneous effects are supported`);
  return compositeEffectFrames(active.map(effect => evaluateEffectFrame({ effect, absoluteFrame, frameRate, targetAspectRatio: width / height,
    preparedReaction: preparedByEffectId?.[effect.id] })), width, height);
}

/** Normal layers can share an intermediate; other modes need the actual backdrop at their place in the stack. */
export { partitionEffectBlendLayers } from "./editor-effect-render-plan.js";
