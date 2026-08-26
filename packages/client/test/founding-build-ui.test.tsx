import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import type { ClientState, FoundingBuildState } from "@arke-studio/contracts";
import { BuildingScreen } from "../src/screens/building.js";
import { ActivityScreen } from "../src/screens/shell.js";
import { foundingNote } from "../src/components/queue-note.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";

/**
 * The building screen and the completion notice (SPEC-031 §1.8, §1.9). The coordinator's
 * fold is the truth; these assert the screen projects it — the stages, the real fraction,
 * the working line naming the item — and that the notice is a count and a cause with one
 * action, never a decision.
 */

function build(overrides: Partial<FoundingBuildState> = {}): FoundingBuildState {
  return {
    buildId: "fb_01J8E0000000000000000000B1",
    worldId: FIXTURE_WORLD_ID,
    genesisId: "gen-test",
    worldName: "The Undersong",
    status: "running",
    stages: [
      { id: "understanding", label: "Understanding your vision", state: "complete" },
      { id: "shaping", label: "Shaping the world", state: "complete" },
      { id: "creating", label: "Creating characters", state: "active" },
      { id: "forging", label: "Forging history and lore", state: "pending" },
      { id: "finalizing", label: "Finalizing the details", state: "pending" },
    ],
    progress: { terminal: 5, authorized: 12 },
    working: ["Nadia · main photo"],
    items: [],
    shortfall: null,
    noticeDismissed: false,
    capMicroUsd: 360000,
    estimatedSpendMicroUsd: 120000,
    ...overrides,
  };
}

function renderBuilding(state: FoundingBuildState | null): string {
  const clientState: ClientState = {
    ...FIXTURE_STATE,
    app: { ...FIXTURE_STATE.app, builds: state === null ? [] : [state] },
  };
  __setStateForTest(clientState);
  return renderToString(
    <MemoryRouter initialEntries={[`/building/${FIXTURE_WORLD_ID}`]}>
      <Routes>
        <Route path="/building/:worldId" element={<BuildingScreen />} />
        <Route path="/w/:worldId" element={<div data-screen="world-overview" />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("the building screen (SPEC-031 §1.8)", () => {
  it("shows five stages, the real fraction, the named item, and Stop", () => {
    const html = renderBuilding(build());
    for (const label of [
      "Understanding your vision",
      "Shaping the world",
      "Creating characters",
      "Forging history and lore",
      "Finalizing the details",
    ]) {
      assert.ok(html.includes(label), `the stage rail names ${label} (R-38)`);
    }
    assert.ok(html.includes("5") && html.includes("12"), "items terminal over items authorized (R-40)");
    assert.ok(html.includes("Nadia · main photo"), "the working line names the item, not the stage (R-41)");
    assert.ok(html.includes("Stop"), "Stop is offered (R-42)");
    assert.ok(html.includes("what is made is kept"), "and says what stopping keeps (R-42)");
    assert.ok(html.includes("CRAFTING YOUR UNIVERSE"), "the one ceremony line at the head (R-43)");
    assert.ok(
      !html.includes("Our world builder") && !html.includes("Every great story"),
      "the mock's other two ceremony lines were cut (R-43, design turn 104)",
    );
  });
});

describe("the completion notice (SPEC-031 §1.9)", () => {
  const shortfall = { count: 3, cause: "the provider rejected the credential" };

  it("is a count and a cause with one action, and never shows mid-run (R-44, R-46)", () => {
    assert.equal(foundingNote(build()), null, "no notice while the run is going");
    const note = foundingNote(build({ status: "completed", shortfall }));
    assert.ok(note);
    assert.match(note.title, /3 items/, "the count, once");
    assert.equal(note.reason, shortfall.cause, "the cause, once — not a list");
    assert.deepEqual(note.action, { label: "Activity", to: "/activity" }, "one action: the screen that acts (R-47)");
  });

  it("stays until dismissed or nothing it names is outstanding (R-45)", () => {
    assert.equal(foundingNote(build({ status: "completed", shortfall, noticeDismissed: true })), null);
    assert.equal(foundingNote(build({ status: "completed", shortfall: null })), null);
    assert.ok(foundingNote(build({ status: "stopped", shortfall })), "a stopped run's shortfall is told too");
  });
});

describe("Activity derives rows from the build record (SPEC-031 R-48)", () => {
  it("an item never dispatched is as visible and as runnable as a failed one", () => {
    const state: ClientState = {
      ...FIXTURE_STATE,
      app: {
        ...FIXTURE_STATE.app,
        builds: [
          build({
            status: "completed",
            shortfall: { count: 2, cause: "no image model resolves" },
            items: [
              {
                key: "main-photo:maren-kest",
                kind: "main-photo",
                stage: 2,
                subject: "maren-kest",
                name: "Maren Kest",
                state: "unauthorized",
                authorized: false,
                estimatedMicroUsd: 0,
                detail: "no image model resolves",
              },
              {
                key: "key-art:world",
                kind: "key-art",
                stage: 3,
                subject: "key-art",
                name: "The Undersong",
                state: "failed",
                authorized: true,
                estimatedMicroUsd: 40000,
                detail: "the provider refused",
              },
            ],
          }),
        ],
      },
    };
    __setStateForTest(state);
    const html = renderToString(
      <MemoryRouter initialEntries={["/activity"]}>
        <Routes>
          <Route path="/activity" element={<ActivityScreen />} />
        </Routes>
      </MemoryRouter>,
    );
    assert.ok(html.includes("THE FOUNDING BUILD"), "the group is named");
    assert.ok(html.includes("Maren Kest · main photo"), "the unrun item has a row (row 25)");
    assert.ok(html.includes("The Undersong · key art"), "the failed item has a row");
    assert.match(html, /Run all/, "one press runs everything outstanding (R-11)");
  });
});
