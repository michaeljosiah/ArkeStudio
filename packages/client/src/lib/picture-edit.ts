import {
  TimelineOperationRefused,
  applyTimelineCommands,
  orderedTrackClips,
  type ProductionTimeline,
  type SourceLengthFrames,
  type TimelineClip,
  type TimelineClipCommand,
  type TimelineClipId,
} from "@arke-studio/contracts";

/**
 * What a pointer gesture on a Picture clip becomes (SPEC-037 R-23, SPEC-039 R-18).
 *
 * Pure and away from the handlers for the reason every gesture in this repo ends up there: the
 * handler measures pixels, and everything that can be wrong — an edge crossing its neighbour, a
 * trim reaching before the source's first frame, a drop that changes nothing — is arithmetic
 * that needs no DOM to be tested. A completed gesture yields exactly one command, or none.
 */

export type PictureGesture = "move" | "trim-start" | "trim-end";

/** Whole frames for a horizontal pointer delta across a lane that spans `totalFrames`. */
export function framesFromDelta(deltaPx: number, laneWidthPx: number, totalFrames: number): number {
  if (laneWidthPx <= 0 || totalFrames <= 0 || !Number.isFinite(deltaPx)) return 0;
  return Math.round((deltaPx / laneWidthPx) * totalFrames);
}

/** The frame under a pointer at `x` pixels into a lane that spans `totalFrames`. */
export function frameAtPixel(xPx: number, laneWidthPx: number, totalFrames: number): number {
  if (laneWidthPx <= 0 || totalFrames <= 0) return 0;
  return Math.max(0, Math.min(totalFrames, Math.round((xPx / laneWidthPx) * totalFrames)));
}

const clamp = (value: number, low: number, high: number): number => Math.min(Math.max(value, low), high);

/**
 * The one command a completed gesture sends, or null when the pointer came back to where it
 * started. Trims are clamped to what the neighbours and the source allow, so the live preview
 * and the command agree and the coordinator is never asked for a range it will refuse.
 *
 * A move on a sequence track is a reorder: the clip lands where its centre was dropped among the
 * other clips' centres, and the holes stay in their slots (`move-to-order`). Dragging a clip
 * along by frames is a different intent and has its own command; the Picture track's drag is
 * the reorder because that is what the target editor's drag does.
 */
export function pictureDragCommand(
  clips: readonly TimelineClip[],
  clipId: TimelineClipId,
  gesture: PictureGesture,
  deltaFrames: number,
  sourceLength: SourceLengthFrames = () => undefined,
): TimelineClipCommand | null {
  const ordered = orderedTrackClips({ clips: [...clips] });
  const index = ordered.findIndex((clip) => clip.id === clipId);
  if (index < 0 || deltaFrames === 0) return null;
  const clip = ordered[index]!;
  const previous = ordered[index - 1];
  const following = ordered[index + 1];
  if (gesture === "move") {
    const centre = clip.startFrame + clip.durationFrames / 2 + deltaFrames;
    const others = ordered.filter((candidate) => candidate.id !== clipId);
    const target = others.filter((candidate) => candidate.startFrame + candidate.durationFrames / 2 < centre).length;
    return target === index ? null : { kind: "move-to-order", clipId, index: target };
  }
  if (gesture === "trim-start") {
    const earliest = -Math.min(clip.sourceInFrames, clip.startFrame - (previous ? previous.startFrame + previous.durationFrames : 0));
    const delta = clamp(deltaFrames, earliest, clip.durationFrames - 1);
    return delta === 0 ? null : { kind: "trim", clipId, edge: "start", deltaFrames: delta };
  }
  const available = sourceLength(clip);
  const bySource = available === undefined ? Number.MAX_SAFE_INTEGER : available - clip.sourceInFrames - clip.durationFrames;
  const latest = Math.min(following ? following.startFrame - (clip.startFrame + clip.durationFrames) : Number.MAX_SAFE_INTEGER, bySource);
  const delta = clamp(deltaFrames, -(clip.durationFrames - 1), latest);
  return delta === 0 ? null : { kind: "trim", clipId, edge: "end", deltaFrames: delta };
}

/**
 * The one command a completed gesture on a Dialogue, Ambience, Music or overlay Picture track
 * sends. These tracks are not sequences: a move is a move by frame, and landing on a neighbour
 * is refused by the algebra rather than resolved by reordering (issue 681).
 */
export function trackDragCommand(
  clips: readonly TimelineClip[],
  clipId: TimelineClipId,
  gesture: PictureGesture,
  deltaFrames: number,
  sourceLength: SourceLengthFrames = () => undefined,
): TimelineClipCommand | null {
  if (gesture !== "move") return pictureDragCommand(clips, clipId, gesture, deltaFrames, sourceLength);
  const clip = clips.find((candidate) => candidate.id === clipId);
  if (clip === undefined || deltaFrames === 0) return null;
  const startFrame = Math.max(0, clip.startFrame + deltaFrames);
  return startFrame === clip.startFrame ? null : { kind: "move-to-frame", clipId, startFrame };
}

/** The timeline as it would read after `commands`, or null when the batch would be refused. */
export function previewTimeline(
  timeline: ProductionTimeline,
  commands: readonly TimelineClipCommand[],
  sourceLength?: SourceLengthFrames,
): ProductionTimeline | null {
  if (commands.length === 0) return timeline;
  try {
    return applyTimelineCommands(timeline, commands, sourceLength === undefined ? {} : { sourceLength });
  } catch (error) {
    if (error instanceof TimelineOperationRefused) return null;
    throw error;
  }
}

/** The clip playing at `frame`, or null on empty timeline. */
export function clipAtFrame(clips: readonly TimelineClip[], frame: number): TimelineClip | null {
  return clips.find((clip) => frame >= clip.startFrame && frame < clip.startFrame + clip.durationFrames) ?? null;
}

/** How far the track reaches, so the canvas has an end to draw to. */
export function trackEndFrame(clips: readonly TimelineClip[]): number {
  return clips.reduce((end, clip) => Math.max(end, clip.startFrame + clip.durationFrames), 0);
}
