/*
 * Timecode, snapping and the scrub-drag gesture.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Portions of this file are derived from LTX-Desktop
 *   https://github.com/Lightricks/LTX-Desktop  (commit 7ec86f3, 2026-08-19)
 *   Copyright (c) Lightricks Ltd.
 *   Licensed under the Apache License, Version 2.0 — see licenses/LICENSE.LTX-Desktop.txt
 *
 * Derived from `frontend/views/editor/video-editor-utils.ts` (formatTime, parseTime,
 * CUT_POINT_TOLERANCE) and `frontend/views/editor/useTimelineDrag.ts` (the resize gesture:
 * pointer capture, pixels→seconds, the 0.2s snap threshold, and commit-once-on-release).
 *
 * Changes made, as Apache-2.0 §4(b) requires:
 *   - `formatTime`/`parseTime` renamed to `formatTimecode`/`parseTimecode`; the upstream 24fps
 *     divisor became an argument with `TIMECODE_FPS` as its legacy default; negative and
 *     non-finite input now clamp rather than producing `NaN:NaN` or a negative frame count.
 *   - The snapping loop, which was inline in the left-edge trim path and read `clip.startTime`
 *     and `clip.duration` off a stored timeline, is generalised to `snapToPoints` over a plain
 *     list of candidate seconds. Arke's cut is derived, so there are no clip records to read.
 *   - The resize gesture, which mutated `{startTime, duration, trimStart, trimEnd, speed,
 *     linkedClipIds, trackIndex}` across a track and then re-resolved overlaps, is reduced to a
 *     scalar drag: one value, clamped, committed once. Arke's trim is a single `trimInSec` on a
 *     selection, and position is derived rather than stored, so none of that machinery applies.
 *   - Mouse events became pointer events with capture, so a drag that leaves the window still
 *     ends; upstream listened on `window` for `mousemove`/`mouseup`.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useCallback, useRef, useState } from "react";

/** Upstream's timecode and Arke's legacy production clock are both 24fps. */
export const TIMECODE_FPS = 24;

/** Upstream's tolerance for treating two edges as the same cut point. */
export const CUT_POINT_TOLERANCE_SEC = 0.05;

/** Upstream's snap threshold on a trim drag, in seconds of timeline. */
export const SNAP_THRESHOLD_SEC = 0.2;

/** `HH:MM:SS:FF` at the production frame rate. Non-finite and negative input read as zero. */
export function formatTimecode(seconds: number, frameRate = TIMECODE_FPS): string {
  const t = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  // Frame-derived seconds often land just below their exact integer when multiplied back.
  const totalFrames = Math.floor(t * frameRate + 1e-7);
  const wholeSeconds = Math.floor(totalFrames / frameRate);
  const hrs = Math.floor(wholeSeconds / 3600);
  const mins = Math.floor((wholeSeconds % 3600) / 60);
  const secs = wholeSeconds % 60;
  const frames = totalFrames % frameRate;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(hrs)}:${pad(mins)}:${pad(secs)}:${pad(frames)}`;
}

/** `HH:MM:SS:FF`, `MM:SS:FF`, `MM:SS` or `SS` back to seconds; null when it does not parse. */
export function parseTimecode(tc: string, frameRate = TIMECODE_FPS): number | null {
  const parts = tc
    .replace(/[^0-9:;]/g, "")
    .replace(/;/g, ":")
    .split(":");
  const n = parts.map((p) => Number.parseInt(p, 10));
  if (n.some(Number.isNaN)) return null;
  if (n.length === 4) return n[0]! * 3600 + n[1]! * 60 + n[2]! + n[3]! / frameRate;
  if (n.length === 3) return n[0]! * 60 + n[1]! + n[2]! / frameRate;
  if (n.length === 2) return n[0]! * 60 + n[1]!;
  if (n.length === 1) return n[0]!;
  return null;
}

/**
 * Pull `value` onto the nearest candidate within `threshold`, or leave it alone.
 *
 * Upstream snapped a trimmed edge to the playhead and to every other clip's start and end. The
 * candidates are the caller's business here — on the song clock they are section markers and
 * anchor boundaries, on the story clock they are shot boundaries.
 */
export function snapToPoints(value: number, points: readonly number[], threshold = SNAP_THRESHOLD_SEC): number {
  let best = value;
  let bestGap = threshold;
  for (const point of points) {
    const gap = Math.abs(value - point);
    if (gap < bestGap) {
      bestGap = gap;
      best = point;
    }
  }
  return best;
}

export interface ScrubDrag {
  /** Attach to the draggable element. */
  onPointerDown: (e: React.PointerEvent) => void;
  /** The value to display: the live drag position while dragging, otherwise the committed one. */
  display: number;
  dragging: boolean;
}

/**
 * Drag a scalar along the x axis, in timeline seconds.
 *
 * This is upstream's hot-path discipline reduced to one number: the in-gesture value is a ref
 * plus one piece of local state for rendering, and the store is written exactly once on release
 * so an undo step — or in Arke's case a commit and a `selection.changed` — is one drag, not one
 * per pointer event.
 */
export function useScrubDrag(opts: {
  value: number;
  pixelsPerSecond: number;
  min?: number;
  max?: number;
  snap?: readonly number[];
  onCommit: (value: number) => void;
}): ScrubDrag {
  const { value, pixelsPerSecond, min = 0, max, snap, onCommit } = opts;
  const [live, setLive] = useState<number | null>(null);
  const origin = useRef<{ x: number; from: number } | null>(null);

  const resolve = useCallback(
    (clientX: number) => {
      const start = origin.current;
      if (start === null || pixelsPerSecond <= 0) return value;
      const delta = (clientX - start.x) / pixelsPerSecond;
      const snapped = snap ? snapToPoints(start.from + delta, snap) : start.from + delta;
      const upper = max === undefined ? snapped : Math.min(snapped, max);
      // Three decimals is a thousandth of a second: finer than a frame at any rate we encode,
      // and enough to keep float drift out of the number that reaches the world on disk.
      return Math.round(Math.max(min, upper) * 1000) / 1000;
    },
    [value, pixelsPerSecond, min, max, snap],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const el = e.currentTarget as HTMLElement;
      el.setPointerCapture(e.pointerId);
      origin.current = { x: e.clientX, from: value };
      setLive(value);

      const move = (ev: PointerEvent) => setLive(resolve(ev.clientX));
      const up = (ev: PointerEvent) => {
        el.releasePointerCapture(ev.pointerId);
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        el.removeEventListener("pointercancel", up);
        const committed = resolve(ev.clientX);
        origin.current = null;
        setLive(null);
        if (committed !== value) onCommit(committed);
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);
    },
    [value, resolve, onCommit],
  );

  return { onPointerDown, display: live ?? value, dragging: live !== null };
}
