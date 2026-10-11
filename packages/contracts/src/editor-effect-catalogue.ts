import type { EffectClip } from "./editor-effects.js";
import type { EffectRenderProjection } from "./editor-effect-render-plan.js";
import type { ProductionTimeline } from "./timeline.js";

export const EDITOR_EFFECT_RENDERER_VERSION = "software-rgba-v1" as const;

/** Versioned finite work budgets; a refusal is preferable to dropping particles (SPEC-053 R-20). */
export const EFFECT_RENDER_PROFILE = Object.freeze({
  id: EDITOR_EFFECT_RENDERER_VERSION,
  maxWidth: 1920,
  maxHeight: 1920,
  maxPixels: 1920 * 1080,
  maxEffects: 8,
  maxConcurrentPictures: 8,
  maxGroups: 128,
  maxParticlesPerEffect: 128,
  maxCandidateBirths: 160,
  maxRasterRadius: 160,
  maxDurationSeconds: 30 * 60,
  maxAuthoredClips: 1000,
  maxAuthoredBytes: 4 * 1024 * 1024,
});

export interface EffectPresetDefinition {
  id: EffectClip["preset"]["id"];
  version: 1;
  label: string;
  shape: "soft-disc" | "streak" | "flake" | "smoke";
  birthsPerSecond: number;
  minimumLifetimeSec: number;
  maximumLifetimeSec: number;
  /** Radius in fractions of the target's shorter dimension, before authored Size. */
  minimumRadius: number;
  maximumRadius: number;
  speedPerSecond: number;
  directionDegrees: number;
  drift: number;
  opacity: number;
  tint: readonly [number, number, number];
  supportedReactionProperties: readonly EffectClip["reaction"]["property"][];
}

const properties = ["brightness", "emission", "size", "speed"] as const;
/** Every advertised preset is drawn by the same software renderer, including Smoke. */
const definitions: EffectPresetDefinition[] = [
  { id: "dust", version: 1, label: "Floating dust", shape: "soft-disc", birthsPerSecond: 12, minimumLifetimeSec: 4, maximumLifetimeSec: 8,
    minimumRadius: 0.001, maximumRadius: 0.006, speedPerSecond: 0.018, directionDegrees: -70, drift: 0.025, opacity: 0.65, tint: [1, 0.95, 0.8], supportedReactionProperties: properties },
  { id: "embers", version: 1, label: "Embers", shape: "streak", birthsPerSecond: 20, minimumLifetimeSec: 1.5, maximumLifetimeSec: 4,
    minimumRadius: 0.001, maximumRadius: 0.004, speedPerSecond: 0.11, directionDegrees: -90, drift: 0.065, opacity: 0.95, tint: [1, 0.45, 0.12], supportedReactionProperties: properties },
  { id: "snow", version: 1, label: "Snow", shape: "flake", birthsPerSecond: 15, minimumLifetimeSec: 3, maximumLifetimeSec: 7,
    minimumRadius: 0.0015, maximumRadius: 0.005, speedPerSecond: 0.065, directionDegrees: 90, drift: 0.04, opacity: 0.85, tint: [0.92, 0.97, 1], supportedReactionProperties: properties },
  { id: "lights", version: 1, label: "Floating lights", shape: "soft-disc", birthsPerSecond: 8, minimumLifetimeSec: 3, maximumLifetimeSec: 7,
    minimumRadius: 0.003, maximumRadius: 0.016, speedPerSecond: 0.014, directionDegrees: -90, drift: 0.04, opacity: 0.65, tint: [1, 0.86, 0.55], supportedReactionProperties: properties },
  { id: "rain", version: 1, label: "Rain", shape: "streak", birthsPerSecond: 50, minimumLifetimeSec: 0.7, maximumLifetimeSec: 2.2,
    minimumRadius: 0.0005, maximumRadius: 0.0014, speedPerSecond: 0.5, directionDegrees: 102, drift: 0.004, opacity: 0.7, tint: [0.7, 0.85, 1], supportedReactionProperties: properties },
  { id: "smoke", version: 1, label: "Smoke", shape: "smoke", birthsPerSecond: 4, minimumLifetimeSec: 3, maximumLifetimeSec: 6,
    minimumRadius: 0.015, maximumRadius: 0.07, speedPerSecond: 0.025, directionDegrees: -90, drift: 0.08, opacity: 0.25, tint: [0.8, 0.85, 0.92], supportedReactionProperties: properties },
];
export const EFFECT_PRESET_CATALOGUE: readonly EffectPresetDefinition[] = Object.freeze(definitions.map(value => Object.freeze({
  ...value, tint: Object.freeze(value.tint), supportedReactionProperties: Object.freeze([...value.supportedReactionProperties]),
})));

export function effectPresetDefinition(preset: EffectClip["preset"]): EffectPresetDefinition {
  const found = EFFECT_PRESET_CATALOGUE.find(value => value.id === preset.id && value.version === preset.version);
  if (!found) throw new RangeError(`Unsupported effect preset ${preset.id} version ${preset.version}`);
  return found;
}

export function assertEffectRasterSize(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > EFFECT_RENDER_PROFILE.maxWidth || height > EFFECT_RENDER_PROFILE.maxHeight || width * height > EFFECT_RENDER_PROFILE.maxPixels) {
    throw new RangeError(`Effects support positive raster dimensions up to ${EFFECT_RENDER_PROFILE.maxPixels} pixels, with neither side above ${EFFECT_RENDER_PROFILE.maxWidth}`);
  }
}

export function effectCapabilityProblem(effects: readonly EffectClip[], width: number, height: number): string | null {
  try {
    assertEffectRasterSize(width, height);
    if (effects.length > EFFECT_RENDER_PROFILE.maxEffects) throw new RangeError(`At most ${EFFECT_RENDER_PROFILE.maxEffects} simultaneous effects are supported`);
    for (const effect of effects) {
      const preset = effectPresetDefinition(effect.preset);
      if (!preset.supportedReactionProperties.includes(effect.reaction.property)) throw new RangeError(`${preset.label} does not support ${effect.reaction.property} reaction`);
    }
    return null;
  } catch (error) { return error instanceof Error ? error.message : String(error); }
}

/** Shared planner/review/export budget; gaps and off-range effects consume no active slot. */
export function effectRenderCapabilityProblem(plan: EffectRenderProjection): string | null {
  try {
    if (plan.rendererVersion !== EDITOR_EFFECT_RENDERER_VERSION) throw new RangeError(`Unsupported effect renderer ${plan.rendererVersion}`);
    assertEffectRasterSize(plan.width, plan.height);
    if (![24, 25, 30].includes(plan.frameRate) || !Number.isSafeInteger(plan.startFrame) || !Number.isSafeInteger(plan.endFrame) || plan.startFrame < 0 || plan.endFrame < plan.startFrame) throw new RangeError("Effect delivery needs valid whole production-frame bounds");
    if (plan.effectLayers.length && plan.endFrame - plan.startFrame > plan.frameRate * EFFECT_RENDER_PROFILE.maxDurationSeconds) throw new RangeError("Effects currently support deliveries up to 30 minutes");
    const events: Array<{ frame: number; delta: number }> = [];
    const groups = new Set<string>();
    const pictureEvents = plan.pictureLayers.filter(picture => picture.kind === "media").flatMap(picture => {
      const from = Math.max(picture.startFrame, plan.startFrame), to = Math.min(picture.endFrame, plan.endFrame);
      return to > from ? [{ frame: from, delta: 1 }, { frame: to, delta: -1 }] : [];
    }).sort((a, b) => a.frame - b.frame || a.delta - b.delta);
    let pictureCount = 0;
    for (const event of pictureEvents) {
      pictureCount += event.delta;
      if (pictureCount > EFFECT_RENDER_PROFILE.maxConcurrentPictures) throw new RangeError(`At most ${EFFECT_RENDER_PROFILE.maxConcurrentPictures} picture layers may be active at frame ${event.frame} with effects`);
    }
    for (const { effect } of plan.effectLayers) {
      effectPresetDefinition(effect.preset);
      const target = effect.target;
      const windows = target.kind === "composition" ? [{ startFrame: plan.startFrame, endFrame: plan.endFrame }] : plan.pictureLayers.filter(picture => picture.kind === "media" &&
        (target.kind === "picture-track" ? picture.trackId === target.trackId : picture.clipId === target.clipId));
      for (const window of windows) if (Math.max(plan.startFrame, effect.startFrame, window.startFrame) < Math.min(plan.endFrame, effect.startFrame + effect.durationFrames, window.endFrame)) {
        groups.add(target.kind === "composition" ? "composition" : `picture:${"clipId" in window ? window.clipId : ""}`);
      }
      const ranges = windows.map(window => ({ startFrame: Math.max(plan.startFrame, effect.startFrame, window.startFrame), endFrame: Math.min(plan.endFrame, effect.startFrame + effect.durationFrames, window.endFrame) }))
        .filter(range => range.endFrame > range.startFrame).sort((a, b) => a.startFrame - b.startFrame);
      const merged: Array<{ startFrame: number; endFrame: number }> = [];
      for (const range of ranges) {
        const last = merged.at(-1);
        if (last && range.startFrame <= last.endFrame) last.endFrame = Math.max(last.endFrame, range.endFrame);
        else merged.push({ ...range });
      }
      for (const range of merged) events.push({ frame: range.startFrame, delta: 1 }, { frame: range.endFrame, delta: -1 });
    }
    if (groups.size > EFFECT_RENDER_PROFILE.maxGroups) throw new RangeError(`At most ${EFFECT_RENDER_PROFILE.maxGroups} scoped picture/composition effect groups are supported`);
    events.sort((a, b) => a.frame - b.frame || a.delta - b.delta);
    let active = 0;
    for (const event of events) {
      active += event.delta;
      if (active > EFFECT_RENDER_PROFILE.maxEffects) throw new RangeError(`At most ${EFFECT_RENDER_PROFILE.maxEffects} effects may be active at frame ${event.frame}`);
    }
    return null;
  } catch (error) { return error instanceof Error ? error.message : String(error); }
}

/** History is authored too: a deleted effect or released baseline still occupies its Undo entry. */
export function effectTimelineCapabilityProblem(timeline: ProductionTimeline): string | null {
  const effects = timeline.tracks.flatMap(track => track.effects ?? []);
  if (effects.length > EFFECT_RENDER_PROFILE.maxAuthoredClips) return `At most ${EFFECT_RENDER_PROFILE.maxAuthoredClips} effect clips are supported on one timeline`;
  let bytes = 0;
  const encoder = new TextEncoder();
  const count = (value: unknown): boolean => {
    if (value === undefined) return false;
    bytes += encoder.encode(JSON.stringify(value)).byteLength;
    return bytes > EFFECT_RENDER_PROFILE.maxAuthoredBytes;
  };
  const reason = "Effect settings, protection and retained history exceed the 4 MiB authored-data budget";
  for (const effect of effects) if (count(effect)) return reason;
  for (const rule of timeline.effectProtection ?? []) if (count(rule)) return reason;
  for (const entry of [...timeline.history.undo, ...timeline.history.redo]) {
    if (entry.kind !== "change") continue;
    for (const effect of entry.effectClips ?? []) if (count(effect)) return reason;
    if (entry.effectProtection) {
      for (const rule of [...entry.effectProtection.before, ...entry.effectProtection.after]) if (count(rule)) return reason;
    }
  }
  return null;
}
