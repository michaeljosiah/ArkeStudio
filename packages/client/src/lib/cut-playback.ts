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
  /**
   * A single frame rather than a timeline, so it needs an element that decodes images.
   *
   * Only a placed clip can be one: a shot's take and a spine segment are always footage. A
   * browser does not decode a PNG as video, so feeding a still to the `<video>` shows nothing at
   * all — the preview would be blank for an image-only production while the export holds that
   * still for its whole placement.
   */
  still?: boolean;
  /** The base clip playing under an overlay (rounds eight and nine): the base video keeps running while the overlay sits on top. */
  under?: { path: string; mediaInSec: number };
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

/**
 * What plays at a given second of a production that has no story (issue 453).
 *
 * The third derivation, and the one with no clock of its own to walk: there are no shots and no
 * track, only the clips somebody placed, so the spans come from where they were placed and the
 * holes between them are genuinely empty rather than missing.
 *
 * Takes the RESOLVED overlays — what `exportOverlays` returns — rather than raw lane records, so
 * the preview shows exactly what the export will render. That resolution is what drops a document
 * or an audio-only clip, and it also decides compositing: overlays come back ordered lane, then
 * start, and the exporter chains them in that order, so the LAST one covering a moment is the one
 * on top. Reading the first would show the picture underneath and disagree with the file.
 */
export function mediaSpans(
  overlays: readonly { path: string; startSec: number; endSec: number; still: boolean }[],
): PlaybackSpan[] {
  if (overlays.length === 0) return [];
  // Every edge any clip begins or ends on. Between two adjacent edges the answer cannot change,
  // which is what makes the result contiguous and orderable without walking frame by frame.
  const edges = [...new Set(overlays.flatMap((o) => [o.startSec, o.endSec]))].sort((a, b) => a - b);
  const spans: PlaybackSpan[] = [];
  let at = edges[0]!;
  // The film starts at zero even when the first clip does not: leading emptiness is part of it.
  if (at > 0) {
    spans.push({ startSec: 0, endSec: at, path: null, mediaInSec: 0, label: "" });
  }
  for (let i = 0; i < edges.length - 1; i += 1) {
    const start = edges[i]!;
    const end = edges[i + 1]!;
    const covering = overlays.filter((o) => o.startSec <= start && o.endSec > start);
    const top = covering[covering.length - 1] ?? null;
    spans.push({
      startSec: start,
      endSec: end,
      path: top?.path ?? null,
      // A clip plays from its own start, so entering it late means entering the file late. A
      // still has one frame and no timeline to be at an offset into.
      mediaInSec: top === null || top.still ? 0 : start - top.startSec,
      label: top === null ? "" : (top.path.split("/").pop() ?? ""),
      still: top?.still ?? false,
    });
    at = end;
  }
  return spans;
}

/** Where the base video element should be: the base under an overlay, else the span's own media. */
export function videoTimeFor(span: PlaybackSpan, seconds: number): number {
  if (span.under !== undefined) return span.under.mediaInSec + Math.max(0, seconds - span.startSec);
  return mediaTimeFor(span, seconds);
}
