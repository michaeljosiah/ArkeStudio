import { z } from "zod";
import type { TimelineClip, TimelineClipId, TimelineTrack } from "./timeline.js";

/*
 * A video clip's speed and direction (SPEC-037 R-35 – R-42).
 *
 * The Cut could place a video and trim it, and nothing else: a clip that had to end on its first
 * frame, or fill a slot a fifth longer than itself, was rendered outside the Studio and uploaded
 * as a new file, which lost the link to the clip it came from. These two fields keep it.
 *
 * A re-timed clip is counted in frames of the re-timed source. `sourceInFrames` and
 * `durationFrames` stay whole frames of the production clock, and frame `n` of the re-timed
 * source is the source at `n × speed` of its own frames. So a clip of D frames consumes
 * `D × speed` frames of source, and a trim or a split moves by whole frames exactly as it does
 * at speed 1, with no fraction of a source frame to round or to lose between two halves.
 *
 * A reversed clip shows the frames it would show forwards, last first. Its source window does
 * not move when it is turned round, which is what lets Reverse be undone by Reverse.
 */

const clipId = z.string().regex(/^cl_[A-Za-z0-9][A-Za-z0-9_-]*$/) as z.ZodType<TimelineClipId>;

export const CLIP_SPEED_MIN = 0.25;
export const CLIP_SPEED_MAX = 4;
/** In hundredths, so 1.05 is a speed and a figure a person types is the figure the record holds. */
export const ClipSpeedSchema = z.number().finite().min(CLIP_SPEED_MIN).max(CLIP_SPEED_MAX)
  .refine(value => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6, "a speed is given in hundredths");

export const ClipSpeedCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("set-clip-speed"), clipId, speed: ClipSpeedSchema }).strict(),
  z.object({ kind: z.literal("set-clip-reverse"), clipId, reverse: z.boolean() }).strict(),
]);
export type ClipSpeedCommand = z.infer<typeof ClipSpeedCommandSchema>;
export const isClipSpeedCommand = (value: { kind: string }): value is ClipSpeedCommand => value.kind === "set-clip-speed" || value.kind === "set-clip-reverse";

type Retimed = Pick<TimelineClip, "speed" | "reverse">;

/** The speed a clip plays at: 1 when the record holds none. */
export const clipSpeed = (clip: Pick<TimelineClip, "speed">): number => clip.speed ?? 1;
/** Whether a clip plays at another speed or backwards: such a clip is drawn by the compositor and plays no sound of its own. */
export const clipRetimed = (clip: Retimed): boolean => clipSpeed(clip) !== 1 || clip.reverse === true;

/** How many frames a source of `sourceFrames` supplies at `speed`: the last is the last that still starts inside it. */
export function retimedSourceFrames(sourceFrames: number, speed: number): number {
  return Math.max(0, Math.ceil(sourceFrames / speed - 1e-9));
}

/** Seconds into its source where a clip's window begins, past whatever in-point the source itself has. */
export function clipSourceInSec(clip: Pick<TimelineClip, "sourceInFrames" | "speed">, frameRate: number): number {
  return clip.sourceInFrames * clipSpeed(clip) / frameRate;
}

/**
 * A source frame that starts within this long after a sample counts as on it. The Viewer seeks
 * this far inside the frame it wants, because Chromium keeps time in microseconds and a seek to
 * exactly 10/24 can land on the frame before; the export's re-timed chain allows the same.
 */
export const PICTURE_SAMPLE_TOLERANCE_SEC = 0.0001;

/**
 * Seconds into its source that a layer shows at `frame`. The Viewer seeks to this and the export
 * samples at it, so the two cannot disagree about which frame a re-timed or reversed clip shows.
 */
export function pictureSourceSec(picture: { startFrame: number; endFrame: number; sourceInSec: number; speed?: number; reverse?: true },
  frame: number, frameRate: number): number {
  const sample = picture.reverse ? picture.endFrame - 1 - frame : frame - picture.startFrame;
  return picture.sourceInSec + sample * (picture.speed ?? 1) / frameRate;
}

/**
 * A trimmed clip's in-point. Forwards the head is the window's start, so a head trim moves it;
 * backwards the tail is, so a tail trim moves it the other way and a head trim leaves it alone.
 */
export function trimmedSourceIn(clip: Pick<TimelineClip, "sourceInFrames" | "reverse">, edge: "start" | "end", deltaFrames: number): number {
  if (clip.reverse) return edge === "end" ? clip.sourceInFrames - deltaFrames : clip.sourceInFrames;
  return edge === "start" ? clip.sourceInFrames + deltaFrames : clip.sourceInFrames;
}

/** The in-points of a split's two halves, `offset` frames into the clip: together they are the window it had. */
export function splitSourceIns(clip: Pick<TimelineClip, "sourceInFrames" | "durationFrames" | "reverse">, offset: number): [number, number] {
  return clip.reverse ? [clip.sourceInFrames + clip.durationFrames - offset, clip.sourceInFrames] : [clip.sourceInFrames, clip.sourceInFrames + offset];
}

/**
 * The clip at another speed: the same stretch of source, so it takes more or less time. It keeps
 * its start. Where the next clip or the source's end leaves less room than that, it keeps what
 * plays first and the rest stays in the source, to be trimmed out once there is room.
 *
 * `available` is the source's length in frames at the new speed, `room` the frames to the next
 * clip; either may be unknown.
 */
export function retimedClip(clip: TimelineClip, speed: number, limits: { available?: number; room?: number } = {}): TimelineClip {
  const next = Math.round(speed * 100) / 100, ratio = clipSpeed(clip) / next;
  let sourceInFrames = Math.round(clip.sourceInFrames * ratio), wanted = Math.max(1, Math.round(clip.durationFrames * ratio));
  if (limits.available !== undefined) {
    // Rounding may reach a frame past the end of a source the clip ran to the end of.
    sourceInFrames = Math.min(sourceInFrames, Math.max(0, limits.available - 1));
    wanted = Math.max(1, Math.min(wanted, limits.available - sourceInFrames));
  }
  const durationFrames = Math.max(1, Math.min(wanted, limits.room ?? wanted));
  // Backwards, what plays first is the window's end: the frames given up are at its start.
  if (clip.reverse) sourceInFrames += wanted - durationFrames;
  const { speed: _was, ...rest } = clip;
  return { ...rest, sourceInFrames, durationFrames, ...(next === 1 ? {} : { speed: next }) };
}

/** The clip turned round, or turned back: its window stays where it is. */
export function reversedClip(clip: TimelineClip, reverse: boolean): TimelineClip {
  const { reverse: _was, ...rest } = clip;
  return reverse ? { ...rest, reverse: true } : rest;
}

/** Why a clip cannot be re-timed, or null when it can. `isVideo` is asked only where the sources are known. */
export function clipSpeedProblem(track: Pick<TimelineTrack, "kind">, clip: TimelineClip, isVideo?: (clip: TimelineClip) => boolean): string | null {
  if (track.kind !== "picture") return "Speed and direction belong to a video on a Picture track";
  if (clip.source.kind === "text") return "Text has no speed";
  if (isVideo && !isVideo(clip)) return "Speed and direction need a video";
  return null;
}

export function clipSpeedStructureProblem(tracks: readonly TimelineTrack[]): string | null {
  return tracks.some(track => track.clips.some(clip => (clip.speed !== undefined || clip.reverse !== undefined) && (track.kind !== "picture" || clip.source.kind === "text")))
    ? "Speed and direction belong only to video clips on a Picture track" : null;
}
