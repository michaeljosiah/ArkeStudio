import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import type { ClientState, StagedProposal } from "@arke-studio/contracts";
import { ConnectedProposalPanel } from "../src/domain/connected.js";
import {
  __handleFrameForTest,
  __setStateForTest,
  __stateForTest,
  seedLiveRuns,
  type AuthoringActivity,
} from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * What a client that reloaded mid-draft is allowed to say and offer (issue 239).
 *
 * Authoring activity is folded from events, so a reload came back holding nothing for a run that
 * was still going — and offered Accept and Discard over a proposal an agent was writing into.
 * The snapshot now carries the live runs; these are the two halves of trusting it.
 */

const PROPOSAL = "pr_01J8E0000000000000000000P1";

function staged(id = PROPOSAL): StagedProposal {
  return {
    proposal: {
      id,
      kind: "sheet-edit",
      summary: "Revise appearance: Maren Kest",
      targets: [{ path: "characters/maren-kest.md", baseVersion: null, baseHash: null }],
      baseCanonRevision: 42,
      reservedCanonIds: [],
      source: "chat:studio",
      created: "2026-08-10T12:00:00.000Z",
      draftRevision: 1,
    },
    ripple: null,
  } as StagedProposal;
}

function worldWith(proposals: StagedProposal[]): ClientState {
  const world = FIXTURE_STATE.world!;
  return { ...FIXTURE_STATE, world: { ...world, proposals } };
}

describe("seeding live authoring runs from the snapshot (issue 239)", () => {
  it("takes a run the client never saw start", () => {
    const seeded = seedLiveRuns({}, [PROPOSAL]);
    assert.deepEqual(seeded[PROPOSAL], { status: "running", lines: [] });
  });

  it("keeps the progress lines of a run it did see, without re-describing it", () => {
    const before: Record<string, AuthoringActivity> = {
      [PROPOSAL]: { status: "completed", detail: "wrote 2 files", lines: ["reading the sheet"] },
    };
    const seeded = seedLiveRuns(before, [PROPOSAL]);
    assert.equal(seeded[PROPOSAL]?.status, "running");
    assert.deepEqual(seeded[PROPOSAL]?.lines, ["reading the sheet"], "the lines are the same run's");
    assert.equal(
      seeded[PROPOSAL]?.detail,
      undefined,
      "the previous turn's ending said something about that turn, not this one",
    );
    assert.equal(before[PROPOSAL]?.status, "completed", "and the input is not mutated");
  });

  it("leaves a running entry exactly as it stands", () => {
    const before: Record<string, AuthoringActivity> = {
      [PROPOSAL]: { status: "running", detail: "turn 2", lines: ["a", "b"] },
    };
    assert.deepEqual(seedLiveRuns(before, [PROPOSAL])[PROPOSAL], before[PROPOSAL]);
  });

  it("claims nothing about a proposal the snapshot leaves out", () => {
    // Absence means nothing is writing into it now. How an unseen run *ended* is not something
    // a snapshot can say, and inventing an ending is the false claim this issue is about.
    const before: Record<string, AuthoringActivity> = { [PROPOSAL]: { status: "running", lines: [] } };
    assert.deepEqual(seedLiveRuns(before, []), before);
    assert.deepEqual(seedLiveRuns({}, []), {});
  });
});

describe("the gate over a proposal being written into (issue 239)", () => {
  it("offers neither Accept nor Discard, and says why", () => {
    __setStateForTest(worldWith([staged()]), {
      authoring: { [PROPOSAL]: { status: "running", lines: [] } },
    });
    const html = renderToString(<ConnectedProposalPanel staged={staged()} />);

    assert.match(html, /studio is drafting/, "the run is named on the panel");
    assert.match(html, /still drafting — cancel first/, "and the refusal explains itself");
    // Both buttons render disabled rather than vanishing, so the panel keeps its shape.
    for (const label of ["Accept", "Discard"]) {
      const at = html.indexOf(`>${label}<`);
      assert.ok(at > 0, `${label} is on the panel`);
      assert.match(html.slice(0, at).split("<button").pop()!, /disabled/, `${label} is disabled`);
    }
  });

  it("offers both once nothing is writing into it", () => {
    __setStateForTest(worldWith([staged()]), { authoring: {} });
    const html = renderToString(<ConnectedProposalPanel staged={staged()} />);

    assert.doesNotMatch(html, /studio is drafting/);
    const at = html.indexOf(">Accept<");
    assert.ok(at > 0, "Accept is on the panel");
    assert.doesNotMatch(html.slice(0, at).split("<button").pop()!, /disabled/, "and it is live");
  });
});

describe("the reusable attended gate card (SPEC-040)", () => {
  it("keeps every recovery control and the computed review and ripples", () => {
    const base = staged();
    const complete: StagedProposal = {
      ...base,
      proposal: {
        ...base.proposal,
        pendingReview: true,
        conflicts: [{
          path: "characters/maren-kest.md",
          field: "Essence",
          base: "Before",
          mine: "Mine",
          theirs: "Theirs",
        }],
        openChoices: [{
          choiceId: "choice-1",
          kind: "unchecked-novelty",
          question: "Which account is true?",
          options: [{ optionId: "mine", label: "The draft" }, { optionId: "theirs", label: "The world" }],
        }],
      },
      review: {
        targets: [{
          path: "characters/maren-kest.md",
          label: "Maren Kest",
          kind: "character sheet · v4",
          action: "amend",
          fields: [{ field: "Essence", before: "Before", proposed: "After" }],
        }],
      },
      ripple: {
        computedAt: "2026-09-03T12:00:00.000Z",
        governing: false,
        items: [{ kind: "owning-canon-rules", summary: "Two rules may need review", targets: ["CANON-002"] }],
      },
    };
    __setStateForTest(worldWith([complete]), {
      gateNotices: { [PROPOSAL]: { reason: "stale", detail: "The exact stale refusal." } },
    });
    const html = renderToString(<ConnectedProposalPanel staged={complete} />);
    for (const text of [
      "Before",
      "After",
      "Two rules may need review",
      "The exact stale refusal.",
      "Rebase onto current",
      "I&#x27;ve reviewed the merged result",
      "This proposal",
      "The world now",
      "Which account is true?",
      "Discard",
    ]) {
      assert.ok(html.includes(text), `${text} is on the shared card`);
    }
  });

  it("offers explicit reconfirmation against the authoritative ripple signature", () => {
    const proposal = staged();
    __setStateForTest(worldWith([proposal]), {
      gateNotices: {
        [PROPOSAL]: {
          reason: "needs-reconfirm",
          detail: "The consequences grew.",
          authoritativeSignature: "signature-2",
        },
      },
    });
    const html = renderToString(<ConnectedProposalPanel staged={proposal} />);
    assert.match(html, /Accept with these consequences/);
    assert.match(html, /The consequences grew/);
  });
});

/**
 * The refusal describes the run, not the proposal — so it has to leave when the run does.
 *
 * Every other gate notice is sticky until the proposal resolves, which is right for the things
 * they say: a stale base, a retired target, a field over its limit. "The studio is still
 * drafting" is the first that is about something transient, and left to the same rule it outlives
 * what it is about, sitting beside the Accept button it was explaining the absence of.
 */
describe("a drafting refusal outlives nothing (review of PR 371)", () => {
  const notice = { drafting: { reason: "drafting" as const, detail: "cancel the run first" } };

  it("clears when the run ends, without waiting for a snapshot", () => {
    __setStateForTest(worldWith([staged()]), {
      authoring: { [PROPOSAL]: { status: "running", lines: [] } },
      gateNotices: { [PROPOSAL]: notice.drafting },
    });
    __handleFrameForTest({
      kind: "event",
      seq: 2,
      event: {
        at: "2026-08-10T12:01:00.000Z",
        type: "authoring.status",
        worldId: FIXTURE_STATE.world!.meta.worldId,
        proposalId: PROPOSAL,
        status: "completed",
      },
    });

    assert.equal(__stateForTest().gateNotices[PROPOSAL], undefined, "the refusal went with the run");
    assert.equal(__stateForTest().authoring[PROPOSAL]?.status, "completed");

    // And the panel it was sitting on says nothing about drafting any more.
    const html = renderToString(<ConnectedProposalPanel staged={staged()} />);
    assert.doesNotMatch(html, /still drafting/);
  });

  it("clears on a snapshot that no longer names the run", () => {
    __setStateForTest(worldWith([staged()]), { gateNotices: { [PROPOSAL]: notice.drafting } });
    __handleFrameForTest({ kind: "snapshot", seq: 3, state: worldWith([staged()]) });
    assert.equal(__stateForTest().gateNotices[PROPOSAL], undefined);
  });

  it("stands while the snapshot still names the run", () => {
    __setStateForTest(worldWith([staged()]), { gateNotices: { [PROPOSAL]: notice.drafting } });
    __handleFrameForTest({
      kind: "snapshot",
      seq: 4,
      state: { ...worldWith([staged()]), authoringRuns: [PROPOSAL] },
    });
    assert.equal(__stateForTest().gateNotices[PROPOSAL]?.reason, "drafting", "the run is still going");
  });

  it("leaves every other reason alone — those are about the proposal", () => {
    __setStateForTest(worldWith([staged()]), {
      gateNotices: { [PROPOSAL]: { reason: "stale", detail: "moved since drafting" } },
    });
    __handleFrameForTest({ kind: "snapshot", seq: 5, state: worldWith([staged()]) });
    assert.equal(__stateForTest().gateNotices[PROPOSAL]?.reason, "stale");
  });
});
