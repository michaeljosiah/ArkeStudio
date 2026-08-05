import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { newId, type WorldChatStoredEvent } from "@arke-studio/contracts";
import { discoverConversations, sortByPendingConsequence } from "../../src/world-chat/discover.js";
import { writeCheckpoint } from "../../src/world-chat/checkpoint.js";
import { foldConversation } from "../../src/world-chat/fold.js";
import { conversationDir, conversationsDir, WorldChatStore } from "../../src/world-chat/store.js";
import { scanWorld } from "../../src/world/scan.js";
import { makeTempWorld } from "../world/helpers.js";
import { tempDir } from "../tmp.js";

/**
 * The rows a world snapshot carries (#70 §4.5).
 *
 * Two properties matter more than the listing itself: opening a world must not cost every
 * conversation ever had, and one damaged conversation must not take the others down with it.
 */

const AT = "2026-08-06T09:00:00Z";

function created(title: string): WorldChatStoredEvent {
  return { type: "conversation.created", title, entryContext: { kind: "world" } };
}

async function conversation(world: string, title: string, at = AT): Promise<WorldChatStore> {
  const id = newId("cv");
  const s = new WorldChatStore(conversationDir(world, id));
  await s.create(id, at);
  await s.append(created(title), { at });
  return s;
}

describe("discovering conversations", () => {
  it("lists nothing, and reports no problem, when a world has never had one", async () => {
    const world = await tempDir("arke-discover-");
    assert.deepEqual((await discoverConversations(world)).summaries, []);
  });

  it("returns a row per conversation without reading its transcript", async () => {
    const world = await tempDir("arke-discover-");
    const a = await conversation(world, "The bells and the lock");
    const turnId = newId("turn");
    await a.append(
      {
        type: "turn.started",
        message: {
          id: newId("msg"),
          turnId,
          role: "user",
          text: "a sentence that must not reach the picker",
          attachmentIds: [],
          createdAt: AT,
        },
        run: {
          id: newId("run"),
          turnId,
          basedOnConversationSeq: 1,
          status: "running",
          adapter: "opencode",
          harnessCleanup: "pending",
          contextDigest: `sha256:${"a".repeat(64)}`,
          startedAt: AT,
        },
      },
      { at: AT },
    );

    const { summaries } = await discoverConversations(world);
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0]!.title, "The bells and the lock");
    assert.equal(summaries[0]!.status, "open");
    // The row carries counts, not content: there is nowhere in it for a message to hide.
    assert.ok(!("messages" in summaries[0]!));
    assert.ok(
      !JSON.stringify(summaries[0]).includes("must not reach the picker"),
      "a world snapshot must not carry what was said in a conversation",
    );
  });

  it("skips a directory that has no header, and keeps the others", async () => {
    const world = await tempDir("arke-discover-");
    await conversation(world, "real");
    await mkdir(join(conversationsDir(world), "not-a-conversation"), { recursive: true });
    await writeFile(join(conversationsDir(world), "not-a-conversation", "stray.txt"), "x", "utf8");

    const { summaries } = await discoverConversations(world);
    assert.equal(summaries.length, 1, "one bad directory must not cost the others");
    assert.equal(summaries[0]!.title, "real");
  });

  it("ignores the tombstone directory a deletion leaves behind", async () => {
    const world = await tempDir("arke-discover-");
    await conversation(world, "real");
    await mkdir(join(conversationsDir(world), ".deleted", "cv_gone"), { recursive: true });

    const { summaries } = await discoverConversations(world);
    assert.equal(summaries.length, 1);
  });

  it("takes the row from a current checkpoint rather than folding again", async () => {
    const world = await tempDir("arke-discover-");
    const s = await conversation(world, "checkpointed");
    const view = foldConversation((await s.readMeta())!.id, AT, (await s.read()).events).view;
    await writeCheckpoint(s.dir, view);

    const { summaries } = await discoverConversations(world);
    assert.equal(summaries[0]!.title, "checkpointed");
  });

  it("falls back to the log when the checkpoint is behind", async () => {
    const world = await tempDir("arke-discover-");
    const s = await conversation(world, "old title");
    const stale = foldConversation((await s.readMeta())!.id, AT, (await s.read()).events).view;
    await writeCheckpoint(s.dir, stale);
    await s.append({ type: "conversation.metadata-updated", title: "new title" }, { at: AT });

    const { summaries } = await discoverConversations(world);
    assert.equal(summaries[0]!.title, "new title", "a stale accelerator must not win over the log");
  });
});

describe("the order of the conversation list", () => {
  const row = (id: string, openProposalCount: number, pointCount: number, updatedAt: string) => ({
    id: newId("cv"),
    title: id,
    status: "open" as const,
    updatedAt,
    pointCount,
    openProposalCount,
  });

  it("puts what is waiting at the gate above what is merely open", () => {
    const sorted = sortByPendingConsequence([
      row("nothing pending", 0, 0, "2026-08-06T12:00:00Z"),
      row("live points", 0, 3, "2026-08-06T11:00:00Z"),
      row("proposals waiting", 1, 0, "2026-08-06T10:00:00Z"),
    ]);
    assert.deepEqual(
      sorted.map((r) => r.title),
      ["proposals waiting", "live points", "nothing pending"],
      "a proposal at the gate is the one you must come back to, however old it is",
    );
  });

  it("breaks ties by recency, which is all that distinguishes them", () => {
    const sorted = sortByPendingConsequence([
      row("older", 0, 2, "2026-08-05T10:00:00Z"),
      row("newer", 0, 2, "2026-08-06T10:00:00Z"),
    ]);
    assert.deepEqual(
      sorted.map((r) => r.title),
      ["newer", "older"],
    );
  });

  it("does not reorder the array it was given", () => {
    const rows = [row("a", 0, 0, "2026-08-05T10:00:00Z"), row("b", 1, 0, "2026-08-06T10:00:00Z")];
    const before = rows.map((r) => r.title);
    sortByPendingConsequence(rows);
    assert.deepEqual(
      rows.map((r) => r.title),
      before,
    );
  });
});

describe("a world snapshot carries the rows", () => {
  it("includes conversations without loading their history", async () => {
    const world = await makeTempWorld();
    await conversation(world, "The bells and the lock");

    const { bundle, problems } = await scanWorld(world);
    assert.equal(bundle.conversations.length, 1);
    assert.equal(bundle.conversations[0]!.title, "The bells and the lock");
    assert.deepEqual(problems, [], "a conversation is not world content and raises no problem");
  });

  it("leaves the field empty for a world that has never had one", async () => {
    const { bundle } = await scanWorld(await makeTempWorld());
    assert.deepEqual(bundle.conversations, []);
  });
});
