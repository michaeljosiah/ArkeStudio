import assert from "node:assert/strict";
import { it } from "node:test";
import { randomUUID } from "node:crypto";
import { readFile, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { newId, orderedShots, StageReviewSchema, type StageReview } from "@arke-studio/contracts";
import { WorldStore } from "../../src/world/store.js";
import { applySceneCommand } from "../../src/productions/scene-commands.js";
import { discardStageReview, keepStageReview, listStageReviews, readStageReview, retainStageReview, stageReviewKept } from "../../src/productions/stage-review.js";
import { makeTempWorld } from "../world/helpers.js";

function draft(store: WorldStore): StageReview {
  const scene = store.getBundle().productions.find(production => production.meta.id === "saltlight")!.scenes.find(scene => scene.id === "sc_04")!;
  return StageReviewSchema.parse({ id: randomUUID(), worldId: store.worldId, productionId: "saltlight", sceneId: scene.id,
    shotId: orderedShots(scene)[0]!.id, baseVersion: scene.version, conversationId: newId("cv"), actionId: newId("act"),
    createdAt: "2026-10-04T12:00:00Z", status: "pending", draft: { staging: { keys: [
      { t: 0, p: [0, 2, 5], l: [0, 1, 0] }, { t: 4, p: [1, 2, 5], l: [0, 1, 0] } ], cast: [], sets: [] },
      cast: [], sets: [], assumptions: [], assessment: "Inspected", inspected: ["camera"] } });
}
const input = (review: StageReview) => ({ productionId: review.productionId, sceneFile: "04-the-verse-rises", sceneId: review.sceneId,
  baseVersion: review.baseVersion, command: { kind: "edit-stage" as const, shotId: review.shotId, staging: review.draft.staging } });

it("reopening preserves a draft; the ordinary Keep commit is its crash-safe, idempotent receipt", async t => {
  const dir = await makeTempWorld(); let store = await WorldStore.open(dir); t.after(() => store.close());
  assert.deepEqual(await listStageReviews(store), []);
  await assert.rejects(readFile(join(dir, ".staging/stage-reviews/.containment-check")), { code: "ENOENT" });
  const review = draft(store); await retainStageReview(store, review);
  assert.equal(store.getBundle().meta.schemaVersion, 56);
  await store.close(); store = await WorldStore.open(dir);
  assert.deepEqual(await listStageReviews(store), [review]);
  await keepStageReview(store, review.id, input(review));
  assert.equal(await stageReviewKept(store, review.id), true);
  const scene = store.getBundle().productions.find(p => p.meta.id === "saltlight")!.scenes.find(s => s.id === review.sceneId)!;
  assert.equal(scene.version, review.baseVersion + 1);
  const log = await readFile(join(dir, "changes.jsonl"), "utf8");
  await store.close(); store = await WorldStore.open(dir);
  await keepStageReview(store, review.id, input(review));
  assert.equal(await readFile(join(dir, "changes.jsonl"), "utf8"), log, "retry cannot apply or commit twice");
  await discardStageReview(store, review.id);
  assert.equal((await readStageReview(store, review.id)).status, "pending", "a later discard cannot replace the kept receipt");
});

it("discard and stale Keep use the same gate as scene edits, and retention never resurrects a decided draft", async t => {
  const store = await WorldStore.open(await makeTempWorld()); t.after(() => store.close());
  const review = draft(store); await retainStageReview(store, review);
  await discardStageReview(store, review.id); await retainStageReview(store, review);
  assert.equal((await readStageReview(store, review.id)).status, "discarded");
  await assert.rejects(keepStageReview(store, review.id, input(review)), /review changed/);
  await assert.rejects(retainStageReview(store, { ...review, shotId: "sh_other" }), /another draft/);
  const next = draft(store); await retainStageReview(store, next);
  await applySceneCommand(store, { ...input(next), command: { kind: "edit-shot", shotId: next.shotId, change: { description: "Changed after inspection." } } });
  const before = await readFile(join(store.dir, "productions/saltlight/scenes/04-the-verse-rises.json"), "utf8");
  await assert.rejects(keepStageReview(store, next.id, input(next)), /version|moved|changed/i);
  assert.equal(await readFile(join(store.dir, "productions/saltlight/scenes/04-the-verse-rises.json"), "utf8"), before);
  assert.equal(await stageReviewKept(store, next.id), false);
});

it("refuses a reparse point in the retained-draft path before reading or writing outside the world", async t => {
  const store = await WorldStore.open(await makeTempWorld()); t.after(() => store.close());
  const external = await makeTempWorld();
  await mkdir(join(store.dir, ".staging"), { recursive: true });
  await symlink(external, join(store.dir, ".staging/stage-reviews"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(listStageReviews(store), /path-invalid/);
  const review = draft(store);
  await assert.rejects(retainStageReview(store, review), /path-invalid/);
  await assert.rejects(readFile(join(external, `${review.id}.json`)), { code: "ENOENT" });
});
