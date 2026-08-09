import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CutFileSchema,
  type AudioDesign,
  type ProductionBundle,
  type ReviewDecision,
  type Selections,
} from "@arke-studio/contracts";
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
  const next: Selections = { ...map, [input.shotId]: { ...map[input.shotId], acceptedTakeId: decision.takeId } };

  // Continuity (R-12, D8): the accepted take's final frame seeds the FOLLOWING shot. For a
  // pass segment the frame source is the pass, not the segment — a coinciding boundary must
  // not chain the same frame twice.
  const ordered = [...production.scenes].sort((a, b) => a.number - b.number).flatMap((s) => s.shots);
  const index = ordered.findIndex((s) => s.id === input.shotId);
  const following = index >= 0 ? ordered[index + 1] : undefined;
  if (following) {
    const frameSourceTakeId = take.segment?.passTakeId ?? take.id;
    next[following.id] = { ...next[following.id], startFrameTakeId: frameSourceTakeId as never };
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
