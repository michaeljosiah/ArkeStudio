import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import type { ClientState, StagedProposal } from "@arke-studio/contracts";
import { CastScreen, FactionsScreen, LocationsScreen, WorldOverviewScreen } from "../src/screens/world.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";

/**
 * A drafting entity on the surface it will land on (issue 228).
 *
 * Submitting "Draft the sheet" returned to the Locations tab, which read "No locations yet" —
 * no spinner, no pending row, no toast — while the studio spent the next half-minute writing
 * the sheet behind the Proposals envelope. The action looked like it had failed, and the
 * obvious response was to submit it again and draft it twice. Characters had the same shape
 * right after world creation: "1 awaiting you" in the header and "No one lives here yet" in
 * the body, two contradictory statements about one world, on screen at once.
 */

const PROPOSAL = "pr_01J8E0000000000000000000P1";

function draftingProposal(path: string, label: string, id = PROPOSAL): StagedProposal {
  return {
    proposal: {
      id,
      kind: "new-sheet",
      summary: `New ${path.startsWith("characters/") ? "character" : path.startsWith("locations/") ? "location" : "faction"}: ${label}`,
      targets: [{ path, baseVersion: null, baseHash: null }],
      baseCanonRevision: 42,
      reservedCanonIds: [],
      source: "chat:studio",
      created: "2026-08-09T12:00:00.000Z",
      draftRevision: 1,
    },
    ripple: null,
    review: { targets: [{ path, label, kind: "new sheet", action: "create", fields: [] }] },
  } as StagedProposal;
}

/** The world with no sheets of its own — the state the issue was reported against. */
function emptyWorldWith(proposals: StagedProposal[]): ClientState {
  const world = FIXTURE_STATE.world!;
  return { ...FIXTURE_STATE, world: { ...world, sheets: [], proposals } };
}

function render(state: ClientState, path: string, element: React.ReactNode): string {
  __setStateForTest(state);
  const html = renderToString(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/w/:worldId/*" element={element} />
      </Routes>
    </MemoryRouter>,
  );
  // Server rendering splits a sentence at every interpolation with a comment marker. Neither
  // that nor the escaped apostrophe is on screen, and asserting around them would be asserting
  // about React rather than about the screen.
  return html.replace(/<!-- -->/g, "").replace(/&#x27;/g, "'");
}

const W = `/w/${FIXTURE_WORLD_ID}`;

describe("an entity being drafted shows as pending, not as nothing (issue 228)", () => {
  it("replaces the Locations empty state with the place that is on its way", () => {
    const html = render(
      emptyWorldWith([draftingProposal("locations/ojuelegba-junction.md", "Ojuelegba Junction")]),
      `${W}/locations`,
      <LocationsScreen />,
    );
    assert.ok(html.includes("Ojuelegba Junction"), "the place the user just asked for is on the screen");
    assert.equal(html.includes("No locations yet"), false, "an empty state never means 'something is on its way'");
    assert.ok(html.includes("drafting"), "and it says which of the three things is true");
  });

  it("keeps the empty state when there is genuinely nothing", () => {
    const html = render(emptyWorldWith([]), `${W}/locations`, <LocationsScreen />);
    assert.ok(html.includes("No locations yet"), "nothing here still means nothing here");
  });

  it("does the same for the cast ledger and for factions", () => {
    const cast = render(
      emptyWorldWith([draftingProposal("characters/timi-j.md", "Timi J")]),
      `${W}/cast`,
      <CastScreen />,
    );
    assert.ok(cast.includes("Timi J"));
    assert.equal(cast.includes("No characters yet"), false);

    const factions = render(
      emptyWorldWith([draftingProposal("factions/the-ebb-council.md", "The Ebb Council")]),
      `${W}/factions`,
      <FactionsScreen />,
    );
    assert.ok(factions.includes("The Ebb Council"));
    assert.equal(factions.includes("No factions yet"), false);
  });

  it("stops the hub saying 'awaiting you' and 'no one lives here' at once", () => {
    // The two statements the issue caught on screen together, about the same world.
    const html = render(
      emptyWorldWith([draftingProposal("characters/timi-j.md", "Timi J")]),
      W,
      <WorldOverviewScreen />,
    );
    assert.ok(html.includes("1 awaiting you"), "the header still counts what is waiting");
    assert.equal(html.includes("No one lives here yet"), false, "and the body no longer contradicts it");
    assert.ok(html.includes("Timi J"), "the character being drafted is the one awaiting");
  });

  it("counts the drafting ones apart from the ones that exist", () => {
    // A draft is not a place yet, so the count of places does not move — it is said separately.
    const html = render(
      emptyWorldWith([draftingProposal("locations/ojuelegba-junction.md", "Ojuelegba Junction")]),
      `${W}/locations`,
      <LocationsScreen />,
    );
    assert.ok(html.includes("0 place"), "nothing has landed yet");
    assert.ok(html.includes("1 drafting"), "and one is on the way");
  });

  it("sends the pending card to Proposals, where the yes it waits for is given", () => {
    const html = render(
      emptyWorldWith([draftingProposal("locations/ojuelegba-junction.md", "Ojuelegba Junction")]),
      `${W}/locations`,
      <LocationsScreen />,
    );
    // The label is what a screen reader is handed, and it says both the state and the way out.
    assert.match(html, /aria-label="Ojuelegba Junction — [^"]*Open Proposals\./);
  });

  it("leaves a world that has sheets showing them, drafting ones alongside", () => {
    const world = FIXTURE_STATE.world!;
    const state: ClientState = {
      ...FIXTURE_STATE,
      world: { ...world, proposals: [draftingProposal("characters/timi-j.md", "Timi J")] },
    };
    const html = render(state, `${W}/cast`, <CastScreen />);
    assert.ok(html.includes("Maren Kest"), "the cast it already has");
    assert.ok(html.includes("Timi J"), "and the one on its way");
  });
});
