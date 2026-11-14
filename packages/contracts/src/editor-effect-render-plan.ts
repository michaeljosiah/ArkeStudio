import type { EffectClip, PictureBlendMode } from "./editor-effects.js";
import type { ProductionTimeline } from "./timeline.js";
import type { PictureFade, PictureMotion } from "./editor-picture-motion.js";
import { crossfadeWindow, transitionInactiveReason, transitionJoin, crossfadeWeight } from "./editor-transitions.js";

/** Normal layers share an intermediate; other modes need their actual backdrop. */
export function partitionEffectBlendLayers(effects: readonly EffectClip[]): Array<{ effects: EffectClip[]; blendMode: PictureBlendMode }> {
  const groups: Array<{ effects: EffectClip[]; blendMode: PictureBlendMode }> = [];
  for (const effect of effects) {
    const blendMode = effect.appearance.blendMode ?? "normal", previous = groups.at(-1);
    if (blendMode === "normal" && previous?.blendMode === "normal") previous.effects.push(effect);
    else groups.push({ effects: [effect], blendMode });
  }
  return groups;
}

/** Slate pixels are delivery content, independent of the application's colour theme. */
export const EFFECT_SLATE_STYLE = Object.freeze({ background: "#000000", colour: "#ffffff", fontFamily: "Geist Sans", fontSize: 48 });

/** Frozen production-clock picture identity for scoped procedural composition (SPEC-053 R-18). */
export interface RenderPictureLayer {
  clipId: string;
  trackId: string;
  order: number;
  kind: "media" | "slate";
  label: string;
  path?: string;
  still: boolean;
  startFrame: number;
  endFrame: number;
  sourceInSec: number;
  sourceOutSec?: number;
  sourceSize?: { width: number; height: number };
  fit: "contain";
  matte: "source-alpha";
  blendMode?: PictureBlendMode;
  opacity?: number;
  /** SPEC-054 R-4: source coverage extends; authored clip boundaries remain unchanged. */
  fadeIn?: { startFrame: number; durationFrames: number };
  fadeOut?: { startFrame: number; durationFrames: number };
  /** A still's move runs across all of this layer's time on screen, a crossfade's overlap included. */
  motion?: PictureMotion;
  /**
   * A video at another speed, or last frame first (SPEC-037 R-40). `sourceInSec` is where its
   * source window begins either way; `pictureSourceSec` is the one reading of these two.
   */
  speed?: number;
  reverse?: true;
}

/** How far through its time on screen a layer is at `frame`: what a moving still's window is read at. */
export function pictureMotionProgress(picture: Pick<RenderPictureLayer, "startFrame" | "endFrame">, frame: number): number {
  return (frame - picture.startFrame) / Math.max(1, picture.endFrame - picture.startFrame);
}

export function projectPictureTransitions(record: ProductionTimeline, pictures: readonly RenderPictureLayer[]): RenderPictureLayer[] {
  const result = pictures.map(picture => ({ ...picture }));
  for (const value of record.transitions ?? []) {
    if (transitionInactiveReason(record.tracks, record.transitions ?? [], value)) continue;
    const join = transitionJoin(record.tracks, value)!;
    const left = result.find(picture => picture.clipId === value.leftClipId && picture.trackId === value.trackId);
    const right = result.find(picture => picture.clipId === value.rightClipId && picture.trackId === value.trackId);
    if (!left?.still || !right?.still || left.kind !== "media" || right.kind !== "media") continue;
    const window = crossfadeWindow(join.cutFrame, value.durationFrames);
    const fade = { startFrame: window.startFrame, durationFrames: value.durationFrames };
    left.endFrame = window.endFrame; left.fadeOut = fade;
    right.startFrame = window.startFrame; right.fadeIn = fade;
  }
  // A clip's own fade takes an edge no crossfade holds, against whatever lies beneath it.
  const fades = new Map<string, PictureFade>(record.tracks.flatMap(track => track.clips.flatMap(clip => clip.fade ? [[clip.id, clip.fade] as const] : [])));
  for (const picture of result) {
    const fade = fades.get(picture.clipId), span = picture.endFrame - picture.startFrame;
    if (!fade || picture.kind !== "media") continue;
    if (fade.inFrames && !picture.fadeIn) picture.fadeIn = { startFrame: picture.startFrame, durationFrames: Math.min(fade.inFrames, span) };
    const frames = Math.min(fade.outFrames ?? 0, span);
    if (frames && !picture.fadeOut) picture.fadeOut = { startFrame: picture.endFrame - frames, durationFrames: frames };
  }
  return result;
}
export function pictureTransitionWeight(picture: RenderPictureLayer, frame: number): number {
  return (picture.fadeIn ? crossfadeWeight(frame, picture.fadeIn.startFrame, picture.fadeIn.durationFrames) : 1) *
    (picture.fadeOut ? 1 - crossfadeWeight(frame, picture.fadeOut.startFrame, picture.fadeOut.durationFrames) : 1);
}

export interface RenderEffectLayer {
  trackId: string;
  trackOrder: number;
  effect: EffectClip;
}

export interface EffectRenderProjection {
  rendererVersion: "software-rgba-v2";
  width: number;
  height: number;
  frameRate: number;
  /** Half-open delivery bounds; effect records and picture windows remain absolute. */
  startFrame: number;
  endFrame: number;
  pictureLayers: RenderPictureLayer[];
  effectLayers: RenderEffectLayer[];
  issues: Array<{ kind: "missing-target" | "analysis-required"; effectId: string; reason: string }>;
}

/** Reuses resolved picture/audio while an effect gesture changes only procedural records. */
export function projectEffectLayers(record: ProductionTimeline): Pick<EffectRenderProjection, "effectLayers" | "issues"> {
  const effectLayers = record.tracks.filter(track => track.kind === "effect" && !track.muted)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .flatMap(track => [...(track.effects ?? [])].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
      .map(effect => ({ trackId: track.id, trackOrder: track.order, effect: structuredClone(effect) })));
  const issues: EffectRenderProjection["issues"] = [];
  for (const { effect } of effectLayers) {
    const target = effect.target;
    const present = target.kind === "composition" || (target.kind === "picture-track"
      ? record.tracks.some(track => track.kind === "picture" && track.id === target.trackId)
      : record.tracks.some(track => track.kind === "picture" && track.clips.some(clip => clip.id === target.clipId)));
    if (!present) issues.push({ kind: "missing-target", effectId: effect.id, reason: "Visual target missing" });
    if (effect.reaction.enabled) issues.push({ kind: "analysis-required", effectId: effect.id, reason: "Audio analysis required" });
  }
  return { effectLayers, issues };
}

/** Delivery readiness uses the same target contribution as rendering, including scoped gaps. */
export function deliveredEffectLayers(plan: EffectRenderProjection): RenderEffectLayer[] {
  return plan.effectLayers.filter(({ effect }) => {
    const start = Math.max(plan.startFrame, effect.startFrame);
    const end = Math.min(plan.endFrame, effect.startFrame + effect.durationFrames);
    if (start >= end) return false;
    const target = effect.target;
    return target.kind === "composition" || plan.pictureLayers.some(picture => picture.kind === "media" &&
      picture.startFrame < end && picture.endFrame > start && (target.kind === "picture-track"
        ? picture.trackId === target.trackId : picture.clipId === target.clipId));
  });
}

export function pictureStackAtFrame(plan: EffectRenderProjection, absoluteFrame: number): RenderPictureLayer[] {
  if (absoluteFrame < plan.startFrame || absoluteFrame >= plan.endFrame) return [];
  return plan.pictureLayers.filter(layer => absoluteFrame >= layer.startFrame && absoluteFrame < layer.endFrame);
}

export function effectsForPicture(plan: EffectRenderProjection, picture: RenderPictureLayer | null, absoluteFrame: number, includeInactive = false): RenderEffectLayer[] {
  if (absoluteFrame < plan.startFrame || absoluteFrame >= plan.endFrame) return [];
  return plan.effectLayers.filter(({ effect }) => {
    if (includeInactive) {
      const start = Math.max(plan.startFrame, picture?.startFrame ?? plan.startFrame), end = Math.min(plan.endFrame, picture?.endFrame ?? plan.endFrame);
      if (effect.startFrame >= end || effect.startFrame + effect.durationFrames <= start) return false;
    } else if (absoluteFrame < effect.startFrame || absoluteFrame >= effect.startFrame + effect.durationFrames) return false;
    const target = effect.target;
    if (picture === null) return target.kind === "composition";
    if (picture.kind !== "media") return false;
    return target.kind === "picture-track" ? target.trackId === picture.trackId : target.kind === "visual-clip" && target.clipId === picture.clipId;
  });
}

/** Only effects whose target contributes now need reaction data in the frame worker. */
export function activeEffectLayersAtFrame(plan: EffectRenderProjection, absoluteFrame: number): RenderEffectLayer[] {
  if (absoluteFrame < plan.startFrame || absoluteFrame >= plan.endFrame) return [];
  const active = new Set(effectsForPicture(plan, null, absoluteFrame).map(row => row.effect.id));
  for (const picture of pictureStackAtFrame(plan, absoluteFrame)) {
    for (const row of effectsForPicture(plan, picture, absoluteFrame)) active.add(row.effect.id);
  }
  return plan.effectLayers.filter(row => active.has(row.effect.id));
}

/** Picture and particles use the same contain rectangle; letterboxing is outside its matte. */
export function containedPictureRect(sourceWidth: number, sourceHeight: number, width: number, height: number): { x: number; y: number; width: number; height: number } {
  if (![sourceWidth, sourceHeight, width, height].every(value => Number.isFinite(value) && value > 0)) throw new Error("Picture dimensions must be measured before composing effects.");
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const w = Math.max(1, Math.round(sourceWidth * scale)), h = Math.max(1, Math.round(sourceHeight * scale));
  return { x: Math.floor((width - w) / 2), y: Math.floor((height - h) / 2), width: w, height: h };
}
