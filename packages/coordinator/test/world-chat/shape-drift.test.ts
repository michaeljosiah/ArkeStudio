import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  newId,
  WORLD_CHAT_SHAPE_EXAMPLES,
  type CandidateChecks,
  type ConversationId,
  type MessageId,
  type ModelCandidateDraft,
  type RunId,
  type TurnId,
  type WorldChatCheckReceipt,
  type WorldChatMessage,
  type WorldChatTurnResult,
} from "@arke-studio/contracts";
import {
  correctiveMessage,
  validateTurnResult,
  type ValidateInput,
} from "../../src/world-chat/turn-result.js";
import { scanWorld } from "../../src/world/scan.js";
import { FIXTURE_WORLD } from "../world/helpers.js";

/**
 * The shape guide and the validator, held together end to end (#70 §8.3, §8.4).
 *
 * The contracts tests hold every guide example to its schema. This suite holds the two failure
 * modes the first live turn actually hit: an answer written exactly as the guide teaches must
 * pass the full validator once its ids point at real things, and an answer shaped the way the
 * live model actually guessed must come back with a corrective message that names what belongs
 * at each fault — a bare path list was watched sending the model into a second wrong guess.
 */

const AT = "2026-08-09T18:01:18.925Z";

function guideMessage(): WorldChatMessage {
  return {
    id: newId("msg") as MessageId,
    turnId: newId("turn") as TurnId,
    role: "user",
    // The guide's own example quote, so its start/end offsets hold against a real message.
    text: WORLD_CHAT_SHAPE_EXAMPLES.evidence.message.quote,
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

/** A validator input around one user message and one raw answer, against the fixture world. */
async function validateInput(
  message: WorldChatMessage,
  result: unknown,
  receipts: readonly WorldChatCheckReceipt[] = [],
): Promise<ValidateInput> {
  return {
    raw: typeof result === "string" ? result : JSON.stringify(result),
    conversationId: newId("cv") as ConversationId,
    messages: [message],
    existing: [],
    groups: [],
    tombstones: [],
    receiptsThisRun: receipts,
    evidenceSources: {
      messages: [message],
      bundle: (await scanWorld(FIXTURE_WORLD)).bundle,
      attachments: [],
      attachmentText: new Map(),
    },
    checksFor: () => completeChecks(),
    now: () => AT,
  };
}

describe("an answer written the way the guide teaches", () => {
  it("passes the full validator once its ids point at real things", async () => {
    const message = guideMessage();
    const runId = newId("run") as RunId;

    // The example verbatim, with the two ids only a live session can know substituted: the
    // message being quoted, and the receipt of a check this run actually made.
    const result = structuredClone(WORLD_CHAT_SHAPE_EXAMPLES.turnResult) as unknown as WorldChatTurnResult;
    const receiptIds = new Set<string>();
    for (const op of result.candidateOperations) {
      if (op.op !== "create" && op.op !== "update") continue;
      op.candidate.evidence = op.candidate.evidence.map((e) =>
        e.kind === "message" ? { ...e, messageId: message.id } : e,
      );
      for (const id of op.candidate.checkReceiptIds) receiptIds.add(id);
    }
    const receipts: WorldChatCheckReceipt[] = [...receiptIds].map((id) => ({
      id: id as WorldChatCheckReceipt["id"],
      runId,
      tool: "search-canon",
      status: "complete",
      consulted: [],
      at: AT,
    }));

    const outcome = validateTurnResult(await validateInput(message, result, receipts));

    assert.equal(
      outcome.ok,
      true,
      outcome.ok
        ? ""
        : `the guide teaches a shape the validator rejects: ${outcome.problems.map((p) => p.safeMessage).join("; ")}`,
    );
    if (!outcome.ok) return;
    assert.equal(outcome.turn.candidates.length, 2);
    assert.equal(outcome.turn.reply, WORLD_CHAT_SHAPE_EXAMPLES.turnResult.reply);
  });
});

describe("the evidence a proposition may stand on", () => {
  /**
   * A candidate evidenced only by a document used to validate, appear in the panel as
   * understood, and then be dropped as "invalid" at wrap-up by `hasIntentEvidence`. The user
   * would find out at the button, about work they were told had landed.
   */
  it("refuses a candidate with supporting evidence but no statement of intent", async () => {
    const message = guideMessage();
    const draft: ModelCandidateDraft = structuredClone(WORLD_CHAT_SHAPE_EXAMPLES.drafts["canon.create"]);
    draft.evidence = [WORLD_CHAT_SHAPE_EXAMPLES.evidence.world];
    draft.checkReceiptIds = [];

    const outcome = validateTurnResult(
      await validateInput(message, {
        reply: "Noted.",
        candidateOperations: [{ op: "create", temporaryId: "t1", candidate: draft }],
        groupOperations: [],
      }),
    );

    assert.equal(outcome.ok, false, "or wrap-up would drop it silently, long after it was shown");
    if (outcome.ok) return;
    assert.ok(
      outcome.problems.some((p) => p.code === "no-intent-evidence"),
      `expected no-intent-evidence, got ${outcome.problems.map((p) => p.code).join(", ")}`,
    );
    assert.match(correctiveMessage(outcome.problems), /"purpose": "intent"/);
  });

  /**
   * The correction case the intent rule would otherwise make impossible: the original ask has
   * fallen out of the eight-turn window, the registry shows only ids and titles, and the words in
   * front of the model are a correction rather than the original ask. The proposition's own
   * verified intent is what carries it — and it must survive into the new snapshot, or wrap-up
   * drops the very thing the user was trying to fix.
   */
  it("lets a correction inherit the intent of the proposition it revises", async () => {
    const message = guideMessage();
    const original: ModelCandidateDraft = structuredClone(WORLD_CHAT_SHAPE_EXAMPLES.drafts["canon.create"]);
    original.evidence = [{ ...WORLD_CHAT_SHAPE_EXAMPLES.evidence.message, messageId: message.id }];
    original.checkReceiptIds = [];

    const created = validateTurnResult(
      await validateInput(message, {
        reply: "Noted.",
        candidateOperations: [{ op: "create", temporaryId: "t1", candidate: original }],
        groupOperations: [],
      }),
    );
    assert.ok(created.ok, created.ok ? "" : created.problems.map((p) => p.code).join(", "));
    const existing = created.turn.candidates[0]!;

    // A later turn: the original message is long gone, and this correction cites only itself.
    const later: WorldChatMessage = {
      id: newId("msg") as MessageId,
      turnId: newId("turn") as TurnId,
      role: "user",
      text: "Actually it was her grandmother.",
      attachmentIds: [],
      createdAt: AT,
    };
    const revision: ModelCandidateDraft = structuredClone(WORLD_CHAT_SHAPE_EXAMPLES.drafts["canon.create"]);
    revision.evidence = [
      {
        kind: "message",
        messageId: later.id,
        quote: later.text,
        start: 0,
        end: later.text.length,
        purpose: "correction",
      },
    ];
    revision.checkReceiptIds = [];

    const input = await validateInput(later, {
      reply: "Changed.",
      candidateOperations: [
        { op: "update", candidateId: existing.id, expectedRevision: existing.revision, candidate: revision },
      ],
      groupOperations: [],
    });
    const outcome = validateTurnResult({ ...input, existing: [existing] });

    assert.equal(
      outcome.ok,
      true,
      outcome.ok ? "" : outcome.problems.map((p) => p.code).join(", "),
    );
    if (!outcome.ok) return;
    const updated = outcome.turn.candidates[0]!;
    assert.ok(
      updated.evidence.some((e) => e.kind === "message" && e.purpose === "intent"),
      "the original ask is still why this exists, so wrap-up can still carry it",
    );
    assert.ok(
      updated.evidence.some((e) => e.kind === "message" && e.purpose === "correction"),
      "and the correction is recorded beside it",
    );
  });

  /** Citing its own reply would let a proposition bootstrap from the Studio's earlier inference. */
  it("refuses evidence that quotes the Studio rather than the user", async () => {
    const message = guideMessage();
    const studio: WorldChatMessage = {
      id: newId("msg") as MessageId,
      turnId: newId("turn") as TurnId,
      role: "studio",
      text: "The bells, then, are older than the harbour.",
      attachmentIds: [],
      createdAt: AT,
    };
    const draft: ModelCandidateDraft = structuredClone(WORLD_CHAT_SHAPE_EXAMPLES.drafts["canon.create"]);
    draft.evidence = [
      {
        kind: "message",
        messageId: studio.id,
        // Quoted exactly, at the right offsets: everything but the role checks out.
        quote: studio.text,
        start: 0,
        end: studio.text.length,
        purpose: "intent",
      },
    ];
    draft.checkReceiptIds = [];

    const input = await validateInput(message, {
      reply: "Noted.",
      candidateOperations: [{ op: "create", temporaryId: "t1", candidate: draft }],
      groupOperations: [],
    });
    const outcome = validateTurnResult({
      ...input,
      messages: [message, studio],
      evidenceSources: { ...input.evidenceSources, messages: [message, studio] },
    });

    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.ok(
      outcome.problems.some((p) => p.code === "message-not-the-users"),
      `expected message-not-the-users, got ${outcome.problems.map((p) => p.code).join(", ")}`,
    );
  });
});

describe("an answer shaped the way the live model actually guessed", () => {
  // The first live turn, structurally: no evidence kind, invented offset field names, a draft
  // with fields from no classification. Values are synthetic — what matters is that each fault
  // comes back naming what belongs there, and that no value travels back out.
  const guessed = {
    reply: "Noted.",
    candidateOperations: [
      {
        op: "create",
        temporaryId: "t1",
        candidate: {
          classification: "canon.create",
          title: "A painterly style",
          rationale: "They asked for it.",
          settledness: "settled",
          evidence: [{ quote: "SECRET-SPAN", startOffset: 226, endOffset: 410 }],
          checkReceiptIds: [],
          draft: { title: "Visual art direction", body: "SECRET-BODY" },
        },
      },
    ],
    groupOperations: [],
  };

  it("gets a corrective message that names what belongs at each fault", async () => {
    const outcome = validateTurnResult(await validateInput(guideMessage(), guessed));

    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    const corrective = correctiveMessage(outcome.problems);

    assert.match(corrective, /evidence\.0\.kind/, "the missing discriminator is named");
    assert.match(corrective, /"message"/, "with the values that could stand there");
    assert.match(corrective, /draft\.type is required/, "a missing field is named as missing");
    assert.match(corrective, /rule/, "and its options travel with the complaint");
    assert.match(corrective, /draft\.statement/, "each missing field, not just the first");
    assert.match(corrective, /The result shape, exactly/, "and it points back at the full shape");

    assert.ok(!corrective.includes("SECRET-SPAN"), "a failing value is never echoed back");
    assert.ok(!corrective.includes("SECRET-BODY"), "whatever field it arrived under");
  });

  /**
   * Zod puts every unknown key in a single issue. Concatenated whole, a junk object would make a
   * corrective prompt the size of the answer it rejects — the retry's context spent on its own
   * error message, which is the opposite of what a bounded turn is for.
   */
  it("stays small when the answer is enormous", async () => {
    const junk: Record<string, unknown> = { reply: "hi", candidateOperations: [], groupOperations: [] };
    for (let i = 0; i < 2_000; i++) junk[`unexpected_field_number_${i}`] = i;

    const outcome = validateTurnResult(await validateInput(guideMessage(), junk));
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;

    const corrective = correctiveMessage(outcome.problems);
    assert.ok(corrective.length <= 4_000, `corrective was ${corrective.length} characters`);
    assert.match(corrective, /and \d+ more/, "and it says how much it did not list");
  });
});
