import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ART_DIRECTION_PATH, LOCAL_ACTOR_ID, newId, orderedShots, orderedTrackClips, stageShot, ulid, type ArkeGenerationBody, type ClientMessage, type DomainEvent, type SessionId } from "@arke-studio/contracts";
import { ConversationActionLifecycle } from "../../src/arke-actions/lifecycle.js";
import { openBenchSession } from "../../src/bench/service.js";
import { Coordinator } from "../../src/coordinator.js";
import { applySceneCommand } from "../../src/productions/scene-commands.js";
import { worldChatActionAdapters } from "../../src/world-chat/actions.js";
import { foldConversation } from "../../src/world-chat/fold.js";
import { conversationDir, WorldChatStore } from "../../src/world-chat/store.js";
import { jobsFence, sceneFence, timelineFence, worldMetadataFence } from "../../src/world-chat/target-reads.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { WorldStateStaleError, type WorldStore } from "../../src/world/store.js";
import { sha256 } from "../../src/world/text-files.js";
import { closeOnCleanup } from "../tmp.js";
import { assembleStory } from "../productions/assemble.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

const AT = "2026-09-04T12:00:00.000Z";

async function setup() {
  const made = await makeTempRoot();
  const provider = new FsWorldProvider(made.root, { clock: () => AT });
  closeOnCleanup(() => provider.close());
  await provider.loadWorld(WORLD_ID);
  const events: DomainEvent[] = [];
  const coordinator = new Coordinator({ provider, adapter: null, changeLogPath: join(made.root, "logs/changes.jsonl"), appVersion: "test", observeEvent: (event) => events.push(event) });
  const internal = coordinator as unknown as {
    handleClientMessage(message: ClientMessage): Promise<void>;
    conversationActionLifecycle(store: WorldStore): ConversationActionLifecycle;
    recoverWorldChat(store: WorldStore): Promise<void>;
    refreshBench(worldId: string, sessionId: SessionId): Promise<void>;
    refreshConversations(store: WorldStore): Promise<void>;
    backgroundWork: Set<Promise<unknown>>;
    useMasterLookForConversationAction(store: WorldStore, index: number, mutation: { source: string; requestId: string; precondition: () => string | null }): Promise<boolean>;
  };
  return { ...made, provider, store: provider.openStore()!, gate: provider.gate()!, coordinator, internal, events };
}

describe("PR 815 coordinator regressions", () => {
  for (const legacy of [false, true]) {
    it(`publishes a ${legacy ? "legacy" : "new"} world-chat Stage handoff after navigation and clears it on failure`, async () => {
      const w = await setup();
      await w.coordinator.openWorld(WORLD_ID);
      const production = w.store.getBundle().productions.find((candidate) => candidate.meta.id === "saltlight")!;
      const scene = production.scenes.find((candidate) => candidate.id === "sc_04")!;
      const shot = orderedShots(scene).find((candidate) => candidate.id === "sh_12")!;
      const staging = stageShot(shot, { cast: ["maren-kest"], sets: ["The Vigil"], durationSec: 4 });
      await applySceneCommand(w.store, { productionId: "saltlight", sceneFile: production.sceneFiles[scene.id]!,
        sceneId: scene.id, baseVersion: scene.version, command: { kind: "edit-stage", shotId: shot.id,
          staging: { cast: staging.cast, sets: staging.sets, keys: staging.keys } } });
      const conversationId = newId("cv");
      const log = new WorldChatStore(conversationDir(w.worldDir, conversationId));
      await log.create(conversationId, AT);
      await log.append({ type: "conversation.created", title: "Stage from world", entryContext: { kind: "world" } }, { at: AT });
      await w.internal.handleClientMessage({ kind: "world-chat-open", worldId: WORLD_ID, conversationId });
      const current = w.store.getBundle().productions.find((candidate) => candidate.meta.id === "saltlight")!;
      const lifecycle = w.internal.conversationActionLifecycle(w.store);
      const action = await lifecycle.prepare({
        conversationId, turnId: newId("turn"), worldId: WORLD_ID, productionId: "saltlight", actionKind: "world-chat-production-stage-playblast",
        targets: [{ kind: "shot", id: shot.id }, ...(!legacy ? [{ kind: "scene", id: scene.id }] : [])],
        payload: { kind: "world-chat-production-stage-playblast", worldId: WORLD_ID, action: {
          kind: "production-stage-playblast", productionId: "saltlight", sceneId: scene.id, shotId: shot.id, checkReceiptIds: [newId("check")],
        } },
        baseObservations: [{ requirement: "scenes", target: `saltlight:${scene.id}`, revisionOrDigest: sceneFence(current, scene.id), complete: true }], createdAt: AT,
      });
      const seq = foldConversation(conversationId, AT, (await log.read()).events).view.seq;
      const decision = await lifecycle.decide({ kind: "conversation-action-decide", worldId: WORLD_ID, conversationId,
        actionId: action.actionId, requestId: ulid(), decision: "approve", expectedConversationSeq: seq, expectedStatus: "pending" });
      assert.equal(decision.status, "awaiting-host");
      await w.internal.refreshConversations(w.store);
      await w.internal.handleClientMessage({ kind: "world-chat-open", worldId: WORLD_ID, conversationId: null });
      assert.equal(w.coordinator.getState().worldChat, null);
      assert.deepEqual(w.coordinator.getState().stagePlayblastRequests, [{
        worldId: WORLD_ID, conversationId, actionId: action.actionId, productionId: "saltlight", sceneId: scene.id, shotId: shot.id,
      }]);
      await w.internal.handleClientMessage({ kind: "conversation-action-stage-playblast-complete", worldId: WORLD_ID,
        conversationId, actionId: action.actionId, status: "failed", detail: "The renderer is unavailable." });
      assert.deepEqual(w.coordinator.getState().stagePlayblastRequests, []);
      assert.equal(foldConversation(conversationId, AT, (await log.read()).events).view.actions[0]!.status, "failed");
    });
  }

  it("finishes a durably approved archive during world-open recovery in the moved folder", async (t) => {
    const w = await setup();
    let archivedFolder = "";
    const archive = w.provider.archiveWorld.bind(w.provider);
    t.mock.method(w.provider, "archiveWorld", async (...args: Parameters<typeof archive>) => {
      const result = await archive(...args);
      archivedFolder = result.folder;
      return result;
    });
    const conversationId = newId("cv");
    const log = new WorldChatStore(conversationDir(w.worldDir, conversationId));
    await log.create(conversationId, AT);
    await log.append({ type: "conversation.created", title: "Archive", entryContext: { kind: "world" } }, { at: AT });
    const action = await w.internal.conversationActionLifecycle(w.store).prepare({
      conversationId, turnId: newId("turn"), worldId: WORLD_ID, actionKind: "world-chat-world-archive",
      targets: [{ kind: "world", id: WORLD_ID }],
      payload: { kind: "world-chat-world-archive", worldId: WORLD_ID, action: { kind: "world-archive", checkReceiptIds: [newId("check")] } },
      baseObservations: [{ requirement: "world-metadata", target: WORLD_ID, revisionOrDigest: worldMetadataFence(w.store.getBundle()), complete: true }],
      createdAt: AT,
    });
    const seq = foldConversation(conversationId, AT, (await log.read()).events).view.seq;
    await log.append({ type: "action.decision-recorded", actionId: action.actionId, decision: {
      requestId: ulid(), decision: "approve", actorId: LOCAL_ACTOR_ID, expectedConversationSeq: seq,
      expectedStatus: "pending", decidedAt: AT,
    } }, { at: AT });
    await w.internal.recoverWorldChat(w.store);
    assert.ok(archivedFolder, "restart recovery executes the approved archive");
    const movedLog = new WorldChatStore(conversationDir(archivedFolder, conversationId));
    const settled = foldConversation(conversationId, AT, (await movedLog.read()).events).view.actions[0]!;
    assert.equal(settled.status, "completed");
    assert.equal(settled.receipt?.kind, "world-archive");
    assert.equal(w.provider.openStore(), null);
    await assert.rejects(readFile(join(w.worldDir, ".conversations", conversationId, "events.jsonl")), { code: "ENOENT" });
  });

  for (const outcome of ["succeeded", "failed", "cancelled"] as const) {
    it(`settles a live ${outcome} Bench generation even when it finishes during approval`, async () => {
      const w = await setup();
      const sessionId = newId("sess");
      const opened = await openBenchSession(w.worldDir, () => AT, {
        sessionId, initial: { mode: "image", brief: "Ledger studies" }, defaultModel: { provider: "fal", model: "flux" },
      });
      assert.ok(opened);
      const conversationId = newId("cv");
      const log = new WorldChatStore(conversationDir(w.worldDir, conversationId));
      await log.create(conversationId, AT);
      await log.append({ type: "conversation.created", title: "Bench", entryContext: { kind: "world" } }, { at: AT });
      await w.internal.handleClientMessage({ kind: "world-chat-open", worldId: WORLD_ID, conversationId });
      const body: ArkeGenerationBody = {
        family: "generation", medium: "image", purpose: "Bench exploration", prompt: "Ledger studies",
        references: [], provider: "fal", model: "flux", quantity: 1, output: "Immutable Bench take",
        cost: "$0.0100 estimated", quoteDigest: `sha256:${"b".repeat(64)}`, quoteExpiresAt: "2026-09-04T12:15:00.000Z",
        estimatedMicroUsd: 10_000, currency: "USD", estimateMayVary: true,
      };
      let dispatched = 0;
      const adapters = worldChatActionAdapters(w.store, w.gate, () => AT, {
        getJobs: () => [], quoteBenchGeneration: async () => ({ authorityRevision: 7, body }),
        dispatchBenchGeneration: async (_action, actionId) => {
          dispatched++;
          const takeId = newId("tk");
          await opened.store.append({ type: "takes-reserved", takes: [{
            id: takeId, n: 1, requestId: actionId, createdAt: AT, request: {
              mode: "image", brief: "Ledger studies", references: [], keyframes: [], provider: "fal", model: "flux",
              params: { kind: "image", count: 1, aspect: "16:9" },
            },
          }] });
          await w.internal.refreshBench(WORLD_ID, sessionId);
          if (outcome === "succeeded") {
            await opened.store.append({ type: "take-completed", takeId, completedAt: AT,
              media: { file: "take.png", hash: "sha256:deadbeefdeadbeef" }, cost: { estimatedMicroUsd: 10_000, actualMicroUsd: 12_000 } });
          } else {
            await opened.store.append({ type: "take-status", takeId, status: outcome });
          }
          await w.internal.refreshBench(WORLD_ID, sessionId);
          return { status: "queued" };
        },
      });
      const lifecycle = new ConversationActionLifecycle({ worldPath: w.worldDir, worldId: WORLD_ID, adapters, now: () => AT });
      const action = await lifecycle.prepare({
        conversationId, turnId: newId("turn"), worldId: WORLD_ID, actionKind: "world-chat-bench-generation",
        targets: [{ kind: "bench-session", id: sessionId }],
        payload: { kind: "world-chat-bench-generation", worldId: WORLD_ID, action: {
          kind: "bench-generation", sessionId, composer: { mode: "image", provider: "fal", model: "flux",
            params: { kind: "image", aspect: "16:9", count: 1 }, brief: "Ledger studies" }, checkReceiptIds: [newId("check")],
        } },
        baseObservations: [{ requirement: "jobs", target: WORLD_ID, revisionOrDigest: jobsFence([], WORLD_ID), complete: true }], createdAt: AT,
      });
      const seq = foldConversation(conversationId, AT, (await log.read()).events).view.seq;
      await lifecycle.decide({ kind: "conversation-action-decide", worldId: WORLD_ID, conversationId,
        actionId: action.actionId, requestId: ulid(), decision: "approve", expectedConversationSeq: seq, expectedStatus: "pending" });
      while (w.internal.backgroundWork.size > 0) await Promise.all(w.internal.backgroundWork);
      const settled = foldConversation(conversationId, AT, (await log.read()).events).view.actions[0]!;
      assert.equal(dispatched, 1);
      assert.equal(settled.status, outcome === "succeeded" ? "completed" : outcome);
      assert.equal(w.coordinator.getState().worldChat?.actions[0]?.status, settled.status);
      if (outcome === "succeeded") {
        assert.equal(settled.receipt?.generation?.completed, 1);
        assert.equal(settled.receipt?.generation?.actualMicroUsd, 12_000);
      }
      assert.ok((await opened.store.fold())!.takes.every((take) => take.disposition === "open"));
    });
  }

  for (const boundary of ["stage", "accept"] as const) {
    it(`refuses a concurrent art-direction change at master-look ${boundary}`, async (t) => {
      const w = await setup();
      t.mock.method(w.provider, "gate", () => w.gate);
      await w.store.ownedWrite(async () => {
        await mkdir(join(w.worldDir, "incoming/master-look"), { recursive: true });
        await writeFile(join(w.worldDir, "incoming/master-look/candidate.png"), Buffer.from([137, 80, 78, 71]));
      });
      const direction = w.store.getBundle().artDirection;
      const changeDirection = async () => {
        const raw = await readFile(join(w.worldDir, ART_DIRECTION_PATH), "utf8").catch(() => null);
        await w.store.commit({ kind: "art-direction", source: "concurrent-editor", files: [{
          path: ART_DIRECTION_PATH, action: raw === null ? "create" : "replace", baseHash: raw === null ? null : sha256(raw),
          content: JSON.stringify({
            ...(raw === null ? { version: 1, history: [], audio: direction.audio, failureModes: direction.failureModes } : JSON.parse(raw)),
            description: "Concurrent description", acceptedAt: AT,
          }),
        }] });
      };
      if (boundary === "stage") {
        const stage = w.gate.stageArtDirectionChange.bind(w.gate);
        t.mock.method(w.gate, "stageArtDirectionChange", async (...args: Parameters<typeof stage>) => {
          await changeDirection();
          return stage(...args);
        });
      } else {
        const accept = w.gate.accept.bind(w.gate);
        t.mock.method(w.gate, "accept", async (...args: Parameters<typeof accept>) => {
          await changeDirection();
          return accept(...args);
        });
      }
      await assert.rejects(w.internal.useMasterLookForConversationAction(w.store, 1, {
        source: "world-chat:test", requestId: newId("act"),
        precondition: () => w.store.getBundle().artDirection.description === direction.description ? null : "The world look changed.",
      }), WorldStateStaleError);
      assert.equal(w.store.getBundle().artDirection.description, "Concurrent description");
      assert.equal(w.store.getBundle().artDirection.masterLook, direction.masterLook);
    });
  }

  for (const decision of ["accept", "reject"] as const) {
    it(`settles the conversation immediately when the Timeline chooses ${decision}`, async () => {
      const w = await setup();
      const timeline = await assembleStory(w.store, "saltlight");
      const clips = orderedTrackClips(timeline.tracks[0]!);
      const conversationId = newId("cv");
      const log = new WorldChatStore(conversationDir(w.worldDir, conversationId));
      await log.create(conversationId, AT);
      await log.append({ type: "conversation.created", title: "Timeline", entryContext: { kind: "production", productionId: "saltlight" } }, { at: AT });
      const lifecycle = new ConversationActionLifecycle({ worldPath: w.worldDir, worldId: WORLD_ID, adapters: worldChatActionAdapters(w.store, w.gate, () => AT), now: () => AT });
      const production = w.store.getBundle().productions.find((candidate) => candidate.meta.id === "saltlight")!;
      const action = await lifecycle.prepare({
        conversationId, turnId: newId("turn"), worldId: WORLD_ID, productionId: "saltlight", actionKind: "world-chat-editor-request",
        targets: [{ kind: "timeline", id: "saltlight", label: "Timeline" }],
        payload: { kind: "world-chat-editor-request", worldId: WORLD_ID, productionId: "saltlight", request: {
          summary: "Move the second shot earlier", commands: [{ kind: "move-adjacent", clipId: clips[1]!.id, direction: "earlier" }],
        } },
        baseObservations: [{ requirement: "timeline", target: "saltlight", revisionOrDigest: timelineFence(production, w.store.getBundle().artifacts), complete: true }], createdAt: AT,
      });
      await w.internal.handleClientMessage({ kind: "world-chat-open", worldId: WORLD_ID, conversationId });
      await w.internal.handleClientMessage({ kind: "editor-request-decide", worldId: WORLD_ID, productionId: "saltlight", requestId: action.authority.id, decision });
      const view = foldConversation(conversationId, AT, (await log.read()).events).view;
      assert.equal(view.actions[0]!.status, decision === "accept" ? "completed" : "cancelled");
      assert.notEqual(view.deletionBlock, "pending-actions");
      assert.equal(w.coordinator.getState().worldChat?.actions[0]!.status, view.actions[0]!.status);
    });
  }

  it("keeps actionable preflight export failures", async () => {
    const w = await setup();
    await w.internal.handleClientMessage({ kind: "export-cut", worldId: WORLD_ID, productionId: "saltlight", preset: "review-cut", timelineRevision: null });
    const failure = w.events.find((event) => event.type === "export.progress" && event.status === "failed");
    assert.ok(failure?.type === "export.progress");
    assert.match(failure.error!, /export needs ffmpeg/);
  });

  it("still reports an invalid editor-request file through the Timeline refusal", async () => {
    const w = await setup();
    await writeFile(join(w.worldDir, "productions/saltlight/editor-requests.json"), "{broken");
    await w.internal.handleClientMessage({ kind: "editor-request-decide", worldId: WORLD_ID, productionId: "saltlight", requestId: "req_01ARZ3NDEKTSV4RRFFQ69G5FAV", decision: "accept" });
    const refusal = w.events.find((event) => event.type === "timeline.command-refused");
    assert.ok(refusal?.type === "timeline.command-refused");
    assert.match(refusal.reason, /editor-requests.json is invalid/);
  });
});
