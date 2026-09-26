import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { newId, type ConversationId, type MessageId } from "@arke-studio/contracts";
import { readdir } from "node:fs/promises";
import type { HarnessAdapter } from "@arke-studio/contracts";
import { makeConversationSummariser, refreshConversationSummary } from "../../src/world-chat/summarisation.js";
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

async function appendTurns(store: WorldChatStore, count: number, model?: string): Promise<void> {
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
      ...(model !== undefined ? { model } : {}),
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
    const foundingMessage = { id: newId("msg"), turnId: newId("turn"), role: "user" as const, text: "The gates never open.", attachmentIds: [], createdAt: new Date().toISOString() };
    await store.append({ type: "founding.message", message: foundingMessage });
    await appendTurns(store, 8);
    const before = (await store.read()).events.at(-1)!.seq;
    const activeMessageId = await appendStartedTurn(store);
    let calls = 0;
    const updated = await refreshConversationSummary(store, async (input) => {
      calls++;
      assert.equal(input.previousSummary, undefined);
      assert.equal(input.messages.length, 17);
      assert.equal(input.messages[0]?.text, foundingMessage.text);
      return "s".repeat(9_000);
    });

    assert.equal(updated, true);
    assert.equal(calls, 1);
    const events = (await store.read()).events;
    const event = events.at(-1)!.event;
    assert.equal(event.type, "summary.updated");
    assert.equal(event.type === "summary.updated" ? event.throughSeq : null, before);
    assert.equal(event.type === "summary.updated" ? event.sourceMessageIds.length : null, 17);
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

describe("the summariser's scratch directory (issue 1247)", () => {
  it("is removed when the session's configuration is refused, not only after a turn", async () => {
    const root = await tempDir("arke-summary-scratch-");
    const adapter = {
      id: "refused",
      readiness: () => ({ ready: true }),
      capabilities: () => new Set(),
      createSession: async () => ({ sessionId: "unexpected" }),
      sendMessage: async () => { throw new Error("unused"); },
      dispatchAsync: async () => { throw new Error("unused"); },
      streamEvents() { return { [Symbol.asyncIterator]: async function* () {} }; },
    } as unknown as HarnessAdapter;
    const summarise = makeConversationSummariser(adapter, async () => { throw new Error("The harness's models could not be read."); }, root);
    assert.equal(await summarise({ messages: [] }), null, "a refused configuration is no summary, not an error");
    assert.deepEqual(await readdir(root), [], "and leaves no directory behind for the next retry to add to");
  });
});

describe("the summariser's model (issue 1289)", () => {
  it("runs on the conversation's model when its own agent has none it may use, and on its own otherwise", async () => {
    const LOCAL = "ollama/hf.co/HauhauCS/Gemma4-12B-QAT-Uncensored-HauhauCS-Balanced:Q4_K_M";
    const root = await tempDir("arke-summary-model-");
    const asked: Array<string | undefined> = [];
    const adapter = {
      id: "arke",
      readiness: () => ({ ready: true }),
      capabilities: () => new Set(),
      createSession: async () => ({ sessionId: "s" }),
      sendMessage: async () => { throw new Error("unused"); },
      dispatchAsync: async () => ({ sessionId: "s", correlationId: "c" }),
      streamEvents() { return { [Symbol.asyncIterator]: async function* () { yield { type: "message.completed", sessionId: "s", text: '{"summary":"They counted keys."}' }; } }; },
    } as unknown as HarnessAdapter;
    // The coordinator's refusal for an agent with nothing chosen and only a model that waits to be chosen.
    const refusing = async (input: { model?: string }) => {
      asked.push(input.model);
      if (input.model === undefined) throw new Error("Gemma 4 · 12B Uncensored Balanced · HauhauCS runs only where you choose it.");
      return input;
    };
    const { store } = await setup();
    await appendTurns(store, 8, LOCAL);
    assert.equal(await refreshConversationSummary(store, makeConversationSummariser(adapter, refusing, root)), true, "a long thread is still condensed");
    assert.deepEqual(asked, [undefined, LOCAL], "its own agent first, then the model the conversation answered on");

    asked.length = 0;
    const own = async (input: { model?: string }) => { asked.push(input.model); return input; };
    assert.equal(await makeConversationSummariser(adapter, own, root)({ messages: [], model: LOCAL }), "They counted keys.");
    assert.deepEqual(asked, [undefined], "a summariser with a model of its own never borrows the conversation's");
  });
});
