import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { ClientState, StagedProposal } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * The approvals screen against its design (design turn 41b).
 *
 * When this screen was first built it matched the design's shell and missed three things the
 * design puts in front of the reviewer: the bulk action, the way back to the conversation, and
 * the account of what did not come across. Those three are what turn a list of proposals into
 * something that explains itself, so each is asserted here rather than left to be noticed again.
 */

const AT = "2026-08-06T10:00:00Z";
const CONVERSATION = "cv_01J8F3K2QW9VZX4N7M0RTYB6HC";

function worldChatProposal(over: Partial<StagedProposal["proposal"]> = {}): StagedProposal {
  return {
    proposal: {
      id: "pr_01J8H0000000000000000000W1" as never,
      kind: "worldbuilding",
      summary: "Bells may pass sideways",
      targets: [{ path: "canon/CANON-900.md", baseVersion: null, baseHash: null }],
      baseCanonRevision: 42,
      reservedCanonIds: ["CANON-900"],
      source: `world-chat:${CONVERSATION}`,
      created: AT,
      draftRevision: 1,
      worldChatOrigins: [
        {
          requestId: "req-1",
          conversationId: CONVERSATION,
          candidateId: "cand_01J8F3K2QW9VZX4N7M0RTYB6HC",
          candidateRevision: 1,
          targetPaths: ["canon/CANON-900.md"],
          fields: ["statement"],
        },
      ],
      ...over,
    },
    ripple: null,
    review: {
      targets: [
        {
          path: "canon/CANON-900.md",
          label: "Inheritance may pass sideways",
          kind: "new rule",
          action: "create",
          fields: [
            { field: "Statement", before: null, proposed: "The bells may be given outside the household." },
          ],
        },
      ],
    },
  } as StagedProposal;
}

function stateWith(proposals: StagedProposal[], notCarried: unknown[] = []): ClientState {
  return {
    ...FIXTURE_STATE,
    world: {
      ...FIXTURE_STATE.world!,
      proposals,
      conversations: [
        {
          id: CONVERSATION as never,
          title: "The bells and the lock",
          status: "closed",
          updatedAt: AT,
          pointCount: 0,
          openProposalCount: proposals.length,
          notCarried: notCarried as never,
        },
      ],
    },
  };
}

/**
 * Server rendering inserts `<!-- -->` between adjacent text and interpolations, so "Accept all 1"
 * arrives as "Accept all <!-- -->1". That is an artifact of how this is rendered, not something a
 * reader would ever see, so it is removed before matching.
 */
function render(state: ClientState): string {
  __setStateForTest(state);
  return renderToString(
    <MemoryRouter initialEntries={[`/w/${FIXTURE_WORLD_ID}/proposals`]}>
      <App />
    </MemoryRouter>,
  ).replaceAll("<!-- -->", "");
}

describe("the approvals screen head", () => {
  it("offers accepting them all, as the design does", () => {
    const html = render(stateWith([worldChatProposal()]));
    assert.match(html, /Accept all 1/);
  });

  it("counts entities rather than files", () => {
    // The design says "12 changes across 5 entities". A reviewer thinks in people and rules, not
    // in paths, and the screen said "files" until this was checked against the design.
    const html = render(stateWith([worldChatProposal()]));
    assert.match(html, /across \d+ entit(y|ies)/);
  });

  it("refuses accept-all while one of them needs a second look", () => {
    const html = render(stateWith([worldChatProposal({ pendingReview: true })]));
    assert.match(html, /Accept all 1/);
    assert.match(
      html,
      /rebased and needs a look first/,
      "and says why, rather than presenting a dead button",
    );
  });

  it("refuses accept-all while one still asks a question", () => {
    const withChoice = worldChatProposal({
      openChoices: [
        {
          choiceId: "c1",
          kind: "duplicate-or-amend",
          question: "Is it new, or a change to CANON-018?",
          options: [
            { optionId: "create", label: "New" },
            { optionId: "amend:CANON-018", label: "Changes CANON-018" },
          ],
        },
      ],
    });
    assert.match(render(stateWith([withChoice])), /still asking a question/);
  });
});

describe("what did not come across", () => {
  it("names the point that did not carry, and why", () => {
    const html = render(
      stateWith(
        [worldChatProposal()],
        [
          {
            candidateId: "cand_01J8F3K2QW9VZX4N7M0RTYB6HD",
            summary: "whether the bells are whale bone",
            reason: "tentative",
          },
        ],
      ),
    );
    assert.match(html, /whether the bells are whale bone/, "named, never merely counted");
    assert.match(
      html,
      /You said maybe, so it cannot become a fact/,
      "and explained as a design decision rather than an error",
    );
  });

  it("says nothing when everything carried", () => {
    const html = render(stateWith([worldChatProposal()]));
    assert.ok(!html.includes("did not come with them"), "no empty explanation for nothing");
  });
});

describe("the detail pane", () => {
  it("shows what would change, not which files would change", () => {
    const html = render(stateWith([worldChatProposal()]));
    assert.match(html, /Inheritance may pass sideways/, "the entity, named");
    assert.match(html, /new rule/);
    assert.match(html, /The bells may be given outside the household\./, "the proposed value itself");
  });

  it("offers the way back to the conversation", () => {
    const html = render(stateWith([worldChatProposal()]));
    assert.match(
      html,
      /Send back to the conversation/,
      "without this the only way to say 'not like this' is to say 'no'",
    );
  });

  it("does not offer send-back for a proposal that came from a form", () => {
    const fromForm = worldChatProposal({ worldChatOrigins: undefined, source: "form" });
    const html = render(stateWith([fromForm]));
    assert.ok(
      !html.includes("Send back to the conversation"),
      "there is no conversation to send it back to",
    );
  });
});
