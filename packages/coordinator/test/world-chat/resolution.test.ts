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

/** Put a completed turn carrying these propositions into the log. */
async function withCandidates(
  log: WorldChatStore,
  candidates: WorldChangeCandidate[],
): Promise<void> {
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
      candidates,
      groups: [],
      tombstones: [],
    },
    { at: AT },
  );
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

  /*
   * A wrap-up that failed and could not take back what it had already staged.
   *
   * It closes its own intent — leaving it open would refuse every later wrap-up on the
   * conversation as in-flight until the studio restarted — so the sweep below is the only thing
   * that ever comes back for these. Without it the proposal waits on the approvals screen with a
   * summary from a conversation that says it created nothing, and accepting it writes one part of
   * a set nobody agreed to as a whole.
   */
  it("sends back what a failed wrap-up could not take back", async () => {
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
    const proposition = candidate();
    await withCandidates(log, [proposition]);

    const orphan = await gate.stage({
      kind: "worldbuilding",
      summary: "Bells",
      source: `world-chat:${conversationId}`,
      targets: [
        {
          path: "canon/CANON-901.md",
          content:
            "---\nid: CANON-901\ntype: lore\ntitle: B\nstatus: settled\nintroducedAt: 0\nlinks: []\n---\n\nBody.\n",
        },
      ],
      worldChatOrigins: [
        {
          requestId: "req-stuck",
          conversationId,
          candidateId: proposition.id,
          candidateRevision: 1,
          targetPaths: ["canon/CANON-901.md"],
          fields: ["statement"],
        },
      ],
    });
    await log.append(
      {
        type: "wrapup.intent-recorded",
        requestId: "req-stuck",
        expectedConversationSeq: 1,
        plannedProposalIds: [],
      },
      { at: AT },
    );
    await log.append(
      {
        type: "wrapup.failed",
        requestId: "req-stuck",
        safeDetail: "materialise; 1 left staged",
        leftovers: [{ proposalId: orphan.id, candidateIds: [proposition.id] }],
      },
      { at: AT },
    );

    const outcome = await recoverWrapUps(store, gate, NOW);
    assert.equal(outcome.repaired[0]!.outcome, "cleaned");
    assert.equal(
      (await gate.listOpen()).some((p) => p.id === orphan.id),
      false,
      "the proposal that attempt left standing is gone",
    );

    const meta = await log.readMeta();
    const view = foldConversation(meta!.id, meta!.createdAt, (await log.read()).events).view;
    assert.equal(view.status, "open", "and the conversation is where it was — nothing carried");
    assert.equal(
      view.candidates.find((c) => c.id === proposition.id)?.status,
      "live",
      "sent back, not discarded — nobody changed their mind, a wrap-up refused itself",
    );

    // Idempotent: the failure event stays in the log for good, so the sweep has to find nothing
    // the second time rather than report the same repair at every start for the rest of the world.
    assert.deepEqual((await recoverWrapUps(store, gate, NOW)).repaired, []);
    await store.close();
  });

  /*
   * A leftover that was decided while nothing was recording it.
   *
   * Recording a resolution against the conversation is best-effort by design — a proposal that has
   * been accepted is accepted, and failing that over bookkeeping would undo real work — so the
   * proposal can be gone with the conversation none the wiser. Without a terminal state here the
   * leftovers guard refuses that conversation for good, and the manifest that would say what
   * happened went with the proposal. The world's own change journal is what is left.
   *
   * It is asked one question: did the change land? A discard line says a proposal directory was
   * removed and cannot say by whom — a person deciding and a previous recovery pass returning the
   * leftover write the same line — so what did not land comes back rather than being read as
   * somebody's decision to drop it.
   */
  it("settles a leftover the conversation never learned the fate of", async () => {
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
    const proposition = candidate();
    await withCandidates(log, [proposition]);

    const orphan = await gate.stage({
      kind: "worldbuilding",
      summary: "Bells",
      source: `world-chat:${conversationId}`,
      targets: [
        {
          path: "canon/CANON-902.md",
          content:
            "---\nid: CANON-902\ntype: lore\ntitle: B\nstatus: settled\nintroducedAt: 0\nlinks: []\n---\n\nBody.\n",
        },
      ],
      worldChatOrigins: [
        {
          requestId: "req-stuck",
          conversationId,
          candidateId: proposition.id,
          candidateRevision: 1,
          targetPaths: ["canon/CANON-902.md"],
          fields: ["statement"],
        },
      ],
    });
    await log.append(
      {
        type: "wrapup.failed",
        requestId: "req-stuck",
        safeDetail: "materialise; 1 left staged",
        leftovers: [{ proposalId: orphan.id, candidateIds: [proposition.id] }],
      },
      { at: AT },
    );

    // Removed, and the conversation never told: the append that would have said so is the one
    // this path is allowed to lose.
    await gate.discard(orphan.id);

    const outcome = await recoverWrapUps(store, gate, NOW);
    assert.equal(outcome.repaired[0]!.outcome, "cleaned");

    const meta = await log.readMeta();
    const view = foldConversation(meta!.id, meta!.createdAt, (await log.read()).events).view;
    assert.equal(
      view.candidates.find((c) => c.id === proposition.id)?.status,
      "live",
      "nothing landed, so the proposition is the conversation's again rather than quietly gone",
    );
    assert.deepEqual((await recoverWrapUps(store, gate, NOW)).repaired, [], "and once is enough");
    await store.close();
  });

  /*
   * Accepting commits the change and removes the proposal directory afterwards, so a process that
   * stopped between the two leaves an accepted proposal still staged. Read as a rollback it would
   * be sent back, its propositions returned to live, and the entry it had already written to the
   * world proposed for a second time — a duplicate Canon entry produced by the cleanup.
   */
  it("does not send back a leftover whose change already landed", async () => {
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
    const proposition = candidate();
    await withCandidates(log, [proposition]);

    const body =
      "---\nid: CANON-903\ntype: lore\ntitle: B\nstatus: settled\nintroducedAt: 0\nlinks: []\n---\n\nBody.\n";
    const orphan = await gate.stage({
      kind: "worldbuilding",
      summary: "Bells",
      source: `world-chat:${conversationId}`,
      targets: [{ path: "canon/CANON-903.md", content: body }],
      worldChatOrigins: [
        {
          requestId: "req-stuck",
          conversationId,
          candidateId: proposition.id,
          candidateRevision: 1,
          targetPaths: ["canon/CANON-903.md"],
          fields: ["statement"],
        },
      ],
    });
    await log.append(
      {
        type: "wrapup.failed",
        requestId: "req-stuck",
        safeDetail: "materialise; 1 left staged",
        leftovers: [{ proposalId: orphan.id, candidateIds: [proposition.id] }],
      },
      { at: AT },
    );

    // The commit half of an accept, without the removal that follows it.
    await store.commitUnserialised({
      kind: "worldbuilding",
      source: `world-chat:${conversationId}`,
      proposalId: orphan.id,
      files: [{ path: "canon/CANON-903.md", action: "create", content: body, baseHash: null }],
    });
    assert.ok(
      (await gate.listOpen()).some((p) => p.id === orphan.id),
      "the proposal is still staged, which is the whole shape of this failure",
    );

    await recoverWrapUps(store, gate, NOW);

    const meta = await log.readMeta();
    const view = foldConversation(meta!.id, meta!.createdAt, (await log.read()).events).view;
    assert.equal(
      view.candidates.find((c) => c.id === proposition.id)?.status,
      "accepted",
      "the change is in the world, so the proposition is history and not something to propose again",
    );
    assert.equal(
      (await gate.listOpen()).some((p) => p.id === orphan.id),
      false,
      "and the directory the accept did not get to remove is gone",
    );
    await store.close();
  });
});
