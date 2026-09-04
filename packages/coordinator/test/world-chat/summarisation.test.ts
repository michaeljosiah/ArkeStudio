import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { newId, type ConversationId, type MessageId } from "@arke-studio/contracts";
import { refreshConversationSummary } from "../../src/world-chat/summarisation.js";
import { foldConversation } from "../../src/world-chat/fold.js";
import { conversationDir, WorldChatStore } from "../../src/world-chat/store.js";
import { tempDir } from "../tmp.js";

const AT = "2026-09-04T12:00:00.000Z";

async function setup() {
  const worldPath = await tempDir("arke-summary-");
  const conversationId = newId("cv") as ConversationId;
  const store = new WorldChatStore(conversationDir(worldPath, conversationId));
  await store.create(conversationId, AT);
  await store.append({ type: "conversation.created", title: "Summary", entryContext: { kind: "world" } }, { at: AT });
  return { store, conversationId };
}

async function appendTurns(store: WorldChatStore, count: number): Promise<void> {
  for (let index = 0; index < count; index++) {
    const turnId = newId("turn");
    const run = {
      id: newId("run"),
      turnId,
      basedOnConversationSeq: 0,
      status: "running" as const,
      adapter: "test",
      harnessCleanup: "not-required" as const,
      contextDigest: `sha256:${"a".repeat(64)}`,
      startedAt: AT,
    };
    await store.append(
      {
        type: "turn.started",
        message: {
          id: newId("msg") as MessageId,
          turnId,
          role: "user",
          text: `Question ${index}`,
          attachmentIds: [],
          createdAt: AT,
        },
        run,
      },
      { at: AT },
    );
    await store.append(
      {
        type: "turn.completed",
        message: {
          id: newId("msg") as MessageId,
          turnId,
          role: "studio",
          text: `Answer ${index}`,
          attachmentIds: [],
          createdAt: AT,
        },
        run: { ...run, status: "completed", endedAt: AT },
        receipts: [],
        candidates: [],
        groups: [],
        tombstones: [],
      },
      { at: AT },
    );
  }
}

async function appendStartedTurn(store: WorldChatStore): Promise<MessageId> {
  const turnId = newId("turn");
  const messageId = newId("msg") as MessageId;
  await store.append(
    {
      type: "turn.started",
      message: {
        id: messageId,
        turnId,
        role: "user",
        text: "This turn is still running",
        attachmentIds: [],
        createdAt: AT,
      },
      run: {
        id: newId("run"),
        turnId,
        basedOnConversationSeq: 0,
        status: "running",
        adapter: "test",
        harnessCleanup: "not-required",
        contextDigest: `sha256:${"a".repeat(64)}`,
        startedAt: AT,
      },
    },
    { at: AT },
  );
  return messageId;
}

describe("conversation summarisation", () => {
  it("runs after eight completed turns and durably bounds its non-authoritative result", async () => {
    const { store, conversationId } = await setup();
    await appendTurns(store, 8);
    const before = (await store.read()).events.at(-1)!.seq;
    const activeMessageId = await appendStartedTurn(store);
    let calls = 0;
    const updated = await refreshConversationSummary(store, async (input) => {
      calls++;
      assert.equal(input.previousSummary, undefined);
      assert.equal(input.messages.length, 16);
      return "s".repeat(9_000);
    });

    assert.equal(updated, true);
    assert.equal(calls, 1);
    const events = (await store.read()).events;
    const event = events.at(-1)!.event;
    assert.equal(event.type, "summary.updated");
    assert.equal(event.type === "summary.updated" ? event.throughSeq : null, before);
    assert.equal(event.type === "summary.updated" ? event.sourceMessageIds.length : null, 16);
    assert.equal(event.type === "summary.updated" ? event.text.length : null, 8_000);
    assert.ok(event.type !== "summary.updated" || !event.sourceMessageIds.includes(activeMessageId),
      "an incomplete later turn stays beyond the summary boundary",
    );
    const meta = (await store.readMeta())!;
    assert.equal(foldConversation(conversationId, meta.createdAt, events).view.summary?.length, 8_000);

    assert.equal(await refreshConversationSummary(store, async () => {
      calls++;
      return "not needed";
    }), false);
    assert.equal(calls, 1, "a summary resets the threshold");
  });

  it("leaves the previous durable summary in place when a later summary fails", async () => {
    const { store, conversationId } = await setup();
    await appendTurns(store, 8);
    await refreshConversationSummary(store, async () => "First summary");
    await appendTurns(store, 8);
    const updated = await refreshConversationSummary(store, async (input) => {
      assert.equal(input.previousSummary, "First summary");
      return null;
    });

    assert.equal(updated, false);
    const events = (await store.read()).events;
    assert.equal(events.filter((envelope) => envelope.event.type === "summary.updated").length, 1);
    const meta = (await store.readMeta())!;
    assert.equal(foldConversation(conversationId, meta.createdAt, events).view.summary, "First summary");
  });

  it("reruns after a turn completes while summarisation is already in flight", async () => {
    const { store } = await setup();
    await appendTurns(store, 8);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    let calls = 0;
    const summarise = async () => {
      calls++;
      if (calls === 1) {
        started();
        await held;
      }
      return `Summary ${calls}`;
    };

    const first = refreshConversationSummary(store, summarise);
    await entered;
    await appendTurns(store, 8);
    const second = refreshConversationSummary(store, summarise);
    release();

    assert.equal(await first, true);
    assert.equal(await second, true);
    assert.equal(calls, 2);
    const events = (await store.read()).events;
    const latest = events.at(-1)!.event;
    assert.equal(events.filter((envelope) => envelope.event.type === "summary.updated").length, 2);
    assert.equal(latest.type === "summary.updated" ? latest.text : null, "Summary 2");
  });
});
