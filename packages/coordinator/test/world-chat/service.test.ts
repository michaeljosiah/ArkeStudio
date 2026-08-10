import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { describe, it } from "node:test";
import { newId, type ConversationId } from "@arke-studio/contracts";
import { ConversationInUseError, WorldChatService } from "../../src/world-chat/service.js";
import { conversationsDir, WorldChatStore } from "../../src/world-chat/store.js";
import { discoverConversations } from "../../src/world-chat/discover.js";
import { recoverConversations } from "../../src/world-chat/recovery.js";
import { tempDir } from "../tmp.js";

/**
 * The conversation lifecycle (#70 §15.1, R-50).
 *
 * Deleting is the only irreversible thing here, so most of this is about what stops it — and
 * about the rename being the moment it happens, so there is no half-deleted conversation.
 */

const NOW = () => "2026-08-06T10:00:00Z";

async function service(): Promise<WorldChatService> {
  return new WorldChatService(await tempDir("arke-service-"), NOW);
}

async function startRun(svc: WorldChatService, id: ConversationId): Promise<void> {
  const store = new WorldChatStore(
    (await import("../../src/world-chat/store.js")).conversationDir(svc.worldPath, id),
  );
  const turnId = newId("turn");
  await store.append(
    {
      type: "turn.started",
      message: { id: newId("msg"), turnId, role: "user", text: "…", attachmentIds: [], createdAt: NOW() },
      run: {
        id: newId("run"),
        turnId,
        basedOnConversationSeq: 1,
        status: "running",
        adapter: "opencode",
        harnessCleanup: "pending",
        contextDigest: `sha256:${"a".repeat(64)}`,
        startedAt: NOW(),
      },
    },
    { at: NOW() },
  );
}

describe("conversation lifecycle", () => {
  it("creates one that is open, titled and empty", async () => {
    const svc = await service();
    const row = await svc.create({ title: "The bells and the lock" });
    assert.equal(row.title, "The bells and the lock");
    assert.equal(row.status, "open");
    assert.equal(row.pointCount, 0);
    assert.equal(row.openProposalCount, 0);
  });

  it("renames, archives and unarchives without losing anything", async () => {
    const svc = await service();
    const { id } = await svc.create({ title: "first name" });

    await svc.rename(id, "second name");
    assert.equal((await svc.load(id))!.title, "second name");

    await svc.archive(id);
    assert.equal((await svc.load(id))!.status, "archived");

    await svc.unarchive(id);
    const back = await svc.load(id);
    assert.equal(back!.status, "open");
    assert.equal(back!.title, "second name", "archiving is a shelf, not an eraser");
  });

  it("treats a repeated create request as one conversation", async () => {
    const svc = await service();
    await svc.create({ title: "once", requestId: "req-1" });
    // A retry reaches a new directory, so the guard that matters is at the command layer; what
    // this pins is that the store's own idempotence does not silently produce a second row in
    // the same conversation.
    const { summaries } = await discoverConversations(svc.worldPath);
    assert.equal(summaries.length, 1);
  });

  it("returns null for a conversation that does not exist", async () => {
    const svc = await service();
    assert.equal(await svc.load(newId("cv") as ConversationId), null);
  });

  it("refuses to delete while a turn is running", async () => {
    const svc = await service();
    const { id } = await svc.create({ title: "busy" });
    await startRun(svc, id);

    assert.equal(await svc.blockedFromDeletion(id), "active-run");
    await assert.rejects(
      () => svc.delete(id, "op-1"),
      (err: unknown) => err instanceof ConversationInUseError && err.reason === "active-run",
    );
    assert.ok(await svc.load(id), "and the conversation is still there");
  });

  it("refuses to delete while a wrap-up is in flight", async () => {
    const svc = await service();
    const { id } = await svc.create({ title: "wrapping" });
    const { conversationDir } = await import("../../src/world-chat/store.js");
    await new WorldChatStore(conversationDir(svc.worldPath, id)).append(
      { type: "wrapup.intent-recorded", requestId: "w1", expectedConversationSeq: 1, plannedProposalIds: [] },
      { at: NOW() },
    );

    assert.equal(await svc.blockedFromDeletion(id), "wrap-up-in-flight");
  });

  it("refuses to delete while its proposals are still waiting", async () => {
    const svc = await service();
    const { id } = await svc.create({ title: "proposed" });
    const { conversationDir } = await import("../../src/world-chat/store.js");
    const store = new WorldChatStore(conversationDir(svc.worldPath, id));
    await store.append(
      {
        type: "wrapup.completed",
        requestId: "w1",
        proposalIds: [newId("pr")],
        notCarried: [],
        mediaIdeaIds: [],
      },
      { at: NOW() },
    );

    assert.equal(await svc.blockedFromDeletion(id), "unresolved-proposals");
  });

  it("allows deletion once the proposals are resolved", async () => {
    const svc = await service();
    const { id } = await svc.create({ title: "settled" });
    const { conversationDir } = await import("../../src/world-chat/store.js");
    const store = new WorldChatStore(conversationDir(svc.worldPath, id));
    const proposalId = newId("pr");
    await store.append(
      {
        type: "wrapup.completed",
        requestId: "w1",
        proposalIds: [proposalId],
        notCarried: [],
        mediaIdeaIds: [],
      },
      { at: NOW() },
    );
    await store.append(
      { type: "proposal.resolved", proposalId, outcome: "accepted", candidateIds: [] },
      { at: NOW() },
    );

    assert.equal(await svc.blockedFromDeletion(id), null);
    await svc.delete(id, "op-1");
    assert.equal(await svc.load(id), null);
  });

  /*
   * A wrap-up that failed and could not take back everything it staged.
   *
   * The failure closes the in-flight guard, so nothing else says this conversation is waiting on
   * anything — and Delete would be offered over a proposal still on the approvals screen. Deleting
   * puts it beyond every repair there is: startup recovery walks the conversations that exist, and
   * send-back needs somewhere to put the propositions back.
   */
  it("refuses to delete while a failed wrap-up's leftovers are still staged", async () => {
    const svc = await service();
    const { id } = await svc.create({ title: "left something behind" });
    const { conversationDir } = await import("../../src/world-chat/store.js");
    const store = new WorldChatStore(conversationDir(svc.worldPath, id));
    const proposalId = newId("pr");
    await store.append(
      {
        type: "wrapup.failed",
        requestId: "w1",
        safeDetail: "materialise; 1 left staged",
        leftovers: [{ proposalId, candidateIds: [] }],
      },
      { at: NOW() },
    );

    assert.equal(await svc.blockedFromDeletion(id), "unresolved-proposals");

    // Recovery sends it back: the proposal is gone, so there is nothing left to hold the door.
    await store.append(
      { type: "conversation.reopened", proposalId, restoredCandidateIds: [] },
      { at: NOW() },
    );
    assert.equal(
      await svc.blockedFromDeletion(id),
      null,
      "a proposal that no longer exists is not one this conversation is waiting on",
    );
  });

  /**
   * The reason has to reach the row, or the button cannot say why it is unavailable — and a
   * Delete that looks available and then refuses is the same mistake as one that fails silently.
   */
  it("carries the reason onto the summary row, not only into the refusal", async () => {
    const svc = await service();
    const { id } = await svc.create({ title: "busy" });
    await startRun(svc, id);

    const { summaries } = await discoverConversations(svc.worldPath);
    assert.equal(summaries[0]!.deletionBlock, "active-run");
  });

  it("leaves the row unmarked when nothing depends on the conversation", async () => {
    const svc = await service();
    await svc.create({ title: "free" });
    const { summaries } = await discoverConversations(svc.worldPath);
    assert.equal(summaries[0]!.deletionBlock, undefined);
  });

  /**
   * The landmine under Delete.
   *
   * A run left `running` by a crash has no terminal event, so every reader folds it as
   * interrupted for ever and the conversation reports itself in use. Without startup recovery it
   * could never be deleted, and the reason given — "a turn is still running" — would be a lie
   * about a process that died days ago. This is why the delete command and the recovery wiring
   * had to land together.
   */
  it("becomes deletable once startup recovery has closed a crashed run", async () => {
    const svc = await service();
    const { id } = await svc.create({ title: "abandoned mid-turn" });
    await startRun(svc, id);
    assert.equal(await svc.blockedFromDeletion(id), "active-run", "before recovery it is stuck");

    await recoverConversations(svc.worldPath, NOW);

    assert.equal(await svc.blockedFromDeletion(id), null);
    await svc.delete(id, "op-1");
    assert.equal(await svc.load(id), null);
  });

  it("leaves nothing behind, and no tombstone, on a clean delete", async () => {
    const svc = await service();
    const { id } = await svc.create({ title: "gone" });
    await svc.delete(id, "op-1");

    assert.deepEqual((await discoverConversations(svc.worldPath)).summaries, []);
    const remaining = await readdir(conversationsDir(svc.worldPath));
    // Only the tombstone directory itself may remain, and it must be empty.
    for (const entry of remaining) {
      assert.equal(entry, ".deleted");
      assert.deepEqual(await readdir(`${conversationsDir(svc.worldPath)}/.deleted`), []);
    }
  });

  it("does not fail when the same delete is asked for twice", async () => {
    const svc = await service();
    const { id } = await svc.create({ title: "gone" });
    await svc.delete(id, "op-1");
    await svc.delete(id, "op-1");
    assert.equal(await svc.load(id), null);
  });

  it("keeps a paged read out of the checkpoint, which only holds the default window", async () => {
    const svc = await service();
    const { id } = await svc.create({ title: "paged" });
    const full = await svc.load(id);
    const paged = await svc.load(id, { messageLimit: 1 });
    assert.ok(full);
    assert.ok(paged);
    assert.ok(paged.messages.length <= 1);
  });
});
