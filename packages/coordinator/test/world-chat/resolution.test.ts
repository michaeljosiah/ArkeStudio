import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  newId,
  type CandidateId,
  type ConversationId,
  type MessageId,
  type WorldChangeCandidate,
} from "@arke-studio/contracts";
import { ProposalManager } from "../../src/gate/proposals.js";
import { foldConversation } from "../../src/world-chat/fold.js";
import { recordResolution, ResolutionError, sendBack } from "../../src/world-chat/resolution.js";
import { conversationDir, WorldChatStore } from "../../src/world-chat/store.js";
import { wrapUp } from "../../src/world-chat/wrapup.js";
import { recoverWrapUps } from "../../src/world-chat/wrapup-recovery.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";

/**
 * What becomes of a conversation after its proposals are decided (#70 §6.5, R-34a).
 *
 * The distinction these tests protect is between discard and send-back. Discard is "I have
 * changed my mind" and stays discarded; send-back is "not like this" and returns the propositions
 * to a reopened conversation. Having both is what makes discard safe to offer at all — without
 * send-back, the only way to say "nearly" would be to say "no".
 */

const AT = "2026-08-06T10:00:00Z";
const NOW = () => AT;

function candidate(over: Partial<WorldChangeCandidate> = {}): WorldChangeCandidate {
  return {
    id: newId("cand") as CandidateId,
    conversationId: newId("cv") as ConversationId,
    revision: 1,
    status: "live",
    settledness: "settled",
    classification: "canon.create",
    subject: { kind: "new", label: "The bells" },
    title: "Bells may pass sideways",
    rationale: "",
    sourceMessageIds: [],
    evidence: [
      {
        kind: "message",
        messageId: newId("msg") as MessageId,
        quote: "the bells pass sideways",
        start: 0,
        end: 23,
        purpose: "intent",
      },
    ],
    checks: {
      state: "complete",
      basedOnCanonRevision: 42,
      required: ["canon-search"],
      completed: ["canon-search"],
      consulted: [],
      likelyDuplicates: [],
      possibleAmendments: [],
      contradictionCandidates: [],
      explanation: "",
    },
    createdAt: AT,
    updatedAt: AT,
    draft: { type: "lore", title: "The bells", statement: "They may pass sideways.", links: [] },
    ...over,
  } as WorldChangeCandidate;
}

/** A world with one conversation that has been wrapped up into one proposal. */
async function wrapped() {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir);
  const gate = new ProposalManager(store);
  const conversationId = newId("cv") as ConversationId;
  const log = new WorldChatStore(conversationDir(dir, conversationId));
  await log.create(conversationId, AT);
  await log.append(
    { type: "conversation.created", title: "the bells", entryContext: { kind: "world" } },
    { at: AT },
  );

  const only = candidate();
  const turnId = newId("turn");
  await log.append(
    {
      type: "turn.completed",
      message: {
        id: newId("msg") as MessageId,
        turnId,
        role: "studio",
        text: "Noted.",
        attachmentIds: [],
        createdAt: AT,
      },
      run: {
        id: newId("run"),
        turnId,
        basedOnConversationSeq: 1,
        status: "completed",
        adapter: "fake",
        harnessCleanup: "not-required",
        contextDigest: `sha256:${"a".repeat(64)}`,
        startedAt: AT,
        endedAt: AT,
      },
      receipts: [],
      candidates: [only],
      groups: [],
      tombstones: [],
    },
    { at: AT },
  );

  const seq = (await log.read()).events.length;
  const result = await wrapUp({
    store,
    gate,
    conversationId,
    requestId: "req-1",
    expectedConversationSeq: seq,
    now: NOW,
  });

  const view = async () => {
    const meta = await log.readMeta();
    return foldConversation(meta!.id, meta!.createdAt, (await log.read()).events).view;
  };
  const proposal = await gate.readManifest(result.proposalIds[0]!);
  return { dir, store, gate, conversationId, log, only, proposal, view };
}

describe("after wrap-up", () => {
  it("closes the conversation and marks its propositions proposed", async () => {
    const w = await wrapped();
    const view = await w.view();
    assert.equal(view.status, "closed");
    assert.equal(view.candidates[0]!.status, "proposed", "no longer live, so the panel stops showing it");
    await w.store.close();
  });

  it("records the proposal each proposition became", async () => {
    const w = await wrapped();
    assert.equal(
      w.proposal.worldChatOrigins?.[0]?.candidateId,
      w.only.id,
      "the proposal knows which proposition it came from",
    );
    await w.store.close();
  });
});

describe("sending a proposal back", () => {
  it("reopens the conversation and returns its propositions to live", async () => {
    const w = await wrapped();
    const conversationId = await sendBack(w.store, w.gate, w.proposal, NOW);
    assert.equal(conversationId, w.conversationId);

    const view = await w.view();
    assert.equal(view.status, "open", "the conversation carries on from where it was");
    assert.equal(view.candidates[0]!.status, "live", "and the proposition is back in the panel");
    assert.equal(view.reopened, true);
    await w.store.close();
  });

  it("removes the proposal, so it is not waiting in two places at once", async () => {
    const w = await wrapped();
    await sendBack(w.store, w.gate, w.proposal, NOW);
    const ours = (await w.gate.listOpen()).filter((p) => p.kind === "worldbuilding");
    assert.deepEqual(ours, []);
    await w.store.close();
  });

  it("refuses when the conversation it came from is gone", async () => {
    const w = await wrapped();
    // Delete the conversation out from under it, as an explicit deletion would.
    const { rm } = await import("node:fs/promises");
    await rm(conversationDir(w.dir, w.conversationId), { recursive: true, force: true });

    await assert.rejects(
      () => sendBack(w.store, w.gate, w.proposal, NOW),
      (err: unknown) => err instanceof ResolutionError && err.reason === "conversation-gone",
    );
    const ours = (await w.gate.listOpen()).filter((p) => p.kind === "worldbuilding");
    assert.equal(ours.length, 1, "and the proposal is left alone rather than silently dropped");
    await w.store.close();
  });

  it("refuses a proposal that did not come from a conversation", async () => {
    const w = await wrapped();
    const plain = { ...w.proposal, worldChatOrigins: undefined };
    await assert.rejects(
      () => sendBack(w.store, w.gate, plain, NOW),
      (err: unknown) => err instanceof ResolutionError && err.reason === "not-world-chat",
    );
    await w.store.close();
  });
});

describe("accepting and discarding", () => {
  it("records acceptance against the conversation", async () => {
    const w = await wrapped();
    await recordResolution(w.store, w.proposal, "accepted", NOW);
    const view = await w.view();
    assert.equal(view.candidates[0]!.status, "accepted", "immutable history, on a closed conversation");
    assert.equal(view.status, "closed", "and accepting does not reopen it");
    await w.store.close();
  });

  it("keeps a discarded proposition discarded", async () => {
    const w = await wrapped();
    await recordResolution(w.store, w.proposal, "discarded", NOW);
    const view = await w.view();
    assert.equal(
      view.candidates[0]!.status,
      "discarded",
      "discard is the user changing their mind; it does not come back to be discarded again",
    );
    assert.equal(view.status, "closed");
    await w.store.close();
  });

  it("does not fail an accept because the conversation was deleted", async () => {
    const w = await wrapped();
    const { rm } = await import("node:fs/promises");
    await rm(conversationDir(w.dir, w.conversationId), { recursive: true, force: true });
    // The world has already changed; losing the account of it is not worth failing the accept.
    await recordResolution(w.store, w.proposal, "accepted", NOW);
    await w.store.close();
  });
});

describe("a wrap-up the app died in the middle of", () => {
  it("finishes one whose proposals are all there", async () => {
    const dir = await makeTempWorld();
    const store = await WorldStore.open(dir);
    const gate = new ProposalManager(store);
    const conversationId = newId("cv") as ConversationId;
    const log = new WorldChatStore(conversationDir(dir, conversationId));
    await log.create(conversationId, AT);
    await log.append(
      { type: "conversation.created", title: "t", entryContext: { kind: "world" } },
      { at: AT },
    );
    // An intent with a proposal that exists but no completion: the crash window.
    await log.append(
      {
        type: "wrapup.intent-recorded",
        requestId: "req-crash",
        expectedConversationSeq: 1,
        plannedProposalIds: [],
      },
      { at: AT },
    );
    await gate.stage({
      kind: "worldbuilding",
      summary: "Bells",
      source: `world-chat:${conversationId}`,
      targets: [{ path: "canon/CANON-900.md", content: "---\nid: CANON-900\ntype: lore\ntitle: B\nstatus: settled\nintroducedAt: 0\nlinks: []\n---\n\nBody.\n" }],
      worldChatOrigins: [
        {
          requestId: "req-crash",
          conversationId,
          candidateId: newId("cand"),
          candidateRevision: 1,
          targetPaths: ["canon/CANON-900.md"],
          fields: ["statement"],
        },
      ],
    });

    const outcome = await recoverWrapUps(store, gate, NOW);
    assert.equal(outcome.repaired[0]!.outcome, "completed");

    const meta = await log.readMeta();
    const view = foldConversation(meta!.id, meta!.createdAt, (await log.read()).events).view;
    assert.equal(view.status, "closed", "work that already exists is not made to happen twice");
    await store.close();
  });

  it("leaves a conversation open when nothing was created", async () => {
    const dir = await makeTempWorld();
    const store = await WorldStore.open(dir);
    const gate = new ProposalManager(store);
    const conversationId = newId("cv") as ConversationId;
    const log = new WorldChatStore(conversationDir(dir, conversationId));
    await log.create(conversationId, AT);
    await log.append(
      { type: "conversation.created", title: "t", entryContext: { kind: "world" } },
      { at: AT },
    );
    await log.append(
      {
        type: "wrapup.intent-recorded",
        requestId: "req-nothing",
        expectedConversationSeq: 1,
        plannedProposalIds: [],
      },
      { at: AT },
    );

    const outcome = await recoverWrapUps(store, gate, NOW);
    assert.equal(outcome.repaired[0]!.outcome, "failed");

    const meta = await log.readMeta();
    const view = foldConversation(meta!.id, meta!.createdAt, (await log.read()).events).view;
    assert.equal(view.status, "open", "nothing was created, so there is nothing to close over");
    await store.close();
  });

  it("does nothing to a conversation whose wrap-up finished", async () => {
    const w = await wrapped();
    const outcome = await recoverWrapUps(w.store, w.gate, NOW);
    assert.deepEqual(outcome.repaired, [], "a completed wrap-up is not an unfinished one");
    await w.store.close();
  });
});
