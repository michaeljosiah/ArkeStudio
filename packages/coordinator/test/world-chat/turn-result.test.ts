import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  newId,
  type CandidateChecks,
  type CandidateId,
  type CandidateTombstone,
  type ConversationId,
  type MessageId,
  type ModelCandidateDraft,
  type TurnId,
  type WorldBundle,
  type WorldChangeCandidate,
  type WorldChatCheckReceipt,
  type WorldChatMessage,
  type WorldChatTurnResult,
} from "@arke-studio/contracts";
import { payloadDigest, structuralKey, suppressedByTombstone } from "../../src/world-chat/identity.js";
import { contentHash } from "../../src/world-chat/observations.js";
import {
  correctiveMessage,
  parseTurnResult,
  validateTurnResult,
  type ValidateInput,
} from "../../src/world-chat/turn-result.js";
import { scanWorld } from "../../src/world/scan.js";
import { FIXTURE_WORLD } from "../world/helpers.js";

/**
 * One model message becoming propositions, or nothing (#70 §8.3, §8.4).
 *
 * The load-bearing tests here are all-or-nothing, evidence verification, and the tombstone. Those
 * three are what stop the panel describing work that does not exist, reasons that were never
 * given, and ideas the user already said to forget.
 */

const AT = "2026-08-06T10:00:00Z";
const NOW = () => AT;

const USER_TEXT = "Her aunt raised her, not her mother. And the bells only ring at slack water.";

function userMessage(): WorldChatMessage {
  return {
    id: newId("msg") as MessageId,
    turnId: newId("turn") as TurnId,
    role: "user",
    text: USER_TEXT,
    attachmentIds: [],
    createdAt: AT,
  };
}

function completeChecks(): CandidateChecks {
  return {
    state: "complete",
    basedOnCanonRevision: 42,
    required: ["canon-search"],
    completed: ["canon-search"],
    consulted: [],
    likelyDuplicates: [],
    possibleAmendments: [],
    contradictionCandidates: [],
    explanation: "Nothing in the world looks like this already.",
  };
}

/** Evidence quoting the real user message at real offsets. */
function intentEvidence(message: WorldChatMessage, quote: string) {
  const start = message.text.indexOf(quote);
  return [
    {
      kind: "message" as const,
      messageId: message.id,
      quote,
      start,
      end: start + quote.length,
      purpose: "intent" as const,
    },
  ];
}

function canonCreateDraft(message: WorldChatMessage, quote = "Her aunt raised her"): ModelCandidateDraft {
  return {
    classification: "canon.create",
    title: "Maren was raised by her aunt",
    rationale: "Stated directly.",
    settledness: "settled",
    evidence: intentEvidence(message, quote),
    checkReceiptIds: [],
    draft: {
      type: "lore",
      title: "Maren's upbringing",
      statement: "Maren Kest was raised by her aunt.",
      links: [],
    },
  };
}

function mediaDraft(
  message: WorldChatMessage,
  target: { kind: "shot"; productionId: string; sceneId: string; shotId: string },
): ModelCandidateDraft {
  return {
    classification: "media.image-opportunity",
    title: `Video for ${target.shotId}`,
    rationale: "The beat needs movement.",
    settledness: "tentative",
    evidence: intentEvidence(message, "the bells only ring at slack water"),
    checkReceiptIds: [],
    draft: {
      medium: "video",
      target,
      purpose: "shot-video",
      brief: `The bells rise under ${target.shotId}.`,
      reason: "The action is visual.",
      dependencies: [],
    },
  };
}

async function baseInput(overrides: Partial<ValidateInput> = {}): Promise<ValidateInput & { message: WorldChatMessage }> {
  const message = overrides.messages?.[0] ?? userMessage();
  const bundle: WorldBundle = (await scanWorld(FIXTURE_WORLD)).bundle;
  return {
    raw: "{}",
    conversationId: newId("cv") as ConversationId,
    messages: [message],
    existing: [],
    groups: [],
    tombstones: [],
    receiptsThisRun: [],
    evidenceSources: { messages: [message], bundle, attachments: [], attachmentText: new Map() },
    checksFor: () => completeChecks(),
    now: NOW,
    ...overrides,
    message,
  } as ValidateInput & { message: WorldChatMessage };
}

function turn(result: Partial<WorldChatTurnResult>): string {
  return JSON.stringify({ reply: "Noted.", candidateOperations: [], groupOperations: [], ...result });
}

describe("parsing a turn result", () => {
  it("refuses a message that is not JSON", () => {
    const parsed = parseTurnResult("I've noted that for you!");
    assert.equal(parsed.ok, false);
    assert.equal(parsed.ok === false && parsed.problems[0]!.code, "not-json");
  });

  it("refuses unrecognised fields rather than ignoring them", () => {
    const parsed = parseTurnResult(
      JSON.stringify({ reply: "hi", candidateOperations: [], groupOperations: [], extra: true }),
    );
    assert.equal(parsed.ok, false);
  });

  it("refuses more operations than one turn may carry", () => {
    const op = {
      op: "create",
      temporaryId: "t",
      candidate: { classification: "undecided", title: "t", rationale: "", settledness: "tentative", evidence: [], checkReceiptIds: [], draft: { question: "?", plausibleActions: [], possibleTargets: [] } },
    };
    const parsed = parseTurnResult(
      JSON.stringify({ reply: "hi", candidateOperations: Array.from({ length: 13 }, () => op), groupOperations: [] }),
    );
    assert.equal(parsed.ok, false);
  });

  it("names the fields at fault without echoing their values", () => {
    const parsed = parseTurnResult(JSON.stringify({ reply: 42, candidateOperations: [], groupOperations: [] }));
    assert.equal(parsed.ok, false);
    const message = parsed.ok === false ? parsed.problems[0]!.safeMessage : "";
    assert.match(message, /reply/);
    assert.ok(!message.includes("42"), "the offending value is not echoed back");
  });
});

describe("accepting a turn", () => {
  it("creates a proposition the coordinator owns the identity of", async () => {
    const input = await baseInput();
    const outcome = validateTurnResult({
      ...input,
      raw: turn({
        reply: "Noted her aunt.",
        candidateOperations: [{ op: "create", temporaryId: "t1", candidate: canonCreateDraft(input.message) }],
      }),
    });

    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    const candidate = outcome.turn.candidates[0]!;
    assert.match(candidate.id, /^cand_/, "the coordinator issued the id, not the model");
    assert.equal(candidate.revision, 1);
    assert.equal(candidate.status, "live");
    assert.deepEqual(candidate.sourceMessageIds, [input.message.id]);
    assert.equal(candidate.checks.state, "complete", "checks come from the coordinator's plan");
  });

  it("applies a correction as a new snapshot of the same proposition", async () => {
    const first = await baseInput();
    const created = validateTurnResult({
      ...first,
      raw: turn({ candidateOperations: [{ op: "create", temporaryId: "t1", candidate: canonCreateDraft(first.message) }] }),
    });
    assert.ok(created.ok);
    const existing = created.turn.candidates[0]!;

    const corrected = canonCreateDraft(first.message);
    corrected.draft = { ...corrected.draft, statement: "Maren Kest was raised by her great-aunt." } as never;

    const outcome = validateTurnResult({
      ...(await baseInput({ messages: [first.message], existing: [existing] })),
      raw: turn({
        candidateOperations: [
          { op: "update", candidateId: existing.id, expectedRevision: 1, candidate: corrected },
        ],
      }),
    });

    assert.ok(outcome.ok);
    const updated = outcome.turn.candidates[0]!;
    assert.equal(updated.id, existing.id, "the same proposition, corrected");
    assert.equal(updated.revision, 2);
    assert.equal(updated.createdAt, existing.createdAt, "and it keeps when it first appeared");
  });

  it("treats a re-proposed idea as the same proposition, not a second card", async () => {
    const input = await baseInput();
    const created = validateTurnResult({
      ...input,
      raw: turn({ candidateOperations: [{ op: "create", temporaryId: "t1", candidate: canonCreateDraft(input.message) }] }),
    });
    assert.ok(created.ok);
    const existing = created.turn.candidates[0]!;

    const outcome = validateTurnResult({
      ...(await baseInput({ messages: [input.message], existing: [existing] })),
      raw: turn({ candidateOperations: [{ op: "create", temporaryId: "t2", candidate: canonCreateDraft(input.message) }] }),
    });

    assert.ok(outcome.ok);
    assert.equal(outcome.turn.candidates.length, 1);
    assert.equal(outcome.turn.candidates[0]!.id, existing.id);
    assert.equal(outcome.turn.candidates[0]!.revision, 2, "it updated rather than duplicated");
  });

  it("keeps media for different shots as different propositions", async () => {
    const input = await baseInput();
    const first = mediaDraft(input.message, {
      kind: "shot",
      productionId: "saltlight",
      sceneId: "sc_04",
      shotId: "sh_12",
    });
    const created = validateTurnResult({
      ...input,
      raw: turn({ candidateOperations: [{ op: "create", temporaryId: "t1", candidate: first }] }),
    });
    assert.ok(created.ok);
    const second = mediaDraft(input.message, {
      kind: "shot",
      productionId: "saltlight",
      sceneId: "sc_04",
      shotId: "sh_13",
    });
    const outcome = validateTurnResult({
      ...(await baseInput({ messages: [input.message], existing: created.turn.candidates })),
      raw: turn({ candidateOperations: [{ op: "create", temporaryId: "t2", candidate: second }] }),
    });
    assert.ok(outcome.ok);
    const existing = created.turn.candidates[0]!;
    const added = outcome.turn.candidates[0]!;
    assert.notEqual(added.id, existing.id, "the second shot receives its own proposition");
    assert.notEqual(structuralKey(added), structuralKey(existing));
  });
});

describe("rejecting a turn", () => {
  it("rejects everything when one piece of evidence does not verify", async () => {
    const input = await baseInput();
    const good = canonCreateDraft(input.message);
    const bad = canonCreateDraft(input.message);
    bad.evidence = [
      { kind: "message", messageId: input.message.id, quote: "she never mentioned an aunt", start: 0, end: 26, purpose: "intent" },
    ];

    const outcome = validateTurnResult({
      ...input,
      raw: turn({
        reply: "I noted both.",
        candidateOperations: [
          { op: "create", temporaryId: "t1", candidate: good },
          { op: "create", temporaryId: "t2", candidate: bad },
        ],
      }),
    });

    assert.equal(outcome.ok, false, "a reply that refers to propositions which did not persist is the thing to avoid");
    if (outcome.ok) return;
    assert.ok(outcome.problems.some((p) => p.code === "message-span-mismatch"));
  });

  it("rejects evidence citing a message that is not in the conversation", async () => {
    const input = await baseInput();
    const draft = canonCreateDraft(input.message);
    draft.evidence = [
      { kind: "message", messageId: newId("msg") as MessageId, quote: "anything", start: 0, end: 8, purpose: "intent" },
    ];
    const outcome = validateTurnResult({
      ...input,
      raw: turn({ candidateOperations: [{ op: "create", temporaryId: "t1", candidate: draft }] }),
    });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.ok(outcome.problems.some((p) => p.code === "message-missing"));
  });

  it("requires a proposition to say what it is based on", async () => {
    const input = await baseInput();
    const draft = canonCreateDraft(input.message);
    draft.evidence = [];
    const outcome = validateTurnResult({
      ...input,
      raw: turn({ candidateOperations: [{ op: "create", temporaryId: "t1", candidate: draft }] }),
    });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.ok(outcome.problems.some((p) => p.code === "no-evidence"));
  });

  it("refuses a check the model did not actually make this turn", async () => {
    const input = await baseInput();
    const draft = canonCreateDraft(input.message);
    draft.checkReceiptIds = [newId("check") as WorldChatCheckReceipt["id"]];
    const outcome = validateTurnResult({
      ...input,
      raw: turn({ candidateOperations: [{ op: "create", temporaryId: "t1", candidate: draft }] }),
    });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.ok(outcome.problems.some((p) => p.code === "foreign-receipt"));
  });

  it("stores only cited final-page target receipts as whole-target evidence", async () => {
    const input = await baseInput();
    const complete: WorldChatCheckReceipt = {
      id: newId("check"),
      runId: newId("run"),
      tool: "target-read",
      status: "complete",
      consulted: [],
      target: { requirement: "scenes", id: "saltlight:sc_04:script" },
      observedRevisionOrDigest: `v1:sha256:${"a".repeat(64)}`,
      complete: true,
      nextCursor: null,
      at: AT,
    };
    const partial: WorldChatCheckReceipt = {
      ...complete,
      id: newId("check"),
      complete: false,
      nextCursor: "more-pages",
    };
    const draft = canonCreateDraft(input.message);
    draft.checkReceiptIds = [partial.id, complete.id];
    const outcome = validateTurnResult({
      ...input,
      receiptsThisRun: [partial, complete],
      raw: turn({ candidateOperations: [{ op: "create", temporaryId: "t1", candidate: draft }] }),
    });

    assert.ok(outcome.ok);
    assert.deepEqual(outcome.turn.candidates[0]!.checks.targetReads, [{
      checkId: complete.id,
      target: complete.target,
      observedRevisionOrDigest: complete.observedRevisionOrDigest,
    }]);
  });

  it("refuses an operation based on an out-of-date proposition", async () => {
    const input = await baseInput();
    const created = validateTurnResult({
      ...input,
      raw: turn({ candidateOperations: [{ op: "create", temporaryId: "t1", candidate: canonCreateDraft(input.message) }] }),
    });
    assert.ok(created.ok);
    const existing = { ...created.turn.candidates[0]!, revision: 3 };

    const outcome = validateTurnResult({
      ...(await baseInput({ messages: [input.message], existing: [existing] })),
      raw: turn({
        candidateOperations: [
          { op: "update", candidateId: existing.id, expectedRevision: 1, candidate: canonCreateDraft(input.message) },
        ],
      }),
    });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.ok(outcome.problems.some((p) => p.code === "stale-revision"));
  });

  it("refuses to change a proposition already carried into a proposal", async () => {
    const input = await baseInput();
    const created = validateTurnResult({
      ...input,
      raw: turn({ candidateOperations: [{ op: "create", temporaryId: "t1", candidate: canonCreateDraft(input.message) }] }),
    });
    assert.ok(created.ok);
    const accepted: WorldChangeCandidate = { ...created.turn.candidates[0]!, status: "accepted" };

    const outcome = validateTurnResult({
      ...(await baseInput({ messages: [input.message], existing: [accepted] })),
      raw: turn({
        candidateOperations: [
          { op: "update", candidateId: accepted.id, expectedRevision: 1, candidate: canonCreateDraft(input.message) },
        ],
      }),
    });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.ok(outcome.problems.some((p) => p.code === "immutable-candidate"));
  });

  it("names every fault at once, because there is only one corrective turn", async () => {
    const input = await baseInput();
    const draft = canonCreateDraft(input.message);
    draft.evidence = [];
    draft.checkReceiptIds = [newId("check") as WorldChatCheckReceipt["id"]];

    const outcome = validateTurnResult({
      ...input,
      raw: turn({ candidateOperations: [{ op: "create", temporaryId: "t1", candidate: draft }] }),
    });
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.ok(outcome.problems.length >= 2);
    const message = correctiveMessage(outcome.problems);
    assert.match(message, /Return the complete result again/);
    assert.ok(!message.includes(USER_TEXT), "the corrective turn carries no conversation content");
  });
});

describe("retraction and resurfacing", () => {
  it("still suppresses an image tombstone written before medium existed", async () => {
    const input = await baseInput();
    const draft: ModelCandidateDraft = {
      classification: "media.image-opportunity",
      title: "Maren at the bells",
      rationale: "The moment wants a still.",
      settledness: "tentative",
      evidence: intentEvidence(input.message, "the bells only ring at slack water"),
      checkReceiptIds: [],
      draft: {
        medium: "image",
        target: { kind: "sheet", sheetKind: "character", sheetId: "maren-kest" },
        purpose: "character-look",
        brief: "maren at the bells",
        reason: "the moment wants a still",
        dependencies: [],
      },
    };
    const legacyDigest = contentHash({
      key: "media.image-opportunity|sheet:maren-kest|character-look",
      draft: {
        brief: "maren at the bells",
        dependencies: [],
        purpose: "character-look",
        reason: "the moment wants a still",
        target: { kind: "sheet", sheetId: "maren-kest", sheetKind: "character" },
      },
      settledness: "tentative",
    });
    const tombstone: CandidateTombstone = {
      candidateId: newId("cand") as CandidateId,
      revision: 1,
      structuralKey: "media.image-opportunity|sheet:maren-kest|character-look",
      payloadDigest: legacyDigest,
      retractedByMessageId: input.message.id,
      at: AT,
    };
    assert.equal(payloadDigest(draft), legacyDigest, "the new parser preserves the old image digest");
    assert.equal(suppressedByTombstone(draft, [tombstone]), tombstone);
  });

  it("withdraws a proposition and remembers the claim", async () => {
    const input = await baseInput();
    const created = validateTurnResult({
      ...input,
      raw: turn({ candidateOperations: [{ op: "create", temporaryId: "t1", candidate: canonCreateDraft(input.message) }] }),
    });
    assert.ok(created.ok);
    const existing = created.turn.candidates[0]!;

    const outcome = validateTurnResult({
      ...(await baseInput({ messages: [input.message], existing: [existing] })),
      raw: turn({
        candidateOperations: [
          { op: "withdraw", candidateId: existing.id, expectedRevision: 1, reason: "the user said to forget it" },
        ],
      }),
    });

    assert.ok(outcome.ok);
    assert.equal(outcome.turn.candidates[0]!.status, "withdrawn");
    const tombstone = outcome.turn.tombstones[0]!;
    assert.equal(tombstone.candidateId, existing.id);
    assert.equal(tombstone.retractedByMessageId, input.message.id);
    assert.equal(tombstone.structuralKey, structuralKey(existing));
  });

  it("does not let the same idea come back next turn just because it is still in context", async () => {
    const input = await baseInput();
    const draft = canonCreateDraft(input.message);
    const tombstone: CandidateTombstone = {
      candidateId: newId("cand") as CandidateId,
      revision: 1,
      structuralKey: structuralKey(draft),
      payloadDigest: payloadDigest(draft),
      retractedByMessageId: input.message.id,
      at: AT,
    };

    const outcome = validateTurnResult({
      ...(await baseInput({ messages: [input.message], tombstones: [tombstone] })),
      raw: turn({ candidateOperations: [{ op: "create", temporaryId: "t1", candidate: draft }] }),
    });

    assert.ok(outcome.ok);
    assert.deepEqual(outcome.turn.candidates, [], "'forget that' does not mean 'until the next message'");
  });

  it("lets it back when the user materially changes it", async () => {
    const input = await baseInput();
    const original = canonCreateDraft(input.message);
    const tombstone: CandidateTombstone = {
      candidateId: newId("cand") as CandidateId,
      revision: 1,
      structuralKey: structuralKey(original),
      payloadDigest: payloadDigest(original),
      retractedByMessageId: input.message.id,
      at: AT,
    };

    const changed = canonCreateDraft(input.message);
    changed.draft = { ...changed.draft, statement: "Maren Kest was raised by the Ebb Council." } as never;

    const outcome = validateTurnResult({
      ...(await baseInput({ messages: [input.message], tombstones: [tombstone] })),
      raw: turn({ candidateOperations: [{ op: "create", temporaryId: "t1", candidate: changed }] }),
    });

    assert.ok(outcome.ok);
    assert.equal(outcome.turn.candidates.length, 1, "a different claim is not the retracted one");
  });

  it("ignores capitalisation and spacing when deciding whether it is the same claim", async () => {
    const input = await baseInput();
    const original = canonCreateDraft(input.message);
    const tombstone: CandidateTombstone = {
      candidateId: newId("cand") as CandidateId,
      revision: 1,
      structuralKey: structuralKey(original),
      payloadDigest: payloadDigest(original),
      retractedByMessageId: input.message.id,
      at: AT,
    };

    const reworded = canonCreateDraft(input.message);
    reworded.draft = { ...reworded.draft, statement: "  MAREN KEST   was raised by her aunt.  " } as never;

    const outcome = validateTurnResult({
      ...(await baseInput({ messages: [input.message], tombstones: [tombstone] })),
      raw: turn({ candidateOperations: [{ op: "create", temporaryId: "t1", candidate: reworded }] }),
    });

    assert.ok(outcome.ok);
    assert.deepEqual(outcome.turn.candidates, [], "a re-render is not a change of mind");
  });
});

describe("splitting a proposition", () => {
  it("supersedes the original and records where the pieces came from", async () => {
    const input = await baseInput();
    const created = validateTurnResult({
      ...input,
      raw: turn({ candidateOperations: [{ op: "create", temporaryId: "t1", candidate: canonCreateDraft(input.message) }] }),
    });
    assert.ok(created.ok);
    const existing = created.turn.candidates[0]!;

    const bells = canonCreateDraft(input.message, "the bells only ring at slack water");
    const outcome = validateTurnResult({
      ...(await baseInput({ messages: [input.message], existing: [existing] })),
      raw: turn({
        candidateOperations: [
          {
            op: "split",
            candidateId: existing.id,
            expectedRevision: 1,
            replacements: [canonCreateDraft(input.message), bells],
          },
        ],
      }),
    });

    assert.ok(outcome.ok);
    const superseded = outcome.turn.candidates.find((c) => c.id === existing.id)!;
    assert.equal(superseded.status, "superseded");
    const pieces = outcome.turn.candidates.filter((c) => c.id !== existing.id);
    assert.equal(pieces.length, 2);
    for (const piece of pieces) assert.equal(piece.splitFrom, existing.id);
  });
});

describe("groups", () => {
  it("builds a group the coordinator has validated every member of", async () => {
    const input = await baseInput();
    const bells = canonCreateDraft(input.message, "the bells only ring at slack water");
    bells.draft = { ...bells.draft, title: "The bells at slack water" } as never;

    const outcome = validateTurnResult({
      ...input,
      raw: turn({
        candidateOperations: [
          { op: "create", temporaryId: "t1", candidate: canonCreateDraft(input.message) },
          { op: "create", temporaryId: "t2", candidate: bells },
        ],
        groupOperations: [
          {
            op: "create",
            temporaryId: "g1",
            title: "Maren's household",
            rationale: "These only make sense together.",
            members: [{ temporaryId: "t1" }, { temporaryId: "t2" }],
          },
        ],
      }),
    });

    assert.ok(outcome.ok);
    const group = outcome.turn.groups[0]!;
    assert.match(group.id, /^grp_/);
    assert.equal(group.atomic, true);
    assert.equal(group.members.length, 2);
    for (const member of group.members) {
      const bound: WorldChangeCandidate | undefined = outcome.turn.candidates.find((c) => c.id === member.candidateId);
      assert.ok(bound);
      assert.equal(bound.groupId, group.id, "the candidate snapshot binds the atomic membership");
    }
  });

  it("versions an existing proposition when new atomic membership is bound", async () => {
    const input = await baseInput();
    const first = validateTurnResult({
      ...input,
      raw: turn({ candidateOperations: [{ op: "create", temporaryId: "old", candidate: canonCreateDraft(input.message) }] }),
    });
    assert.ok(first.ok);
    const existing = first.turn.candidates[0]!;
    const bells = canonCreateDraft(input.message, "the bells only ring at slack water");
    bells.draft = { ...bells.draft, title: "The bells at slack water" } as never;

    const outcome = validateTurnResult({
      ...(await baseInput({ messages: [input.message], existing: [existing] })),
      raw: turn({
        candidateOperations: [{ op: "create", temporaryId: "new", candidate: bells }],
        groupOperations: [{
          op: "create",
          temporaryId: "group",
          title: "Maren's household",
          rationale: "These only make sense together.",
          members: [{ candidateId: existing.id, revision: existing.revision }, { temporaryId: "new" }],
        }],
      }),
    });

    assert.ok(outcome.ok);
    const group = outcome.turn.groups[0]!;
    const rebound = outcome.turn.candidates.find((candidate) => candidate.id === existing.id)!;
    assert.equal(rebound.revision, existing.revision + 1);
    assert.equal(rebound.groupId, group.id);
    assert.equal(group.members.find((member) => member.candidateId === existing.id)!.revision, rebound.revision);
  });

  it("refuses a group naming a proposition that does not exist", async () => {
    const input = await baseInput();
    const outcome = validateTurnResult({
      ...input,
      raw: turn({
        candidateOperations: [{ op: "create", temporaryId: "t1", candidate: canonCreateDraft(input.message) }],
        groupOperations: [
          {
            op: "create",
            temporaryId: "g1",
            title: "Group",
            rationale: "",
            members: [{ temporaryId: "t1" }, { temporaryId: "nope" }],
          },
        ],
      }),
    });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.ok(outcome.problems.some((p) => p.code === "unknown-group-member"));
  });
});

describe("same-turn entity references", () => {
  it("resolves a grouped temporary reference even when it points at a later create", async () => {
    const input = await baseInput();
    const first = canonCreateDraft(input.message) as Extract<ModelCandidateDraft, { classification: "canon.create" }>;
    first.draft.links = [{ kind: "pending-entity", ref: { temporaryId: "t2" } }] as never;
    const second = canonCreateDraft(input.message, "the bells only ring at slack water") as Extract<ModelCandidateDraft, { classification: "canon.create" }>;
    second.title = "The bells ring at slack water";
    second.draft = { ...second.draft, title: "Slack-water bells", statement: "The bells ring only at slack water." };

    const outcome = validateTurnResult({
      ...input,
      raw: turn({
        candidateOperations: [
          { op: "create", temporaryId: "t1", candidate: first },
          { op: "create", temporaryId: "t2", candidate: second },
        ],
        groupOperations: [{
          op: "create",
          temporaryId: "g1",
          title: "The answering bells",
          rationale: "The first cites the second.",
          members: [{ temporaryId: "t1" }, { temporaryId: "t2" }],
        }],
      }),
    });

    assert.ok(outcome.ok);
    const linked = outcome.turn.candidates.find((candidate) => candidate.title === first.title)!;
    const target = outcome.turn.candidates.find((candidate) => candidate.title === second.title)!;
    assert.deepEqual((linked.draft as { links: unknown[] }).links, [
      { kind: "pending-entity", ref: { candidateId: target.id, revision: target.revision } },
    ]);
  });

  it("refuses a temporary reference that is not in one atomic group", async () => {
    const input = await baseInput();
    const first = canonCreateDraft(input.message) as Extract<ModelCandidateDraft, { classification: "canon.create" }>;
    first.draft.links = [{ kind: "pending-entity", ref: { temporaryId: "t2" } }] as never;
    const second = canonCreateDraft(input.message, "the bells only ring at slack water");
    second.title = "The bells ring at slack water";

    const outcome = validateTurnResult({
      ...input,
      raw: turn({
        candidateOperations: [
          { op: "create", temporaryId: "t1", candidate: first },
          { op: "create", temporaryId: "t2", candidate: second },
        ],
      }),
    });

    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.ok(outcome.problems.some((entry) => entry.code === "unbound-pending-reference"));
  });

  it("refuses a temporary reference with no create", async () => {
    const input = await baseInput();
    const draft = canonCreateDraft(input.message) as Extract<ModelCandidateDraft, { classification: "canon.create" }>;
    draft.draft.links = [{ kind: "pending-entity", ref: { temporaryId: "missing" } }] as never;
    const outcome = validateTurnResult({
      ...input,
      raw: turn({ candidateOperations: [{ op: "create", temporaryId: "t1", candidate: draft }] }),
    });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.ok(outcome.problems.some((entry) => entry.code === "unknown-temporary-reference"));
  });
});
