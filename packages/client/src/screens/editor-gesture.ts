import type { TimelineClip, TimelineClipId } from "@arke-studio/contracts";
import { framesFromDelta, type PictureGesture } from "../lib/picture-edit.js";
import { autoScrollStep, snapFrame, snapMoveDelta } from "../lib/clip-gesture.js";

/**
 * The one pointer engine behind a clip drag on any lane (issue 1034).
 *
 * Both track kinds used to run their own copy of the same listeners and preview by applying the
 * eventual command to the record — which followed the hand on a typed lane, where the command is
 * a frame, and jumped on the sequence, where the command is an order. The engine says nothing
 * about commands. It turns pointer motion into a snapped frame delta and reports it, scrolls the
 * canvas when the hand nears its edge, and ends the gesture on release, cancel or Escape. What
 * the lane draws from that, and what it sends on release, stays the lane's.
 */

/** Pixels within which an edge is pulled onto a snap candidate (Clipchamp's feel at 1×). */
export const SNAP_PX = 8;

export interface GestureUpdate {
  clipId: TimelineClipId;
  gesture: PictureGesture;
  /** The pointer's travel in frames, after snapping. */
  deltaFrames: number;
  /** The candidate an edge snapped onto, or null. */
  snappedTo: number | null;
  /** The pointer's x within the lane, in pixels — where the time chip sits. */
  pointerX: number;
  /** Whether the pointer has moved at all since the press. */
  moved: boolean;
}

export interface GestureOptions {
  /** The press. Its `currentTarget` takes pointer capture. */
  event: { button: number; pointerId: number; clientX: number; currentTarget: EventTarget | null; preventDefault(): void; stopPropagation(): void };
  /** The lane the clip sits in; its width is the whole span. */
  lane: HTMLElement;
  /** The scroll container, for auto-scroll; null when there is none to scroll. */
  canvas: HTMLElement | null;
  totalFrames: number;
  clip: TimelineClip;
  gesture: PictureGesture;
  /** Absolute frames an edge may snap onto; null when Snap is off. */
  snapFrames: readonly number[] | null;
  onUpdate: (update: GestureUpdate) => void;
  /** Release. Null when the gesture was cancelled or never moved: nothing is written. */
  onEnd: (update: GestureUpdate | null) => void;
}

/** Attach the gesture to a press. Returns false when the press could not start one. */
export function startClipGesture(options: GestureOptions): boolean {
  const { event, lane, canvas, clip, gesture } = options;
  const element = event.currentTarget as (HTMLElement & Partial<Pick<HTMLElement, "setPointerCapture" | "releasePointerCapture">>) | null;
  if (element === null) return false;
  const span = Math.max(options.totalFrames, 1);
  const laneWidth = lane.getBoundingClientRect().width;
  if (laneWidth <= 0) return false;
  event.preventDefault();
  event.stopPropagation();
  if (typeof element.setPointerCapture === "function") {
    try { element.setPointerCapture(event.pointerId); } catch { /* a synthetic press has no pointer to capture */ }
  }
  const originX = event.clientX;
  const laneLeft = lane.getBoundingClientRect().left;
  const threshold = Math.max(1, framesFromDelta(SNAP_PX, laneWidth, span));
  let scrolled = 0;
  let lastClientX = originX;
  let bypass = false;
  let frame = 0;
  let ended = false;

  const compute = (clientX: number): GestureUpdate => {
    const rawDelta = framesFromDelta(clientX - originX + scrolled, laneWidth, span);
    const candidates = options.snapFrames;
    let deltaFrames = rawDelta;
    let snappedTo: number | null = null;
    if (candidates !== null && candidates.length > 0) {
      if (gesture === "move") {
        const snapped = snapMoveDelta(clip.startFrame, clip.durationFrames, rawDelta, candidates, threshold, bypass);
        deltaFrames = snapped.deltaFrames;
        snappedTo = snapped.snappedTo;
      } else {
        const edge = gesture === "trim-start" ? clip.startFrame : clip.startFrame + clip.durationFrames;
        const snapped = snapFrame(edge + rawDelta, candidates, threshold, bypass);
        deltaFrames = snapped.frame - edge;
        snappedTo = snapped.snappedTo;
      }
    }
    return {
      clipId: clip.id,
      gesture,
      deltaFrames,
      snappedTo,
      pointerX: clientX - laneLeft + scrolled,
      moved: clientX !== originX || scrolled !== 0,
    };
  };
  const report = () => options.onUpdate(compute(lastClientX));
  const tick = () => {
    frame = 0;
    if (ended || canvas === null) return;
    const box = canvas.getBoundingClientRect();
    const step = autoScrollStep(lastClientX, box.left, box.right);
    if (step !== 0) {
      const before = canvas.scrollLeft;
      canvas.scrollLeft = before + step;
      const actual = canvas.scrollLeft - before;
      if (actual !== 0) {
        scrolled += actual;
        report();
      }
    }
    if (step !== 0 && typeof requestAnimationFrame === "function") frame = requestAnimationFrame(tick);
  };
  const move = (pointer: PointerEvent) => {
    lastClientX = pointer.clientX;
    bypass = pointer.altKey === true;
    report();
    if (frame === 0 && canvas !== null && typeof requestAnimationFrame === "function") {
      const box = canvas.getBoundingClientRect();
      if (autoScrollStep(lastClientX, box.left, box.right) !== 0) frame = requestAnimationFrame(tick);
    }
  };
  const finish = () => {
    ended = true;
    if (frame !== 0 && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
    element.removeEventListener("pointermove", move);
    element.removeEventListener("pointerup", up);
    element.removeEventListener("pointercancel", cancel);
    if (typeof window !== "undefined") window.removeEventListener("keydown", onKey, true);
  };
  const up = (pointer: PointerEvent) => {
    if (typeof element.releasePointerCapture === "function") {
      try { element.releasePointerCapture(pointer.pointerId); } catch { /* never captured */ }
    }
    lastClientX = pointer.clientX;
    bypass = pointer.altKey === true;
    const final = compute(lastClientX);
    finish();
    // A click that only selected writes nothing: a gesture that never moved is not an edit.
    options.onEnd(final.moved ? final : null);
  };
  // A gesture the browser took away — a touch the OS claimed, capture lost — was never completed.
  const cancel = () => {
    finish();
    options.onEnd(null);
  };
  // Escape drops the gesture where it is (Clipchamp): the ghost goes home and nothing is sent.
  const onKey = (key: KeyboardEvent) => {
    if (key.key !== "Escape") return;
    key.preventDefault();
    key.stopPropagation();
    cancel();
  };
  element.addEventListener("pointermove", move);
  element.addEventListener("pointerup", up);
  element.addEventListener("pointercancel", cancel);
  if (typeof window !== "undefined") window.addEventListener("keydown", onKey, true);
  return true;
}
