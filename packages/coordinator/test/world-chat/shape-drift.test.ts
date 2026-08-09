import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  newId,
  WORLD_CHAT_SHAPE_EXAMPLES,
  type CandidateChecks,
  type ConversationId,
  type MessageId,
  type RunId,
  type TurnId,
  type WorldChatCheckReceipt,
  type WorldChatMessage,
  type WorldChatTurnResult,
} from "@arke-studio/contracts";
import { correctiveMessage, validateTurnResult } from "../../src/world-chat/turn-result.js";
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

    const outcome = validateTurnResult({
      raw: JSON.stringify(result),
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
    });

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
    const message = guideMessage();
    const outcome = validateTurnResult({
      raw: JSON.stringify(guessed),
      conversationId: newId("cv") as ConversationId,
      messages: [message],
      existing: [],
      groups: [],
      tombstones: [],
      receiptsThisRun: [],
      evidenceSources: {
        messages: [message],
        bundle: (await scanWorld(FIXTURE_WORLD)).bundle,
        attachments: [],
        attachmentText: new Map(),
      },
      checksFor: () => completeChecks(),
      now: () => AT,
    });

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
});
