import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { newId, type WorldChangeCandidate, type WorldChatStoredEvent } from "@arke-studio/contracts";
import { WorldChatStore } from "../../src/world-chat/store.js";
import { foldConversation, summarise } from "../../src/world-chat/fold.js";
import {
  checkpointPath,
  clearCheckpoint,
  readCheckpoint,
  writeCheckpoint,
} from "../../src/world-chat/checkpoint.js";
import { tempDir } from "../tmp.js";

/**
 * The fold turns a log into a workspace, and the checkpoint only ever makes that faster (#70
 * §7.2, §4.2). These lean on the invariants that would otherwise decay quietly: revisions moving
 * one at a time, a proposal resolving once, and an accelerator never being believed over the log.
 */

const AT = "2026-08-06T09:00:00Z";
const CV = newId("cv");

function turn(text: string, candidates: WorldChangeCandidate[] = []): WorldChatStoredEvent {
  const turnId = newId("turn");
  const runId = newId("run");
  const run = {
    id: runId,
    turnId,
    basedOnConversationSeq: 0,
    status: "completed" as const,
    adapter: "opencode",
    harnessCleanup: "not-required" as const,
    contextDigest: `sha256:${"a".repeat(64)}`,
    startedAt: AT,
    endedAt: AT,
  };
  return {
    type: "turn.completed",
    message: { id: newId("msg"), turnId, role: "studio", text, attachmentIds: [], createdAt: AT },
    run,
    receipts: [],
    candidates,
    groups: [],
    tombstones: [],
  };
}

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

async function store(): Promise<WorldChatStore> {
  const dir = await tempDir("arke-fold-");
  const s = new WorldChatStore(join(dir, CV));
  await s.create(CV, AT);
  return s;
}

describe("world chat fold", () => {
  it("shows the current value of a proposition, not the history of it", async () => {
    const s = await store();
    const id = newId("cand");
    await s.append(
      { type: "conversation.created", title: "The bells", entryContext: { kind: "world" } },
      { at: AT },
    );
    await s.append(turn("first", [candidate(id, 1, "her mother taught her")]), { at: AT });
    await s.append(turn("corrected", [candidate(id, 2, "her aunt taught her")]), { at: AT });

    const { events } = await s.read();
    const { view, problems } = foldConversation(CV, AT, events);
    assert.equal(view.candidates.length, 1, "one proposition, not two contradicting each other");
    assert.equal(view.candidates[0]!.title, "her aunt taught her");
    assert.equal(view.candidates[0]!.revision, 2);
    assert.equal(problems.length, 0);
  });

  it("names a revision that skipped, and still shows the newer value", async () => {
    const s = await store();
    const id = newId("cand");
    await s.append(turn("first", [candidate(id, 1, "one")]), { at: AT });
    await s.append(turn("skipped", [candidate(id, 4, "four")]), { at: AT });

    const { events } = await s.read();
    const { view, problems } = foldConversation(CV, AT, events);
    assert.equal(problems.length, 1);
    assert.match(problems[0]!.detail, /jumped from revision 1 to 4/);
    assert.equal(view.candidates[0]!.title, "four", "the newer snapshot is still the better guess");
  });

  it("folds a run left running into interrupted, and asks to be repaired once", async () => {
    const s = await store();
    const turnId = newId("turn");
    await s.append(
      {
        type: "turn.started",
        message: {
          id: newId("msg"),
          turnId,
          role: "user",
          text: "mid-turn",
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

    const { events } = await s.read();
    const folded = foldConversation(CV, AT, events);
    assert.equal(
      folded.view.activeRun?.status,
      "interrupted",
      "nothing renders a spinner that will never stop",
    );
    assert.equal(folded.needsInterruptedRunRepair, true, "and the caller is told to make that durable");
  });

  it("resolves a proposal once, however many times reconciliation runs", async () => {
    const s = await store();
    const id = newId("cand");
    const proposalId = newId("pr");
    await s.append(turn("drafted", [candidate(id, 1, "a rule")]), { at: AT });
    await s.append(
      { type: "proposal.resolved", proposalId, outcome: "accepted", candidateIds: [id] },
      { at: AT },
    );
    // Startup recovery re-reconciling the same proposal must not undo anything.
    await s.append(
      { type: "proposal.resolved", proposalId, outcome: "discarded", candidateIds: [id] },
      { at: AT },
    );

    const { events } = await s.read();
    const { view } = foldConversation(CV, AT, events);
    assert.equal(view.candidates[0]!.status, "accepted", "the first resolution stands");
  });

  it("keeps a wrap-up that never completed from looking closed", async () => {
    const s = await store();
    await s.append(
      { type: "wrapup.intent-recorded", requestId: "r1", expectedConversationSeq: 0, plannedProposalIds: [] },
      { at: AT },
    );
    const { events } = await s.read();
    assert.equal(foldConversation(CV, AT, events).view.status, "open", "an intent is not an outcome");
  });

  it("reopens on a send-back and puts the proposition back in play", async () => {
    const s = await store();
    const id = newId("cand");
    const proposalId = newId("pr");
    await s.append(turn("drafted", [candidate(id, 1, "a rule")]), { at: AT });
    await s.append(
      {
        type: "wrapup.completed",
        requestId: "r1",
        proposalIds: [proposalId],
        notCarried: [],
        mediaIdeaIds: [],
      },
      { at: AT },
    );
    await s.append({ type: "conversation.reopened", proposalId, restoredCandidateIds: [id] }, { at: AT });

    const { events } = await s.read();
    const folded = foldConversation(CV, AT, events);
    assert.equal(folded.view.status, "open");
    assert.equal(folded.view.candidates[0]!.status, "live");
    assert.equal(folded.view.reopened, true);
    assert.equal(summarise(folded.view).reopened, true);
  });

  it("counts only live propositions on the summary row", async () => {
    const s = await store();
    const live = newId("cand");
    const gone = newId("cand");
    await s.append(
      { type: "conversation.created", title: "The bells", entryContext: { kind: "world" } },
      { at: AT },
    );
    await s.append(turn("two", [candidate(live, 1, "kept"), candidate(gone, 1, "dropped")]), { at: AT });
    await s.append(
      { type: "candidate.status-changed", candidateId: gone, revision: 1, status: "withdrawn" },
      { at: AT },
    );

    const { events } = await s.read();
    const folded = foldConversation(CV, AT, events);
    assert.equal(summarise(folded.view).pointCount, 1);
  });
});

describe("world chat checkpoint", () => {
  it("rebuilds the same view after the checkpoint is deleted", async () => {
    const s = await store();
    await s.append(
      { type: "conversation.created", title: "The bells", entryContext: { kind: "world" } },
      { at: AT },
    );
    await s.append(turn("said", [candidate(newId("cand"), 1, "a rule")]), { at: AT });

    const { events } = await s.read();
    const { view } = foldConversation(CV, AT, events);
    await writeCheckpoint(s.dir, view);

    const saved = await readCheckpoint(s.dir, view.seq);
    assert.deepEqual(saved.checkpoint?.view, view);

    await clearCheckpoint(s.dir);
    const gone = await readCheckpoint(s.dir, view.seq);
    assert.equal(gone.checkpoint, null, "absent is ordinary");
    assert.equal(gone.problems.length, 0, "and not worth reporting as a problem");

    const rebuilt = foldConversation(CV, AT, (await s.read()).events).view;
    assert.deepEqual(rebuilt, view, "deleting it costs a fold, never data");
  });

  it("distrusts a checkpoint that runs past the end of the log", async () => {
    const s = await store();
    await s.append(turn("one"), { at: AT });
    const { view } = foldConversation(CV, AT, (await s.read()).events);
    await writeCheckpoint(s.dir, { ...view, seq: 99 });

    // A checkpoint describing events the log no longer has is exactly what a torn write leaves.
    const read = await readCheckpoint(s.dir, view.seq);
    assert.equal(read.checkpoint, null);
    assert.equal(read.problems[0]?.kind, "checkpoint-invalid");
    assert.match(read.problems[0]!.detail, /rebuilt from the log/);
  });

  it("falls back to the log when the checkpoint will not parse", async () => {
    const s = await store();
    await s.append(turn("one"), { at: AT });
    await writeFile(checkpointPath(s.dir), "{ this is not json", "utf8");

    const read = await readCheckpoint(s.dir, 1);
    assert.equal(read.checkpoint, null);
    assert.equal(read.problems[0]?.kind, "checkpoint-invalid");
  });

  it("leaves the previous checkpoint whole rather than half-written", async () => {
    const s = await store();
    await s.append(turn("one"), { at: AT });
    const first = foldConversation(CV, AT, (await s.read()).events).view;
    await writeCheckpoint(s.dir, first);

    await s.append(turn("two"), { at: AT });
    const second = foldConversation(CV, AT, (await s.read()).events).view;
    await writeCheckpoint(s.dir, second);

    const raw = await readFile(checkpointPath(s.dir), "utf8");
    assert.doesNotThrow(() => JSON.parse(raw), "an atomic rename never leaves a partial file");
    assert.equal((await readCheckpoint(s.dir, second.seq)).checkpoint?.throughSeq, second.seq);
  });
});
