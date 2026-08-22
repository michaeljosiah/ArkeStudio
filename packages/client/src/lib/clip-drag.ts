import { snapToPoints } from "./timeline-drag.js";

/**
 * What a drag does to a placed clip (lanes).
 *
 * Kept pure and away from the pointer handlers for the reason every gesture in this repo ends up
 * there: the arithmetic is where the bugs are — an edge that crosses its opposite, a clip dragged
 * off the end of the film, a lane below the bottom one — and none of it needs a DOM to be wrong.
 * The handlers measure pixels; this decides what the clip becomes.
 */

export type ClipGesture = "move" | "trim-start" | "trim-end";

export interface ClipPlacement {
  startSec: number;
  endSec: number;
  lane: number;
}

export interface ClipBounds {
  totalSec: number;
  maxLane: number;
  /** Shot and section boundaries, so a clip lands on a cut rather than near it. */
  snapPoints: readonly number[];
}

/** Something has to survive the drag: a clip shorter than this is not a window, it is a mistake. */
export const MIN_CLIP_SEC = 0.1;

const clamp = (value: number, low: number, high: number): number => Math.min(Math.max(value, low), high);

/** Milliseconds are the resolution the file stores; anything finer is noise a float invented. */
const tidy = (seconds: number): number => Math.round(seconds * 1000) / 1000;

export function applyClipDrag(
  origin: ClipPlacement,
  gesture: ClipGesture,
  deltaSec: number,
  deltaLanes: number,
  bounds: ClipBounds,
): ClipPlacement {
  const lane = clamp(origin.lane + deltaLanes, 0, bounds.maxLane);
  if (gesture === "move") {
    /*
     * The duration is fixed, so the clamp is on the whole clip rather than on either edge: a clip
     * dragged past the end stops with its tail on the end, instead of being squashed against it.
     */
    const span = origin.endSec - origin.startSec;
    const wanted = snapToPoints(origin.startSec + deltaSec, bounds.snapPoints);
    const startSec = clamp(wanted, 0, Math.max(0, bounds.totalSec - span));
    return { startSec: tidy(startSec), endSec: tidy(startSec + span), lane };
  }
  /*
   * Both edge gestures clamp between a floor and a ceiling that can cross each other, and a
   * crossed clamp does not refuse — it returns the ceiling. `clamp(v, 50.1, 40)` is 40, which is
   * an end before its own start.
   *
   * It is reachable without anybody dragging anything strange: the film shrinks under a clip that
   * is already placed whenever a shot is deleted, a take is un-accepted, or a shorter master track
   * is assigned. The window is then outside a film that has no room for it, and there is no
   * honest edge to offer — so the gesture returns the clip unchanged rather than filing a window
   * the coordinator would refuse and the lane would draw as a sliver.
   */
  if (gesture === "trim-start") {
    const ceiling = origin.endSec - MIN_CLIP_SEC;
    if (ceiling < 0) return { ...origin, lane };
    const wanted = snapToPoints(origin.startSec + deltaSec, bounds.snapPoints);
    const startSec = clamp(wanted, 0, ceiling);
    return { startSec: tidy(startSec), endSec: tidy(origin.endSec), lane };
  }
  const floor = origin.startSec + MIN_CLIP_SEC;
  if (floor > bounds.totalSec) return { ...origin, lane };
  const wanted = snapToPoints(origin.endSec + deltaSec, bounds.snapPoints);
  const endSec = clamp(wanted, floor, bounds.totalSec);
  return { startSec: tidy(origin.startSec), endSec: tidy(endSec), lane };
}

/**
 * Where the cuts are, for a clip to snap to (lanes).
 *
 * Zero and the end are included because the two placements people actually reach for are "from
 * the top" and "to the end", and neither is a shot boundary.
 */
export function snapPointsFor(spanStarts: readonly number[], totalSec: number): number[] {
  return [...new Set([0, ...spanStarts, totalSec])].sort((a, b) => a - b);
}
