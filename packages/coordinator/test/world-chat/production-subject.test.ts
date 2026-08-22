import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WorldChatEntityRefSchema, WorldChangeCandidateSchema } from "@arke-studio/contracts";

/**
 * A production proposition can be written down (found 2026-08-21, driving the installed app).
 *
 * A proposition's subject is its own target — `subjectOf` returns it — and the subject union
 * admitted only `world`, `canon` and `sheet`. So every `development.*` proposition the studio
 * made was rejected the moment it was written, with `invalid_union_discriminator` on
 * `candidates[0].subject.kind`. Season, episode, scene and series propositions are the only ones
 * a production thread can make, so the whole feature had never produced a single point.
 *
 * A cast is why it reached the store instead of the compiler: `record["target"] as
 * WorldChangeCandidate["subject"]` asserts precisely the thing that was false.
 */

const BASE = {
  id: "cand_01J8H000000000000000000000",
  conversationId: "cv_01J8H000000000000000000000",
  revision: 1,
  status: "live",
  settledness: "settled",
  title: "The season answers whether she is tested or replaced.",
  rationale: "",
  sourceMessageIds: [],
  evidence: [],
  checks: {
    state: "complete",
    basedOnCanonRevision: 0,
    required: [],
    completed: [],
    consulted: [],
    likelyDuplicates: [],
    possibleAmendments: [],
    contradictionCandidates: [],
    explanation: "",
  },
  createdAt: "2026-08-21T05:00:00.000Z",
  updatedAt: "2026-08-21T05:00:00.000Z",
} as const;

describe("the subject union admits what a production thread is about", () => {
  it("takes a season's target — the production itself", () => {
    assert.equal(WorldChatEntityRefSchema.safeParse({ kind: "production", productionId: "the-long-wait" }).success, true);
  });

  it("takes an episode, named or not yet named", () => {
    const named = { kind: "episode", productionId: "the-long-wait", episodeId: "ep_the-first-night" };
    assert.equal(WorldChatEntityRefSchema.safeParse(named).success, true);
    // Absent while the episode is being created — the payload's own `episodeId` is optional.
    assert.equal(WorldChatEntityRefSchema.safeParse({ kind: "episode", productionId: "the-long-wait" }).success, true);
  });

  it("takes a scene and a series", () => {
    assert.equal(
      WorldChatEntityRefSchema.safeParse({ kind: "scene", productionId: "the-long-wait", sceneId: "sc_01" }).success,
      true,
    );
    assert.equal(WorldChatEntityRefSchema.safeParse({ kind: "series", seriesId: "the-long-wait" }).success, true);
  });

  it("still refuses a shape nobody declared", () => {
    assert.equal(WorldChatEntityRefSchema.safeParse({ kind: "chapter", chapterId: "ch_1" }).success, false);
    assert.equal(WorldChatEntityRefSchema.safeParse({ kind: "production" }).success, false, "productionId is required");
  });

  it("a season candidate now survives being written down", () => {
    // The exact shape that was rejected: subject is the target, because subjectOf returns it.
    const target = { kind: "production", productionId: "the-long-wait" } as const;
    const candidate = {
      ...BASE,
      subject: target,
      classification: "development.season",
      target,
      draft: { question: "Is she being tested or replaced?" },
    };
    const parsed = WorldChangeCandidateSchema.safeParse(candidate);
    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues?.slice(0, 2)));
  });
});
