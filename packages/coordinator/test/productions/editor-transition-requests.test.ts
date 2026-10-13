import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { storyTimelineFingerprint, transitionVersionRef, type TransitionReviewOperation, type ModelTransitionProposal } from "@arke-studio/contracts";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";
import { applyHumanTimelineCommand } from "../../src/productions/timeline.js";
import { EditorEffectAnalysisService } from "../../src/productions/editor-effect-analysis.js";
import { EditorEffectDependencies } from "../../src/productions/editor-effect-dependencies.js";
import { stageTransitionProposal, handleTransitionReview, readTransitionFamilies } from "../../src/productions/editor-transition-requests.js";
import { readRequestFile } from "../../src/productions/editor-request-file.js";

const productionId = "saltlight", conversationId = "cv_01J8G0000000000000000000C1";
const pair = { trackId: "tr_picture", leftClipId: "cl_first", rightClipId: "cl_second" };
const model = (durationFrames = 24): ModelTransitionProposal => ({ summary: "Gentle image crossfades", commands: [{ kind: "transition-set", ...pair, durationFrames }] });
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
  const stage = (proposal = model()) => stageTransitionProposal(store, { productionId, conversationId, proposal, actionId: `act_01J8G00000000000000000${String(++action).padStart(4, "0")}` }, deps);
  const operate = async (operation: TransitionReviewOperation) => (await handleTransitionReview(store, { kind: "editor-transition-proposal", worldId: store.worldId, productionId,
    requestId: `human-${++action}`, operation }, deps)).result;
  return { store, deps, readTimeline, stage, operate, artifact };
}

test("real world proposal preparation and review do not write Current; reviewed Apply is atomic and durable", async () => {
  const { store, readTimeline, stage, operate } = await setup(), before = await readTimeline();
  const staged = await stage(), ref = transitionVersionRef(staged.family.id, staged.version);
  assert.equal(await readTimeline(), before);
  assert.equal((await operate({ kind: "apply", ref, reviewId: "not-reviewed" })).outcome, "refused");
  const reviewed = await operate({ kind: "review", ref }); assert.equal(reviewed.outcome, "reviewed"); assert.equal(await readTimeline(), before);
  const applied = await operate({ kind: "apply", ref, reviewId: reviewed.reviewId! }); assert.equal(applied.outcome, "applied", applied.reason);
  const after = JSON.parse(await readTimeline());
  assert.equal(after.revision, JSON.parse(before).revision + 1); assert.deepEqual(after.tracks, JSON.parse(before).tracks);
  assert.equal(after.history.undo.at(-1).requestId, staged.family.id);
  assert.equal((await operate({ kind: "apply", ref, reviewId: reviewed.reviewId! })).outcome, "applied");
  assert.equal(await readTimeline(), JSON.stringify(after, null, 2) + "\n");
  await applyHumanTimelineCommand(store, productionId, { kind: "undo", baseRevision: after.revision });
  assert.equal(JSON.parse(await readTimeline()).transitions.length, 0);
  assert.ok((await readTransitionFamilies(store, productionId))[0]!.receipt?.undoneAt);
  assert.equal((JSON.parse(await readFile(join(store.dir, "world.json"), "utf8"))).schemaVersion, 76);
});

test("manual adjustment and Keep Current survive model revisions; arrival does not grant Review", async () => {
  const { store, readTimeline, stage, operate } = await setup(), before = await readTimeline();
  const first = await stage(), ref = transitionVersionRef(first.family.id, first.version);
  await operate({ kind: "review", ref });
  const edit = await operate({ kind: "edit", ref, commands: [{ kind: "transition-set", ...pair, durationFrames: 30 }] }); assert.equal(edit.outcome, "updated", edit.reason);
  const revised = await stage({ ...model(12), family: { id: first.family.id, parentVersionId: edit.ref.versionId, candidateHash: edit.ref.candidateHash } });
  assert.equal(revised.version.transitions[0]!.durationFrames, 30);
  const revisedRef = transitionVersionRef(revised.family.id, revised.version);
  assert.equal((await operate({ kind: "apply", ref: revisedRef, reviewId: edit.reviewId! })).outcome, "refused");
  await operate({ kind: "review", ref: revisedRef });
  const keep = await operate({ kind: "keep", ref: revisedRef, pair }); assert.equal(keep.outcome, "updated", keep.reason);
  const next = await stage({ ...model(36), family: { id: first.family.id, parentVersionId: keep.ref.versionId, candidateHash: keep.ref.candidateHash } });
  assert.equal(next.version.transitions.length, 0); assert.equal(await readTimeline(), before);
  assert.equal((await readRequestFile(store, productionId)).file.schemaVersion, 2);
});

test("a preparation receipt is idempotent only for the same conversation and exact proposal", async () => {
  const { store, deps } = await setup();
  const input = { productionId, conversationId, actionId: "act_01J8G0000000000000000000A1", proposal: model() };
  const first = await stageTransitionProposal(store, input, deps);
  assert.equal((await stageTransitionProposal(store, input, deps)).version.id, first.version.id);
  await assert.rejects(stageTransitionProposal(store, { ...input, proposal: model(36) }, deps), /different transition request/);
  await assert.rejects(stageTransitionProposal(store, { ...input, conversationId: "cv_01J8G0000000000000000000C2" }, deps), /different transition request/);
  assert.equal((await readTransitionFamilies(store, productionId)).length, 1);
});

test("a changed source invalidates Apply; explicit Update needs a fresh Review", async () => {
  const { store, artifact, readTimeline, stage, operate } = await setup(), before = await readTimeline();
  const first = await stage(), ref = transitionVersionRef(first.family.id, first.version), review = await operate({ kind: "review", ref });
  await appendFile(join(store.dir, "artifacts", artifact.file), "changed source");
  const refused = await operate({ kind: "apply", ref, reviewId: review.reviewId! }); assert.equal(refused.outcome, "refused"); assert.match(refused.reason!, /Media changed/);
  assert.equal(await readTimeline(), before);
  const update = await operate({ kind: "update", ref }); assert.equal(update.outcome, "updated", update.reason); assert.equal(update.reviewId, undefined);
  assert.equal((await operate({ kind: "apply", ref: update.ref, reviewId: review.reviewId! })).outcome, "refused");
});

test("pending protection keeps its exact baseline across revisions and release requires another Review", async () => {
  const { stage, operate, readTimeline } = await setup(), before = await readTimeline();
  const first = await stage(model(36)); let ref = transitionVersionRef(first.family.id, first.version);
  await operate({ kind: "review", ref });
  const protect = await operate({ kind: "edit", ref, commands: [{ kind: "transition-protect", ...pair, setting: "duration" }] });
  assert.equal(protect.outcome, "updated", protect.reason); ref = protect.ref;
  const revised = await stage({ ...model(12), family: { id: ref.familyId, parentVersionId: ref.versionId, candidateHash: ref.candidateHash } });
  assert.equal(revised.version.transitions[0]!.durationFrames, 36); assert.equal(revised.version.transitions[0]!.protectDuration, true);
  ref = transitionVersionRef(revised.family.id, revised.version); await operate({ kind: "review", ref });
  assert.equal((await operate({ kind: "edit", ref, commands: [{ kind: "transition-set", ...pair, durationFrames: 30 }] })).outcome, "refused");
  const release = await operate({ kind: "edit", ref, commands: [{ kind: "transition-release", ...pair, setting: "duration" }] });
  assert.equal(release.outcome, "updated", release.reason); assert.equal(release.reviewId, undefined);
  assert.equal((await operate({ kind: "apply", ref: release.ref, reviewId: protect.reviewId! })).outcome, "refused");
  const review = await operate({ kind: "review", ref: release.ref });
  assert.equal((await operate({ kind: "apply", ref: release.ref, reviewId: review.reviewId! })).outcome, "applied");
  const after = JSON.parse(await readTimeline()); assert.equal(after.transitions[0].protectDuration, false);
  assert.deepEqual(after.tracks, JSON.parse(before).tracks); assert.equal(after.history.undo.length, JSON.parse(before).history.undo.length + 1);
});

test("pending join protection keeps presence but permits an Arke duration revision", async () => {
  const { stage, operate } = await setup(); const first = await stage(), ref = transitionVersionRef(first.family.id, first.version);
  await operate({ kind: "review", ref });
  const protect = await operate({ kind: "edit", ref, commands: [{ kind: "transition-protect", ...pair, setting: "join" }] });
  const parent = { id: ref.familyId, parentVersionId: protect.ref.versionId, candidateHash: protect.ref.candidateHash };
  const revised = await stage({ ...model(36), family: parent });
  assert.equal(revised.version.transitions[0]!.durationFrames, 36); assert.equal(revised.version.transitions[0]!.protectJoin, true);
  const removed = await stage({ summary: "Remove fades", commands: [{ kind: "transition-remove", ...pair }], family: parent });
  assert.equal(removed.version.transitions.length, 1); assert.equal(removed.version.transitions[0]!.protectJoin, true);
});

test("native dependency preparation can enter the derived-write gate for staging, adjustments and Update", async () => {
  const { store, deps, stage, operate } = await setup();
  const capture = deps.captureDependencies.bind(deps); let writes = 0;
  deps.captureDependencies = async input => {
    // Audio-reactive productions save their prepared feature manifest this way.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([store.derivedWrite(async () => { writes++; }), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Preparation retained the world gate")), 2000);
      })]);
    } finally { clearTimeout(timer); }
    return capture(input);
  };
  const first = await stage(), ref = transitionVersionRef(first.family.id, first.version);
  await operate({ kind: "review", ref });
  const edit = await operate({ kind: "edit", ref, commands: [{ kind: "transition-set", ...pair, durationFrames: 30 }] });
  assert.equal(edit.outcome, "updated", edit.reason);
  const update = await operate({ kind: "update", ref: edit.ref });
  assert.equal(update.outcome, "updated", update.reason); assert.equal(writes, 3);
});

test("Current and pending human decisions cannot be overwritten while dependencies prepare", async () => {
  const { store, deps, stage, operate, readTimeline } = await setup();
  const first = await stage(), ref = transitionVersionRef(first.family.id, first.version);
  await operate({ kind: "review", ref });
  const capture = deps.captureDependencies.bind(deps);
  let duringCapture = async () => {
    await applyHumanTimelineCommand(store, productionId, { kind: "commands", baseRevision: JSON.parse(await readTimeline()).revision,
      sourceFingerprint: storyTimelineFingerprint(store.getBundle().productions.find(value => value.meta.id === productionId)!),
      commands: [{ kind: "transition-set", ...pair, durationFrames: 18 }] });
  };
  deps.captureDependencies = async input => { const result = await capture(input); await duringCapture(); return result; };
  await assert.rejects(stage(model(30)), /Current changed during preparation/);
  assert.equal(JSON.parse(await readTimeline()).transitions[0].durationFrames, 18);
  duringCapture = async () => { assert.equal((await operate({ kind: "discard", ref })).outcome, "discarded"); };
  const result = await operate({ kind: "update", ref });
  assert.equal(result.outcome, "refused"); assert.match(result.reason!, /pending decisions changed/);
  assert.equal((await readTransitionFamilies(store, productionId))[0]!.status, "discarded");
});
