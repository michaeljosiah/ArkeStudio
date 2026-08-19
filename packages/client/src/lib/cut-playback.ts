import type { DerivedCut, DerivedSpineCut } from "@arke-studio/contracts";

/**
 * What plays at a given second of the cut, on either clock (80a, 81a).
 *
 * The two derivations answer different questions — the story lays shots end to end and sums their
 * authored durations, the song walks the track and asks what covers each moment — but a player
 * only needs one shape: contiguous spans from zero, each either a piece of media with an offset
 * into it, or nothing to show and a reason why. Deriving that here keeps the preview from
 * learning which clock it is on.
 */
export interface PlaybackSpan {
  startSec: number;
  endSec: number;
  /** World-relative media path, or null where there is nothing to play. */
  path: string | null;
  /** Where in the source file this span starts — trim already applied by the derivation. */
  mediaInSec: number;
  label: string;
}

export function spineSpans(cut: DerivedSpineCut): PlaybackSpan[] {
  return cut.segments.map((seg) => ({
    startSec: seg.startSec,
    endSec: seg.endSec,
    path: seg.media?.path ?? null,
    mediaInSec: seg.media?.inSec ?? 0,
    label: seg.label,
  }));
}

export function storySpans(cut: DerivedCut): PlaybackSpan[] {
  const spans: PlaybackSpan[] = [];
  let at = 0;
  for (const entry of cut.entries) {
    spans.push({
      startSec: at,
      endSec: at + entry.durationSec,
      path: entry.media?.path ?? null,
      // A whole take carries no in-point unless it was trimmed; a segment carries the pass range.
      mediaInSec: entry.media?.inSec ?? 0,
      label: entry.label,
    });
    at += entry.durationSec;
  }
  return spans;
}

/**
 * The span covering `seconds`, or null past the end.
 *
 * Spans are contiguous and ordered, so the half-open convention is what stops a boundary reading
 * as two spans at once — the same `[startSec, endSec)` the spine anchors use.
 */
export function spanAt(spans: readonly PlaybackSpan[], seconds: number): PlaybackSpan | null {
  for (const span of spans) {
    if (seconds >= span.startSec && seconds < span.endSec) return span;
  }
  // Landing exactly on the end belongs to the last span, not to nothing.
  const last = spans[spans.length - 1];
  return last !== undefined && seconds >= last.endSec && seconds <= last.endSec ? last : null;
}

/** Where in the source file the transport is, for a span it is inside. */
export function mediaTimeFor(span: PlaybackSpan, seconds: number): number {
  return span.mediaInSec + Math.max(0, seconds - span.startSec);
}
