import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  newId,
  type CandidateId,
  type ConversationId,
  type MessageId,
  type WorldChangeCandidate,
} from "@arke-studio/contracts";
import { ProposalManager } from "../../src/gate/proposals.js";
import { evaluateReadiness } from "../../src/world-chat/readiness.js";
import { conversationDir, WorldChatStore } from "../../src/world-chat/store.js";
import { wrapUp, WrapUpError } from "../../src/world-chat/wrapup.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";

/**
 * Turning a conversation into proposals (#70 §11.3).
 *
 * The tests worth their place are the refusals. Wrap-up is the moment a conversation stops being
 * talk, so what it declines to carry — and what it leaves untouched when it cannot finish — is
 * the whole promise that talking changes nothing until you say so.
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
    rationale: "They said so.",
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
      explanation: "Nothing in the world looks like this already.",
    },
    createdAt: AT,
    updatedAt: AT,
    draft: { type: "lore", title: "The bells", statement: "The bells may pass sideways.", links: [] },
    ...over,
  } as WorldChangeCandidate;
}

async function world() {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir);
  const gate = new ProposalManager(store);
  const conversationId = newId("cv") as ConversationId;
  /** The fixture world already ships a staged proposal, so only ours are interesting. */
  const ours = async () => (await gate.listOpen()).filter((p) => p.kind === "worldbuilding");
  const log = new WorldChatStore(conversationDir(dir, conversationId));
  await log.create(conversationId, AT);
  await log.append(
    { type: "conversation.created", title: "the bells", entryContext: { kind: "world" } },
    { at: AT },
  );
  return { dir, store, gate, conversationId, log, ours };
}

/** Put a completed turn carrying these propositions into the log. */
async function withCandidates(
  log: WorldChatStore,
  candidates: WorldChangeCandidate[],
): Promise<number> {
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
  return (await log.read()).events.length;
}

function failsToMaterialise(): WorldChangeCandidate {
  return candidate({
    classification: "relationship.change",
    title: "Bray and somebody who is not here",
    draft: {
      from: { kind: "sheet", sheetId: "bray-half-hitch" },
      to: { kind: "sheet", sheetId: "nobody-at-all" },
      linkAction: "add",
      proseEdits: [
        {
          sheet: { kind: "sheet", sheetId: "nobody-at-all" },
          sectionHeading: "Relationships",
          body: "They have never met.",
          reason: "",
        },
      ],
    },
  } as Partial<WorldChangeCandidate>);
}

describe("what a conversation carries", () => {
  it("makes a proposal from a settled proposition", async () => {
    const w = await world();
    const seq = await withCandidates(w.log, [candidate()]);

    const result = await wrapUp({
      store: w.store,
      gate: w.gate,
      conversationId: w.conversationId,
      requestId: "req-1",
      expectedConversationSeq: seq,
      now: NOW,
    });

    assert.equal(result.proposalIds.length, 1);
    const staged = await w.ours();
    assert.equal(staged.length, 1);
    assert.equal(staged[0]!.kind, "worldbuilding");
    assert.match(staged[0]!.source, /^world-chat:cv_/);
    assert.equal(
      staged[0]!.worldChatOrigins?.[0]?.requestId,
      "req-1",
      "the proposal records which conversation and request produced it",
    );
    await w.store.close();
  });

  it("names what did not carry, rather than counting it", async () => {
    const w = await world();
    const maybe = candidate({ settledness: "tentative", title: "Whether the bells are whale bone" });
    const seq = await withCandidates(w.log, [candidate(), maybe]);

    const result = await wrapUp({
      store: w.store,
      gate: w.gate,
      conversationId: w.conversationId,
      requestId: "req-2",
      expectedConversationSeq: seq,
      now: NOW,
    });

    assert.equal(result.proposalIds.length, 1);
    assert.deepEqual(result.notCarried, [
      {
        candidateId: maybe.id,
        summary: "Whether the bells are whale bone",
        reason: "tentative",
      },
    ]);
    await w.store.close();
  });

  it("keeps a media idea out of the proposals and says it kept it", async () => {
    const w = await world();
    const idea = candidate({
      classification: "media.image-opportunity",
      title: "A picture of the lock",
      draft: {
        target: { kind: "world" },
        purpose: "world-key-art",
        brief: "The lock at slack water.",
        reason: "",
        dependencies: [],
      },
    } as Partial<WorldChangeCandidate>);
    const seq = await withCandidates(w.log, [candidate(), idea]);

    const result = await wrapUp({
      store: w.store,
      gate: w.gate,
      conversationId: w.conversationId,
      requestId: "req-3",
      expectedConversationSeq: seq,
      now: NOW,
    });

    assert.deepEqual(result.mediaIdeaIds, [idea.id], "the idea is retained, not lost and not proposed");
    assert.equal(result.proposalIds.length, 1);
    await w.store.close();
  });

  it("carries an open question as an open thread", async () => {
    const w = await world();
    const thread = candidate({
      classification: "canon.thread",
      settledness: "unresolved",
      title: "Who objects when the bells pass sideways?",
      draft: { title: "Objections", question: "Who objects?", consideredEntryIds: [] },
    } as Partial<WorldChangeCandidate>);
    const seq = await withCandidates(w.log, [thread]);

    const result = await wrapUp({
      store: w.store,
      gate: w.gate,
      conversationId: w.conversationId,
      requestId: "req-4",
      expectedConversationSeq: seq,
      now: NOW,
    });

    assert.equal(result.threadProposalIds.length, 1, "a question becomes a thread, through the gate");
    const staged = await w.ours();
    const content = await readFile(
      join(w.dir, ".proposals", staged[0]!.id, "canon", `${staged[0]!.reservedCanonIds[0]}.md`),
      "utf8",
    );
    assert.match(content, /status: open/, "and it is open, because it asserts nothing");
    await w.store.close();
  });
});

describe("what wrap-up refuses", () => {
  it("refuses when nothing is settled enough", async () => {
    const w = await world();
    const seq = await withCandidates(w.log, [candidate({ settledness: "tentative" })]);

    await assert.rejects(
      () =>
        wrapUp({
          store: w.store,
          gate: w.gate,
          conversationId: w.conversationId,
          requestId: "req-5",
          expectedConversationSeq: seq,
          now: NOW,
        }),
      (err: unknown) => err instanceof WrapUpError && err.reason === "nothing-to-carry",
    );
    assert.deepEqual(await w.ours(), [], "and stages nothing");
    await w.store.close();
  });

  it("refuses a conversation that moved on while it was being read", async () => {
    const w = await world();
    const seq = await withCandidates(w.log, [candidate()]);

    await assert.rejects(
      () =>
        wrapUp({
          store: w.store,
          gate: w.gate,
          conversationId: w.conversationId,
          requestId: "req-6",
          expectedConversationSeq: seq - 1,
          now: NOW,
        }),
      (err: unknown) => err instanceof WrapUpError && err.reason === "stale",
    );
    await w.store.close();
  });

  it("leaves no proposal behind when a change cannot be written", async () => {
    const w = await world();
    // Passes readiness — a relationship change has no `target` field for readiness to check —
    // and fails at materialisation, which is the path this test is about.
    const seq = await withCandidates(w.log, [candidate(), failsToMaterialise()]);

    await assert.rejects(
      () =>
        wrapUp({
          store: w.store,
          gate: w.gate,
          conversationId: w.conversationId,
          requestId: "req-7",
          expectedConversationSeq: seq,
          now: NOW,
        }),
      (err: unknown) => err instanceof WrapUpError,
    );

    assert.deepEqual(
      await w.ours(),
      [],
      "a proposal nobody can accept is worse than no proposal",
    );
    await w.store.close();
  });

  it("records the failure on the conversation and leaves it open", async () => {
    const w = await world();
    const seq = await withCandidates(w.log, [candidate(), failsToMaterialise()]);

    await wrapUp({
      store: w.store,
      gate: w.gate,
      conversationId: w.conversationId,
      requestId: "req-8",
      expectedConversationSeq: seq,
      now: NOW,
    }).catch(() => {});

    const { events } = await w.log.read();
    assert.ok(events.some((e) => e.event.type === "wrapup.failed"), "the attempt is recorded");
    assert.ok(
      !events.some((e) => e.event.type === "wrapup.completed"),
      "and the conversation is not closed — there is no half-closed state",
    );
    await w.store.close();
  });
});

describe("readiness on its own", () => {
  const bundle = { canon: [], sheets: [] } as never;

  it("holds back a proposition with no intent evidence", () => {
    const bare = candidate({ evidence: [] });
    const { carried, notCarried } = evaluateReadiness([bare], bundle);
    assert.deepEqual(carried, []);
    assert.equal(notCarried[0]!.reason, "invalid");
  });

  it("holds back an undecided proposition", () => {
    const undecided = candidate({
      classification: "undecided",
      draft: { question: "which?", plausibleActions: [], possibleTargets: [] },
    } as Partial<WorldChangeCandidate>);
    assert.equal(evaluateReadiness([undecided], bundle).notCarried[0]!.reason, "undecided");
  });

  it("ignores propositions that are not live", () => {
    const withdrawn = candidate({ status: "withdrawn" });
    const { carried, notCarried } = evaluateReadiness([withdrawn], bundle);
    assert.deepEqual(carried, []);
    assert.deepEqual(notCarried, [], "a retracted idea is history, not something that failed to carry");
  });

  it("lets a partial check through only when the user has overridden it", () => {
    const partial = candidate();
    partial.checks = { ...partial.checks, state: "partial" };
    assert.equal(evaluateReadiness([partial], bundle).notCarried[0]!.reason, "invalid");

    const overridden = candidate();
    overridden.checks = {
      ...overridden.checks,
      state: "partial",
      userOverride: { at: AT, reason: "create-anyway" },
    };
    assert.equal(evaluateReadiness([overridden], bundle).carried.length, 1);
  });
});
