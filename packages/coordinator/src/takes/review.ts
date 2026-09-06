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
  hasOwnFrame,
  type Selections,
  type CutFile,
  type ClipAudioMode,
  type CutOverlay,
  type ShotSelection,
  orderedShots,
  resolveProductionArtifact,
} from "@arke-studio/contracts";
import { supersededBy } from "../productions/continuation.js";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import { sha256 } from "../world/text-files.js";
import { WorldStateStaleError, type WorldStatePrecondition, type WorldStore } from "../world/store.js";

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

/** The ordinary clip-selection rules, factored so a board can apply every member in one commit. */
export function applyTakeAcceptance(
  production: ProductionBundle,
  artifacts: Parameters<typeof hasOwnFrame>[1],
  selections: Selections,
  input: { takeId: string; shotId: string; by: string; at: string },
): { decision: ReviewDecision; selections: Selections } {
  const take = production.takes.find((candidate) => candidate.id === input.takeId);
  if (!take) throw new Error(`take ${input.takeId} is not in this production`);
  if (take.boardSheetParent === true) throw new Error(`take ${input.takeId} is a board-sheet parent and cannot be accepted for a shot`);
  if (take.kind === "clip" && take.segment === undefined && take.coversShots.length > 1) {
    throw new Error(`take ${input.takeId} is a backing pass and cannot be accepted for one shot`);
  }
  if (!take.coversShots.includes(input.shotId)) {
    throw new Error(`take ${input.takeId} does not cover shot ${input.shotId}`);
  }
  if (take.kind === "frame" || take.kind === "still") {
    throw new Error(`take ${input.takeId} is a still — accept it as this shot's frame, not as footage`);
  }
  const decision: ReviewDecision = {
    ts: input.at,
    takeId: input.takeId as ReviewDecision["takeId"],
    shotId: input.shotId as ReviewDecision["shotId"],
    decision: "accept",
    by: input.by,
  };
  const previous = selections[input.shotId];
  const takeChanged = previous?.acceptedTakeId !== decision.takeId;
  const targetScene = sortScenes(production.scenes).find((scene) =>
    orderedShots(scene).some((shot) => shot.id === input.shotId),
  );
  if (targetScene === undefined) throw new Error(`shot ${input.shotId} is not in this production`);
  const ordered = orderedShots(targetScene);
  const index = ordered.findIndex((shot) => shot.id === input.shotId);
  if (take.continuedFrom !== undefined) {
    const predecessor = index > 0 ? ordered[index - 1] : undefined;
    const predecessorTake = production.takes.find((candidate) => candidate.id === take.continuedFrom);
    if (predecessor === undefined || predecessorTake === undefined) {
      throw new Error("that continuation does not name available predecessor footage in this scene");
    }
    if (predecessorTake.continuedFrom !== undefined) {
      throw new Error("that continuation would extend footage that was itself continued");
    }
    if (selections[predecessor.id]?.acceptedTakeId !== take.continuedFrom) {
      throw new Error("that continuation was made from footage no longer selected — restore its predecessor first");
    }
  }
  let next: Selections = {
    ...selections,
    [input.shotId]: {
      trimInSec: 0,
      ...previous,
      acceptedTakeId: decision.takeId,
      ...(takeChanged ? { trimInSec: 0 } : {}),
    },
  };
  if (takeChanged) {
    for (const { shotId } of supersededBy({ changedShotId: input.shotId, selections, takes: production.takes })) {
      next = { ...next, [shotId]: { ...next[shotId], acceptedTakeId: null, trimInSec: 0 } };
    }
  }
  const following = index >= 0 ? ordered[index + 1] : undefined;
  if (following && !hasOwnFrame(next[following.id], artifacts)) {
    const frameSourceTakeId = take.segment?.passTakeId ?? take.id;
    next[following.id] = { trimInSec: 0, ...next[following.id], startFrameTakeId: frameSourceTakeId as never };
  }
  return { decision, selections: next };
}

/** Accept: record the decision AND set the selection in one commit (R-9); chain continuity (R-12). */
export async function acceptTake(
  store: WorldStore,
  production: ProductionBundle,
  input: { takeId: string; shotId: string; by: string },
  options: { source?: string; requestId?: string; precondition?: WorldStatePrecondition } = {},
): Promise<ReviewDecision> {
  const reviewsPath = `productions/${production.meta.id}/reviews.jsonl`;
  const selectionsPath = `productions/${production.meta.id}/selections.json`;
  return store.gateOp(async () => {
    const stale = options.precondition?.();
    if (stale) throw new WorldStateStaleError(stale);
    const current = store
      .getBundle()
      .productions.find((candidate) => candidate.meta.id === production.meta.id);
    if (current === undefined) throw new Error(`production ${production.meta.id} is no longer available`);
    if (!current.scenes.some((scene) => orderedShots(scene).some((shot) => shot.id === input.shotId))) {
      throw new Error(`shot ${input.shotId} is no longer in production ${production.meta.id}`);
    }
    const reviews = await readOr(store, reviewsPath, "");
    const selections = await readOr(store, selectionsPath, "{}");
    const applied = applyTakeAcceptance(
      current,
      store.getBundle().artifacts,
      JSON.parse(selections.raw) as Selections,
      { ...input, at: store.now() },
    );
    const decision = applied.decision;

    await store.commitUnserialised({
      kind: "take-review",
      source: options.source ?? `review:${input.by}`,
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
          content: JSON.stringify(applied.selections, null, 2) + "\n",
          baseHash: selections.existed ? sha256(selections.raw) : null,
        },
      ],
      ...(options.requestId !== undefined ? { requestId: options.requestId } : {}),
    });
    return decision;
  });
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
  options: { source?: string; requestId?: string; precondition?: WorldStatePrecondition } = {},
): Promise<ShotSelection> {
  const selectionsPath = `productions/${production.meta.id}/selections.json`;
  return store.gateOp(async () => {
    const stale = options.precondition?.();
    if (stale) throw new WorldStateStaleError(stale);
    const currentProduction = store.getBundle().productions.find((candidate) => candidate.meta.id === production.meta.id);
    if (!currentProduction) throw new Error(`production ${production.meta.id} is no longer available`);
    const selections = await readOr(store, selectionsPath, "{}");
    const map = JSON.parse(selections.raw) as Selections;
    const current = map[input.shotId];
    const takeId = current?.acceptedTakeId;
    if (!takeId) throw new Error(`shot ${input.shotId} has no accepted take to trim`);

    const ceiling = trimCeilingSec(currentProduction, input.shotId, takeId);
    if (!ceiling.ok) throw new Error(`shot ${input.shotId} cannot be trimmed: ${ceiling.reason}`);
    // Absent is "not measured", never "measured zero" (R-5a). Refusing every trim on an unprobed
    // file would disable the control on a machine without ffmpeg, which is a supported way to run.
    if (ceiling.ceilingSec !== undefined && input.trimInSec >= ceiling.ceilingSec) {
      throw new Error(
        `trim of ${input.trimInSec}s leaves nothing of ${ceiling.ceilingSec.toFixed(3)}s of material`,
      );
    }

    const next: Selections = { ...map, [input.shotId]: { ...current, trimInSec: input.trimInSec } };
    await store.commitUnserialised({
      kind: "shot-trim",
      source: options.source ?? "review:user",
      files: [
        {
          path: selectionsPath,
          action: selections.existed ? "replace" : "create",
          content: JSON.stringify(next, null, 2) + "\n",
          baseHash: selections.existed ? sha256(selections.raw) : null,
        },
      ],
      ...(options.requestId !== undefined ? { requestId: options.requestId } : {}),
    });
    return next[input.shotId]!;
  });
}

/**
 * Reject: a cited sheet and field are REQUIRED (R-10) — the durable corpus a future
 * "rejections teach the shot" reads. The selection is untouched; the take is untouched.
 */
export async function rejectTake(
  store: WorldStore,
  production: ProductionBundle,
  input: { takeId: string; shotId?: string; by: string; citation: { sheet: string; field: string; note?: string } },
  options: { source?: string; requestId?: string; precondition?: WorldStatePrecondition } = {},
): Promise<ReviewDecision> {
  if (!input.citation.sheet || !input.citation.field) {
    throw new Error("a rejection requires a cited sheet and field (R-10)");
  }
  const reviewsPath = `productions/${production.meta.id}/reviews.jsonl`;
  return store.gateOp(async () => {
    const stale = options.precondition?.();
    if (stale) throw new WorldStateStaleError(stale);
    const reviews = await readOr(store, reviewsPath, "");
    const decision: ReviewDecision = {
      ts: store.now(),
      takeId: input.takeId as ReviewDecision["takeId"],
      ...(input.shotId !== undefined ? { shotId: input.shotId as ReviewDecision["shotId"] } : {}),
      decision: "reject",
      by: input.by,
      citation: input.citation,
    };
    await store.commitUnserialised({
      kind: "take-review",
      source: options.source ?? `review:${input.by}`,
      files: [
        {
          path: reviewsPath,
          action: reviews.existed ? "replace" : "create",
          content: reviews.raw + JSON.stringify(decision) + "\n",
          baseHash: reviews.existed ? sha256(reviews.raw) : null,
        },
      ],
      ...(options.requestId !== undefined ? { requestId: options.requestId } : {}),
    });
    return decision;
  });
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
  precondition?: WorldStatePrecondition,
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
  }, undefined, precondition);
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
  const overlay = CutOverlaySchema.parse({
    id: newId("ov"),
    artifactId: input.artifactId,
    startSec: input.startSec,
    endSec: input.endSec,
    ...(input.lane !== undefined ? { lane: input.lane } : {}),
    ...(input.audio !== undefined ? { audio: input.audio } : {}),
  });
  await editOverlays(store, productionId, (current) => [...current, overlay], () => {
    // Rechecked after a fresh scan under the write gate, including a sidecar scope change.
    const resolved = resolveProductionArtifact(store.getBundle().artifacts, input.artifactId, productionId);
    return resolved.ok ? null : `${overlay.id} cites ${resolved.reason}`;
  });
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
  }, () => {
    const resolved = resolveProductionArtifact(store.getBundle().artifacts, sound!.artifactId, productionId);
    return resolved.ok ? null : `${overlayId} cites ${resolved.reason}`;
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
