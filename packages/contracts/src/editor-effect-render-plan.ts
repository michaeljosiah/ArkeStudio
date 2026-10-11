import type { EffectClip } from "./editor-effects.js";

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
}

export interface RenderEffectLayer {
  trackId: string;
  trackOrder: number;
  effect: EffectClip;
}

export interface EffectRenderProjection {
  rendererVersion: "software-rgba-v1";
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

export function pictureStackAtFrame(plan: EffectRenderProjection, absoluteFrame: number): RenderPictureLayer[] {
  if (absoluteFrame < plan.startFrame || absoluteFrame >= plan.endFrame) return [];
  return plan.pictureLayers.filter(layer => absoluteFrame >= layer.startFrame && absoluteFrame < layer.endFrame);
}

export function effectsForPicture(plan: EffectRenderProjection, picture: RenderPictureLayer | null, absoluteFrame: number): RenderEffectLayer[] {
  if (absoluteFrame < plan.startFrame || absoluteFrame >= plan.endFrame) return [];
  return plan.effectLayers.filter(({ effect }) => {
    if (absoluteFrame < effect.startFrame || absoluteFrame >= effect.startFrame + effect.durationFrames) return false;
    const target = effect.target;
    if (picture === null) return target.kind === "composition";
    if (picture.kind !== "media") return false;
    return target.kind === "picture-track" ? target.trackId === picture.trackId : target.kind === "visual-clip" && target.clipId === picture.clipId;
  });
}

/** Picture and particles use the same contain rectangle; letterboxing is outside its matte. */
export function containedPictureRect(sourceWidth: number, sourceHeight: number, width: number, height: number): { x: number; y: number; width: number; height: number } {
  if (![sourceWidth, sourceHeight, width, height].every(value => Number.isFinite(value) && value > 0)) throw new Error("Picture dimensions must be measured before composing effects.");
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const w = Math.max(1, Math.round(sourceWidth * scale)), h = Math.max(1, Math.round(sourceHeight * scale));
  return { x: Math.floor((width - w) / 2), y: Math.floor((height - h) / 2), width: w, height: h };
}
