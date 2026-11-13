import assert from "node:assert/strict";
import { test } from "node:test";
import { ClientMessageSchema, ModelWorldChatActionSchema, ProductionChatTurnResultSchema, WorldChatTurnResultSchema,
  WorldChatSubjectSchema, EffectReviewCommandSchema, editorProposalActionCount } from "../src/index.js";

const worldId = `01J8G${"0".repeat(21)}`, check = `check_${worldId}`;
const proposal = { summary: "Quiet atmosphere", commands: [{ kind: "effect-patch", clipId: "cl_dust", patch: { appearance: { opacity: .3 } } }], identities: [] };
const action = { kind: "production-effects-propose", productionId: "film", proposal, checkReceiptIds: [check] };
const ref = { familyId: `req_${worldId}`, versionId: "version-1", candidateHash: "a".repeat(64), decisionRevision: 0 };
const result = { reply: "Prepared", candidateOperations: [], groupOperations: [], bibleEdits: [], editorRequests: [], sceneEdits: [], actions: [action] };

test("the model prepares effect intent but cannot send review, release or human authority", () => {
  assert.equal(ModelWorldChatActionSchema.safeParse(action).success, true);
  for (const extra of [{ authority: "human" }, { reviewId: "grant" }, { decisions: [] }, { scope: { kind: "effects-only" } }]) {
    assert.equal(ModelWorldChatActionSchema.safeParse({ ...action, ...extra }).success, false);
    assert.equal(ModelWorldChatActionSchema.safeParse({ ...action, proposal: { ...proposal, ...extra } }).success, false);
  }
  assert.equal(ModelWorldChatActionSchema.safeParse({ ...action, proposal: { ...proposal, commands: [{ kind: "effect-release", ruleId: "pr_amount" }] } }).success, false);
  const human = { kind: "editor-effect-proposal", worldId, productionId: "film", requestId: "release-gesture",
    operation: { kind: "edit", ref, intent: { kind: "release", ruleId: "pr_amount" } } };
  assert.equal(EffectReviewCommandSchema.safeParse(human).success, true);
  assert.equal(ClientMessageSchema.safeParse(human).success, true);
  assert.equal(ModelWorldChatActionSchema.safeParse(human).success, false);
});

test("all editor proposal result paths share the two-per-turn bound", () => {
  const generic = { summary: "Mute sound", commands: [{ kind: "set-track", trackId: "tr_audio", muted: true }] };
  for (const schema of [WorldChatTurnResultSchema, ProductionChatTurnResultSchema]) {
    assert.equal(schema.safeParse({ ...result, editorRequests: [generic] }).success, true);
    assert.equal(schema.safeParse({ ...result, editorRequests: [generic, generic] }).success, false);
    assert.equal(schema.safeParse({ ...result, actions: [action, action, action] }).success, false);
    assert.equal(schema.safeParse({ ...result, actions: [action, { kind: "production-audio-edit", productionId: "film", request: generic, checkReceiptIds: [check] }], editorRequests: [generic] }).success, false);
  }
  assert.equal(editorProposalActionCount([{ kind: "production-timeline-operation", request: { operation: "assemble" } },
    { kind: "production-audio-cue" }, { kind: "production-timeline-operation", request: { operation: "undo" } }]), 2);
});

test("request scope and exact Review identity are strict and independent", () => {
  const scope = { kind: "effects-only", target: { kind: "composition" }, range: { startFrame: 0, endFrame: 240 },
    audio: { kind: "off" }, direction: "Gentle dust", palette: [{ id: "dust", version: 1 }] };
  assert.equal(WorldChatSubjectSchema.safeParse({ kind: "effect-arrangement", scope, reviewed: ref }).success, true);
  assert.equal(WorldChatSubjectSchema.safeParse({ kind: "effect-arrangement", scope: { ...scope, range: { startFrame: 240, endFrame: 0 } } }).success, false);
  const apply = { kind: "editor-effect-proposal", worldId, productionId: "film", requestId: "apply-gesture", operation: { kind: "apply", ref, reviewId: "review-1" } };
  assert.equal(EffectReviewCommandSchema.safeParse(apply).success, true);
  assert.equal(EffectReviewCommandSchema.safeParse({ ...apply, operation: { ...apply.operation, commands: proposal.commands } }).success, false);
  assert.equal(EffectReviewCommandSchema.safeParse({ ...apply, operation: { kind: "apply", ref } }).success, false);
});
