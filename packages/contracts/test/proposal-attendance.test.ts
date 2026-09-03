import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProposalSchema, proposalDecisionOf, proposalOriginOf, unattendedProposalsOf } from "../src/index.js";

const legacy = ProposalSchema.parse({
  id: "pr_01J8H0000000000000000000Z9",
  kind: "story-overview",
  summary: "A saved overview",
  targets: [{ path: "productions/saltlight/story.json", baseVersion: 1, baseHash: "sha256:9f2c66a1b0e4d8c2" }],
  baseCanonRevision: 4,
  reservedCanonIds: [],
  source: "world-chat:cv_01J8H0000000000000000000Z8",
  created: "2026-09-03T12:00:00.000Z",
  worldChatOrigins: [{
    requestId: "request-1",
    conversationId: "cv_01J8H0000000000000000000Z8",
    candidateId: "wc_01J8H0000000000000000000Z7",
    candidateRevision: 1,
    targetPaths: ["productions/saltlight/story.json"],
    fields: ["spine"],
  }],
});

describe("proposal origin and attended ownership (SPEC-040)", () => {
  it("parses old proposals and derives their immutable origin", () => {
    assert.equal(legacy.origin, undefined);
    assert.deepEqual(proposalOriginOf(legacy), {
      source: legacy.source,
      surface: "world-chat",
      gesture: "legacy-stage",
      conversationId: "cv_01J8H0000000000000000000Z8",
    });
  });

  it("defaults old proposals unattended unless their durable conversation is demonstrably open", () => {
    assert.deepEqual(proposalDecisionOf(legacy), { mode: "unattended" });
    assert.equal(
      proposalDecisionOf(legacy, [{ id: "cv_01J8H0000000000000000000Z8", status: "open" }]).mode,
      "attended",
    );
    for (const status of ["closed", "archived"] as const) {
      assert.deepEqual(
        proposalDecisionOf(legacy, [{ id: "cv_01J8H0000000000000000000Z8", status }]),
        { mode: "unattended" },
      );
    }
  });

  it("downgrades recorded World Chat ownership when the conversation is missing or closed", () => {
    const recorded = ProposalSchema.parse({
      ...legacy,
      origin: { source: legacy.source, surface: "world-chat", gesture: "save", conversationId: "cv_missing" },
      decision: { mode: "attended", owner: { kind: "world-chat", conversationId: "cv_missing" } },
    });
    assert.deepEqual(proposalDecisionOf(recorded, []), { mode: "unattended" });
    assert.deepEqual(proposalDecisionOf(recorded, [{ id: "cv_missing", status: "closed" }]), { mode: "unattended" });
  });

  it("filters by effective ownership, including old records and orphaned conversations", () => {
    const attended = {
      proposal: ProposalSchema.parse({
        ...legacy,
        decision: {
          mode: "attended",
          owner: { kind: "world-chat", conversationId: "cv_01J8H0000000000000000000Z8" },
        },
      }),
    };
    const orphaned = {
      proposal: ProposalSchema.parse({
        ...legacy,
        id: "pr_01J8H0000000000000000000Y1",
        decision: { mode: "attended", owner: { kind: "world-chat", conversationId: "cv_missing" } },
      }),
    };
    assert.deepEqual(
      unattendedProposalsOf(
        [attended, orphaned],
        [{ id: "cv_01J8H0000000000000000000Z8", status: "open" }],
      ),
      [orphaned],
    );
    assert.deepEqual(unattendedProposalsOf([{ proposal: legacy }]), [{ proposal: legacy }]);
  });

  it("routes a question only the person can answer to the unattended exception queue", () => {
    const asking = ProposalSchema.parse({
      ...legacy,
      decision: {
        mode: "attended",
        owner: { kind: "world-chat", conversationId: "cv_01J8H0000000000000000000Z8" },
      },
      openChoices: [{
        choiceId: "choice-1",
        kind: "duplicate-or-amend",
        question: "Is this new or an amendment?",
        options: [{ optionId: "new", label: "New" }, { optionId: "amend", label: "Amend" }],
      }],
    });
    assert.deepEqual(
      proposalDecisionOf(asking, [{ id: "cv_01J8H0000000000000000000Z8", status: "open" }]),
      { mode: "unattended" },
    );
  });
});
