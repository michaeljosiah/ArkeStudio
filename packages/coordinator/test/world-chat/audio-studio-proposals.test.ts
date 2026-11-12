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
import { audioStudioSubjectFence, chapterFence, WorldChatTargetReads } from "../../src/world-chat/target-reads.js";
import { createProduction } from "../../src/productions/ops.js";
import { saveEpisodeScript } from "../../src/productions/audio-drama.js";
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

test("Arke suggests changes to an audio drama's episode in Audio Studio, read and reconciled by its stem (issue 1882)", async () => {
  const store = await WorldStore.open(await makeTempWorld(), { clock: () => AT });
  closeOnCleanup(() => store.close());
  const id = await createProduction(store, { title: "Low Water", medium: "story", productionKind: "audio-drama" });
  await saveEpisodeScript(store, id, { episode: 1, title: "", baseHash: null, blocks: [{ id: ulid(), kind: "heading", place: "The quay" }, { id: ulid(), kind: "dialogue", speaker: "maren-kest", words: "Climb." }] });
  const production = store.getBundle().productions.find(entry => entry.meta.id === id)!;
  const opened = await openAudioStudio(store, id, "episode-001");
  const conversationId = newId("cv"), entryContext = { kind: "production" as const, productionId: id };
  const log = new WorldChatStore(conversationDir(store.dir, conversationId));
  await log.create(conversationId, AT);
  await log.append({ type: "conversation.created", title: "Audio Studio", entryContext }, { at: AT });
  const changed: string[] = [];
  const adapter = audioStudioProposalConversationAdapter(store, {}, async (productionId, chapterId) => { changed.push(`${productionId}:${chapterId}`); });
  const lifecycle = new ConversationActionLifecycle({ worldPath: store.dir, worldId: store.worldId, now: () => AT, adapters: [adapter] });
  // Read as the studio reads it, by the episode's stem.
  const reads = new WorldChatTargetReads({ getAudioStudio: (productionId, file) => audioStudioSnapshot(store, productionId, file) });
  const lease = { token: "fixture-token", worldId: store.worldId, conversationId, runId: newId("run"), allowedAttachmentIds: [], expiresAt: Date.now() + 60000 };
  const page = await reads.call(lease, store.getBundle(), "get_chapter", { productionId: id, chapterId: "episode-001", section: "audio-studio" });
  assert.equal(page.result.target.id, `${id}:episode-001:audio-studio`);
  assert.deepEqual([(page.result.items[0] as { chapterId: string }).chapterId, (page.result.items[0] as { base: string }).base], ["episode-001", opened.base]);
  await assert.rejects(reads.call(lease, store.getBundle(), "get_chapter", { productionId: id, chapterId: "episode-009", section: "audio-studio" }), /unavailable for this chapter or episode/);
  const receipt: WorldChatCheckReceipt = { id: newId("check"), runId: newId("run"), tool: "target-read", status: "complete", consulted: [],
    target: { requirement: "chapters", id: `${id}:episode-001:audio-studio` }, observedRevisionOrDigest: audioStudioSubjectFence(production, "episode-001"), complete: true, nextCursor: null, at: AT };
  const action = ModelWorldChatActionSchema.parse({ kind: "production-audio-studio-propose", productionId: id, chapterId: "episode-001",
    proposal: { base: opened.base, summary: "Add an effects track", commands: [{ kind: "add-track", track: { id: "effects", name: "Effects", gainDb: -6, muted: false } }] }, checkReceiptIds: [receipt.id] });
  const turn: WorldChatActionTurn = { conversationId, turnId: newId("turn"), entryContext, at: AT, existingCandidates: [], existingGroups: [], candidates: [], groups: [], bibleEdits: [],
    bibleBaseVersion: 1, sceneEdits: [], sceneBaseVersion: null, editorRequests: [], receipts: [receipt], actions: [action] };
  const prepared = prepareWorldChatActions(store, lifecycle, turn)[0]!;
  await log.append({ type: "action.prepare-intent", intent: prepared.intent }, { at: AT });
  const card = await lifecycle.bindIntent(prepared.intent, prepared.payload);
  assert.deepEqual(changed, [`${id}:episode-001`], "the episode's open studio is told to read again");
  assert.equal(await adapter.reconcile!(card), null, "a pending episode suggestion is not stale");
  const snapshot = await audioStudioSnapshot(store, id, "episode-001");
  assert.equal(snapshot.proposals?.[0]?.status, "pending");
  assert.deepEqual(snapshot.state, opened.state, "Current is unchanged");
  await decideAudioStudioProposal(store, id, "episode-001", snapshot.proposals![0]!.id, 1, "apply");
  assert.equal((await adapter.reconcile!(card))?.status, "completed");
  assert.ok((await openAudioStudio(store, id, "episode-001")).state.tracks.some(track => track.id === "effects"));
});
