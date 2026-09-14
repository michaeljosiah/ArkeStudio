import assert from "node:assert/strict";
import { it } from "node:test";
import { newId, ulid } from "@arke-studio/contracts";
import { ProductionCreationService } from "../../src/application/production-creation.js";
import { ConversationActionService } from "../../src/application/conversation-actions.js";
import type { ConversationActionAuthorityAdapter } from "../../src/arke-actions/lifecycle.js";
import { WorldStore } from "../../src/world/store.js";
import { WorldChatService } from "../../src/world-chat/service.js";
import { WorldChatStore, conversationDir } from "../../src/world-chat/store.js";
import { foldConversation } from "../../src/world-chat/fold.js";
import { closeOnCleanup } from "../tmp.js";
import { makeTempWorld } from "../world/helpers.js";
const AT = "2026-09-14T15:00:00.000Z";
async function world() {
  const store = await WorldStore.open(await makeTempWorld());
  closeOnCleanup(() => store.close());
  return store;
}
it("creation holds duplicate admission through publication, then replays the committed slug", async () => {
  const store = await world();
  const service = new ProductionCreationService();
  const input = { title: "Inkbound", format: "story" as const, requestId: ulid() };
  let published!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { published = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const first = service.create(store, input, async () => { published(); await held; });
  await entered;
  try {
    assert.ok(store.getBundle().productions.some(p => p.meta.id === "inkbound"));
    assert.deepEqual(await service.create(store, input, async () => assert.fail("duplicate published")), { status: "pending" });
  } finally { release(); }
  assert.deepEqual(await first, { status: "created", slug: "inkbound" });
  assert.deepEqual(await new ProductionCreationService().create(store, input, async () => assert.fail("replay published")),
    { status: "created", slug: "inkbound" });
  assert.equal(store.getBundle().productions.filter(p => p.meta.id.startsWith("inkbound")).length, 1);
});
it("publication failure leaves the committed production available for creation replay", async () => {
  const store = await world();
  const service = new ProductionCreationService();
  const input = { title: "Inkbound", format: "story" as const, requestId: ulid() };
  const failure = new Error("host publication failed");
  assert.deepEqual(await service.create(store, input, async () => { throw failure; }), { status: "failed", error: failure });
  assert.deepEqual(await service.create(store, input, async () => assert.fail("must replay")), { status: "created", slug: "inkbound" });
});
it("creation refuses a missing medium without writing or notifying the host", async () => {
  const store = await world();
  const before = store.getBundle().productions.length;
  const result = await new ProductionCreationService().create(store, { title: "Missing" }, async () => assert.fail("must refuse"));
  assert.equal(result.status, "invalid");
  assert.equal(store.getBundle().productions.length, before);
});
it("one supplied authority handles approval and replay, with current world availability", async () => {
  const store = await world();
  let open = true;
  let executed = 0;
  // This replaces a default kind. Keeping both would be rejected as duplicate authority.
  const adapter: ConversationActionAuthorityAdapter = {
    actionKind: "world-chat-world-metadata",
    prepare: async () => ({
      authority: { kind: "world-store", id: store.worldId }, authorityRevision: 1,
      shown: { title: "Rename", consequence: "Change the name", affectedTargets: [{ kind: "world", id: store.worldId }],
        ripples: [], permissionReason: "authored-change", body: { family: "authored-diff",
          fields: [{ label: "Name", before: "Old", after: "New" }], conflicts: [], openChoices: [] } },
    }),
    validate: async () => ({ ok: true }),
    execute: async () => { executed++; return { status: "completed", receipt: { kind: "world-version", id: store.worldId, summary: "Renamed" } }; },
  };
  const deps = { gate: null, actions: {}, supplied: [adapter], now: () => AT, isWorldOpen: () => open };
  const service = new ConversationActionService(store, deps);
  const conversation = await new WorldChatService(store.dir).create({ title: "A decision", at: AT });
  const action = await service.lifecycle.prepare({ conversationId: conversation.id, turnId: newId("turn"), worldId: store.worldId,
    actionKind: adapter.actionKind, targets: [{ kind: "world", id: store.worldId }], payload: { kind: "world-chat-world-metadata", worldId: store.worldId, action: { kind: "world-metadata", changes: { name: "New" }, checkReceiptIds: [newId("check")] } }, baseObservations: [{ requirement: "world-metadata", target: store.worldId, revisionOrDigest: "v1", complete: true }, { requirement: "art-direction", target: "art-direction", revisionOrDigest: "v1", complete: true }], createdAt: AT });
  assert.equal(executed, 0, "preparing is not permission");
  const log = new WorldChatStore(conversationDir(store.dir, conversation.id));
  const seq = foldConversation(conversation.id, AT, (await log.read()).events).view.seq;
  const request = { kind: "conversation-action-decide" as const, worldId: store.worldId, conversationId: conversation.id,
    actionId: action.actionId, requestId: ulid(), decision: "approve" as const, expectedConversationSeq: seq, expectedStatus: "pending" as const };
  open = false;
  assert.equal((await service.decide(request)).reason, "wrong-world");
  assert.equal(executed, 0);
  open = true;
  assert.equal((await service.decide(request)).status, "completed");
  const restarted = new ConversationActionService(store, deps);
  await restarted.recover();
  assert.equal((await restarted.decide(request)).deduplicated, true);
  assert.equal(executed, 1);
});

it("archive records its terminal outcome in the moved world even when host publication fails", async () => {
  const { makeTempRoot, WORLD_ID } = await import("../world/helpers.js");
  const { FsWorldProvider } = await import("../../src/world/provider.js");
  const { worldMetadataFence } = await import("../../src/world-chat/target-reads.js");
  const { access } = await import("node:fs/promises");
  const made = await makeTempRoot();
  const provider = new FsWorldProvider(made.root);
  closeOnCleanup(() => provider.close());
  await provider.loadWorld(WORLD_ID);
  const store = provider.openStore()!;
  let folder = "";
  const service = new ConversationActionService(store, {
    gate: provider.gate(), actions: {}, now: () => AT, isWorldOpen: () => provider.openStore() === store,
    archiveWorld: async () => {
      const archived = await provider.archiveWorld(WORLD_ID);
      folder = archived.folder;
      return { id: WORLD_ID, folder };
    },
    archived: async () => { throw new Error("publication unavailable"); },
  });
  const conversation = await new WorldChatService(store.dir).create({ title: "Archive", at: AT });
  const action = await service.lifecycle.prepare({ conversationId: conversation.id, turnId: newId("turn"), worldId: WORLD_ID,
    actionKind: "world-chat-world-archive", targets: [{ kind: "world", id: WORLD_ID }],
    payload: { kind: "world-chat-world-archive", worldId: WORLD_ID, action: { kind: "world-archive", checkReceiptIds: [newId("check")] } },
    baseObservations: [{ requirement: "world-metadata", target: WORLD_ID, revisionOrDigest: worldMetadataFence(store.getBundle()), complete: true }], createdAt: AT });
  const log = new WorldChatStore(conversationDir(store.dir, conversation.id));
  const seq = foldConversation(conversation.id, AT, (await log.read()).events).view.seq;
  const result = await service.decide({ kind: "conversation-action-decide", worldId: WORLD_ID, conversationId: conversation.id,
    actionId: action.actionId, requestId: ulid(), decision: "approve", expectedConversationSeq: seq, expectedStatus: "pending" });
  assert.ok(folder);
  assert.equal(result.status, "failed");
  const moved = new WorldChatStore(conversationDir(folder, conversation.id));
  assert.equal(foldConversation(conversation.id, AT, (await moved.read()).events).view.actions[0]?.status, "failed");
  await assert.rejects(access(made.worldDir), { code: "ENOENT" });
});
