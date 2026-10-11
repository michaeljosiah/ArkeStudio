import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { defaultEffectClip } from "../src/editor-effects.js";
import { DEFAULT_MIX, applyTimelineCommands, undoTimelineHistory, redoTimelineHistory, type ProductionTimeline } from "../src/timeline.js";
import { createEffectProposalFamily, reviewEffectProposalVersion, effectProposalApplyRefusal } from "../src/editor-effect-proposal-lifecycle.js";
import { compileEffectModelRevision, compileEffectHumanAdjustment, replayEffectProposal, finalizeEffectProposal,
  effectCandidateContentMaterial, effectCandidateFingerprintMaterial, effectCandidateTimeline, rebaseEffectProposal,
  type EffectProposalCompilation, type CompiledEffectCandidate } from "../src/editor-effect-proposal-compile.js";
import { ModelEffectProposalSchema, EffectProposalFamilySchema, type EffectArrangementScope, type EffectProposalFamily,
  type EffectProposalDependencies, type EffectProposalVersion, type EffectHumanIntent, type ModelEffectProposal, type EffectCreativeCommand,
  type EffectIdentityAllocation } from "../src/editor-effect-proposal.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex"), NOW = "2026-10-11T20:00:00.000Z";
const scope: EffectArrangementScope = { kind: "effects-only", target: { kind: "composition" }, range: { startFrame: 0, endFrame: 240 },
  audio: { kind: "off" }, palette: [{ id: "dust", version: 1 }], direction: "Quiet dust" };
function base(count = 1): ProductionTimeline {
  return { schemaVersion: 1, revision: 0, frameRate: 24, history: { undo: [], redo: [] }, mix: DEFAULT_MIX, library: [], tracks: [
    { id: "tr_picture", kind: "picture", name: "Picture", order: 0, muted: false, clips: [] },
    { id: "tr_fx", kind: "effect", name: "Atmosphere", order: 1, muted: false, clips: [], effects: Array.from({ length: count }, (_, index) =>
      ({ ...defaultEffectClip({ id: `cl_${index}`, lineageId: `ef_${index}`, startFrame: 0, durationFrames: 240, seed: index + 1 }),
        appearance: { amount: 0.6, size: 0.3, opacity: 0.5, colour: "#ffffff" } })) },
  ] };
}
function family(timeline = base()): EffectProposalFamily {
  return createEffectProposalFamily({ id: "req_01J8G000000000000000000001", productionId: "saltlight", conversationId: "cv_01J8G0000000000000000000C1",
    scope, base: timeline, timelineHash: `sha256:${hash(JSON.stringify(timeline))}`, baseId: "base_0", at: NOW });
}
function fence(timeline: ProductionTimeline): EffectProposalDependencies {
  return { schemaVersion: 1, base: { revision: timeline.revision, timelineHash: `sha256:${hash(JSON.stringify(timeline))}` }, resolutionHash: hash("resolution"),
    profiles: { rendererVersion: "software-rgba-v1", catalogueHash: hash("catalogue"), analysisProfileId: "audible-pcm-v1" }, sources: [], reactions: [], protection: [], issues: [] };
}
function append(owner: EffectProposalFamily, result: EffectProposalCompilation, id: string, parent?: string,
  branchId = `branch_${id}`, baseId = "base_0"): EffectProposalFamily {
  const dependencies = fence(base());
  const version: EffectProposalVersion = { id, number: owner.versions.length + 1, branchId, baseId, createdAt: NOW, origin: "model", summary: "Quiet dust",
    ...(parent ? { parentVersionId: parent } : {}), ...result.draft, dependencies,
    basisHash: hash(effectCandidateContentMaterial(result.draft)), candidateHash: hash(effectCandidateFingerprintMaterial(result.draft, dependencies)) };
  const steps = owner.steps.some(step => step.id === result.step.id) ? owner.steps : [...owner.steps, result.step];
  return EffectProposalFamilySchema.parse({ ...owner, steps, identities: result.ledger, decisions: [...owner.decisions, ...result.decisions.filter(decision => !owner.decisions.some(row => row.id === decision.id))],
    activeDecisionIds: result.draft.decisionIds, decisionRevision: result.draft.decisionRevision, versions: [...owner.versions, version],
    branches: [...owner.branches.filter(branch => branch.id !== branchId), { id: branchId, headVersionId: id, undoVersionIds: parent ? [parent] : [], redoVersionIds: [] }] });
}
function model(timeline: ProductionTimeline, owner: EffectProposalFamily, commands: EffectCreativeCommand[], id: string, parent?: string,
  identities: ModelEffectProposal["identities"] = [], allocations: EffectIdentityAllocation[] = []) {
  const version = owner.versions.find(row => row.id === parent);
  return compileEffectModelRevision({ base: timeline, family: owner, model: { summary: "Quiet dust", commands, identities,
    ...(version ? { family: { id: owner.id, parentVersionId: version.id, candidateHash: version.candidateHash } } : {}) },
    ...(parent ? { parentVersionId: parent } : {}), allocations, stamp: { stepId: `step_${id}`, versionId: id, branchId: `branch_${id}`, at: NOW } });
}
function human(timeline: ProductionTimeline, owner: EffectProposalFamily, from: string, intent: EffectHumanIntent, id: string) {
  const version = owner.versions.find(row => row.id === from)!;
  return compileEffectHumanAdjustment({ base: timeline, family: owner, fromVersionId: from, allocations: [], action: { id: `action_${id}`, at: NOW,
    ref: { familyId: owner.id, versionId: from, candidateHash: version.candidateHash, decisionRevision: owner.decisionRevision }, intent },
    stamp: { stepId: `step_${id}`, versionId: id, branchId: `branch_${id}`, at: NOW } });
}
const patch = (amount: number, clipId = "cl_0"): EffectCreativeCommand => ({ kind: "effect-patch", clipId, patch: { appearance: { amount } } });
const effect = (result: EffectProposalCompilation, id = "cl_0") => result.draft.state.tracks.flatMap(track => track.effects).find(row => row.id === id)!;

test("model creative schemas refuse authority switches, permanent protection and unbounded segments", () => {
  const proposal = { summary: "quiet", commands: [patch(0.3)], identities: [] };
  for (const forged of [{ ...proposal, authority: "human" }, { ...proposal, commands: [{ ...patch(0.3), human: true }] },
    { ...proposal, commands: [{ kind: "effect-release", ruleId: "pr_colour" }] }, { ...proposal, commands: Array.from({ length: 51 }, () => patch(0.3)) }])
    assert.equal(ModelEffectProposalSchema.safeParse(forged).success, false);
});

test("mixed provenance produces one exact revision/Undo and persisted replay hashes match", () => {
  const timeline = base(); let owner = family(timeline);
  const first = model(timeline, owner, [patch(0.3)], "v1"); assert.equal(first.ok, true); owner = append(owner, first, "v1");
  const adjusted = human(timeline, owner, "v1", { kind: "adjust", commands: [{ kind: "effect-patch", clipId: "cl_0", patch: { appearance: { colour: "#aaccee" } } }] }, "v2");
  assert.equal(adjusted.ok, true); owner = append(owner, adjusted, "v2", "v1");
  const replayed = replayEffectProposal({ base: timeline, family: JSON.parse(JSON.stringify(owner)), versionId: "v2" });
  assert.equal(replayed.ok, true); if (!replayed.ok) return;
  assert.equal(hash(effectCandidateContentMaterial(replayed.compiled)), owner.versions[1]!.basisHash);
  const applied = finalizeEffectProposal(timeline, replayed.compiled, { label: "Quiet dust", requestId: owner.id });
  assert.equal(applied.kind, "changed"); if (applied.kind !== "changed") return;
  assert.equal(applied.timeline.revision, 1); assert.equal(applied.timeline.history.undo.length, 1);
  assert.deepEqual(undoTimelineHistory(applied.timeline).tracks, timeline.tracks);
  assert.deepEqual(redoTimelineHistory(undoTimelineHistory(applied.timeline)).tracks, applied.timeline.tracks);
  assert.throws(() => finalizeEffectProposal(timeline, structuredClone(replayed.compiled) as CompiledEffectCandidate, { label: "fake", requestId: owner.id }), /replayed exact/);
});

test("latest scalar human values survive model revision from both latest and older parent", () => {
  const timeline = base(); let owner = family(timeline);
  const first = model(timeline, owner, [patch(0.3)], "v1"); owner = append(owner, first, "v1");
  const adjusted = human(timeline, owner, "v1", { kind: "adjust", commands: [patch(0.42)] }, "v2"); owner = append(owner, adjusted, "v2", "v1");
  for (const parent of ["v1", "v2"]) {
    const result = model(timeline, owner, [{ kind: "effect-patch", clipId: "cl_0", patch: { appearance: { amount: 0.9, size: 0.8 } } }], `v3_${parent}`, parent);
    assert.equal(result.ok, true, JSON.stringify(result.conflicts)); assert.equal(effect(result).appearance.amount, 0.42); assert.equal(effect(result).appearance.size, 0.8);
  }
});

test("manual point values survive whole-curve suggestions without freezing unadjusted points", () => {
  const timeline = base(); timeline.tracks[1]!.effects![0]!.intensityCurve.points = [
    { id: "ep_a", offsetFrames: 0, value: 0.2, interpolation: "linear" }, { id: "ep_b", offsetFrames: 100, value: 0.6, interpolation: "linear" }];
  let owner = family(timeline); owner = append(owner, model(timeline, owner, [patch(0.3)], "v1"), "v1");
  const points = structuredClone(timeline.tracks[1]!.effects![0]!.intensityCurve.points); points[0]!.value = 0.4;
  owner = append(owner, human(timeline, owner, "v1", { kind: "adjust", commands: [{ kind: "effect-patch", clipId: "cl_0", patch: { intensityCurve: { points } } }] }, "v2"), "v2", "v1");
  const suggested = points.map(point => ({ ...point, value: 0.9 }));
  const result = model(timeline, owner, [{ kind: "effect-patch", clipId: "cl_0", patch: { intensityCurve: { points: suggested } } }], "v3", "v2");
  assert.equal(result.ok, true, JSON.stringify(result.conflicts)); assert.deepEqual(effect(result).intensityCurve.points.map(point => point.value), [0.4, 0.9]);
});

test("explicit Release retries only the blocked suggestion and remains one Undo", () => {
  let timeline = base(); timeline = applyTimelineCommands(timeline, [{ kind: "effect-protect", rule: { id: "pr_colour", lineageId: "ef_0",
    kind: "property", property: "appearance.colour", scope: { kind: "whole" } } }], { effectAuthority: "human" });
  let owner = family(timeline);
  const blocked = model(timeline, owner, [{ kind: "effect-patch", clipId: "cl_0", patch: { appearance: { colour: "#aabbcc" } } }], "v1");
  assert.equal(blocked.ok, false); assert.equal(blocked.conflicts[0]!.kind, "protection", JSON.stringify(blocked.conflicts)); owner = append(owner, blocked, "v1");
  const released = human(timeline, owner, "v1", { kind: "release", ruleId: "pr_colour" }, "v2");
  assert.equal(released.ok, true, JSON.stringify(released.conflicts)); owner = append(owner, released, "v2", "v1");
  const replayed = replayEffectProposal({ base: timeline, family: owner, versionId: "v2" }); assert.equal(replayed.ok, true, JSON.stringify(replayed.conflicts));
  if (!replayed.ok) return;
  const result = finalizeEffectProposal(timeline, replayed.compiled, { label: "Colour after Release", requestId: owner.id });
  assert.equal(result.kind, "changed"); if (result.kind !== "changed") return;
  assert.equal(result.timeline.history.undo.length, timeline.history.undo.length + 1);
  assert.deepEqual(undoTimelineHistory(result.timeline).effectProtection, timeline.effectProtection);
  const fork = model(timeline, owner, [{ kind: "effect-patch", clipId: "cl_0", patch: { appearance: { colour: "#ddccbb" } } }], "v3", "v1");
  assert.equal(fork.ok, false); // fork before Release cannot acquire it
});

test("complete 51-result arrangement fails atomically even though each segment is bounded", () => {
  const timeline = base(51); let owner = family(timeline);
  const first = model(timeline, owner, Array.from({ length: 50 }, (_, index) => patch(0.1, `cl_${index}`)), "v1"); assert.equal(first.ok, true); owner = append(owner, first, "v1");
  const result = model(timeline, owner, [patch(0.1, "cl_50")], "v2", "v1");
  assert.equal(result.ok, false); assert.match(result.conflicts.at(-1)!.reason, /51 final changes/);
  assert.throws(() => finalizeEffectProposal(timeline, result.draft as CompiledEffectCandidate, { label: "truncated", requestId: owner.id }), /replayed exact/);
});

test("scope rejects target, audio, unrelated track and outside-passage edits", () => {
  const timeline = base(), owner = family(timeline);
  for (const commands of [[{ kind: "set-track", trackId: "tr_picture", name: "Unauthorized" }],
    [{ kind: "effect-patch", clipId: "cl_0", patch: { target: { kind: "picture-track", trackId: "tr_picture" } } }],
    [{ kind: "effect-patch", clipId: "cl_0", patch: { audioInput: { kind: "composition-mix" }, reaction: { enabled: true } } }],
    [{ kind: "effect-move", clipId: "cl_0", startFrame: 10 }]] as EffectCreativeCommand[][])
    assert.equal(model(timeline, owner, commands, "v1").ok, false);
});

test("Review permits old-version inspection but Apply requires current human decisions", () => {
  const timeline = base(); let owner = family(timeline);
  owner = append(owner, model(timeline, owner, [patch(0.3)], "v1"), "v1");
  owner = append(owner, human(timeline, owner, "v1", { kind: "adjust", commands: [patch(0.4)] }, "v2"), "v2", "v1");
  const ref = { familyId: owner.id, versionId: "v1", candidateHash: owner.versions[0]!.candidateHash, decisionRevision: owner.decisionRevision };
  const reviewed = reviewEffectProposalVersion(owner, ref, { id: "review_old", at: NOW });
  assert.match(effectProposalApplyRefusal(reviewed.family, ref, reviewed.grant.id)!, /Human decisions changed/);
});

test("Update preserves unrelated Current values but blocks a changed retained manual scope", () => {
  const timeline = base(); let owner = family(timeline);
  owner = append(owner, model(timeline, owner, [patch(0.3)], "v1"), "v1");
  owner = append(owner, human(timeline, owner, "v1", { kind: "adjust", commands: [patch(0.4)] }, "v2"), "v2", "v1");
  for (const touched of [false, true]) {
    const current = applyTimelineCommands(timeline, [{ kind: "effect-patch", clipId: "cl_0", patch: { appearance: touched ? { amount: 0.8 } : { size: 0.8 } } }], { effectAuthority: "human" });
    const { history: _history, ...authored } = current;
    const next = { ...owner, bases: [...owner.bases, { id: "base_new", revision: current.revision, timelineHash: `sha256:${hash(JSON.stringify(current))}`, authored }] };
    const result = rebaseEffectProposal({ base: current, family: next, fromVersionId: "v2", newBaseId: "base_new", stamp: { versionId: "v3", stepId: "step_v3", at: NOW } });
    assert.equal(result.ok, !touched, JSON.stringify(result.conflicts));
    if (!touched) assert.equal(effectCandidateTimeline(current, result.draft).tracks[1]!.effects![0]!.appearance.size, 0.8);
    else assert.deepEqual(effectCandidateTimeline(current, result.draft).tracks, current.tracks);
  }
});

test("Keep current restores an AI-removed existing effect as an exact no-op", () => {
  const timeline = base(); let owner = family(timeline);
  owner = append(owner, model(timeline, owner, [{ kind: "effect-remove", clipId: "cl_0" }], "v1"), "v1");
  const result = human(timeline, owner, "v1", { kind: "keep-current", entityId: "segment:cl_0", scope: { kind: "whole-effect" } }, "v2");
  assert.equal(result.ok, true, JSON.stringify(result.conflicts)); assert.deepEqual(result.draft.delta, []);
  if (result.ok) assert.equal(finalizeEffectProposal(timeline, result.compiled, { label: "Keep current", requestId: owner.id }).kind, "unchanged");
});

test("Exclude addition removes its dependent empty new track and tombstones identity", () => {
  const timeline = base(); let owner = family(timeline);
  const original = defaultEffectClip({ id: "cl_alias", lineageId: "ef_model", startFrame: 0, durationFrames: 120, seed: 99 });
  const allocation: EffectIdentityAllocation = { kind: "effect", alias: "cl_alias", entityId: "origin_new", clipId: "cl_new", lineageId: "ef_new", seed: 42, slotId: "slot_new" };
  const first = model(timeline, owner, [{ kind: "add-track", trackId: "tr_new", trackKind: "effect", name: "New" },
    { kind: "effect-create", trackId: "tr_new", effect: original }], "v1", undefined, [{ kind: "new-effect", alias: "cl_alias", slotId: "slot_new" }], [allocation]);
  assert.equal(first.ok, true, JSON.stringify(first.conflicts)); owner = append(owner, first, "v1");
  const excluded = human(timeline, owner, "v1", { kind: "exclude", originId: "origin_new" }, "v2");
  assert.equal(excluded.ok, true, JSON.stringify(excluded.conflicts)); assert.deepEqual(excluded.draft.delta, []); owner = append(owner, excluded, "v2", "v1");
  assert.equal(owner.identities.origins.find(row => row.originId === "origin_new")!.tombstoned, true);
  const resurrection = model(timeline, owner, [{ kind: "effect-duplicate", clipId: "cl_new", newClipId: "cl_another", newLineageId: "ef_bad", startFrame: 0, seed: 200 }], "v3", "v2",
    [{ kind: "duplicate", alias: "cl_another", sourceOriginId: "origin_new", slotId: "slot_other" }],
    [{ kind: "effect", alias: "cl_another", entityId: "origin_other", clipId: "cl_other", lineageId: "ef_other", seed: 200, slotId: "slot_other" }]);
  assert.equal(resurrection.ok, false); assert.match(resurrection.conflicts[0]!.reason, /slot|excluded/i);
});

test("manual duplicate copies points and protection with new identity and seed", () => {
  let timeline = base(); timeline.tracks[1]!.effects![0]!.intensityCurve.points = [{ id: "ep_a", offsetFrames: 0, value: 0.2, interpolation: "linear" }];
  timeline = applyTimelineCommands(timeline, [{ kind: "effect-protect", rule: { id: "pr_amount", lineageId: "ef_0", kind: "property", property: "appearance.amount", scope: { kind: "whole" } } }], { effectAuthority: "human" });
  let owner = family(timeline);
  owner = append(owner, model(timeline, owner, [{ kind: "effect-patch", clipId: "cl_0", patch: { appearance: { size: 0.3 } } }], "v1"), "v1");
  const result = human(timeline, owner, "v1", { kind: "adjust", commands: [{ kind: "effect-duplicate", clipId: "cl_0", newClipId: "cl_copy", newLineageId: "ef_copy", seed: 12, startFrame: 0 }] }, "v2");
  assert.equal(result.ok, true, JSON.stringify(result.conflicts)); assert.equal(effect(result, "cl_copy").seed, 12);
  assert.notEqual(effect(result, "cl_copy").intensityCurve.points[0]!.id, "ep_a");
  assert.equal(result.draft.state.protection.length, 2);
});

test("Release becomes stale after a later manual change to its scope, including restored values", () => {
  let timeline = base(); timeline = applyTimelineCommands(timeline, [{ kind: "effect-protect", rule: { id: "pr_amount", lineageId: "ef_0", kind: "property", property: "appearance.amount", scope: { kind: "whole" } } }], { effectAuthority: "human" });
  let owner = family(timeline); owner = append(owner, model(timeline, owner, [patch(0.3)], "v1"), "v1");
  owner = append(owner, human(timeline, owner, "v1", { kind: "release", ruleId: "pr_amount" }, "v2"), "v2", "v1");
  const unrelated = human(timeline, owner, "v2", { kind: "adjust", commands: [{ kind: "effect-patch", clipId: "cl_0", patch: { appearance: { size: 0.8 } } }] }, "v3");
  assert.equal(unrelated.ok, true, JSON.stringify(unrelated.conflicts));
  assert.throws(() => human(timeline, owner, "v2", { kind: "adjust", commands: [patch(0.9), patch(0.3)] }, "noop"), /changes no effect/);
  const changed = human(timeline, owner, "v2", { kind: "adjust", commands: [patch(0.9)] }, "v4");
  assert.equal(changed.ok, false); assert.match(changed.conflicts[0]!.reason, /later manual edit/);
  owner = append(owner, changed, "v4", "v2");
  const restored = human(timeline, owner, "v4", { kind: "adjust", commands: [patch(0.3)] }, "v5");
  assert.equal(restored.ok, false); assert.match(restored.conflicts[0]!.reason, /later manual edit/);
  owner = append(owner, restored, "v5", "v4");
  const renewed = human(timeline, owner, "v5", { kind: "release", ruleId: "pr_amount" }, "v6");
  assert.equal(renewed.ok, true, JSON.stringify(renewed.conflicts));
  owner = append(owner, renewed, "v6", "v5");
  assert.equal(replayEffectProposal({ base: timeline, family: owner, versionId: "v6" }).ok, true);
});

test("permission for one point field retains its other manually adjusted field", () => {
  const timeline = base(); timeline.tracks[1]!.effects![0]!.intensityCurve.points = [{ id: "ep_a", offsetFrames: 0, value: 0.2, interpolation: "linear" }];
  let owner = family(timeline); owner = append(owner, model(timeline, owner, [patch(0.3)], "v1"), "v1");
  owner = append(owner, human(timeline, owner, "v1", { kind: "adjust", commands: [{ kind: "effect-patch", clipId: "cl_0", patch: { intensityCurve: { points: [
    { id: "ep_a", offsetFrames: 20, value: 0.4, interpolation: "linear" }] } } }] }, "v2"), "v2", "v1");
  const entityId = owner.identities.points[0]!.entityId;
  owner = append(owner, human(timeline, owner, "v2", { kind: "permit-revision", adjustmentIds: owner.activeDecisionIds,
    scopes: [{ kind: "point", curve: "intensityCurve", entityId, fields: ["value"] }] }, "v3"), "v3", "v2");
  const result = model(timeline, owner, [{ kind: "effect-patch", clipId: "cl_0", patch: { intensityCurve: { points: [
    { id: "ep_a", offsetFrames: 40, value: 0.9, interpolation: "linear" }] } } }], "v4", "v3");
  assert.equal(result.ok, true, JSON.stringify(result.conflicts)); assert.deepEqual(effect(result).intensityCurve.points[0], { id: "ep_a", offsetFrames: 20, value: 0.9, interpolation: "linear" });
});

test("a model cannot remove a manually adjusted point using a fresh unnamed replacement", () => {
  const timeline = base(); timeline.tracks[1]!.effects![0]!.intensityCurve.points = [{ id: "ep_a", offsetFrames: 0, value: 0.2, interpolation: "linear" }];
  let owner = family(timeline); owner = append(owner, model(timeline, owner, [patch(0.3)], "v1"), "v1");
  owner = append(owner, human(timeline, owner, "v1", { kind: "adjust", commands: [{ kind: "effect-patch", clipId: "cl_0", patch: { intensityCurve: { points: [] } } }] }, "v2"), "v2", "v1");
  const result = model(timeline, owner, [{ kind: "effect-patch", clipId: "cl_0", patch: { intensityCurve: { points: [{ id: "ep_fresh", offsetFrames: 1, value: 0.8, interpolation: "linear" }] } } }], "v3", "v2",
    [{ kind: "new-point", alias: "ep_fresh", originId: "origin:ef_0" }], [{ kind: "point", alias: "ep_fresh", entityId: "point_new", authoredId: "ep_new" }]);
  assert.equal(result.ok, false); assert.match(result.conflicts[0]!.reason, /manual deletion/);
});

test("authenticated pending target, audio, palette and range changes admit only that identity", () => {
  const timeline = base(); let owner = family(timeline);
  owner = append(owner, model(timeline, owner, [patch(0.3)], "v1"), "v1");
  const adjusted = human(timeline, owner, "v1", { kind: "adjust", commands: [
    { kind: "effect-patch", clipId: "cl_0", patch: { target: { kind: "picture-track", trackId: "tr_picture" }, preset: { id: "embers", version: 1 },
      audioInput: { kind: "composition-mix" }, reaction: { enabled: true } } },
    { kind: "effect-move", clipId: "cl_0", startFrame: 500 },
  ] }, "v2");
  assert.equal(adjusted.ok, true, JSON.stringify(adjusted.conflicts)); owner = append(owner, adjusted, "v2", "v1");
  const revision = model(timeline, owner, [{ kind: "effect-patch", clipId: "cl_0", patch: { appearance: { amount: 0.8 },
    target: { kind: "composition" }, reaction: { enabled: false }, audioInput: null, preset: { id: "dust", version: 1 } } }], "v3", "v2");
  assert.equal(revision.ok, true, JSON.stringify(revision.conflicts)); assert.equal(effect(revision).appearance.amount, 0.8);
  assert.deepEqual(effect(revision).target, { kind: "picture-track", trackId: "tr_picture" }); assert.equal(effect(revision).startFrame, 500);
  assert.equal(effect(revision).reaction.enabled, true); assert.deepEqual(effect(revision).audioInput, { kind: "composition-mix" });
  assert.equal(effect(revision).preset.id, "embers");
  const outside = defaultEffectClip({ id: "cl_new_alias", lineageId: "ef_hint", startFrame: 500, durationFrames: 120, seed: 77 });
  const attempt = model(timeline, owner, [{ kind: "effect-create", trackId: "tr_fx", effect: outside }], "v4", "v2",
    [{ kind: "new-effect", alias: "cl_new_alias", slotId: "new-slot" }],
    [{ kind: "effect", alias: "cl_new_alias", entityId: "origin_new", clipId: "cl_new", lineageId: "ef_new", seed: 22, slotId: "new-slot" }]);
  assert.equal(attempt.ok, false); // No slot or passage authority transfers from the human-edited entity.
});

test("a corrected model revision replaces blocked creative intent without dropping protection", () => {
  let timeline = base(); timeline = applyTimelineCommands(timeline, [{ kind: "effect-protect", rule: { id: "pr_colour", lineageId: "ef_0", kind: "property", property: "appearance.colour", scope: { kind: "whole" } } }], { effectAuthority: "human" });
  let owner = family(timeline);
  const blocked = model(timeline, owner, [{ kind: "effect-patch", clipId: "cl_0", patch: { appearance: { colour: "#000000" } } }], "v1");
  owner = append(owner, blocked, "v1");
  const revised = model(timeline, owner, [patch(0.2)], "v2", "v1");
  assert.equal(revised.ok, true, JSON.stringify(revised.conflicts)); assert.equal(effect(revised).appearance.colour, "#ffffff");
  assert.equal(effect(revised).appearance.amount, 0.2); assert.deepEqual(revised.draft.state.protection, timeline.effectProtection);
  owner = append(owner, revised, "v2", "v1");
  assert.equal(replayEffectProposal({ base: timeline, family: owner, versionId: "v2" }).ok, true);
  assert.equal(owner.versions[0]!.conflicts.length, 1);
});

test("Amount-only human edits do not expand the model's authorized passage", () => {
  const timeline = base(); timeline.tracks[1]!.effects![0]!.durationFrames = 480;
  let owner = { ...family(timeline), scope: { ...scope, range: { startFrame: 120, endFrame: 240 } } };
  const inert: ModelEffectProposal = { summary: "Quiet dust", identities: [], commands: [], requestedActions: [{ kind: "new-slot", count: 1, reason: "Review existing dust first" }] };
  const first = compileEffectModelRevision({ base: timeline, family: owner, model: inert, allocations: [], stamp: { stepId: "step_v1", versionId: "v1", branchId: "branch_v1", at: NOW } });
  owner = append(owner, first, "v1");
  const adjusted = human(timeline, owner, "v1", { kind: "adjust", commands: [patch(0.4)] }, "v2");
  assert.equal(adjusted.ok, true, JSON.stringify(adjusted.conflicts)); owner = append(owner, adjusted, "v2", "v1");
  const result = model(timeline, owner, [{ kind: "effect-patch", clipId: "cl_0", patch: { appearance: { size: 0.9 } } }], "v3", "v2");
  assert.equal(result.ok, false); assert.match(result.conflicts[0]!.reason, /outside the requested passage/);
});
