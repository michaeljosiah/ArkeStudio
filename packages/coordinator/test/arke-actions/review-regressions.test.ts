import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ART_DIRECTION_PATH, newId, orderedTrackClips, type ClientMessage, type DomainEvent } from "@arke-studio/contracts";
import { ConversationActionLifecycle } from "../../src/arke-actions/lifecycle.js";
import { Coordinator } from "../../src/coordinator.js";
import { worldChatActionAdapters } from "../../src/world-chat/actions.js";
import { foldConversation } from "../../src/world-chat/fold.js";
import { conversationDir, WorldChatStore } from "../../src/world-chat/store.js";
import { timelineFence } from "../../src/world-chat/target-reads.js";
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
    useMasterLookForConversationAction(store: WorldStore, index: number, mutation: { source: string; requestId: string; precondition: () => string | null }): Promise<boolean>;
  };
  return { ...made, provider, store: provider.openStore()!, gate: provider.gate()!, coordinator, internal, events };
}

describe("PR 815 coordinator regressions", () => {
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
