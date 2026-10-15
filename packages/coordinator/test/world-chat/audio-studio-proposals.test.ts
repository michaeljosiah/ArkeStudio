import assert from "node:assert/strict";
import { test } from "node:test";
import { ModelWorldChatActionSchema, newId, ulid, groupApprovalEligible, type WorldChatCheckReceipt } from "@arke-studio/contracts";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";
import { audioStudioSnapshot, decideAudioStudioProposal, openAudioStudio } from "../../src/productions/audio-studio.js";
import { audioStudioProposalConversationAdapter } from "../../src/world-chat/audio-studio-proposals.js";
import { ConversationActionLifecycle } from "../../src/arke-actions/lifecycle.js";
import { ARKE_CLIENT_COMMAND_REGISTRY } from "../../src/arke-actions/registry.js";
import { chapterFence, WorldChatTargetReads } from "../../src/world-chat/target-reads.js";
import { prepareWorldChatActions, type WorldChatActionTurn } from "../../src/world-chat/actions.js";
import { conversationDir, WorldChatStore } from "../../src/world-chat/store.js";
import { foldConversation } from "../../src/world-chat/fold.js";

const PRODUCTION = "the-ledger-of-nights", FILE = "01-neap", AT = "2026-10-15T12:00:00.000Z";

test("Arke stages a chapter audio proposal with complete section reads; generic approval cannot apply it", async () => {
  const store = await WorldStore.open(await makeTempWorld(), { clock: () => AT });
  closeOnCleanup(() => store.close());
  const production = store.getBundle().productions.find(entry => entry.meta.id === PRODUCTION)!;
  const chapter = production.chapters.find(entry => entry.file === FILE)!;
  const opened = await openAudioStudio(store, PRODUCTION, FILE);
  const conversationId = newId("cv"), entryContext = { kind: "production" as const, productionId: PRODUCTION };
  const log = new WorldChatStore(conversationDir(store.dir, conversationId));
  await log.create(conversationId, AT);
  await log.append({ type: "conversation.created", title: "Audio Studio", entryContext }, { at: AT });
  const adapter = audioStudioProposalConversationAdapter(store);
  const lifecycle = new ConversationActionLifecycle({ worldPath: store.dir, worldId: store.worldId, now: () => AT, adapters: [adapter] });
  const receipt: WorldChatCheckReceipt = { id: newId("check"), runId: newId("run"), tool: "target-read", status: "complete", consulted: [],
    target: { requirement: "chapters", id: `${PRODUCTION}:${chapter.id}:audio-studio` }, observedRevisionOrDigest: chapterFence(production, chapter.id), complete: true, nextCursor: null, at: AT };
  const action = ModelWorldChatActionSchema.parse({ kind: "production-audio-studio-propose", productionId: PRODUCTION, chapterId: FILE,
    proposal: { base: opened.base, summary: "Add an effects track", commands: [{ kind: "add-track", track: { id: "effects", name: "Effects", gainDb: -6, muted: false } }] }, checkReceiptIds: [receipt.id] });
  const turn: WorldChatActionTurn = { conversationId, turnId: newId("turn"), entryContext, at: AT, existingCandidates: [], existingGroups: [], candidates: [], groups: [], bibleEdits: [],
    bibleBaseVersion: 1, sceneEdits: [], sceneBaseVersion: null, editorRequests: [], receipts: [receipt], actions: [action] };
  assert.throws(() => prepareWorldChatActions(store, lifecycle, { ...turn, receipts: [{ ...receipt, target: { requirement: "chapters", id: `${PRODUCTION}:${chapter.id}` } }] }), /read|consult|chapter/i);
  const prepared = prepareWorldChatActions(store, lifecycle, turn)[0]!;
  await log.append({ type: "action.prepare-intent", intent: prepared.intent }, { at: AT });
  const card = await lifecycle.bindIntent(prepared.intent, prepared.payload);
  assert.match(card.approvalBlockedReason!, /Audio Studio/); assert.equal(groupApprovalEligible(card), false);
  const meta = (await log.readMeta())!, view = foldConversation(meta.id, meta.createdAt, (await log.read()).events).view;
  const result = await lifecycle.decide({ kind: "conversation-action-decide", worldId: store.worldId, conversationId, actionId: card.actionId,
    expectedConversationSeq: view.seq, expectedStatus: "pending", decision: "approve", requestId: ulid() });
  assert.equal(result.disposition, "refused");
  assert.equal((await adapter.execute({ ...card, approvalBlockedReason: undefined })).status, "failed");
  const snapshot = await audioStudioSnapshot(store, PRODUCTION, FILE);
  assert.deepEqual(snapshot.state, opened.state); assert.equal(snapshot.revision, 0);
  const reads = new WorldChatTargetReads({ getAudioStudio: async () => snapshot });
  const lease = { token: "fixture-token", worldId: store.worldId, conversationId, runId: newId("run"), allowedAttachmentIds: [], expiresAt: Date.now() + 60000 };
  const firstPage = await reads.call(lease, store.getBundle(), "get_chapter", { productionId: PRODUCTION, chapterId: FILE, section: "audio-studio", limit: 1 });
  assert.equal(firstPage.result.target.id, `${PRODUCTION}:${chapter.id}:audio-studio`);
  assert.equal((firstPage.result.items[0] as { base: string }).base, snapshot.base);
  assert.ok(firstPage.result.nextCursor);
  const staleReads = new WorldChatTargetReads({ getAudioStudio: async () => ({ ...snapshot, base: "f".repeat(64) }) });
  await assert.rejects(staleReads.call(lease, store.getBundle(), "get_chapter", { productionId: PRODUCTION, chapterId: FILE, section: "audio-studio", cursor: firstPage.result.nextCursor }), /changed while/);
  const family = snapshot.proposals![0]!;
  await decideAudioStudioProposal(store, PRODUCTION, FILE, family.id, 1, "apply");
  assert.equal((await adapter.reconcile!(card))?.status, "completed");
  assert.equal(ARKE_CLIENT_COMMAND_REGISTRY["decide-audio-studio-proposal"].classification, "human-only-control-plane");
});
