import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { newId, type WorldChangeCandidate, type WorldChatStoredEvent } from "@arke-studio/contracts";
import { WorldChatStore } from "../../src/world-chat/store.js";
import { foldConversation } from "../../src/world-chat/fold.js";
import { tempDir } from "../tmp.js";

/**
 * What survives closing the app (#70 §21.2).
 *
 * The store and the fold are tested separately elsewhere; this is the round trip. A conversation
 * is only worth having if yesterday's is still there tomorrow, and the failure mode that matters
 * is not "it threw" but "it came back subtly different".
 */

const AT = "2026-08-06T09:00:00Z";
const CV = newId("cv");

function candidate(id: string, revision: number, title: string): WorldChangeCandidate {
  return {
    id,
    conversationId: CV,
    revision,
    status: "live",
    settledness: "settled",
    subject: { kind: "canon", entryId: "CANON-018" },
    title,
    rationale: "",
    sourceMessageIds: [],
    evidence: [],
    checks: {
      state: "complete",
      basedOnCanonRevision: 42,
      required: [],
      completed: [],
      consulted: [],
      likelyDuplicates: [],
      possibleAmendments: [],
      contradictionCandidates: [],
      explanation: "",
    },
    createdAt: AT,
    updatedAt: AT,
    classification: "canon.create",
    draft: { type: "rule", title, statement: "…", links: [] },
  } as WorldChangeCandidate;
}

function reply(text: string, candidates: WorldChangeCandidate[]): WorldChatStoredEvent {
  const turnId = newId("turn");
  return {
    type: "turn.completed",
    message: { id: newId("msg"), turnId, role: "studio", text, attachmentIds: [], createdAt: AT },
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
    candidates,
    groups: [],
    tombstones: [],
  };
}

describe("a conversation survives being closed and reopened", () => {
  it("comes back with the same messages, propositions and title", async () => {
    const dir = join(await tempDir("arke-restart-"), CV);
    const first = new WorldChatStore(dir);
    await first.create(CV, AT);
    await first.append(
      { type: "conversation.created", title: "The bells and the lock", entryContext: { kind: "world" } },
      { at: AT },
    );
    const id = newId("cand");
    await first.append(reply("that changes the line of inheritance", [candidate(id, 1, "her mother")]), {
      at: AT,
    });
    await first.append(reply("noted", [candidate(id, 2, "her aunt")]), { at: AT });
    await first.drain();

    const before = foldConversation(CV, AT, (await first.read()).events).view;

    // A different process, holding nothing in memory.
    const next = new WorldChatStore(dir);
    const after = foldConversation(CV, AT, (await next.read()).events).view;

    assert.deepEqual(after, before, "reopening must not change what the conversation says");
    assert.equal(after.title, "The bells and the lock");
    assert.equal(after.candidates[0]!.title, "her aunt", "including the correction");
    assert.equal(after.messages.length, 2);
  });

  it("keeps a retraction retracted, so the same idea is not detected again", async () => {
    const dir = join(await tempDir("arke-restart-"), CV);
    const s = new WorldChatStore(dir);
    await s.create(CV, AT);
    const id = newId("cand");
    const turnId = newId("turn");
    await s.append(reply("first", [candidate(id, 1, "whale bone")]), { at: AT });
    await s.append(
      {
        type: "turn.completed",
        message: {
          id: newId("msg"),
          turnId,
          role: "studio",
          text: "dropped",
          attachmentIds: [],
          createdAt: AT,
        },
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
        tombstones: [
          {
            candidateId: id,
            revision: 1,
            structuralKey: "canon.create|whale bone",
            payloadDigest: `sha256:${"b".repeat(64)}`,
            retractedByMessageId: newId("msg"),
            at: AT,
          },
        ],
      },
      { at: AT },
    );

    const folded = foldConversation(CV, AT, (await new WorldChatStore(dir).read()).events);
    assert.equal(folded.view.candidates[0]!.status, "withdrawn");
    assert.equal(folded.tombstones.length, 1, "the tombstone outlives the session that made it");
    assert.equal(folded.tombstones[0]!.structuralKey, "canon.create|whale bone");
  });

  it("cannot land a reply without the propositions it describes", async () => {
    // Not a behaviour to be enforced later — the reply, its receipts and its propositions are one
    // record, so there is no interleaving in which half of a turn is durable.
    const dir = join(await tempDir("arke-restart-"), CV);
    const s = new WorldChatStore(dir);
    await s.create(CV, AT);
    await s.append(
      reply("two things follow", [candidate(newId("cand"), 1, "one"), candidate(newId("cand"), 1, "two")]),
      {
        at: AT,
      },
    );

    const { events } = await s.read();
    assert.equal(events.length, 1, "one event, not three");
    const view = foldConversation(CV, AT, events).view;
    assert.equal(view.messages.length, 1);
    assert.equal(view.candidates.length, 2, "the reply and its propositions arrived together");
  });

  it("cannot land a user message without a run to retry", async () => {
    const dir = join(await tempDir("arke-restart-"), CV);
    const s = new WorldChatStore(dir);
    await s.create(CV, AT);
    const turnId = newId("turn");
    await s.append(
      {
        type: "turn.started",
        message: {
          id: newId("msg"),
          turnId,
          role: "user",
          text: "her aunt",
          attachmentIds: [],
          createdAt: AT,
        },
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
      },
      { at: AT },
    );

    const folded = foldConversation(CV, AT, (await s.read()).events);
    assert.equal(folded.view.messages.length, 1, "the message the user typed is kept");
    assert.ok(folded.view.activeRun, "and it has a run, so there is something to retry");
    assert.equal(folded.view.activeRun.turnId, folded.view.messages[0]!.turnId);
  });

  it("shows the most recent messages and says when there are older ones", async () => {
    const dir = join(await tempDir("arke-restart-"), CV);
    const s = new WorldChatStore(dir);
    await s.create(CV, AT);
    for (let i = 0; i < 5; i++) await s.append(reply(`message ${i}`, []), { at: AT });

    const view = foldConversation(CV, AT, (await s.read()).events, { messageLimit: 2 }).view;
    assert.equal(view.messages.length, 2);
    assert.deepEqual(
      view.messages.map((m) => m.text),
      ["message 3", "message 4"],
      "the newest, because that is what you are looking at when a conversation opens",
    );
    assert.equal(view.hasMore, true, "and the older ones are known to exist");
  });

  it("pages back from a log sequence, not a position in the list", async () => {
    const dir = join(await tempDir("arke-restart-"), CV);
    const s = new WorldChatStore(dir);
    await s.create(CV, AT);
    // One event each, so message N arrived at sequence N+1.
    for (let i = 0; i < 5; i++) await s.append(reply(`message ${i}`, []), { at: AT });
    const { events } = await s.read();

    const page = foldConversation(CV, AT, events, { messageLimit: 2, before: 4 }).view;
    assert.deepEqual(
      page.messages.map((m) => m.text),
      ["message 1", "message 2"],
      "the two most recent that arrived before sequence 4",
    );
    assert.equal(page.hasMore, true, "message 0 is still further back");

    const start = foldConversation(CV, AT, events, { messageLimit: 2, before: 2 }).view;
    assert.deepEqual(
      start.messages.map((m) => m.text),
      ["message 0"],
    );
    assert.equal(start.hasMore, false, "the beginning of the conversation says so");

    // The cursor keeps its meaning as the conversation grows underneath it, which an index
    // into the message list would not.
    await s.append(reply("message 5", []), { at: AT });
    const again = foldConversation(CV, AT, (await s.read()).events, { messageLimit: 2, before: 4 }).view;
    assert.deepEqual(
      again.messages.map((m) => m.text),
      ["message 1", "message 2"],
    );
  });
});
