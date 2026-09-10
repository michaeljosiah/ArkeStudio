import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import type { ClientState, FoundingBuildState } from "@arke-studio/contracts";
import { BuildingScreen } from "../src/screens/building.js";
import { ActivityPanel } from "../src/components/activity-panel.js";
import { openActivityPanel } from "../src/lib/activity-panel.js";
import { foundingNote } from "../src/components/queue-note.js";
import { shortDate } from "../src/lib/format.js";
import { App } from "../src/App.js";
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
      { id: "understanding", label: "Blueprint ready", state: "complete" },
      { id: "shaping", label: "World records", state: "complete" },
      { id: "creating", label: "Main photos · establishing views", state: "active" },
      { id: "forging", label: "Character sheets · key art", state: "pending" },
      { id: "finalizing", label: "Finishing", state: "pending" },
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
      "Blueprint ready",
      "World records",
      "Main photos · establishing views",
      "Character sheets · key art",
      "Finishing",
    ]) {
      assert.ok(html.includes(label), `the stage rail names ${label} (R-38)`);
    }
    assert.ok(html.includes("5") && html.includes("12"), "items terminal over items authorized (R-40)");
    assert.ok(html.includes("Nadia · main photo"), "the working line names the item, not the stage (R-41)");
    assert.ok(html.includes("Stop"), "Stop is offered (R-42)");
    assert.equal(html.includes("what is made is kept"), false, "no caption under Stop (turn 137)");
    assert.ok(!html.includes("CRAFTING YOUR UNIVERSE"), "the build speaks in the same concrete voice as the studio (#930)");
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

  /*
   * A notice that persists has to age, and it has to stop being the world's ceiling (issue
   * 1007). It carried "the world is open and usable" — reassurance, which turn 69 rules off a
   * screen — and no date at all, so a shortfall from three days ago read exactly like one from
   * a minute ago, on every tab of the world.
   */
  it("dates itself and says nothing else in its meta band (issue 1007)", () => {
    const ended = foundingNote(build({ status: "completed", shortfall, endedAt: "2026-09-06T09:12:00.000Z" }));
    assert.ok(ended);
    assert.equal(ended.meta, shortDate("2026-09-06T09:12:00.000Z"), "the band is the date and nothing else");
    assert.doesNotMatch(ended.meta, /open and usable/, "no reassurance (design turn 69)");

    const stopped = foundingNote(build({ status: "stopped", shortfall, endedAt: "2026-09-06T09:12:00.000Z" }));
    assert.match(stopped!.meta, /^stopped by you · /, "a stopped run says so, then dates itself");

    // A build recorded before the stamp existed still raises its notice; it just has no date.
    const undated = foundingNote(build({ status: "completed", shortfall }));
    assert.equal(undated!.meta, "", "and never an em dash where a date should be");
  });
});

describe("where the completion notice draws (issue 1007)", () => {
  const withShortfall: ClientState = {
    ...FIXTURE_STATE,
    app: {
      ...FIXTURE_STATE.app,
      builds: [
        build({
          status: "completed",
          shortfall: { count: 3, cause: "openai: image generation failed" },
          endedAt: "2026-09-06T09:12:00.000Z",
        }),
      ],
    },
  };

  function at(path: string): string {
    __setStateForTest(withShortfall);
    return renderToString(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    );
  }

  /*
   * R-44 raises it on arrival at the world. Every tab was not arrival — it was a permanent
   * 110px band above nine screens that size themselves against the window, and it is what
   * pushed Save off the edit sheet, the composer off World Chat and the key art below the fold.
   */
  it("is on Overview, and on no other tab of the world", () => {
    assert.match(at(`/w/${FIXTURE_WORLD_ID}`), /did not land/, "Overview raises it");
    // Each tab is asserted to have actually drawn, so "no notice" cannot pass on a blank page.
    for (const [tab, screen] of [
      ["art-direction", "world-art-direction"],
      ["cast", "cast"],
      ["canon", "canon"],
      ["artifacts", "artifacts"],
    ] as const) {
      const html = at(`/w/${FIXTURE_WORLD_ID}/${tab}`);
      assert.match(html, new RegExp(`data-screen="${screen}"`), `${tab} drew`);
      assert.doesNotMatch(html, /did not land/, `${tab} carries no notice`);
    }
  });

  it("is one row — the count, the cause, the date, Activity and Dismiss", () => {
    const html = at(`/w/${FIXTURE_WORLD_ID}`);
    assert.match(html, /fy-buildnotice/, "its own row, not a callout with a paragraph in it");
    assert.match(html, /openai: image generation failed/, "the cause, once (R-46)");
    assert.match(html, /Dismiss/, "and the press that ends it (R-45)");
    assert.match(html, /Activity/, "and the one that acts (R-47)");
  });

  /*
   * R-46 puts the cause on the notice, and it has to be on the notice for everyone (codex round
   * four). The cause was clipped to one line with a `title` holding the rest — a copy a keyboard
   * or a touch screen cannot reach, which for those readers is the cause not being stated at all.
   */
  it("states the cause on the row itself, not in a tooltip", () => {
    const html = at(`/w/${FIXTURE_WORLD_ID}`);
    const row = /<div class="fy-buildnotice"[\s\S]*?<\/div>/.exec(html)?.[0] ?? "";
    assert.ok(row.includes("openai: image generation failed"), "the row carries it");
    assert.doesNotMatch(row, /title="openai/, "and does not hide the rest behind a hover");
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
    // Activity is a panel since design turn 136; the rows are the same, in the Inbox.
    openActivityPanel("inbox");
    const html = renderToString(
      <MemoryRouter initialEntries={["/activity"]}>
        <Routes>
          <Route path="/activity" element={<ActivityPanel />} />
        </Routes>
      </MemoryRouter>,
    );
    assert.ok(html.includes("The founding build"), "the group is named");
    assert.ok(html.includes("Maren Kest · main photo"), "the unrun item has a row (row 25)");
    assert.ok(html.includes("The Undersong · key art"), "the failed item has a row");
    assert.match(html, /Run all/, "one press runs everything outstanding (R-11)");
  });
});
