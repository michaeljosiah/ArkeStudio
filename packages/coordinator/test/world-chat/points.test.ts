import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  newId,
  type CandidateId,
  type ConversationId,
  type MessageId,
  type WorldChangeCandidate,
} from "@arke-studio/contracts";
import { lookContentHash } from "../../src/world-chat/look.js";
import { projectPoints } from "../../src/world-chat/project.js";
import { evaluateReadiness } from "../../src/world-chat/readiness.js";

/**
 * What the rail says will carry, against what wrap-up actually carries (§6.2, §10.3).
 *
 * The caption under the button counts the points that become proposals. It is the only number on
 * the screen that makes a promise about the next screen, so every reason readiness has for holding
 * a point back has to be applied here as well — and one of them was not, which is a caption saying
 * "1 of 1 points become proposals" above a button that answers nothing-to-carry.
 */

const AT = "2026-08-10T10:00:00Z";
const LOOK = "Painterly and hand-animated, with visible brushwork.";

function lookChange(over: Partial<WorldChangeCandidate> = {}): WorldChangeCandidate {
  return {
    id: newId("cand") as CandidateId,
    conversationId: newId("cv") as ConversationId,
    revision: 1,
    status: "live",
    settledness: "settled",
    classification: "art-direction.change",
    subject: { kind: "world" },
    title: "The world takes a painterly look",
    rationale: "They asked for it.",
    sourceMessageIds: [],
    evidence: [
      {
        kind: "message",
        messageId: newId("msg") as MessageId,
        quote: "make it painterly",
        start: 0,
        end: 17,
        purpose: "intent",
      },
    ],
    checks: {
      state: "complete",
      basedOnCanonRevision: 42,
      basedOnArtDirectionVersion: 3,
      basedOnArtDirectionLook: lookContentHash(LOOK),
      required: [],
      completed: [],
      consulted: [],
      likelyDuplicates: [],
      possibleAmendments: [],
      contradictionCandidates: [],
      explanation: "Nothing in the world looks like this already.",
    },
    createdAt: AT,
    updatedAt: AT,
    draft: { description: "Painterly and hand-animated." },
    ...over,
  } as WorldChangeCandidate;
}

/** The world as readiness reads it, so both sides of the promise can be checked against one thing. */
function world(over: Record<string, unknown> = {}) {
  return {
    canon: [],
    sheets: [],
    proposals: [],
    artDirection: { version: 3, description: LOOK },
    ...over,
  } as never;
}

describe("the count under the wrap-up button", () => {
  it("counts a look drafted against the look that is still there", () => {
    const point = lookChange();
    const [projected] = projectPoints([point], { look: { version: 3, description: LOOK } });
    assert.equal(projected?.settled, true);
    assert.equal(evaluateReadiness([point], world()).carried.length, 1, "and wrap-up agrees");
  });

  /*
   * The version moved. Readiness refuses this as `look-moved` — the draft carries the whole
   * description, so writing it would undo whatever landed in between — and the rail counted it as
   * a proposal anyway.
   */
  it("does not count one drafted against a look that has since been accepted over", () => {
    const point = lookChange();
    const moved = { version: 4, description: "Ink and wash: brush contour, washed tone." };
    const [projected] = projectPoints([point], { look: moved });
    assert.equal(projected?.settled, false, "the caption must not promise what wrap-up will refuse");

    const { carried, notCarried } = evaluateReadiness([point], world({ artDirection: moved }));
    assert.deepEqual(carried, []);
    assert.equal(notCarried[0]?.reason, "look-moved");
  });

  /*
   * The number did not move and the words did. A world with no art-direction file derives its look
   * from world.json and derives it at v1 every time, so editing the tone rewrites the description
   * every image is generated from while the version sits still.
   */
  it("does not count one whose description was rewritten under the same version", () => {
    const point = lookChange();
    const rewritten = { version: 3, description: "A coherent visual language for Saltlight." };
    assert.equal(projectPoints([point], { look: rewritten })[0]?.settled, false);
    assert.equal(
      evaluateReadiness([point], world({ artDirection: rewritten })).notCarried[0]?.reason,
      "look-moved",
    );
  });

  it("does not count one while a change to the look is already waiting", () => {
    const point = lookChange();
    const [projected] = projectPoints([point], {
      look: { version: 3, description: LOOK },
      lookAlreadyProposed: true,
    });
    assert.equal(projected?.settled, false);
    assert.equal(
      evaluateReadiness([point], world({ proposals: [{ proposal: { kind: "art-direction" } }] }))
        .notCarried[0]?.reason,
      "look-already-proposed",
    );
  });

  /*
   * Told nothing about the world, the rail cannot know a look has moved — and must not invent it.
   * Every point in a conversation about anything else goes through the same function.
   */
  it("counts a look when the caller could not say what the world's look is", () => {
    assert.equal(projectPoints([lookChange()], {})[0]?.settled, true);
  });
});
