import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { STAGE_REVIEW_SCHEMA_VERSION, StageReviewSchema, type ConversationActionCard, type StageReview } from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import { containedWorldFilePath } from "../world/contained-file.js";
import { atomicWriteFile, renameWithRetry } from "../world/atomic.js";
import { readChanges } from "../world/change-writer.js";
import { applySceneCommand, type SceneCommandInput, type SceneCommandDeps } from "./scene-commands.js";

const ReviewId = z.string().uuid();
const directory = ".staging/stage-reviews";
const historyDirectory = ".staging/stage-review-history";
const file = (id: string, archived = false) => `${archived ? historyDirectory : directory}/${ReviewId.parse(id)}.json`;
const deliveryKey = (id: string) => `stage-review:${ReviewId.parse(id)}`;

export async function readStageReview(store: WorldStore, id: string): Promise<StageReview> {
  try { return await readReviewFile(store, id); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return readReviewFile(store, id, true);
  }
}

async function readReviewFile(store: WorldStore, id: string, archived = false): Promise<StageReview> {
  const review = StageReviewSchema.parse(JSON.parse(await readFile(await containedWorldFilePath(store.dir, file(id, archived)), "utf8")));
  if (review.worldId !== store.worldId || review.id !== id) throw new Error("The Stage draft belongs to a different world.");
  return review;
}

/** Persist before publishing ready, so Keep and reconnect have the same reviewed draft. */
export async function retainStageReview(store: WorldStore, value: StageReview): Promise<void> {
  const review = StageReviewSchema.parse(value);
  if (review.worldId !== store.worldId) throw new Error("The Stage draft belongs to a different world.");
  await store.raiseSchemaBoundary(STAGE_REVIEW_SCHEMA_VERSION, "stage-review-boundary");
  await store.ownedWrite(async () => {
    let existing: StageReview | undefined;
    try { existing = await readStageReview(store, review.id); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (existing) {
      if (JSON.stringify({ ...existing, status: "pending" }) !== JSON.stringify({ ...review, status: "pending" })) {
        throw new Error("The Stage review id already belongs to another draft.");
      }
      return;
    }
    const path = await containedWorldFilePath(store.dir, file(review.id), true);
    await atomicWriteFile(path, JSON.stringify(review) + "\n");
  });
}

export async function listStageReviews(store: WorldStore, archived = false): Promise<StageReview[]> {
  let names: string[];
  try {
    // Check the directory's ancestors and its own reparse boundary before enumerating it.
    const source = archived ? historyDirectory : directory;
    await containedWorldFilePath(store.dir, `${source}/.containment-check`, false, "stage", true);
    names = await readdir(join(store.dir, source));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const reviews: StageReview[] = [];
  for (const name of names) {
    if (!name.endsWith(".json") || !ReviewId.safeParse(name.slice(0, -5)).success) continue;
    try { reviews.push(await readReviewFile(store, name.slice(0, -5), archived)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return reviews.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

/** Call under world ownership only, after the decision's durable receipt exists. */
async function archiveReviewUnserialised(store: WorldStore, id: string): Promise<void> {
  let source: string;
  try { source = await containedWorldFilePath(store.dir, file(id)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const destination = await containedWorldFilePath(store.dir, file(id, true), true);
  await renameWithRetry(source, destination);
}

/** Recover the narrow crash window between a durable decision and its archive move. */
export async function compactSettledStageReviews(store: WorldStore): Promise<void> {
  const reviews = await listStageReviews(store);
  if (reviews.length === 0) return;
  const kept = await keptStageReviewIds(store);
  const settled = reviews.filter(review => review.status === "discarded" || kept.has(review.id));
  if (settled.length === 0) return;
  await store.ownedWrite(async () => {
    for (const review of settled) await archiveReviewUnserialised(store, review.id);
  });
}

/** The ordinary scene commit is the receipt; a crash cannot keep a draft without settling it. */
export async function stageReviewKept(store: WorldStore, id: string): Promise<boolean> {
  ReviewId.parse(id);
  return (await keptStageReviewIds(store)).has(id);
}

export async function keptStageReviewIds(store: WorldStore): Promise<Set<string>> {
  const kept = new Set<string>();
  for (const change of await readChanges(join(store.dir, "changes.jsonl"))) {
    if (typeof change.requestId !== "string" || !change.requestId.startsWith("stage-review:") || typeof change.commitId !== "string") continue;
    const id = change.requestId.slice("stage-review:".length);
    if (ReviewId.safeParse(id).success) kept.add(id);
  }
  return kept;
}

function assertTarget(review: StageReview, input: SceneCommandInput): void {
  if (review.status !== "pending" || review.productionId !== input.productionId || review.sceneId !== input.sceneId ||
    review.baseVersion !== input.baseVersion || input.command.kind !== "edit-stage" || input.command.shotId !== review.shotId) {
    throw new Error("The Stage review changed. Reopen its current card before Keep.");
  }
}

export async function keepStageReview(store: WorldStore, id: string, input: SceneCommandInput, deps: SceneCommandDeps = {}): Promise<void> {
  const review = await readStageReview(store, id);
  assertTarget(review, input);
  if (await stageReviewKept(store, id)) {
    await store.ownedWrite(() => archiveReviewUnserialised(store, id));
    return;
  }
  await applySceneCommand(store, { ...input, requestId: deliveryKey(id) }, {
    ...deps,
    validateInGate: async () => {
      await deps.validateInGate?.();
      assertTarget(await readStageReview(store, id), input);
      if (await stageReviewKept(store, id)) throw new Error("The Stage draft was already kept.");
    },
  });
  await store.ownedWrite(() => archiveReviewUnserialised(store, id));
}

export async function discardStageReview(store: WorldStore, id: string): Promise<void> {
  await store.gateOp(async () => {
    const review = await readStageReview(store, id);
    if (review.status !== "discarded" && !await stageReviewKept(store, id)) {
      await atomicWriteFile(await containedWorldFilePath(store.dir, file(id)), JSON.stringify({ ...review, status: "discarded" }) + "\n");
    }
    await archiveReviewUnserialised(store, id);
  });
}

/** A crash after retention must resume human review, not buy another construction turn. */
export async function recoverRetainedStageReviews(store: WorldStore, actions: readonly ConversationActionCard[], lifecycle: {
  completeHostAction(input: { conversationId: string; actionId: string; payload: unknown }): Promise<boolean>;
}): Promise<boolean> {
  const pending = actions.filter(action => action.actionKind === "world-chat-production-stage-construct" && action.status === "awaiting-host");
  if (pending.length === 0) return false;
  // Only unfinished host receipts need historical drafts, never ordinary snapshot refreshes.
  const reviews = [...await listStageReviews(store), ...await listStageReviews(store, true)];
  let changed = false;
  for (const action of pending) {
    const review = reviews.find(review => review.actionId === action.actionId && review.conversationId === action.conversationId &&
      review.worldId === action.worldId && review.productionId === action.productionId && review.baseVersion === action.authorityRevision);
    if (review) changed = await lifecycle.completeHostAction({ conversationId: action.conversationId, actionId: action.actionId,
      payload: { kind: "stage-constructor-result", shotId: review.shotId, sceneId: review.sceneId, status: "ready", detail: review.draft.assessment } }) || changed;
  }
  return changed;
}
