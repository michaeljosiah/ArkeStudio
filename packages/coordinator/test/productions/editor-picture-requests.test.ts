import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { storyTimelineFingerprint, pictureVersionRef, type PictureReviewOperation, type ModelPictureProposal } from "@arke-studio/contracts";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";
import { applyHumanTimelineCommand, applyTimelineCommand } from "../../src/productions/timeline.js";
import { EditorEffectAnalysisService } from "../../src/productions/editor-effect-analysis.js";
import { EditorEffectDependencies } from "../../src/productions/editor-effect-dependencies.js";
import { stagePictureProposal, handlePictureReview, readPictureFamilies } from "../../src/productions/editor-picture-requests.js";


const productionId = "saltlight", conversationId = "cv_01J8G0000000000000000000C1";

const model = (opacity = .7): ModelPictureProposal => ({ summary: "Lighten overlay", commands: [{ kind: "picture-appearance", clipId: "cl_first", patch: { blendMode: "screen", opacity } }] });
async function setup() {
  const store = await WorldStore.open(await makeTempWorld()); closeOnCleanup(() => store.close());
  const production = store.getBundle().productions.find(value => value.meta.id === productionId)!;
  const artifact = store.getBundle().artifacts.find(value => value.kind === "board")!;
  await applyHumanTimelineCommand(store, productionId, { kind: "commands", baseRevision: null, sourceFingerprint: storyTimelineFingerprint(production), commands:
    ["cl_first", "cl_second"].map((id, index) => ({ kind: "place" as const, trackId: "tr_picture" as const,
      clip: { id: id as `cl_${string}`, startFrame: index * 96, durationFrames: 96, sourceInFrames: 0, source: { kind: "artifact" as const, artifactId: artifact.id, label: `Image ${index + 1}` } } })),
  });
  const analysis = new EditorEffectAnalysisService(undefined, () => {}); closeOnCleanup(() => analysis.stop());
  const deps = new EditorEffectDependencies(analysis); let action = 0;
  const readTimeline = () => readFile(join(store.dir, "productions", productionId, "timeline.json"), "utf8");
  const stage = (proposal = model()) => stagePictureProposal(store, { productionId, conversationId, proposal, actionId: `act_01J8G00000000000000000${String(++action).padStart(4, "0")}` }, deps);
  const operate = async (operation: PictureReviewOperation) => (await handlePictureReview(store, { kind: "editor-picture-proposal", worldId: store.worldId, productionId,
    requestId: `human-${++action}`, operation }, deps)).result;
  return { store, deps, readTimeline, stage, operate, artifact };
}

test("picture composite Review is explicit, Apply is exact/idempotent and one durable Undo restores appearance", async () => {
  const { store, readTimeline, stage, operate } = await setup(), before = await readTimeline();
  const staged = await stage(), ref = pictureVersionRef(staged.family.id, staged.version);
  assert.equal(await readTimeline(), before);
  assert.equal((await operate({ kind: "apply", ref, reviewId: "not-reviewed" })).outcome, "refused");
  const reviewed = await operate({ kind: "review", ref }); assert.equal(reviewed.outcome, "reviewed", reviewed.reason);
  assert.equal(await readTimeline(), before);
  const applied = await operate({ kind: "apply", ref, reviewId: reviewed.reviewId! }); assert.equal(applied.outcome, "applied", applied.reason);
  const after = JSON.parse(await readTimeline());
  assert.equal(after.revision, JSON.parse(before).revision + 1);
  assert.equal(after.tracks[0].clips[0].visual.blendMode, "screen");
  assert.equal(after.history.undo.at(-1).requestId, staged.family.id);
  assert.equal((await operate({ kind: "apply", ref, reviewId: reviewed.reviewId! })).outcome, "applied");
  assert.equal(await readTimeline(), JSON.stringify(after, null, 2) + "\n");
  await applyHumanTimelineCommand(store, productionId, { kind: "undo", baseRevision: after.revision });
  assert.equal(JSON.parse(await readTimeline()).tracks[0].clips[0].visual, undefined);
  assert.ok((await readPictureFamilies(store, productionId))[0]!.receipt?.undoneAt);
  assert.equal(JSON.parse(await readFile(join(store.dir, "world.json"), "utf8")).schemaVersion, 77);
});

test("manual picture values, named protection and Keep Current remain sticky; Release requires fresh Review", async () => {
  const { stage, operate, readTimeline } = await setup(), before = await readTimeline();
  const first = await stage(); let ref = pictureVersionRef(first.family.id, first.version);
  await operate({ kind: "review", ref });
  const edit = await operate({ kind: "edit", ref, commands: [{ kind: "picture-appearance", clipId: "cl_first", patch: { opacity: .4 } },
    { kind: "picture-protect", clipId: "cl_first", rule: { id: "vp_blend", property: "blendMode", scope: { kind: "whole" } } }] });
  assert.equal(edit.outcome, "updated", edit.reason); ref = edit.ref;
  const revised = await stage({ summary: "Brighter", commands: [{ kind: "picture-appearance", clipId: "cl_first", patch: { opacity: 1, blendMode: "add" } }],
    family: { id: ref.familyId, parentVersionId: ref.versionId, candidateHash: ref.candidateHash } });
  assert.equal(revised.version.pictures[0]!.visual?.opacity, .4); assert.equal(revised.version.pictures[0]!.visual?.blendMode, "screen");
  ref = pictureVersionRef(revised.family.id, revised.version);
  assert.equal((await operate({ kind: "apply", ref, reviewId: edit.reviewId! })).outcome, "refused");
  const reviewed = await operate({ kind: "review", ref });
  const release = await operate({ kind: "edit", ref, commands: [{ kind: "picture-release", ruleId: "vp_blend" }] });
  assert.equal(release.outcome, "updated", release.reason); assert.equal(release.reviewId, undefined);
  assert.equal((await operate({ kind: "apply", ref: release.ref, reviewId: reviewed.reviewId! })).outcome, "refused");
  await operate({ kind: "review", ref: release.ref });
  const keep = await operate({ kind: "keep", ref: release.ref, clipId: "cl_first" }); assert.equal(keep.outcome, "updated", keep.reason);
  const next = await stage({ ...model(.9), family: { id: ref.familyId, parentVersionId: keep.ref.versionId, candidateHash: keep.ref.candidateHash } });
  assert.equal(next.version.pictures[0]!.visual, undefined);
  assert.equal(await readTimeline(), before);

});

test("generic chat history cannot remove or reinstate picture protection from an applied composite", async () => {
  const { store, stage, operate, readTimeline } = await setup();
  const first = await stage(), ref = pictureVersionRef(first.family.id, first.version);
  await operate({ kind: "review", ref });
  const edit = await operate({ kind: "edit", ref, commands: [{ kind: "picture-protect", clipId: "cl_first",
    rule: { id: "vp_chat", property: "opacity", scope: { kind: "whole" } } }] });
  const review = await operate({ kind: "review", ref: edit.ref });
  const applied = await operate({ kind: "apply", ref: edit.ref, reviewId: review.reviewId! });
  assert.equal(applied.outcome, "applied", applied.reason);
  const protectedBytes = await readTimeline(), protectedValue = JSON.parse(protectedBytes);
  await assert.rejects(applyTimelineCommand(store, productionId, { kind: "undo", baseRevision: protectedValue.revision }), /editor's Undo or Redo/);
  assert.equal(await readTimeline(), protectedBytes);
  await applyHumanTimelineCommand(store, productionId, { kind: "undo", baseRevision: protectedValue.revision });
  const undoneBytes = await readTimeline(), undone = JSON.parse(undoneBytes);
  assert.equal(undone.tracks[0].clips[0].visual, undefined);
  await assert.rejects(applyTimelineCommand(store, productionId, { kind: "redo", baseRevision: undone.revision }), /editor's Undo or Redo/);
  assert.equal(await readTimeline(), undoneBytes);
  await applyHumanTimelineCommand(store, productionId, { kind: "redo", baseRevision: undone.revision });
  assert.deepEqual(JSON.parse(await readTimeline()).tracks, protectedValue.tracks);
});

test("Keep Current preserves absent appearance and refuses a no-op Apply", async () => {
  const { stage, operate, readTimeline } = await setup(), before = await readTimeline();
  const first = await stage(), ref = pictureVersionRef(first.family.id, first.version);
  await operate({ kind: "review", ref });
  const kept = await operate({ kind: "keep", ref, clipId: "cl_first" });
  assert.equal(kept.outcome, "updated", kept.reason);
  const review = await operate({ kind: "review", ref: kept.ref });
  const applied = await operate({ kind: "apply", ref: kept.ref, reviewId: review.reviewId! });
  assert.equal(applied.outcome, "refused"); assert.match(applied.reason!, /No changes/);
  assert.equal(await readTimeline(), before);
});

test("Update accepts an already completed human Release and still requires a fresh Review", async () => {
  const { store, stage, operate, readTimeline } = await setup();
  const sourceFingerprint = storyTimelineFingerprint(store.getBundle().productions.find(value => value.meta.id === productionId)!);
  let current = JSON.parse(await readTimeline());
  await applyHumanTimelineCommand(store, productionId, { kind: "commands", baseRevision: current.revision, sourceFingerprint, commands: [
    { kind: "picture-protect", clipId: "cl_first", rule: { id: "vp_released", property: "blendMode", scope: { kind: "whole" } } },
  ] });
  const first = await stage(), ref = pictureVersionRef(first.family.id, first.version);
  await operate({ kind: "review", ref });
  const release = await operate({ kind: "edit", ref, commands: [{ kind: "picture-release", ruleId: "vp_released" }] });
  current = JSON.parse(await readTimeline());
  await applyHumanTimelineCommand(store, productionId, { kind: "commands", baseRevision: current.revision, sourceFingerprint,
    commands: [{ kind: "picture-release", ruleId: "vp_released" }] });
  const updated = await operate({ kind: "update", ref: release.ref });
  assert.equal(updated.outcome, "updated", updated.reason); assert.equal(updated.reviewId, undefined);
  const review = await operate({ kind: "review", ref: updated.ref });
  const applied = await operate({ kind: "apply", ref: updated.ref, reviewId: review.reviewId! });
  assert.equal(applied.outcome, "applied", applied.reason);
  const clip = JSON.parse(await readTimeline()).tracks[0].clips[0];
  assert.equal(clip.visual.blendMode, "screen"); assert.equal(clip.visual.protection, undefined);
});

test("Update from an old card records the latest manual decisions as its Undo predecessor", async () => {
  const { store, stage, operate, readTimeline } = await setup();
  const first = await stage(), ref = pictureVersionRef(first.family.id, first.version);
  await operate({ kind: "review", ref });
  const edit = await operate({ kind: "edit", ref, commands: [
    { kind: "picture-appearance", clipId: "cl_first", patch: { opacity: .4 } },
    { kind: "picture-protect", clipId: "cl_first", rule: { id: "vp_pending", property: "opacity", scope: { kind: "whole" } } },
  ] });
  assert.equal(edit.outcome, "updated", edit.reason);
  const current = JSON.parse(await readTimeline());
  await applyHumanTimelineCommand(store, productionId, { kind: "commands", baseRevision: current.revision,
    sourceFingerprint: storyTimelineFingerprint(store.getBundle().productions.find(value => value.meta.id === productionId)!),
    commands: [{ kind: "picture-appearance", clipId: "cl_second", patch: { opacity: .8 } }] });
  const before = await readTimeline(), updated = await operate({ kind: "update", ref });
  assert.equal(updated.outcome, "updated", updated.reason); assert.equal(updated.reviewId, undefined);
  let family = (await readPictureFamilies(store, productionId))[0]!;
  assert.equal(family.versions.at(-1)!.parentVersionId, edit.ref.versionId);
  assert.equal(family.undo.at(-1), edit.ref.versionId);
  await operate({ kind: "review", ref: updated.ref });
  const undone = await operate({ kind: "history", ref: updated.ref, direction: "undo" });
  assert.equal(undone.outcome, "updated", undone.reason);
  family = (await readPictureFamilies(store, productionId))[0]!;
  assert.deepEqual(family.versions.at(-1)!.sticky, family.versions.find(value => value.id === edit.ref.versionId)!.sticky);
  assert.equal(family.versions.at(-1)!.pictures[0]!.visual?.opacity, .4);
  assert.equal(family.versions.at(-1)!.pictures[0]!.visual?.protection?.[0]?.id, "vp_pending");
  assert.equal(await readTimeline(), before);
});

test("picture Apply detects changed source bytes and Update retains decisions but grants no Review", async () => {
  const { store, stage, operate, artifact, readTimeline } = await setup(), before = await readTimeline();
  const first = await stage(), ref = pictureVersionRef(first.family.id, first.version), review = await operate({ kind: "review", ref });
  await appendFile(join(store.dir, "artifacts", artifact.file), "changed source");
  const refused = await operate({ kind: "apply", ref, reviewId: review.reviewId! }); assert.equal(refused.outcome, "refused"); assert.match(refused.reason!, /Media changed/);
  assert.equal(await readTimeline(), before);
  const update = await operate({ kind: "update", ref }); assert.equal(update.outcome, "updated", update.reason); assert.equal(update.reviewId, undefined);
  assert.equal((await operate({ kind: "apply", ref: update.ref, reviewId: review.reviewId! })).outcome, "refused");
});

test("a changed protected value requires a fresh named Release after Update", async () => {
  const { store, stage, operate, readTimeline } = await setup();
  const sourceFingerprint = storyTimelineFingerprint(store.getBundle().productions.find(value => value.meta.id === productionId)!);
  let current = JSON.parse(await readTimeline());
  await applyHumanTimelineCommand(store, productionId, { kind: "commands", baseRevision: current.revision, sourceFingerprint, commands: [
    { kind: "picture-protect", clipId: "cl_first", rule: { id: "vp_current", property: "blendMode", scope: { kind: "whole" } } },
  ] });
  const first = await stage(), ref = pictureVersionRef(first.family.id, first.version);
  await operate({ kind: "review", ref });
  const release = await operate({ kind: "edit", ref, commands: [{ kind: "picture-release", ruleId: "vp_current" }] });
  assert.equal(release.outcome, "updated", release.reason);
  current = JSON.parse(await readTimeline());
  await applyHumanTimelineCommand(store, productionId, { kind: "commands", baseRevision: current.revision, sourceFingerprint, commands: [
    { kind: "picture-appearance", clipId: "cl_first", patch: { blendMode: "add" } },
  ] });
  const updated = await operate({ kind: "update", ref: release.ref }); assert.equal(updated.outcome, "updated", updated.reason);
  const family = (await readPictureFamilies(store, productionId))[0]!;
  assert.match(family.versions.at(-1)!.conflicts[0]!, /changed after Release/);
  assert.equal(family.versions.at(-1)!.pictures[0]!.visual?.protection?.length, 1);
  const review = await operate({ kind: "review", ref: updated.ref }); assert.equal(review.outcome, "reviewed", review.reason);
  assert.equal((await operate({ kind: "apply", ref: updated.ref, reviewId: review.reviewId! })).outcome, "refused");
  const renewed = await operate({ kind: "edit", ref: updated.ref, commands: [{ kind: "picture-release", ruleId: "vp_current" }] });
  assert.equal(renewed.outcome, "updated", renewed.reason); assert.equal(renewed.reviewId, undefined);
  const reviewed = await operate({ kind: "review", ref: renewed.ref });
  const applied = await operate({ kind: "apply", ref: renewed.ref, reviewId: reviewed.reviewId! });
  assert.equal(applied.outcome, "applied", applied.reason);
  assert.equal(JSON.parse(await readTimeline()).tracks[0].clips[0].visual.blendMode, "screen");
});
