import assert from "node:assert/strict";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { newId, type WorldChatStoredEvent } from "@arke-studio/contracts";
import { foldConversation } from "../../src/world-chat/fold.js";
import { recoverConversations } from "../../src/world-chat/recovery.js";
import { conversationDir, conversationsDir, WorldChatStore } from "../../src/world-chat/store.js";
import { tempDir } from "../tmp.js";

/**
 * Startup has to close the turn the last process died in the middle of (#70 §7.2).
 *
 * The part worth testing is not that it happens but that it happens *once*: recovery runs on
 * every open, and a log that says the same turn ended twice is worse than one that never said
 * it ended at all.
 */

const AT = "2026-08-06T09:00:00Z";
const NOW = () => "2026-08-06T10:00:00Z";

function midTurn(): WorldChatStoredEvent {
  const turnId = newId("turn");
  return {
    type: "turn.started",
    message: { id: newId("msg"), turnId, role: "user", text: "her aunt", attachmentIds: [], createdAt: AT },
    run: {
      id: newId("run"),
      turnId,
      basedOnConversationSeq: 0,
      status: "running",
      adapter: "opencode",
      harnessCleanup: "pending",
      contextDigest: `sha256:${"a".repeat(64)}`,
      startedAt: AT,
    },
  };
}

async function worldWithInterruptedTurn(): Promise<{ world: string; dir: string }> {
  const world = await tempDir("arke-recovery-");
  const id = newId("cv");
  const dir = conversationDir(world, id);
  const s = new WorldChatStore(dir);
  await s.create(id, AT);
  await s.append(
    { type: "conversation.created", title: "mid-turn", entryContext: { kind: "world" } },
    { at: AT },
  );
  await s.append(midTurn(), { at: AT });
  await s.drain();
  return { world, dir };
}

describe("startup recovery", () => {
  it("makes an interrupted run durable, so the next reader does not have to infer it", async () => {
    const { world, dir } = await worldWithInterruptedTurn();

    const outcome = await recoverConversations(world, NOW);
    assert.equal(outcome.repaired.length, 1);

    const store = new WorldChatStore(dir);
    const { events } = await store.read();
    const last = events[events.length - 1]!;
    assert.equal(last.event.type, "run.finished");
    assert.equal(last.event.type === "run.finished" && last.event.run.status, "interrupted");
    assert.equal(
      last.event.type === "run.finished" && last.event.run.endedAt,
      "2026-08-06T10:00:00Z",
      "and it ended when we noticed, since nobody recorded when it actually stopped",
    );
  });

  it("does nothing on a second pass, however many times the app is opened", async () => {
    const { world, dir } = await worldWithInterruptedTurn();

    const first = await recoverConversations(world, NOW);
    const second = await recoverConversations(world, NOW);
    const third = await recoverConversations(world, NOW);

    assert.equal(first.repaired.length, 1);
    assert.deepEqual(second.repaired, [], "the turn had already been closed");
    assert.deepEqual(third.repaired, []);

    const { events } = await new WorldChatStore(dir).read();
    const terminals = events.filter((e) => e.event.type === "run.finished");
    assert.equal(
      terminals.length,
      1,
      "a log that says the turn ended twice is worse than one that never said so",
    );
  });

  it("leaves a conversation whose turn completed properly alone", async () => {
    const world = await tempDir("arke-recovery-");
    const id = newId("cv");
    const s = new WorldChatStore(conversationDir(world, id));
    await s.create(id, AT);
    const turnId = newId("turn");
    await s.append(
      {
        type: "turn.completed",
        message: { id: newId("msg"), turnId, role: "studio", text: "done", attachmentIds: [], createdAt: AT },
        run: {
          id: newId("run"),
          turnId,
          basedOnConversationSeq: 0,
          status: "completed",
          adapter: "opencode",
          harnessCleanup: "not-required",
          contextDigest: `sha256:${"a".repeat(64)}`,
          startedAt: AT,
          endedAt: AT,
        },
        receipts: [],
        candidates: [],
        groups: [],
        tombstones: [],
      },
      { at: AT },
    );
    const before = (await s.read()).events.length;

    assert.deepEqual((await recoverConversations(world, NOW)).repaired, []);
    assert.equal((await new WorldChatStore(s.dir).read()).events.length, before, "nothing appended");
  });

  it("keeps the message that was typed, so the turn can be retried", async () => {
    const { world, dir } = await worldWithInterruptedTurn();
    await recoverConversations(world, NOW);

    const store = new WorldChatStore(dir);
    const meta = await store.readMeta();
    const view = foldConversation(meta!.id, meta!.createdAt, (await store.read()).events).view;
    assert.equal(view.messages.length, 1);
    assert.equal(view.messages[0]!.text, "her aunt");
    assert.equal(view.activeRun?.status, "interrupted", "and it is honestly described, not still spinning");
  });

  it("sweeps the tombstone a deletion left behind", async () => {
    const world = await tempDir("arke-recovery-");
    const tomb = join(conversationsDir(world), ".deleted", "cv_gone-op1");
    await mkdir(tomb, { recursive: true });
    await writeFile(join(tomb, "events.jsonl"), "{}\n", "utf8");

    const outcome = await recoverConversations(world, NOW);
    assert.deepEqual(outcome.sweptTombstones, ["cv_gone-op1"]);
    assert.deepEqual(await readdir(join(conversationsDir(world), ".deleted")), []);
  });

  it("opens a world that has no conversations at all", async () => {
    const outcome = await recoverConversations(await tempDir("arke-recovery-"), NOW);
    assert.deepEqual(outcome, { repaired: [], sweptTombstones: [] });
  });
});
