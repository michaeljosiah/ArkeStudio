import { ProposalManager } from "../../src/gate/proposals.js";
import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assessDialogueShot, dialogueShotFacts, orderedShots, allowedDialogueFeedback, ulid, type Job } from "@arke-studio/contracts";
import { recordTakesFromJob } from "../../src/takes/arrival.js";
import { recordDialogueFeedback } from "../../src/takes/feedback.js";
import { proposeShotVisualFacts } from "../../src/productions/visual-facts.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";

it("freezes pass assessments, gates independent feedback on immutable evidence, and preserves malformed history", async t => {
  const dir = await makeTempWorld(), store = await WorldStore.open(dir); t.after(() => store.close());
  const world = store.getBundle(), production = world.productions[0]!, scene = production.scenes[0]!, shot = orderedShots(scene)[0]!;
  const facts = dialogueShotFacts(shot, [], { frameMode: "none", audioIntent: "none", shotDurationSec: 5, audioDurationSec: null });
  const assessment = assessDialogueShot({ engineVersion: 1, manifestVersion: 1, modelId: "fixture", providerRoute: "fixture/text", endpointVersion: "v1",
    now: store.now(), facts, guidance: [], hardBlocks: [], acknowledgedRecommendationIds: [] }).assessment;
  const landing = `productions/${production.meta.id}/incoming/dialogue-feedback`;
  await mkdir(join(dir, landing), { recursive: true }); await writeFile(join(dir, landing, "video.mp4"), "fixture-video");
  const job: Job = { id: `jb_${ulid()}`, idempotencyKey: ulid(), worldId: store.worldId, productionId: production.meta.id,
    target: { kind: "scene-pass", id: scene.id, coversShots: [shot.id] }, capability: "video", provider: "fal", model: "fixture", status: "succeeded",
    params: { prompt: "fixture", shotPlan: [{ shotId: shot.id, number: shot.number, startSec: 0, endSec: 5 }],
      provenance: { canonRevision: world.meta.canonRevision, sheets: {}, dialogueAssessments: { [shot.id]: assessment } } },
    estimatedMicroUsd: 0, providerJobId: "fixture", attempt: 1, landing: { dir: landing }, landedFiles: [`${landing}/video.mp4`], error: null, createdAt: store.now(), updatedAt: store.now() };
  const takes = await recordTakesFromJob(store, job, 0);
  assert.equal(takes.length, 2);
  for (const take of takes) assert.deepEqual(take.provenance.dialogueAssessments?.[shot.id], assessment);
  const take = takes[1]!;
  assert.equal(allowedDialogueFeedback(take, shot.id).includes("audio-ignored"), false);
  assert.equal(allowedDialogueFeedback(take, shot.id).includes("start-frame-not-respected"), false);
  const before = store.getBundle().productions.find(p => p.meta.id === production.meta.id)!;
  const request = { kind: "record-dialogue-feedback" as const, worldId: store.worldId, requestId: ulid(), productionId: production.meta.id,
    takeId: take.id, shotId: shot.id, tags: ["framing-drifted" as const], recommendationIds: [] };
  await assert.rejects(recordDialogueFeedback(store, { ...request, tags: ["audio-ignored"] }), /frozen inputs/);
  await recordDialogueFeedback(store, request); await recordDialogueFeedback(store, request);
  const after = store.getBundle().productions.find(p => p.meta.id === production.meta.id)!;
  assert.equal(after.feedback?.length, 1);
  assert.deepEqual(after.takes, before.takes); assert.deepEqual(after.reviews, before.reviews); assert.deepEqual(after.selections, before.selections);
  const path = join(dir, `productions/${production.meta.id}/take-feedback.jsonl`), raw = await readFile(path, "utf8");
  await store.ownedWrite(() => writeFile(path, `${raw}malformed\n${raw}`));
  const scanned = store.getBundle();
  assert.equal(scanned.productions.find(p => p.meta.id === production.meta.id)?.feedback?.length, 2);
  assert.ok(scanned.problems.some(p => p.path.endsWith("take-feedback.jsonl") && p.message.includes("line 2")));
  await assert.rejects(recordDialogueFeedback(store, { ...request, requestId: ulid() }));
  const proposal = await proposeShotVisualFacts(store, { kind: "propose-shot-visual-facts", worldId: store.worldId, requestId: ulid(), productionId: production.meta.id,
    sceneId: scene.id, shotId: shot.id, expectedSceneVersion: scene.version, visualFacts: { onScreenCharacters: [], composition: "wide", confirmedAt: store.now() } });
  assert.ok(proposal.id);
  const projected = await new ProposalManager(store).project(proposal.id);
  assert.ok(projected.review.targets.some(target => target.fields.some(field => field.field.includes("Authored visual facts"))), "proposal review exposes the exact authored facts");
  assert.deepEqual(store.getBundle().productions.find(p => p.meta.id === production.meta.id)!.scenes, before.scenes, "fact proposal leaves authored state unchanged until accepted");
});
