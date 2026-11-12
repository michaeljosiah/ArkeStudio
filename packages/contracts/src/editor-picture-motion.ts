import { z } from "zod";
import type { TimelineClip, TimelineClipId, TimelineTrack } from "./timeline.js";

const clipId = z.string().regex(/^cl_[A-Za-z0-9][A-Za-z0-9_-]*$/) as z.ZodType<TimelineClipId>, fadeFrames = z.number().int().max(108000);
export const PICTURE_MOTION_KINDS = ["push-in", "pull-out", "drift-left", "drift-right", "drift-up", "drift-down"] as const;
export const PICTURE_MOTION_DEFAULT_AMOUNT = 0.08;
/** `amount` is how far the frame travels: 0.08 ends a push 8% closer, and a drift holds that much closer throughout. */
export const PictureMotionSchema = z.object({ kind: z.enum(PICTURE_MOTION_KINDS), amount: z.number().finite().min(0.01).max(0.5) }).strict();
export type PictureMotion = z.infer<typeof PictureMotionSchema>;
/** A fade at an open edge, from or to whatever lies beneath. A crossfade at the same edge takes its place. */
export const PictureFadeSchema = z.object({ inFrames: fadeFrames.min(1).optional(), outFrames: fadeFrames.min(1).optional() }).strict()
  .refine(value => value.inFrames !== undefined || value.outFrames !== undefined, "choose a fade");
export type PictureFade = z.infer<typeof PictureFadeSchema>;
export const PictureMotionCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("picture-motion"), clipId, motion: PictureMotionSchema.nullable() }).strict(),
  // A patch: an edge left out keeps its fade, and 0 removes it.
  z.object({ kind: z.literal("picture-fade"), clipId, inFrames: fadeFrames.min(0).optional(), outFrames: fadeFrames.min(0).optional() }).strict(),
]);
export type PictureMotionCommand = z.infer<typeof PictureMotionCommandSchema>;
export const isPictureMotionCommand = (value: { kind: string }): value is PictureMotionCommand => ["picture-motion", "picture-fade"].includes(value.kind);

export type PictureMotionPosition = { zoom: number; x: number; y: number };
/**
 * The window a moving still shows at `progress` through its time on screen: `zoom` is how much
 * closer than the whole picture, and `x`, `y` place the window in the room that leaves (0 is the
 * left or top edge, 1 the right or bottom). Every value is linear in progress, so the export can
 * interpolate between the two ends and still match the preview frame for frame.
 */
export function pictureMotionAt(motion: PictureMotion, progress: number): PictureMotionPosition {
  const p = Math.max(0, Math.min(1, progress)), held = 1 + motion.amount;
  if (motion.kind === "push-in") return { zoom: 1 + motion.amount * p, x: 0.5, y: 0.5 };
  if (motion.kind === "pull-out") return { zoom: 1 + motion.amount * (1 - p), x: 0.5, y: 0.5 };
  // The picture drifts the way it is named, so the window crosses it the other way.
  if (motion.kind === "drift-left") return { zoom: held, x: p, y: 0.5 };
  if (motion.kind === "drift-right") return { zoom: held, x: 1 - p, y: 0.5 };
  return { zoom: held, x: 0.5, y: motion.kind === "drift-up" ? p : 1 - p };
}

/** The part of a `width` by `height` picture that window covers, in the picture's own pixels. */
export function pictureMotionWindow(at: PictureMotionPosition, width: number, height: number): { x: number; y: number; width: number; height: number } {
  const w = width / at.zoom, h = height / at.zoom;
  return { x: (width - w) * at.x, y: (height - h) * at.y, width: w, height: h };
}

export function applyPictureMotionCommand(tracks: readonly TimelineTrack[], command: PictureMotionCommand, isStill?: (clip: TimelineClip) => boolean): TimelineTrack[] {
  const track = tracks.find(row => row.clips.some(clip => clip.id === command.clipId)), clip = track?.clips.find(row => row.id === command.clipId);
  if (track?.kind !== "picture" || !clip) throw new Error("Choose an existing picture clip");
  let next: TimelineClip;
  if (command.kind === "picture-motion") {
    // Until text has moves of its own, a still's move on it is refused by name rather than as "not a still" (SPEC-065 R-17).
    if (command.motion && clip.source.kind === "text") throw new Error("Text does not move yet");
    if (command.motion && isStill && !isStill(clip)) throw new Error("Motion needs a still image");
    if (command.motion ? clip.motion?.kind === command.motion.kind && clip.motion.amount === command.motion.amount : !clip.motion) return [...tracks];
    const { motion: _was, ...rest } = clip;
    next = command.motion ? { ...rest, motion: command.motion } : rest;
  } else {
    const inFrames = command.inFrames ?? clip.fade?.inFrames ?? 0, outFrames = command.outFrames ?? clip.fade?.outFrames ?? 0;
    if (inFrames === (clip.fade?.inFrames ?? 0) && outFrames === (clip.fade?.outFrames ?? 0)) return [...tracks];
    const { fade: _was, ...rest } = clip;
    next = inFrames || outFrames ? { ...rest, fade: { ...(inFrames ? { inFrames } : {}), ...(outFrames ? { outFrames } : {}) } } : rest;
  }
  return tracks.map(row => row.id !== track.id ? row : { ...row, clips: row.clips.map(value => value.id !== clip.id ? value : next) });
}

/** A split keeps each fade at the edge it was made for: the cut between the halves is hard. */
export function splitPictureFade(left: TimelineClip, right: TimelineClip): [TimelineClip, TimelineClip] {
  const edge = (clip: TimelineClip, key: "inFrames" | "outFrames"): TimelineClip => {
    const { fade, ...rest } = clip, frames = fade?.[key];
    return frames ? { ...rest, fade: key === "inFrames" ? { inFrames: frames } : { outFrames: frames } } : rest;
  };
  return [edge(left, "inFrames"), edge(right, "outFrames")];
}

export function pictureMotionStructureProblem(tracks: readonly TimelineTrack[]): string | null {
  return tracks.some(track => track.kind !== "picture" && track.clips.some(clip => clip.motion || clip.fade)) ? "Motion and fades belong only to picture clips" : null;
}
