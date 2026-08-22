import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CutFileSchema,
  CutOverlaySchema,
  newId,
  sortScenes,
  trimCeilingSec,
  type AudioDesign,
  type ProductionBundle,
  type ReviewDecision,
  type Selections,
  type CutFile,
  type ClipAudioMode,
  type CutOverlay,
  type ShotSelection,
} from "@arke-studio/contracts";
import { supersededBy } from "../productions/continuation.js";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import { sha256 } from "../world/text-files.js";
import type { WorldStore } from "../world/store.js";

/**
 * Review (SPEC-013 §2.5, §2.6): decisions append to reviews.jsonl; selections are the small
 * mutable map of what each shot uses. Accepting writes both in ONE commit (R-9, D6) — the
 * journalled primitive is exactly the multi-file atomicity a crash window needs. No proposal,
 * no scene version: scenes are gated, selections are operational (R-8, D7).
 */

async function readOr(store: WorldStore, path: string, fallback: string): Promise<{ raw: string; existed: boolean }> {
  try {
    return { raw: await readFile(toExtendedLength(join(store.dir, fromPortable(path))), "utf8"), existed: true };
  } catch {
    return { raw: fallback, existed: false };
  }
}

/** Accept: record the decision AND set the selection in one commit (R-9); chain continuity (R-12). */
export async function acceptTake(
  store: WorldStore,
  production: ProductionBundle,
  input: { takeId: string; shotId: string; by: string },
): Promise<ReviewDecision> {
  const take = production.takes.find((t) => t.id === input.takeId);
  if (!take) throw new Error(`take ${input.takeId} is not in this production`);
  const reviewsPath = `productions/${production.meta.id}/reviews.jsonl`;
  const selectionsPath = `productions/${production.meta.id}/selections.json`;
  const reviews = await readOr(store, reviewsPath, "");
  const selections = await readOr(store, selectionsPath, "{}");

  const decision: ReviewDecision = {
    ts: store.now(),
    takeId: input.takeId as ReviewDecision["takeId"],
    shotId: input.shotId as ReviewDecision["shotId"],
    decision: "accept",
    by: input.by,
  };

  const map = JSON.parse(selections.raw) as Selections;
  /*
   * A trim belongs to the footage it was measured against (#253).
   *
   * Accepting a *different* take resets it to zero: 4.2 seconds into one clip is not 4.2 seconds
   * into another, and carrying the number over starts the cut at an unrelated moment — with the
   * coordinator's own selection.changed event reporting a zero trim it did not write.
   *
   * The reset therefore comes *after* the spread, not before it. Written the other way round the
   * copied selection silently overwrote the reset, which is the same bug wearing a comment that
   * claimed otherwise. Re-accepting the take already selected leaves the trim alone, because
   * nothing about the footage changed.
   */
  const previous = map[input.shotId];
  const takeChanged = previous?.acceptedTakeId !== decision.takeId;
  let next: Selections = {
    ...map,
    [input.shotId]: {
      trimInSec: 0,
      ...previous,
      acceptedTakeId: decision.takeId,
      ...(takeChanged ? { trimInSec: 0 } : {}),
    },
  };

  // SPEC-019 R-54, D36: anything built by extending the take this shot was using is no longer
  // describing the cut. Marking it is not enough — the cut is derived from selections, so a take
  // that is only flagged stays in the picture while the record says it does not. Clearing the
  // selection makes SPEC-013 R-15 render a labelled gap for free. Nothing is deleted: the take
  // keeps its media, its provenance and its own review decisions, because a reselection is one
  // the user may undo a minute later and paid-for footage should not die for it.
  for (const { shotId } of supersededBy({ changedShotId: input.shotId, selections: map, takes: production.takes })) {
    next = { ...next, [shotId]: { trimInSec: 0, ...next[shotId], acceptedTakeId: null } };
  }

  // Continuity (R-12, D8): the accepted take's final frame seeds the FOLLOWING shot. For a
  // pass segment the frame source is the pass, not the segment — a coinciding boundary must
  // not chain the same frame twice.
  const ordered = sortScenes(production.scenes).flatMap((s) => s.shots);
  const index = ordered.findIndex((s) => s.id === input.shotId);
  const following = index >= 0 ? ordered[index + 1] : undefined;
  if (following) {
    const frameSourceTakeId = take.segment?.passTakeId ?? take.id;
    next[following.id] = { trimInSec: 0, ...next[following.id], startFrameTakeId: frameSourceTakeId as never };
  }

  await store.commit({
    kind: "take-review",
    source: `review:${input.by}`,
    files: [
      {
        path: reviewsPath,
        action: reviews.existed ? "replace" : "create",
        content: reviews.raw + JSON.stringify(decision) + "\n",
        baseHash: reviews.existed ? sha256(reviews.raw) : null,
      },
      {
        path: selectionsPath,
        action: selections.existed ? "replace" : "create",
        content: JSON.stringify(next, null, 2) + "\n",
        baseHash: selections.existed ? sha256(selections.raw) : null,
      },
    ],
  });
  return decision;
}

/**
 * Set where a shot starts inside its selected media (R-8, #253) — the one authored edit the cut
 * offers, and the only writer of `trimInSec` there is.
 *
 * Operational like the selection it sits on: no proposal, no scene version, no review decision.
 * A trim is not an opinion about the take, so nothing is appended to reviews.jsonl; it is a
 * statement about which part of chosen footage is in the picture, and the take itself is never
 * touched (R-1).
 *
 * It refuses in two ways. A shot with no accepted take has no footage to measure against, so a
 * number stored there would be waiting to apply itself to whatever is selected next — exactly
 * the bug acceptTake's reset exists to prevent. And a trim that consumes everything leaves a
 * shot that is silently all slate; the ceiling is asked of the same predicate the cut derives
 * from, so a refusal and the picture cannot disagree.
 */
export async function setTrim(
  store: WorldStore,
  production: ProductionBundle,
  input: { shotId: string; trimInSec: number },
): Promise<ShotSelection> {
  const selectionsPath = `productions/${production.meta.id}/selections.json`;
  const selections = await readOr(store, selectionsPath, "{}");
  const map = JSON.parse(selections.raw) as Selections;
  const current = map[input.shotId];
  const takeId = current?.acceptedTakeId;
  if (!takeId) throw new Error(`shot ${input.shotId} has no accepted take to trim`);

  const ceiling = trimCeilingSec(production, input.shotId, takeId);
  if (!ceiling.ok) throw new Error(`shot ${input.shotId} cannot be trimmed: ${ceiling.reason}`);
  // Absent is "not measured", never "measured zero" (R-5a). Refusing every trim on an unprobed
  // file would disable the control on a machine without ffmpeg, which is a supported way to run.
  if (ceiling.ceilingSec !== undefined && input.trimInSec >= ceiling.ceilingSec) {
    throw new Error(
      `trim of ${input.trimInSec}s leaves nothing of ${ceiling.ceilingSec.toFixed(3)}s of material`,
    );
  }

  const next: Selections = { ...map, [input.shotId]: { ...current, trimInSec: input.trimInSec } };
  await store.commit({
    kind: "shot-trim",
    source: "review:user",
    files: [
      {
        path: selectionsPath,
        action: selections.existed ? "replace" : "create",
        content: JSON.stringify(next, null, 2) + "\n",
        baseHash: selections.existed ? sha256(selections.raw) : null,
      },
    ],
  });
  return next[input.shotId]!;
}

/**
 * Reject: a cited sheet and field are REQUIRED (R-10) — the durable corpus a future
 * "rejections teach the shot" reads. The selection is untouched; the take is untouched.
 */
export async function rejectTake(
  store: WorldStore,
  production: ProductionBundle,
  input: { takeId: string; shotId?: string; by: string; citation: { sheet: string; field: string; note?: string } },
): Promise<ReviewDecision> {
  if (!input.citation.sheet || !input.citation.field) {
    throw new Error("a rejection requires a cited sheet and field (R-10)");
  }
  const reviewsPath = `productions/${production.meta.id}/reviews.jsonl`;
  const reviews = await readOr(store, reviewsPath, "");
  const decision: ReviewDecision = {
    ts: store.now(),
    takeId: input.takeId as ReviewDecision["takeId"],
    ...(input.shotId !== undefined ? { shotId: input.shotId as ReviewDecision["shotId"] } : {}),
    decision: "reject",
    by: input.by,
    citation: input.citation,
  };
  await store.commit({
    kind: "take-review",
    source: `review:${input.by}`,
    files: [
      {
        path: reviewsPath,
        action: reviews.existed ? "replace" : "create",
        content: reviews.raw + JSON.stringify(decision) + "\n",
        baseHash: reviews.existed ? sha256(reviews.raw) : null,
      },
    ],
  });
  return decision;
}

/**
 * The production's audio design, as dispatch needs it (SPEC-019 R-11). Only one question is
 * asked of `cut.json` here: does this cut compose its own score? If it does, the model must not
 * lay music under every clip, because the take would arrive with music baked into audio that
 * cannot be separated from it. A production with no cut file yet composes no score.
 */
export async function audioDesignFor(store: WorldStore, productionId: string): Promise<AudioDesign> {
  const existing = await readOr(store, `productions/${productionId}/cut.json`, "");
  if (!existing.existed) return { scoreTrack: false };
  try {
    const cut = CutFileSchema.parse(JSON.parse(existing.raw));
    return { scoreTrack: cut.audio.some((track) => track.kind === "score" && track.entries.length > 0) };
  } catch {
    // An unreadable cut file is not a reason to refuse a dispatch, and treating it as "no score"
    // only ever adds music the user can still remove — the reverse would bake it in.
    return { scoreTrack: false };
  }
}

/** Save the audio tracks — the only thing cut.json holds (R-16, R-17). */
/**
 * Overlays (82a): the one stored position on the cut, filed beside the audio placement cut.json
 * already holds.
 *
 * Read through `CutFileSchema` rather than merged blind, so a cut.json written before overlays
 * existed comes back with an empty list instead of an undefined one — and so a hand-edited file
 * that no longer parses fails here, loudly, rather than losing a production's audio on write.
 */
async function editOverlays(
  store: WorldStore,
  productionId: string,
  edit: (current: CutOverlay[]) => CutOverlay[],
): Promise<CutFile> {
  const path = `productions/${productionId}/cut.json`;
  const existing = await readOr(store, path, "{}");
  const cut = CutFileSchema.parse(JSON.parse(existing.raw));
  const next: CutFile = { ...cut, overlays: edit(cut.overlays) };
  await store.commit({
    kind: "cut-overlays",
    source: "form",
    files: [
      {
        path,
        action: existing.existed ? "replace" : "create",
        content: JSON.stringify(next, null, 2) + "\n",
        baseHash: existing.existed ? sha256(existing.raw) : null,
      },
    ],
  });
  return next;
}

/** Place an artifact on a lane for a window (82a, lanes). Returns the clip as filed. */
export async function placeOverlay(
  store: WorldStore,
  productionId: string,
  input: { artifactId: string; startSec: number; endSec: number; lane?: number; audio?: ClipAudioMode },
): Promise<CutOverlay> {
  if (input.endSec <= input.startSec) {
    throw new Error(`a clip ending at ${input.endSec}s cannot start at ${input.startSec}s`);
  }
  // A clip cites an artifact; citing one the world does not have would file a placement pointing
  // at nothing, which the cut would then have to render as an absence it cannot explain.
  const known = store.getBundle().artifacts.some((a) => a.id === input.artifactId);
  if (!known) throw new Error(`artifact ${input.artifactId} is not in this world`);

  const overlay = CutOverlaySchema.parse({
    id: newId("ov"),
    artifactId: input.artifactId,
    startSec: input.startSec,
    endSec: input.endSec,
    ...(input.lane !== undefined ? { lane: input.lane } : {}),
    ...(input.audio !== undefined ? { audio: input.audio } : {}),
  });
  await editOverlays(store, productionId, (current) => [...current, overlay]);
  return overlay;
}

/**
 * Move one that is already placed — the same act as placing it, against the same bounds.
 *
 * The lane travels with the move because dragging a clip up a lane and dragging it along the
 * ruler are one gesture to the person doing it; omitting it leaves the clip where it was, so a
 * pure trim does not have to restate which lane it is on.
 */
export async function moveOverlay(
  store: WorldStore,
  productionId: string,
  input: { overlayId: string; startSec: number; endSec: number; lane?: number },
): Promise<CutOverlay> {
  if (input.endSec <= input.startSec) {
    throw new Error(`a clip ending at ${input.endSec}s cannot start at ${input.startSec}s`);
  }
  let moved: CutOverlay | null = null;
  await editOverlays(store, productionId, (current) => {
    const found = current.find((o) => o.id === input.overlayId);
    if (found === undefined) throw new Error(`clip ${input.overlayId} is not on this cut`);
    moved = CutOverlaySchema.parse({
      ...found,
      startSec: input.startSec,
      endSec: input.endSec,
      ...(input.lane !== undefined ? { lane: input.lane } : {}),
    });
    return current.map((o) => (o.id === input.overlayId ? moved! : o));
  });
  return moved!;
}

/**
 * Split a clip's sound onto the lane below it (lanes).
 *
 * Two clips over one file, which is what every editor means by the word: the picture stays
 * exactly where it was and stops carrying sound, and the sound becomes its own clip on the next
 * lane down, over the same window. Nothing is copied and nothing is transcoded — both halves
 * still cite the one artifact, and undoing the split is deleting one of them.
 *
 * It refuses rather than producing a half that can never sound. A still has no audio track to
 * separate, and a clip already split is not split again — the second call would file a third
 * placement over the same seconds and the mix would count the same sound twice.
 */
export async function splitOverlayAudio(
  store: WorldStore,
  productionId: string,
  overlayId: string,
): Promise<CutOverlay> {
  const bundle = store.getBundle();
  let sound: CutOverlay | null = null;
  await editOverlays(store, productionId, (current) => {
    const found = current.find((o) => o.id === overlayId);
    if (found === undefined) throw new Error(`clip ${overlayId} is not on this cut`);
    if (found.audio !== "keep") {
      throw new Error(`clip ${overlayId} has already been split`);
    }
    const artifact = bundle.artifacts.find((a) => a.id === found.artifactId);
    if (artifact === undefined) throw new Error(`artifact ${found.artifactId} is not in this world`);
    if (artifact.kind !== "video") {
      throw new Error(`a ${artifact.kind} has no sound to split from its picture`);
    }
    /*
     * Being a video is not evidence of a soundtrack, and this function's promise is that it never
     * produces a half that can never sound. The exporter takes a video's audio only when the
     * measurement says it has some, so splitting one measured silent would mute the picture for
     * good and file a sound half every encode then discards.
     *
     * The two silences are different facts and say so: measured-and-empty is settled, while
     * not-yet-measured is the window between filing a video and its probe landing, and telling
     * somebody to try again is only useful if it is true.
     */
    if (artifact.mediaInfo === undefined) {
      throw new Error(`${artifact.file} has not been measured yet — its sound cannot be split until it has`);
    }
    if (!artifact.mediaInfo.hasAudio) {
      throw new Error(`${artifact.file} was measured as silent, so there is no sound to split off`);
    }
    // The lane below, floored at zero: splitting the bottom clip leaves both halves sharing a
    // lane, which mixes and composites exactly the same and is one fewer surprise than refusing.
    const lane = Math.max(0, (found.lane ?? 0) - 1);
    sound = CutOverlaySchema.parse({ ...found, id: newId("ov"), lane, audio: "only" });
    return [...current.map((o) => (o.id === overlayId ? { ...o, audio: "mute" as const } : o)), sound];
  });
  return sound!;
}

/**
 * Put a split back together (lanes).
 *
 * Splitting is otherwise a one-way door: `audio` has no other writer, so a picture muted by a
 * split stays muted for the life of the clip and the only escape is deleting it and dropping the
 * file again, losing the window and the lane it was placed in.
 *
 * Rejoining is the exact inverse and nothing more — the picture carries its own sound again, and
 * the sound half the split created is removed. Removing it is what keeps the mix honest: leaving
 * both would count the same sound twice, once from the picture and once from its twin.
 */
export async function rejoinOverlayAudio(store: WorldStore, productionId: string, overlayId: string): Promise<CutOverlay> {
  let rejoined: CutOverlay | null = null;
  await editOverlays(store, productionId, (current) => {
    const found = current.find((o) => o.id === overlayId);
    if (found === undefined) throw new Error(`clip ${overlayId} is not on this cut`);
    if (found.audio !== "mute") throw new Error(`clip ${overlayId} is not a split picture`);
    rejoined = { ...found, audio: "keep" };
    /*
     * The twin is the sound half over the same file and the same window. Matched rather than
     * recorded, because an id pointing at a clip somebody may have deleted or dragged elsewhere
     * is a reference that goes stale silently; a window that no longer matches is a clip the
     * person has since made their own, and taking it away would be taking their edit.
     */
    return current.filter(
      (o) =>
        !(
          o.id !== overlayId &&
          o.audio === "only" &&
          o.artifactId === found.artifactId &&
          o.startSec === found.startSec &&
          o.endSec === found.endSec
        ),
    ).map((o) => (o.id === overlayId ? rejoined! : o));
  });
  return rejoined!;
}

/** Remove the placement. The artifact is untouched: it was only ever cited (82a). */
export async function removeOverlay(store: WorldStore, productionId: string, overlayId: string): Promise<void> {
  await editOverlays(store, productionId, (current) => {
    if (!current.some((o) => o.id === overlayId)) throw new Error(`overlay ${overlayId} is not on this cut`);
    return current.filter((o) => o.id !== overlayId);
  });
}

export async function saveAudioTracks(store: WorldStore, productionId: string, cutJson: string): Promise<void> {
  const path = `productions/${productionId}/cut.json`;
  const existing = await readOr(store, path, "");
  await store.commit({
    kind: "cut-audio",
    source: "form",
    files: [
      {
        path,
        action: existing.existed ? "replace" : "create",
        content: cutJson,
        baseHash: existing.existed ? sha256(existing.raw) : null,
      },
    ],
  });
}
