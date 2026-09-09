import { orderedTrackClips, type TimelineClip, type TimelineClipId } from "@arke-studio/contracts";

/**
 * What a drag shows before it commits (issue 1034), kept pure beside `picture-edit.ts`.
 *
 * The command a drag sends is decided there and is unchanged: a move on the sequence is still a
 * reorder, a move on a typed lane is still a frame. What was missing is everything between the
 * press and the release — where the hand is, where the record will put the clip, which edge it
 * snapped to, how far the canvas should scroll — and every one of those is arithmetic that needs
 * no DOM to be wrong.
 */

export interface SnapResult {
  frame: number;
  /** The candidate the frame was pulled onto, or null when nothing was close enough. */
  snappedTo: number | null;
}

/** Pull `frame` onto the nearest candidate within `threshold` frames; the first nearest wins a tie. */
export function snapFrame(frame: number, candidates: readonly number[], threshold: number, bypass = false): SnapResult {
  if (bypass || threshold <= 0) return { frame, snappedTo: null };
  let best: number | null = null;
  let bestGap = threshold;
  for (const candidate of candidates) {
    const gap = Math.abs(frame - candidate);
    if (gap < bestGap || (gap === bestGap && best === null && gap <= threshold)) {
      bestGap = gap;
      best = candidate;
    }
  }
  return best === null ? { frame, snappedTo: null } : { frame: best, snappedTo: best };
}

/**
 * Snap a moving clip by whichever of its two edges is nearer a candidate. The delta is what moves,
 * so the answer is a delta: the same one the algebra then receives.
 */
export function snapMoveDelta(
  startFrame: number,
  durationFrames: number,
  deltaFrames: number,
  candidates: readonly number[],
  threshold: number,
  bypass = false,
): SnapResult & { deltaFrames: number } {
  const head = snapFrame(startFrame + deltaFrames, candidates, threshold, bypass);
  const tail = snapFrame(startFrame + durationFrames + deltaFrames, candidates, threshold, bypass);
  const headGap = head.snappedTo === null ? Infinity : Math.abs(head.frame - (startFrame + deltaFrames));
  const tailGap = tail.snappedTo === null ? Infinity : Math.abs(tail.frame - (startFrame + durationFrames + deltaFrames));
  if (headGap === Infinity && tailGap === Infinity) return { frame: startFrame + deltaFrames, snappedTo: null, deltaFrames };
  if (headGap <= tailGap) return { frame: head.frame, snappedTo: head.snappedTo, deltaFrames: head.frame - startFrame };
  return { frame: tail.frame - durationFrames, snappedTo: tail.snappedTo, deltaFrames: tail.frame - durationFrames - startFrame };
}

/** Every edge on the timeline a drag can land against, plus the playhead and zero. */
export function snapCandidates(
  tracks: ReadonlyArray<{ clips: readonly TimelineClip[] }>,
  playheadFrame: number,
  except: TimelineClipId | null = null,
): number[] {
  const edges = new Set<number>([0, playheadFrame]);
  for (const track of tracks) {
    for (const clip of track.clips) {
      if (clip.id === except) continue;
      edges.add(clip.startFrame);
      edges.add(clip.startFrame + clip.durationFrames);
    }
  }
  return [...edges].sort((a, b) => a - b);
}

export interface ReorderPreview {
  /** The ordinal the clip would take among the others — the `move-to-order` index. */
  index: number;
  /** The clip's own ordinal now. */
  from: number;
  /** Where the slot begins, in the current layout's frames. */
  slotStartFrame: number;
  /** How far each other clip slides to open the slot, keyed by id; absent means it stays. */
  shifts: Map<TimelineClipId, number>;
}

/**
 * Where the sequence will put a clip whose centre has moved by `deltaFrames`, and what the
 * neighbours do to make room. The index rule is `pictureDragCommand`'s exactly — the clip lands
 * where its centre falls among the others' centres — so the slot drawn during the drag is the
 * slot the command lands in.
 */
export function reorderPreview(clips: readonly TimelineClip[], clipId: TimelineClipId, deltaFrames: number): ReorderPreview | null {
  const ordered = orderedTrackClips({ clips: [...clips] });
  const from = ordered.findIndex((clip) => clip.id === clipId);
  if (from < 0) return null;
  const clip = ordered[from]!;
  const centre = clip.startFrame + clip.durationFrames / 2 + deltaFrames;
  const others = ordered.filter((candidate) => candidate.id !== clipId);
  const index = others.filter((candidate) => candidate.startFrame + candidate.durationFrames / 2 < centre).length;
  const shifts = new Map<TimelineClipId, number>();
  if (index === from) return { index, from, slotStartFrame: clip.startFrame, shifts };
  if (index > from) {
    // Later: the clips between slide left into the hole the clip leaves; the slot opens after the last of them.
    for (let ordinal = from; ordinal < index; ordinal += 1) shifts.set(others[ordinal]!.id, -clip.durationFrames);
    const last = others[index - 1]!;
    return { index, from, slotStartFrame: last.startFrame + last.durationFrames - clip.durationFrames, shifts };
  }
  // Earlier: the clips between slide right; the slot opens where the first of them stood.
  for (let ordinal = index; ordinal < from; ordinal += 1) shifts.set(others[ordinal]!.id, clip.durationFrames);
  return { index, from, slotStartFrame: others[index]!.startFrame, shifts };
}

/**
 * How far to scroll the canvas this frame for a pointer at `pointerX`: nothing in the middle,
 * faster the deeper the pointer sits in an edge band, capped so the canvas never outruns the hand.
 */
export function autoScrollStep(pointerX: number, left: number, right: number, edgePx = 28, maxPx = 18): number {
  if (right - left <= edgePx * 2) return 0;
  if (pointerX < left + edgePx) return -Math.ceil(((left + edgePx - pointerX) / edgePx) * maxPx);
  if (pointerX > right - edgePx) return Math.ceil(((pointerX - (right - edgePx)) / edgePx) * maxPx);
  return 0;
}

/** What a desktop file says it is while it is still only being dragged over the window. */
export type DroppedKind = "video" | "audio" | "image" | "unknown";

/**
 * The kinds of the files in a drag, read from the MIME types the browser exposes during
 * `dragover` — the one thing it will say about a file before it is dropped. An engine that
 * exposes no items says only that there are files, which reads as one unknown.
 */
export function fileKindsFromTransfer(transfer: {
  items?: ArrayLike<{ kind: string; type: string }> | null;
  types: ArrayLike<string> | readonly string[];
}): DroppedKind[] {
  const types = Array.from(transfer.types as ArrayLike<string>);
  if (!types.includes("Files")) return [];
  const items = transfer.items ? Array.from(transfer.items as ArrayLike<{ kind: string; type: string }>) : [];
  const kinds = items
    .filter((item) => item.kind === "file")
    .map((item): DroppedKind => {
      const type = item.type.toLowerCase();
      if (type.startsWith("video/")) return "video";
      if (type.startsWith("audio/")) return "audio";
      if (type.startsWith("image/")) return "image";
      return "unknown";
    });
  return kinds.length === 0 ? ["unknown"] : kinds;
}

/**
 * Whether a lane can take these files, from what is known of them. A sound lane takes sound and
 * video (a video may carry sound; only the import can say); a picture lane takes video and
 * stills. A file the browser cannot name is let through: the import reads it and says.
 */
export function laneTakesFiles(kinds: readonly DroppedKind[], wantsSound: boolean): boolean {
  return kinds.every((kind) => kind === "unknown" || (wantsSound ? kind !== "image" : kind !== "audio"));
}
