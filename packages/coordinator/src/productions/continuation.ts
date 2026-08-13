import { copyFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Selections, Take } from "@arke-studio/contracts";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import type { WorldStore } from "../world/store.js";
import type { FfmpegRunner } from "../takes/export.js";
// The probe seam moved to media/probe.ts (#253): the spine, the cut and #248 all measure media,
// so it is no longer continuation's to own. Nothing is imported back — this file defined the
// seam for others and never called it, which is exactly why it was the wrong home.

/**
 * Continuation (SPEC-019 §2.13, R-49..R-54, D33..D36).
 *
 * SPEC-013 R-12 extracts an accepted take's final frame and offers it as the next shot's start
 * frame — a workaround for models that could not take video, losing motion, momentum and the
 * audio running underneath. Extension continues the footage instead.
 *
 * It is the one capability in SPEC-019 that does not drop in cleanly, and it is built knowing
 * that: takes are immutable, carry no review state, and each retries alone, but a continued take
 * depends on a *specific* predecessor take.
 */

export type ContinuationAvailability =
  | { available: true; predecessor: Take }
  | { available: false; reason: string };

/**
 * May this shot continue its predecessor (R-50, R-51)?
 *
 * Two refusals, both named rather than hidden. There is no predecessor take to depend on — the
 * dependency is on a specific take and there is not one yet. Or the predecessor was itself
 * produced by continuation, which is where §1.4's one-hop decision stops being an intention: a
 * decision nothing checks is one an implementation walks straight past, every shot in a scene
 * declaring continuation and a single reselection invalidating the whole tail.
 */
export function continuationAvailable(input: {
  shotIndex: number;
  shots: ReadonlyArray<{ id: string; number: number }>;
  selections: Selections;
  takes: readonly Take[];
}): ContinuationAvailability {
  const previous = input.shots[input.shotIndex - 1];
  if (!previous) {
    return { available: false, reason: "this is the first shot — there is nothing before it to continue" };
  }
  const selectedId = input.selections[previous.id]?.acceptedTakeId ?? null;
  if (!selectedId) {
    return { available: false, reason: `shot ${previous.number} has no accepted take to continue from` };
  }
  const predecessor = input.takes.find((take) => take.id === selectedId);
  if (!predecessor) {
    return { available: false, reason: `shot ${previous.number}'s accepted take is no longer available` };
  }
  if (predecessor.continuedFrom !== undefined) {
    return {
      available: false,
      reason: `shot ${previous.number}'s take was itself continued — continuation stops at one hop, so this would chain`,
    };
  }
  return { available: true, predecessor };
}

/**
 * The media a continuation actually extends (R-49, D33).
 *
 * This is the sharpest edge in the capability. A take derived from a pass owns an **in/out range**
 * into media holding several shots (SPEC-013 R-3) — segments are ranges, not files. Handing the
 * provider that backing file would extend whatever sits at its end, which is usually a different
 * shot entirely, and the result reads as a model failure rather than as the wrong footage being
 * dispatched.
 *
 * So a segment is materialised to its own file first. Never re-encoded, on the same grounds
 * SPEC-013 R-13 gives for frame extraction: a stream copy preserves exactly what was reviewed.
 */
export async function materialiseForContinuation(
  store: WorldStore,
  productionId: string,
  take: Take,
  ffmpeg: FfmpegRunner | null,
  signal: AbortSignal,
): Promise<{ path: string; materialised: boolean }> {
  if (!take.media) throw new Error(`take ${take.id} has no media to continue`);
  // A segment's media lives with the pass that produced it, not with the segment.
  const source = `productions/${productionId}/takes/${take.segment?.passTakeId ?? take.id}/${take.media}`;
  const range = take.segment;
  if (!range) {
    // A whole take is already its own file; nothing to cut, so nothing to copy.
    return { path: source, materialised: false };
  }
  const dir = join(store.dir, "productions", productionId, "continuation");
  await mkdir(toExtendedLength(dir), { recursive: true });
  const out = `productions/${productionId}/continuation/${take.id}.mov`;
  const absoluteOut = join(store.dir, fromPortable(out));
  try {
    // Already cut for an earlier attempt: a retry must not pay to cut the same range twice.
    const existing = await stat(toExtendedLength(absoluteOut));
    if (existing.size > 0) return { path: out, materialised: true };
  } catch {
    /* not cut yet */
  }
  if (!ffmpeg) throw new Error("that take is a pass segment and cannot be cut out without ffmpeg");
  await ffmpeg.run(
    [
      "-ss",
      String(range.inSec),
      "-to",
      String(range.outSec),
      "-i",
      join(store.dir, fromPortable(source)),
      // Stream copy: no re-encode, so what is extended is exactly what was reviewed.
      "-c",
      "copy",
      "-y",
      absoluteOut,
    ],
    () => {},
    signal,
  );
  return { path: out, materialised: true };
}

/**
 * Takes invalidated by a selection change (R-53, R-54, D36).
 *
 * Marking is not enough on its own. The cut is derived from selections, so a take that is only
 * flagged stays in the picture while the record insists it no longer describes it — the mark
 * would be a fact nothing acted on. Superseding therefore clears the continuing shot's selection
 * too, and SPEC-013 R-15 does the rest for free: a shot with no selection renders as a labelled
 * gap.
 *
 * Nothing is deleted. The take keeps its media, its provenance and its own review decisions,
 * because a selection change is one the user may undo a minute later and paid-for footage should
 * not die for it.
 */
export function supersededBy(input: {
  changedShotId: string;
  selections: Selections;
  takes: readonly Take[];
}): Array<{ shotId: string; takeId: string }> {
  const wasSelected = input.selections[input.changedShotId]?.acceptedTakeId ?? null;
  if (!wasSelected) return [];
  const out: Array<{ shotId: string; takeId: string }> = [];
  for (const [shotId, selection] of Object.entries(input.selections)) {
    const selectedId = selection?.acceptedTakeId ?? null;
    if (!selectedId || shotId === input.changedShotId) continue;
    const take = input.takes.find((candidate) => candidate.id === selectedId);
    if (take?.continuedFrom === wasSelected) out.push({ shotId, takeId: take.id });
  }
  return out;
}

/** Copy a materialised segment somewhere, used by tests and by the dispatch path alike. */
export async function copyMaterialised(store: WorldStore, from: string, to: string): Promise<void> {
  await mkdir(toExtendedLength(join(store.dir, fromPortable(to), "..")), { recursive: true });
  await copyFile(toExtendedLength(join(store.dir, fromPortable(from))), toExtendedLength(join(store.dir, fromPortable(to))));
}
