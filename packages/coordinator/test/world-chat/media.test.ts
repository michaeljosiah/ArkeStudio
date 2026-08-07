import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  newId,
  type CandidateId,
  type ConversationId,
  type MessageId,
  type Proposal,
  type WorldBundle,
  type WorldChangeCandidate,
} from "@arke-studio/contracts";
import { blockingDependencies, explainBlocked, routeFor } from "../../src/world-chat/media.js";
import { scanWorld } from "../../src/world/scan.js";
import { FIXTURE_WORLD } from "../world/helpers.js";

/**
 * Taking an image idea somewhere it can be made (#70 §14).
 *
 * Two rules carry the weight. Every route goes to a workflow that already exists, so generated
 * media never lands somewhere nobody chose. And nothing generates from a change that has not been
 * accepted, so there is no picture of a character the world never had.
 */

const AT = "2026-08-06T10:00:00Z";
const WORLD = "01J8F3K2QW9VZX4N7M0RTYB6HC";
let bundle: WorldBundle;

function idea(draft: Record<string, unknown>): WorldChangeCandidate {
  return {
    id: newId("cand") as CandidateId,
    conversationId: newId("cv") as ConversationId,
    revision: 1,
    status: "live",
    settledness: "settled",
    classification: "media.image-opportunity",
    subject: { kind: "world" },
    title: "A picture of her",
    rationale: "",
    sourceMessageIds: [],
    evidence: [
      { kind: "message", messageId: newId("msg") as MessageId, quote: "a picture", start: 0, end: 9, purpose: "intent" },
    ],
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
    draft: { purpose: "character-main-photo", brief: "Her, at the rail.", reason: "", dependencies: [], ...draft },
  } as unknown as WorldChangeCandidate;
}

function proposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: "pr_01J8H0000000000000000000M1",
    kind: "worldbuilding",
    summary: "A new character: the harbourmaster",
    targets: [{ path: "characters/the-harbourmaster.md", baseVersion: null, baseHash: null }],
    baseCanonRevision: 42,
    reservedCanonIds: [],
    source: "world-chat:cv_1",
    created: AT,
    draftRevision: 1,
    ...over,
  } as Proposal;
}

describe("where an image idea goes", () => {
  it("sends a main photo to the workflow that replaces one", () => {
    const route = routeFor(
      idea({ target: { kind: "sheet", sheetKind: "character", sheetId: "maren-kest" }, purpose: "character-main-photo" }),
      WORLD,
    );
    assert.deepEqual(route, { kind: "route", path: `/w/${WORLD}/cast/maren-kest/main-photo` });
  });

  it("sends a look to the looks workflow, not the main photo one", () => {
    const route = routeFor(
      idea({ target: { kind: "sheet", sheetKind: "character", sheetId: "maren-kest" }, purpose: "character-look" }),
      WORLD,
    );
    assert.deepEqual(route, { kind: "route", path: `/w/${WORLD}/cast/maren-kest/looks` });
  });

  it("sends key art to the world", () => {
    const route = routeFor(idea({ target: { kind: "world" }, purpose: "world-key-art" }), WORLD);
    assert.deepEqual(route, { kind: "route", path: `/w/${WORLD}` });
  });

  it("refuses key art aimed at one entity", () => {
    const route = routeFor(
      idea({ target: { kind: "sheet", sheetKind: "character", sheetId: "maren-kest" }, purpose: "world-key-art" }),
      WORLD,
    );
    assert.equal(route.kind, "invalid");
  });

  it("refuses a character photo with no character", () => {
    const route = routeFor(idea({ target: { kind: "world" }, purpose: "character-main-photo" }), WORLD);
    assert.equal(route.kind, "invalid", "there is no generic 'replace an image' destination");
  });

  it("refuses anything that is not an image idea", () => {
    const notMedia = { ...idea({ target: { kind: "world" } }), classification: "canon.create" } as WorldChangeCandidate;
    assert.equal(routeFor(notMedia, WORLD).kind, "invalid");
  });
});

describe("what must land before it can be generated", () => {
  it("allows an idea about a character who is already in the world", async () => {
    bundle ??= (await scanWorld(FIXTURE_WORLD)).bundle;
    const blocking = blockingDependencies(
      idea({ target: { kind: "sheet", sheetKind: "character", sheetId: "maren-kest" } }),
      bundle,
      [],
    );
    assert.deepEqual(blocking, []);
  });

  it("blocks an idea about a character who is only proposed, and names the proposal", async () => {
    bundle ??= (await scanWorld(FIXTURE_WORLD)).bundle;
    const blocking = blockingDependencies(
      idea({ target: { kind: "sheet", sheetKind: "character", sheetId: "the-harbourmaster" } }),
      bundle,
      [proposal()],
    );
    assert.equal(blocking.length, 1);
    assert.equal(blocking[0]!.proposalId, "pr_01J8H0000000000000000000M1");
    assert.match(
      explainBlocked(blocking),
      /harbourmaster/,
      "the reviewer's next action is to decide that proposal, so it has to be named",
    );
  });

  it("blocks when the character is nowhere at all", async () => {
    bundle ??= (await scanWorld(FIXTURE_WORLD)).bundle;
    const blocking = blockingDependencies(
      idea({ target: { kind: "sheet", sheetKind: "character", sheetId: "nobody" } }),
      bundle,
      [],
    );
    assert.equal(blocking.length, 1);
    assert.match(blocking[0]!.summary, /not in the world/);
  });

  it("blocks on a named proposal that is still waiting", async () => {
    bundle ??= (await scanWorld(FIXTURE_WORLD)).bundle;
    const blocking = blockingDependencies(
      idea({
        target: { kind: "sheet", sheetKind: "character", sheetId: "maren-kest" },
        dependencies: [{ proposalId: "pr_01J8H0000000000000000000M1" }],
      }),
      bundle,
      [proposal()],
    );
    assert.equal(blocking.length, 1, "a picture from an undecided change would be orphaned by a discard");
  });

  it("stops blocking once that proposal is no longer staged", async () => {
    bundle ??= (await scanWorld(FIXTURE_WORLD)).bundle;
    const blocking = blockingDependencies(
      idea({
        target: { kind: "sheet", sheetKind: "character", sheetId: "maren-kest" },
        dependencies: [{ proposalId: "pr_01J8H0000000000000000000M1" }],
      }),
      bundle,
      [],
    );
    assert.deepEqual(blocking, [], "accepted means gone from the staged set and present in the world");
  });

  it("blocks on a proposition that has not even become a proposal", async () => {
    bundle ??= (await scanWorld(FIXTURE_WORLD)).bundle;
    const blocking = blockingDependencies(
      idea({
        target: { kind: "sheet", sheetKind: "character", sheetId: "maren-kest" },
        dependencies: [{ candidateId: newId("cand"), revision: 1 }],
      }),
      bundle,
      [],
    );
    assert.equal(blocking.length, 1);
  });

  it("says nothing when nothing is blocking", () => {
    assert.equal(explainBlocked([]), "");
  });
});
