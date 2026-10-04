import assert from "node:assert/strict";
import { it } from "node:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { newId, ulid, orderedShots, orderedTrackClips, HumanDecisionCardSchema, type ClientMessage, type HarnessAdapter } from "@arke-studio/contracts";
import type { ConversationActionLifecycle } from "../../src/arke-actions/lifecycle.js";
import { sceneFence } from "../../src/world-chat/target-reads.js";
import { Coordinator } from "../../src/coordinator.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import type { WorldStore } from "../../src/world/store.js";
import { WorldChatService } from "../../src/world-chat/service.js";
import { discardStageReview, retainStageReview } from "../../src/productions/stage-review.js";
import { stageEditorRequests } from "../../src/productions/editor-requests.js";
import { storeBatch, verifyCandidates } from "../../src/artifacts/extraction.js";
import { setOwner } from "../../src/artifacts/filing.js";
import { assembleStory } from "../productions/assemble.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

const AT = "2026-10-04T12:00:00.000Z";

it("projects existing authorities and settles screen and thread decisions through their ordinary commands", async t => {
  const made = await makeTempRoot(), provider = new FsWorldProvider(made.root);
  t.after(() => provider.close());
  await provider.loadWorld(WORLD_ID);
  const store = provider.openStore()!;
  const coordinator = new Coordinator({ provider, adapter: null, changeLogPath: join(made.root, "logs/changes.jsonl"), appVersion: "test" });
  const send = (message: ClientMessage) => (coordinator as unknown as { handleClientMessage(message: ClientMessage): Promise<void> }).handleClientMessage(message);
  await coordinator.openWorld(WORLD_ID);
  const service = new WorldChatService(store.dir);
  const conversation = await service.create({ title: "Production decisions", entryContext: { kind: "production", productionId: "saltlight" } });
  const other = await service.create({ title: "Unrelated", entryContext: { kind: "world" } });
  const timeline = await assembleStory(store, "saltlight");
  const [request] = await stageEditorRequests(store, { conversationId: conversation.id, entryContext: { kind: "production", productionId: "saltlight" },
    requests: [{ summary: "Move the second clip earlier", commands: [{ kind: "move-adjacent", clipId: orderedTrackClips(timeline.tracks[0]!)[1]!.id, direction: "earlier" }] }], now: AT });
  const production = store.getBundle().productions.find(p => p.meta.id === "saltlight")!, scene = production.scenes.find(s => s.id === "sc_04")!;
  const reviewId = randomUUID(), shotId = orderedShots(scene)[0]!.id;
  const draft = { staging: { keys: [{ t: 0, p: [0, 2, 5] as [number, number, number], l: [0, 1, 0] as [number, number, number] },
    { t: 4, p: [1, 2, 5] as [number, number, number], l: [0, 1, 0] as [number, number, number] }] }, cast: [], sets: [], assumptions: [], assessment: "Ready for Keep", inspected: ["camera"] };
  await retainStageReview(store, { id: reviewId, worldId: WORLD_ID, productionId: "saltlight", sceneId: scene.id, shotId, baseVersion: scene.version,
    conversationId: conversation.id, actionId: newId("act"), createdAt: AT, status: "pending", draft });
  const artifact = await setOwner(store, store.getBundle().artifacts[0]!, "saltlight");
  assert.ok(artifact);
  const batch = verifyCandidates([{ kind: "character", name: "Maren", body: "Waits by the river", section: "Essence", quote: "Waits by the river" }], "Waits by the river", [], "saltlight");
  await storeBatch(store, artifact, batch);
  await send({ kind: "world-chat-open", worldId: WORLD_ID, conversationId: other.id });
  assert.deepEqual(coordinator.getState().worldChat?.humanDecisions, [], "another conversation cannot inherit these decisions");
  await send({ kind: "world-chat-open", worldId: WORLD_ID, conversationId: conversation.id });
  const cards = () => coordinator.getState().worldChat!.humanDecisions!;
  assert.deepEqual(new Set(cards().map(card => card.body.control.kind)), new Set(["editor-request", "extraction", "stage-review"]));
  cards().forEach(card => HumanDecisionCardSchema.parse(card));
  await send({ kind: "editor-request-decide", worldId: WORLD_ID, productionId: "saltlight", requestId: request!.id, decision: "accept" });
  assert.equal(cards().some(card => card.body.control.kind === "editor-request"), false);
  assert.equal(coordinator.getState().world!.productions.find(p => p.meta.id === "saltlight")!.editorRequests.find(r => r.id === request!.id)!.status, "accepted");
  await send({ kind: "resolve-extraction", worldId: WORLD_ID, artifactId: artifact.id, candidateHash: batch.verified[0]!.hash, decision: "reject" });
  assert.equal(cards().some(card => card.body.control.kind === "extraction"), false);
  await send({ kind: "scene-command", worldId: WORLD_ID, productionId: "saltlight", sceneId: scene.id, sceneFile: "04-the-verse-rises",
    baseVersion: scene.version, stageReviewId: reviewId, command: { kind: "edit-stage", shotId, staging: draft.staging } });
  assert.equal(cards().some(card => card.body.control.kind === "stage-review"), false);
  assert.deepEqual(coordinator.getState().stageReviews, []);
  await send({ kind: "world-chat-open", worldId: WORLD_ID, conversationId: conversation.id });
  assert.deepEqual(cards(), [], "reopening cannot resurrect a settled authority");
});

for (const settled of [false, true]) it(`recovery completes a retained construction without repeating the renderer handoff (${settled ? "archived" : "pending"})`, async t => {
  const made = await makeTempRoot(), provider = new FsWorldProvider(made.root); t.after(() => provider.close());
  await provider.loadWorld(WORLD_ID);
  const store = provider.openStore()!, service = new WorldChatService(store.dir);
  const conversation = await service.create({ title: "Stage review", entryContext: { kind: "production", productionId: "saltlight" } });
  const coordinator = new Coordinator({ provider, adapter: null, appVersion: "test", changeLogPath: join(made.root, "changes.jsonl") });
  await coordinator.openWorld(WORLD_ID);
  const internal = coordinator as unknown as { conversationActionLifecycle(store: WorldStore): ConversationActionLifecycle; handleClientMessage(message: ClientMessage): Promise<void> };
  const lifecycle = internal.conversationActionLifecycle(store), production = store.getBundle().productions.find(p => p.meta.id === "saltlight")!;
  const scene = production.scenes.find(s => s.id === "sc_04")!, shotId = orderedShots(scene)[0]!.id;
  const action = await lifecycle.prepare({ conversationId: conversation.id, turnId: newId("turn"), worldId: WORLD_ID, productionId: "saltlight",
    actionKind: "world-chat-production-stage-construct", targets: [{ kind: "scene", id: scene.id }, { kind: "shot", id: shotId }],
    payload: { kind: "world-chat-production-stage-construct", worldId: WORLD_ID, action: { kind: "production-stage-construct", productionId: "saltlight",
      sceneId: scene.id, shotId, instruction: "Construct", preserve: "none", checkReceiptIds: [newId("check")] } },
    baseObservations: [{ requirement: "scenes", target: `saltlight:${scene.id}`, revisionOrDigest: sceneFence(production, scene.id), complete: true }], createdAt: AT });
  const decision = await lifecycle.decide({ kind: "conversation-action-decide", worldId: WORLD_ID, conversationId: conversation.id,
    actionId: action.actionId, expectedConversationSeq: (await service.load(conversation.id))!.seq, expectedStatus: "pending", decision: "approve", requestId: ulid() });
  assert.equal(decision.disposition, "recorded");
  assert.equal((await service.load(conversation.id))!.actions[0]!.status, "awaiting-host");
  const reviewId = randomUUID();
  await retainStageReview(store, { id: reviewId, worldId: WORLD_ID, productionId: "saltlight", sceneId: scene.id, shotId,
    baseVersion: scene.version, conversationId: conversation.id, actionId: action.actionId, createdAt: AT, status: "pending",
    draft: { staging: { keys: [{ t: 0, p: [0, 2, 5], l: [0, 1, 0] }, { t: 4, p: [1, 2, 5], l: [0, 1, 0] }] },
      cast: [], sets: [], assumptions: [], assessment: "Inspected", inspected: ["camera"] } });
  if (settled) await discardStageReview(store, reviewId);
  await internal.handleClientMessage({ kind: "world-chat-open", worldId: WORLD_ID, conversationId: conversation.id });
  assert.equal(coordinator.getState().worldChat!.actions[0]!.status, "completed");
  assert.deepEqual(coordinator.getState().worldChat!.humanDecisions!.map(card => card.body.control.kind), settled ? [] : ["stage-review"]);
  assert.equal(coordinator.getState().stageConstructionRequests?.some(request => request.actionId === action.actionId), false);
});

it("a duplicate renderer refusal cannot fail the first renderer's construction authority", async t => {
  const made = await makeTempRoot(), provider = new FsWorldProvider(made.root); t.after(() => provider.close());
  await provider.loadWorld(WORLD_ID);
  const store = provider.openStore()!, service = new WorldChatService(store.dir);
  const conversation = await service.create({ title: "Stage handoff", entryContext: { kind: "production", productionId: "saltlight" } });
  const adapter = { readiness: () => ({ ready: true }) } as unknown as HarnessAdapter;
  const coordinator = new Coordinator({ provider, adapter, appVersion: "test", changeLogPath: join(made.root, "changes.jsonl") });
  await coordinator.openWorld(WORLD_ID);
  const internal = coordinator as unknown as { conversationActionLifecycle(store: WorldStore): ConversationActionLifecycle;
    handleClientMessage(message: ClientMessage): Promise<void>; languageModelFor(): Promise<{ reason: string }>;
    backgroundWork: Set<Promise<unknown>> };
  const lifecycle = internal.conversationActionLifecycle(store), production = store.getBundle().productions.find(p => p.meta.id === "saltlight")!;
  const scene = production.scenes.find(s => s.id === "sc_04")!, shotId = orderedShots(scene)[0]!.id;
  const action = await lifecycle.prepare({ conversationId: conversation.id, turnId: newId("turn"), worldId: WORLD_ID, productionId: "saltlight",
    actionKind: "world-chat-production-stage-construct", targets: [{ kind: "shot", id: shotId }],
    payload: { kind: "world-chat-production-stage-construct", worldId: WORLD_ID, action: { kind: "production-stage-construct", productionId: "saltlight",
      sceneId: scene.id, shotId, instruction: "Construct", preserve: "none", checkReceiptIds: [newId("check")] } },
    baseObservations: [{ requirement: "scenes", target: `saltlight:${scene.id}`, revisionOrDigest: sceneFence(production, scene.id), complete: true }], createdAt: AT });
  await lifecycle.decide({ kind: "conversation-action-decide", worldId: WORLD_ID, conversationId: conversation.id, actionId: action.actionId,
    expectedConversationSeq: (await service.load(conversation.id))!.seq, expectedStatus: "pending", decision: "approve", requestId: ulid() });
  let entered!: () => void, release!: (value: { reason: string }) => void;
  const selected = new Promise<void>(resolve => { entered = resolve; });
  internal.languageModelFor = () => { entered(); return new Promise(resolve => { release = resolve; }); };
  const request: Extract<ClientMessage, { kind: "stage-construct" }> = { kind: "stage-construct", worldId: WORLD_ID, productionId: "saltlight",
    sceneId: scene.id, shotId, baseVersion: scene.version, requestId: randomUUID(), actionId: action.actionId, conversationId: conversation.id,
    instruction: "Construct", preserve: "none" };
  const first = internal.handleClientMessage(request); await selected;
  try {
    await internal.handleClientMessage({ ...request, requestId: randomUUID() });
    await Promise.all(internal.backgroundWork);
    assert.equal((await service.load(conversation.id))!.actions[0]!.status, "awaiting-host");
  } finally { release({ reason: "Construction stopped for this test." }); await first; await Promise.all(internal.backgroundWork); }
  assert.equal((await service.load(conversation.id))!.actions[0]!.status, "failed", "only the original renderer can settle its failed run");
});
