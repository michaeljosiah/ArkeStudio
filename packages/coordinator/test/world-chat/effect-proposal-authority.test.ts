import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  ModelWorldChatActionSchema, ModelEffectProposalSchema, ModelEditorRequestSchema,
  defaultEffectClip, newId, ulid, storyTimelineFingerprint, timelineSourceFingerprint, groupApprovalEligible,
  type ConversationActionCard, type EffectArrangementScope, type ModelEffectProposal,
  type WorldChatCheckReceipt, type WorldChatSubject,
} from "@arke-studio/contracts";
import { ConversationActionLifecycle } from "../../src/arke-actions/lifecycle.js";
import { ARKE_CLIENT_COMMAND_REGISTRY } from "../../src/arke-actions/registry.js";
import { prepareWorldChatActions, type WorldChatActionTurn } from "../../src/world-chat/actions.js";
import { effectProposalConversationAdapter } from "../../src/world-chat/effect-proposals.js";
import { timelineFence } from "../../src/world-chat/target-reads.js";
import { editorRequestReadRows, productionReadFence } from "../../src/world-chat/production-reads.js";
import { foldConversation } from "../../src/world-chat/fold.js";
import { conversationDir, WorldChatStore } from "../../src/world-chat/store.js";
import { EditorEffectDependencies } from "../../src/productions/editor-effect-dependencies.js";
import { EditorEffectAnalysisService } from "../../src/productions/editor-effect-analysis.js";
import { readEffectProposalFamilies, reviewEffectProposal } from "../../src/productions/editor-effect-requests.js";
import { decideEditorRequest } from "../../src/productions/editor-requests.js";
import { applyHumanTimelineCommand } from "../../src/productions/timeline.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

const PRODUCTION = "saltlight", AT = "2026-10-11T18:30:00.000Z";
const scope: EffectArrangementScope = { kind: "effects-only", target: { kind: "composition" }, range: { startFrame: 0, endFrame: 240 },
  audio: { kind: "off" }, direction: "Soft blue dust", palette: [{ id: "dust", version: 1 }] };
const proposal = (): ModelEffectProposal => ({ summary: "Blue atmosphere, keeping your amount", identities: [],
  commands: [{ kind: "effect-patch", clipId: "cl_dust", patch: { appearance: { colour: "#223344" } } }],
  requestedActions: [{ kind: "release", ruleId: "pr_amount", reason: "Would you like Arke to vary the amount too?" }] });

async function setup() {
  const store = await WorldStore.open(await makeTempWorld(), { clock: () => AT });
  const analysis = new EditorEffectAnalysisService(undefined, () => {});
  closeOnCleanup(async () => { await analysis.stop(); await store.close(); });
  const production = store.getBundle().productions.find(row => row.meta.id === PRODUCTION)!;
  const effect = defaultEffectClip({ id: "cl_dust", lineageId: "ef_dust", startFrame: 0, durationFrames: 240, seed: 7 });
  effect.appearance.amount = 0.6;
  await applyHumanTimelineCommand(store, PRODUCTION, { kind: "commands", baseRevision: null, sourceFingerprint: storyTimelineFingerprint(production), commands: [
    { kind: "add-track", trackKind: "effect", trackId: "tr_fx", name: "Effects" }, { kind: "effect-create", trackId: "tr_fx", effect },
    { kind: "effect-protect", rule: { id: "pr_amount", lineageId: "ef_dust", kind: "property", property: "appearance.amount", scope: { kind: "whole" } } },
  ] });
  const conversationId = newId("cv"), entryContext = { kind: "cut" as const, productionId: PRODUCTION };
  const log = new WorldChatStore(conversationDir(store.dir, conversationId));
  await log.create(conversationId, AT);
  await log.append({ type: "conversation.created", title: "Effects", entryContext }, { at: AT });
  const dependencies = new EditorEffectDependencies(analysis);
  const adapter = effectProposalConversationAdapter(store, dependencies, () => AT);
  const lifecycle = new ConversationActionLifecycle({ worldPath: store.dir, worldId: store.worldId, now: () => AT, adapters: [adapter] });
  const current = () => readFile(join(store.dir, "productions", PRODUCTION, "timeline.json"), "utf8");
  const requests = () => readFile(join(store.dir, "productions", PRODUCTION, "editor-requests.json"), "utf8");
  const loaded = async () => {
    const meta = (await log.readMeta())!;
    return foldConversation(meta.id, meta.createdAt, (await log.read()).events).view;
  };
  const receipts = (): WorldChatCheckReceipt[] => {
    const bundle = store.getBundle(), currentProduction = bundle.productions.find(row => row.meta.id === PRODUCTION)!;
    return (["timeline", "editor-requests"] as const).map(requirement => ({ id: newId("check"), runId: newId("run"), tool: "target-read", status: "complete",
      consulted: [], target: { requirement, id: PRODUCTION }, observedRevisionOrDigest: requirement === "timeline"
        ? timelineFence(currentProduction, bundle.artifacts) : productionReadFence(editorRequestReadRows(currentProduction)), complete: true, nextCursor: null, at: AT }));
  };
  const turn = (model = proposal(), overrides: Partial<WorldChatActionTurn> = {}): WorldChatActionTurn => {
    const reads = receipts();
    return { conversationId, turnId: newId("turn"), entryContext, at: AT, existingCandidates: [], existingGroups: [], candidates: [], groups: [], bibleEdits: [],
      bibleBaseVersion: 1, sceneEdits: [], sceneBaseVersion: null, editorRequests: [], receipts: reads,
      subject: { kind: "effect-arrangement", scope: structuredClone(scope) },
      actions: [ModelWorldChatActionSchema.parse({ kind: "production-effects-propose", productionId: PRODUCTION, proposal: model, checkReceiptIds: reads.map(read => read.id) })], ...overrides };
  };
  const bind = async (one: WorldChatActionTurn) => {
    const prepared = prepareWorldChatActions(store, lifecycle, one);
    assert.equal(prepared.length, 1);
    await log.append({ type: "action.prepare-intent", intent: prepared[0]!.intent }, { at: AT });
    return { prepared: prepared[0]!, card: await lifecycle.bindIntent(prepared[0]!.intent, prepared[0]!.payload) };
  };
  const approve = async (card: ConversationActionCard, grouped = false) => lifecycle.decide({ kind: "conversation-action-decide", worldId: store.worldId,
    conversationId, actionId: card.actionId, expectedConversationSeq: (await loaded()).seq, expectedStatus: "pending", decision: "approve", requestId: ulid(),
    ...(grouped ? { groupApprovalTurnId: card.turnId } : {}) });
  return { store, log, adapter, lifecycle, current, requests, loaded, receipts, turn, bind, approve };
}

test("a real chat effects card only stages; generic/group approval cannot apply or release even after explicit Review", async () => {
  const w = await setup(), before = await w.current();
  const { card } = await w.bind(w.turn());
  const [family] = await readEffectProposalFamilies(w.store, PRODUCTION);
  assert.ok(family); assert.equal(family.versions.length, 1);
  assert.equal(family.versions[0]!.conflicts.length, 0);
  assert.equal(family.decisions.length, 0, "the model's requested Release is an inert affordance");
  assert.equal(family.reviewGrants.length, 0, "card arrival cannot activate Suggested");
  assert.match(card.approvalBlockedReason!, /Review in timeline/);
  assert.equal(groupApprovalEligible(card), false);
  assert.equal((await w.approve(card)).disposition, "refused");
  assert.equal((await w.approve(card, true)).disposition, "refused");
  assert.equal(await w.current(), before);
  const version = family.versions[0]!;
  await reviewEffectProposal(w.store, { productionId: PRODUCTION, ref: { familyId: family.id, versionId: version.id,
    candidateHash: version.candidateHash, decisionRevision: family.decisionRevision }, now: AT });
  const pending = await w.requests();
  assert.equal((await w.approve(card)).disposition, "refused", "Review does not turn generic approval into Apply reviewed version");
  await assert.rejects(decideEditorRequest(w.store, { productionId: PRODUCTION, requestId: family.id, decision: "accept", now: AT }), /not on|request/i);
  assert.deepEqual(await w.adapter.validate(card), { ok: false, reason: "blocked", detail: card.approvalBlockedReason });
  assert.equal((await w.adapter.execute({ ...card, approvalBlockedReason: undefined })).status, "failed", "the adapter refuses even if a caller omits the display blocker");
  assert.equal(await w.requests(), pending);
  assert.equal(await w.current(), before, "neither timeline bytes nor its protection baseline changed");
});

test("model preparation takes exact scope from the trusted subject and rejects executable protection or invented authority", async () => {
  const w = await setup(), before = await w.current(), one = w.turn();
  const prepared = prepareWorldChatActions(w.store, w.lifecycle, one)[0]!;
  assert.equal(prepared.payload.kind, "world-chat-effect-proposal");
  if (prepared.payload.kind !== "world-chat-effect-proposal") return;
  assert.deepEqual(prepared.payload.scope, scope);
  assert.equal(prepared.payload.productionId, PRODUCTION);
  const rawAction = one.actions[0]!;
  for (const extra of [{ scope: { ...scope, range: { startFrame: 0, endFrame: 500 } } }, { authority: "human" }, { reviewed: { familyId: "invented" } }]) {
    assert.equal(ModelWorldChatActionSchema.safeParse({ ...rawAction, ...extra }).success, false);
  }
  for (const command of [{ kind: "effect-release", ruleId: "pr_amount" }, { kind: "effect-protect", rule: { id: "pr_fake", lineageId: "ef_dust", kind: "boundary", boundary: "start" } }]) {
    assert.equal(ModelEffectProposalSchema.safeParse({ ...proposal(), commands: [command] }).success, false);
    assert.equal(ModelEditorRequestSchema.safeParse({ summary: "Generic bypass", commands: [command] }).success, false);
  }
  assert.equal(ARKE_CLIENT_COMMAND_REGISTRY["editor-effect-proposal"].classification, "human-only-control-plane");
  assert.throws(() => prepareWorldChatActions(w.store, w.lifecycle, w.turn(proposal(), { subject: undefined })), /Choose the effects arrangement/);
  assert.throws(() => prepareWorldChatActions(w.store, w.lifecycle, { ...one, actions: [{ ...rawAction, productionId: "another-production" } as typeof rawAction] }), /another production/);
  assert.equal(await w.current(), before);
  await assert.rejects(w.requests(), { code: "ENOENT" }, "pure preparation cannot create a proposal file before its durable intent");
});

test("effects cards require complete and current timeline and request reads", async () => {
  const w = await setup(), one = w.turn();
  for (const receiptIndex of [0, 1]) {
    const receipts = structuredClone(one.receipts!); receipts[receiptIndex]!.complete = false; receipts[receiptIndex]!.nextCursor = "next-page";
    assert.throws(() => prepareWorldChatActions(w.store, w.lifecycle, { ...one, receipts }), /complete target read|earlier page/);
  }
  const before = JSON.parse(await w.current()) as { revision: number };
  const production = w.store.getBundle().productions.find(row => row.meta.id === PRODUCTION)!;
  const sourceFingerprint = timelineSourceFingerprint(production, null);
  assert.ok(sourceFingerprint);
  await applyHumanTimelineCommand(w.store, PRODUCTION, { kind: "commands", baseRevision: before.revision, sourceFingerprint,
    commands: [{ kind: "effect-patch", clipId: "cl_dust", patch: { appearance: { amount: 0.7 } } }] });
  assert.throws(() => prepareWorldChatActions(w.store, w.lifecycle, one), /timeline read is no longer current/);
  const fresh = w.turn();
  await w.bind(fresh);
  assert.throws(() => prepareWorldChatActions(w.store, w.lifecycle, fresh), /editor-requests read is no longer current/, "a new family invalidates the previous complete request-list read");
});

test("effects-only turn preparation refuses broader siblings and counts proposals across model result channels", async () => {
  const w = await setup(), one = w.turn(), before = await w.current();
  const ordinary = { summary: "Rename Picture", commands: [{ kind: "set-track" as const, trackId: "tr_picture" as const, name: "Pictures" }] };
  assert.throws(() => prepareWorldChatActions(w.store, w.lifecycle, { ...one, editorRequests: [ordinary] }), /effects-only/);
  const audio = ModelWorldChatActionSchema.parse({ kind: "production-audio-edit", productionId: PRODUCTION, request: ordinary,
    checkReceiptIds: one.receipts!.map(read => read.id) });
  assert.throws(() => prepareWorldChatActions(w.store, w.lifecycle, { ...one, actions: [...one.actions, audio] }), /effects-only/);
  const subject = one.subject as Extract<WorldChatSubject, { kind: "effect-arrangement" }>;
  assert.equal(prepareWorldChatActions(w.store, w.lifecycle, { ...one, actions: [one.actions[0]!, one.actions[0]!] }).length, 2);
  assert.throws(() => prepareWorldChatActions(w.store, w.lifecycle, { ...one, subject, actions: [one.actions[0]!, one.actions[0]!, one.actions[0]!] }), /2-per-turn/);
  assert.throws(() => prepareWorldChatActions(w.store, w.lifecycle, { ...one, subject: undefined, actions: [one.actions[0]!, audio], editorRequests: [ordinary] }), /2-per-turn/,
    "the same aggregate bound applies before any one channel creates an intent");
  assert.equal((await w.loaded()).actions.length, 0);
  await assert.rejects(w.requests(), { code: "ENOENT" });
  assert.equal(await w.current(), before);
});
