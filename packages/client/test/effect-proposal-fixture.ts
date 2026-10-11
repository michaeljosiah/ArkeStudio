import { createHash } from "node:crypto";
import { allocateEffectProposalIdentities, compileEffectHumanAdjustment, compileEffectModelRevision, createEffectProposalFamily,
  defaultEffectClip, DEFAULT_MIX, effectCandidateContentMaterial, effectCandidateFingerprintMaterial, effectProposalFamilyView,
  EffectProposalFamilySchema, type EffectHumanIntent, type EffectProposalCompilation, type EffectProposalDependencies,
  type EffectProposalFamily, type EffectProposalVersion, type EffectReviewGrant, type EffectVersionRef, type ModelEffectProposal,
  type ProductionTimeline } from "@arke-studio/contracts";

export const EFFECT_REVIEW_TEST_AT = "2026-10-11T20:00:00.000Z";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export function effectProposalTestFence(timeline: ProductionTimeline): EffectProposalDependencies {
  return { schemaVersion: 1, base: { revision: timeline.revision, timelineHash: `sha256:${digest(JSON.stringify(timeline))}` },
    resolutionHash: digest("resolution"), profiles: { rendererVersion: "software-rgba-v1", catalogueHash: digest("catalogue"), analysisProfileId: "audible-pcm-v1" },
    sources: [], reactions: [], protection: [], issues: [] };
}
export function effectProposalTestRef(family: EffectProposalFamily, version = family.versions.at(-1)!): EffectVersionRef {
  return { familyId: family.id, versionId: version.id, candidateHash: version.candidateHash, decisionRevision: family.decisionRevision };
}
export function grantEffectProposalTestReview(family: EffectProposalFamily, version = family.versions.at(-1)!, id = `review_${version.id}`):
  { family: EffectProposalFamily; grant: EffectReviewGrant; ref: EffectVersionRef } {
  const ref = effectProposalTestRef(family, version);
  const grant: EffectReviewGrant = { ...ref, id, branchId: version.branchId, decisionRevision: version.decisionRevision, reviewedAt: EFFECT_REVIEW_TEST_AT };
  return { family: { ...family, reviewGrants: [...family.reviewGrants.filter(row => row.id !== id), grant] }, grant, ref };
}
function append(family: EffectProposalFamily, timeline: ProductionTimeline, compilation: EffectProposalCompilation, id: string,
  origin: EffectProposalVersion["origin"], parent?: EffectProposalVersion, branchId = parent?.branchId ?? "branch_first"): EffectProposalFamily {
  const dependencies = effectProposalTestFence(timeline);
  const version: EffectProposalVersion = { id, number: family.versions.length + 1, branchId, baseId: family.bases[0]!.id,
    createdAt: EFFECT_REVIEW_TEST_AT, origin, summary: "Quiet atmospheric dust", ...(parent ? { parentVersionId: parent.id } : {}),
    ...compilation.draft, dependencies, basisHash: digest(effectCandidateContentMaterial(compilation.draft)),
    candidateHash: digest(effectCandidateFingerprintMaterial(compilation.draft, dependencies)) };
  const branch = family.branches.find(row => row.id === branchId);
  return EffectProposalFamilySchema.parse({ ...family, decisionRevision: version.decisionRevision, identities: compilation.ledger,
    steps: [...family.steps, compilation.step], decisions: [...family.decisions, ...compilation.decisions.filter(row => !family.decisions.some(existing => existing.id === row.id))],
    activeDecisionIds: version.decisionIds, versions: [...family.versions, version],
    branches: [...family.branches.filter(row => row.id !== branchId), { id: branchId, headVersionId: id,
      undoVersionIds: [...(branch?.undoVersionIds ?? []), ...(parent ? [parent.id] : [])], redoVersionIds: [] }] });
}
export function appendEffectProposalTestModel(family: EffectProposalFamily, timeline: ProductionTimeline, model: ModelEffectProposal,
  id = `v${family.versions.length + 1}`, parent = family.versions.at(-1)): EffectProposalFamily {
  const branchId = `branch_${id}`;
  const proposal = { ...model, ...(parent ? { family: { id: family.id, parentVersionId: parent.id, candidateHash: parent.candidateHash } } : {}) };
  let minted = 0;
  const allocations = allocateEffectProposalIdentities(proposal, kind => `${({ clip: "cl", lineage: "ef", entity: "entity", point: "ep", cue: "ec" })[kind]}_${id}_${++minted}`, () => 100);
  const compilation = compileEffectModelRevision({ base: timeline, family, model: proposal, allocations,
    ...(parent ? { parentVersionId: parent.id } : {}), stamp: { stepId: `step_${id}`, versionId: id, branchId, at: EFFECT_REVIEW_TEST_AT } });
  return append(family, timeline, compilation, id, "model", parent, branchId);
}
export function appendEffectProposalTestHuman(family: EffectProposalFamily, timeline: ProductionTimeline, intent: EffectHumanIntent,
  id = `v${family.versions.length + 1}`, parent = family.versions.at(-1)!): EffectProposalFamily {
  const compilation = compileEffectHumanAdjustment({ base: timeline, family, fromVersionId: parent.id, allocations: [],
    action: { id: `action_${id}`, at: EFFECT_REVIEW_TEST_AT, ref: effectProposalTestRef(family, parent), intent },
    stamp: { stepId: `step_${id}`, versionId: id, branchId: parent.branchId, at: EFFECT_REVIEW_TEST_AT } });
  return append(family, timeline, compilation, id, intent.kind === "release" ? "release" : "human-adjustment", parent);
}
export function effectProposalFixture() {
  const effect = defaultEffectClip({ id: "cl_existing", lineageId: "ef_existing", seed: 42, startFrame: 0, durationFrames: 240 });
  const timeline: ProductionTimeline = { schemaVersion: 1, revision: 0, frameRate: 24, history: { undo: [], redo: [] }, mix: DEFAULT_MIX, library: [],
    tracks: [{ id: "tr_picture", kind: "picture", name: "Picture", order: 0, muted: false, clips: [] },
      { id: "tr_effects", kind: "effect", name: "Atmosphere", order: 1, muted: false, clips: [], effects: [effect] }] };
  let family = createEffectProposalFamily({ id: "req_01J8G000000000000000000001", productionId: "saltlight", conversationId: "cv_01J8G0000000000000000000C1",
    scope: { kind: "effects-only", target: { kind: "composition" }, range: { startFrame: 0, endFrame: 240 }, audio: { kind: "off" },
      palette: [{ id: "dust", version: 1 }], direction: "Quiet dust" }, base: timeline, timelineHash: effectProposalTestFence(timeline).base.timelineHash,
    baseId: "base_first", at: EFFECT_REVIEW_TEST_AT });
  family = appendEffectProposalTestModel(family, timeline, { summary: "Quiet dust", identities: [{ kind: "new-effect", alias: "cl_added", slotId: "slot_added" }],
    commands: [{ kind: "effect-patch", clipId: effect.id, patch: { appearance: { amount: 0.15 } } },
      { kind: "effect-create", trackId: "tr_effects", effect: defaultEffectClip({ id: "cl_added", lineageId: "ef_added", seed: 1, startFrame: 48, durationFrames: 96, order: 1 }) }] });
  return { timeline, effect, family, view: effectProposalFamilyView(family), version: family.versions.at(-1)! };
}
