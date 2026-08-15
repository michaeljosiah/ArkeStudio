import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  newId,
  type CheckReceiptId,
  type ModelCandidateDraft,
  type RunId,
  type WorldChatCheckReceipt,
} from "@arke-studio/contracts";
import { checksAreStale, deriveChecks, planFor } from "../../src/world-chat/check-plan.js";
import { sha256 } from "../../src/world/text-files.js";

/**
 * The coordinator's own check plan (#70 §5.7, §8.3.1).
 *
 * The distinction this file exists to protect: a search that ran and found nothing means "this is
 * new"; a search that could not run means "nobody knows". They must never produce the same state.
 */

const AT = "2026-08-06T10:00:00Z";
const RUN = newId("run") as RunId;

function draft(over: Partial<ModelCandidateDraft> = {}): ModelCandidateDraft {
  return {
    classification: "canon.create",
    title: "Maren was raised by her aunt",
    rationale: "",
    settledness: "settled",
    evidence: [],
    checkReceiptIds: [],
    draft: { type: "lore", title: "Maren's upbringing", statement: "Raised by her aunt.", links: [] },
    ...over,
  } as ModelCandidateDraft;
}

function receipt(over: Partial<WorldChatCheckReceipt> = {}): WorldChatCheckReceipt {
  return {
    id: newId("check") as CheckReceiptId,
    runId: RUN,
    tool: "search-canon",
    status: "complete",
    consulted: [],
    at: AT,
    ...over,
  };
}

describe("what a proposition must have checked", () => {
  it("requires a canon search before claiming a new entry is new", () => {
    assert.deepEqual(planFor(draft()).required, ["canon-search"]);
  });

  it("requires reading the target of an amendment", () => {
    const plan = planFor(
      draft({
        classification: "canon.amend",
        target: { kind: "canon", entryId: "CANON-002" },
        draft: { statement: "Amended." },
      } as never),
    );
    assert.deepEqual(plan.required, ["target-read"]);
    assert.deepEqual(plan.targets, [{ kind: "canon", entryId: "CANON-002" }]);
  });

  it("requires both a sheet search and a canon search for a new character", () => {
    const plan = planFor(
      draft({
        classification: "sheet.create",
        draft: { type: "character", name: "The Harbourmaster", canonRules: [], links: [], sections: [] },
      } as never),
    );
    assert.deepEqual([...plan.required].sort(), ["canon-search", "sheet-search"]);
  });

  it("requires reading both ends of a relationship", () => {
    const plan = planFor(
      draft({
        classification: "relationship.change",
        draft: {
          from: { kind: "sheet", sheetId: "maren-kest" },
          to: { kind: "sheet", sheetId: "bray-half-hitch" },
          linkAction: "add",
          proseEdits: [],
        },
      } as never),
    );
    assert.deepEqual([...plan.required].sort(), ["related-read", "target-read"]);
    assert.equal(plan.targets.length, 2, "a relationship naming somebody who is not there is a mistake");
  });

  it("asks nothing of an undecided proposition, which can never become a proposal", () => {
    const plan = planFor(
      draft({
        classification: "undecided",
        draft: { question: "Which is it?", plausibleActions: [], possibleTargets: [] },
      } as never),
    );
    assert.deepEqual(plan.required, []);
  });

  it("builds the same query for the same proposition every time", () => {
    assert.equal(planFor(draft()).queries["canon-search"], planFor(draft()).queries["canon-search"]);
  });
});

describe("what the checks found", () => {
  it("calls a proposition checked when the search ran, even with no matches", () => {
    const checks = deriveChecks({
      draft: draft(),
      plan: planFor(draft()),
      receipts: [receipt({ status: "empty" })],
      canonRevision: 42,
    });
    assert.equal(checks.state, "complete");
    assert.deepEqual(checks.completed, ["canon-search"]);
    assert.match(checks.explanation, /Nothing in the world looks like this/);
  });

  it("says nobody knows when the search could not run at all", () => {
    const checks = deriveChecks({
      draft: draft(),
      plan: planFor(draft()),
      receipts: [receipt({ status: "unavailable" })],
      canonRevision: 42,
    });
    assert.equal(
      checks.state,
      "unavailable",
      "a search that could not run must not read as one that found nothing",
    );
    assert.match(checks.explanation, /could not be searched/);
  });

  it("stays partial when a required check simply has not happened", () => {
    const checks = deriveChecks({
      draft: draft(),
      plan: planFor(draft()),
      receipts: [],
      canonRevision: 42,
    });
    assert.equal(checks.state, "partial");
  });

  it("surfaces a close match as something worth a look, without blocking", () => {
    const checks = deriveChecks({
      draft: draft(),
      plan: planFor(draft()),
      receipts: [receipt()],
      canonRevision: 42,
      matches: [{ ref: { kind: "canon", entryId: "CANON-002" }, score: 0.9 }],
    });
    assert.deepEqual(checks.likelyDuplicates, [{ kind: "canon", entryId: "CANON-002" }]);
    assert.equal(checks.state, "complete", "a possible duplicate is a question, not a block");
    assert.match(checks.explanation, /worth a look/);
  });

  it("ignores a match too weak to mean anything", () => {
    const checks = deriveChecks({
      draft: draft(),
      plan: planFor(draft()),
      receipts: [receipt()],
      canonRevision: 42,
      matches: [{ ref: { kind: "canon", entryId: "CANON-002" }, score: 0.1 }],
    });
    assert.deepEqual(checks.likelyDuplicates, []);
  });

  it("records what it consulted against the check that consulted it", () => {
    const r = receipt({
      consulted: [
        {
          ref: { kind: "canon", entryId: "CANON-002" },
          observedVersion: 42,
          contentHash: `sha256:${"a".repeat(64)}`,
        },
      ],
    });
    const checks = deriveChecks({ draft: draft(), plan: planFor(draft()), receipts: [r], canonRevision: 42 });
    assert.equal(checks.consulted[0]!.checkId, r.id);
  });

  it("notices when what it looked at has since moved", () => {
    const checks = deriveChecks({
      draft: draft(),
      plan: planFor(draft()),
      receipts: [
        receipt({
          consulted: [
            {
              ref: { kind: "sheet", sheetKind: "character", sheetId: "maren-kest" },
              observedVersion: 4,
              contentHash: `sha256:${"a".repeat(64)}`,
            },
          ],
        }),
      ],
      canonRevision: 42,
    });

    assert.equal(checksAreStale(checks, { canonRevision: 42, versionOf: () => 4 }), false);
    assert.equal(checksAreStale(checks, { canonRevision: 42, versionOf: () => 5 }), true, "the sheet moved");
    assert.equal(checksAreStale(checks, { canonRevision: 43, versionOf: () => 4 }), true, "canon moved");
  });

  /*
   * The look a whole-description draft was shown, pinned by its words and not only its number.
   *
   * A world with no art-direction file derives its look from world.json, and derives it at v1
   * every time — so a draft bound to the version alone survives the world's tone being rewritten
   * underneath it, and replaces a description nobody ever showed the model.
   */
  it("pins a look change to the words it was shown as well as the version", () => {
    const shown = "Painterly and hand-animated, with visible brushwork.";
    const look = draft({
      classification: "art-direction.change",
      draft: { description: "Ink and wash." },
    } as never);
    const checks = deriveChecks({
      draft: look,
      plan: planFor(look),
      receipts: [],
      canonRevision: 42,
      artDirectionLook: { version: 1, description: shown },
    });

    assert.equal(checks.basedOnArtDirectionVersion, 1);
    assert.equal(checks.basedOnArtDirectionLook, sha256(shown));
    const versionOf = () => null;
    assert.equal(
      checksAreStale(checks, { canonRevision: 42, versionOf, artDirectionLook: { version: 1, description: shown } }),
      false,
    );
    assert.equal(
      checksAreStale(checks, {
        canonRevision: 42,
        versionOf,
        artDirectionLook: { version: 1, description: "The Undersong should feel quiet dread." },
      }),
      true,
      "the number stayed still and the look did not",
    );
  });

  it("pins nothing on a proposition that does not replace the look", () => {
    const checks = deriveChecks({
      draft: draft(),
      plan: planFor(draft()),
      receipts: [],
      canonRevision: 42,
      artDirectionLook: { version: 1, description: "Painterly." },
    });
    assert.equal(checks.basedOnArtDirectionVersion, undefined);
    assert.equal(checks.basedOnArtDirectionLook, undefined, "nothing else is bound to the world's look");
  });
});

/**
 * A relationship is the classification that needs to know what else touches the entity, and the
 * only one whose required categories include `related-read` (#70 §5.7).
 *
 * It was unwritable for as long as it existed: the coordinator's plan runner called the search
 * and target tools and never `related`, so the category could not complete, the state stayed
 * `partial`, and readiness refuses `partial` — every relationship a conversation described
 * reached the rail and answered "there is not enough behind it to write it down".
 */
describe("a relationship needs what else touches the entity", () => {
  const relationship = () =>
    draft({
      classification: "relationship.change",
      title: "Ottoline is linked to Colm",
      target: { kind: "sheet", sheetKind: "character", sheetId: "sister-ottoline-pike" },
      draft: {
        proseEdits: [
          { sheet: { kind: "sheet", sheetId: "sister-ottoline-pike" }, sectionHeading: "Essence", body: "Bound." },
        ],
      },
    } as unknown as Partial<ModelCandidateDraft>);

  it("requires a related read, which only one tool satisfies", () => {
    assert.ok(planFor(relationship()).required.includes("related-read"));
  });

  it("stays partial on the target read alone — the state readiness refuses", () => {
    const checks = deriveChecks({
      draft: relationship(),
      plan: planFor(relationship()),
      receipts: [receipt({ tool: "get-sheet" })],
      canonRevision: 42,
    });
    assert.equal(checks.state, "partial");
  });

  it("completes once the related read is among the receipts", () => {
    const checks = deriveChecks({
      draft: relationship(),
      plan: planFor(relationship()),
      receipts: [receipt({ tool: "get-sheet" }), receipt({ tool: "related" })],
      canonRevision: 42,
    });
    assert.equal(checks.state, "complete");
  });

  /*
   * A check that could not run is not a check nobody asked for. The plan runner used to swallow a
   * failed call and drop its receipt, which left the category merely missing — and missing is
   * `partial`, which blocks. Carried through, it is `unavailable`, which deliberately does not.
   */
  it("reads as unavailable, not partial, when the related read could not run", () => {
    const checks = deriveChecks({
      draft: relationship(),
      plan: planFor(relationship()),
      receipts: [receipt({ tool: "get-sheet" }), receipt({ tool: "related", status: "unavailable" })],
      canonRevision: 42,
    });
    assert.equal(checks.state, "unavailable", "a broken index is shown, not turned into a refusal");
  });
});
