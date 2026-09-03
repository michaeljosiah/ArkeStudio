import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import type { ClientState } from "@arke-studio/contracts";
import { GenerateScreen } from "../src/screens/production.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";

/**
 * Generate · review the takes (design turn 102c) — the takes are the front of the workspace,
 * watched side by side, and the marks on them tell no lies.
 *
 * Every case here is one the first cut got wrong, found by driving or by review 2026-08-22:
 * the address's shot ignored, a ✓ guessed onto a take nobody accepted, chips flattened across
 * scenes so two read "Shot 1", a second scene unreachable, and a foot with nothing to press.
 */

const GENERATE = `/w/${FIXTURE_WORLD_ID}/p/saltlight/generate`;
const ROUTE = "/w/:worldId/p/:prodId/generate";

function render(state: ClientState, path: string): string {
  __setStateForTest(state);
  try {
    return renderToString(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={ROUTE} element={<GenerateScreen />} />
        </Routes>
      </MemoryRouter>,
    ).replace(/<!-- -->/g, "");
  } finally {
    __setStateForTest(FIXTURE_STATE);
  }
}

type Production = NonNullable<ClientState["world"]>["productions"][number];

function withSaltlight(mutate: (p: Production) => Production): ClientState {
  const world = FIXTURE_STATE.world!;
  return {
    ...FIXTURE_STATE,
    world: {
      ...world,
      productions: world.productions.map((p) => (p.meta.id === "saltlight" ? mutate(p) : p)),
    },
  };
}

function withSecondScene(p: Production): Production {
  return {
    ...p,
    sceneFiles: { ...p.sceneFiles, sc_05: "05-the-lamps-hold" },
    scenes: [
      ...p.scenes,
      {
        id: "sc_05",
        number: 5,
        slug: "the-lamps-hold",
        title: "The lamps hold",
        status: "draft",
        version: 1,
        shots: [{ id: "sh_20", number: 20, title: "The lamps hold", description: "They hold." }],
      },
    ],
  };
}

describe("the takes, watched (turn 102c)", () => {
  it("opens on the takes with the accepted one marked, and the foot can act", () => {
    const html = render(FIXTURE_STATE, GENERATE);
    assert.ok(html.includes('data-screen="generate-workspace"'));
    assert.ok(html.includes("Take 1") && html.includes("Take 2"), "takes side by side");
    assert.ok(html.includes("✓ SELECTED"), "the accepted take is marked");
    assert.ok(html.includes("Open in generator"), "the workspace reaches the generation owner");
    assert.ok(html.includes("Accept take"), "and accept");
    assert.ok(html.includes("Reject"), "and teach");
    assert.ok(html.includes("Contact sheet") && html.includes("Advanced"), "the other lenses are doors, not tabs");
  });

  it("honours the shot the address carries (?shot=), which is how the storyboard sends one", () => {
    const html = render(FIXTURE_STATE, `${GENERATE}?shot=sh_13`);
    assert.ok(html.includes("Shot 13"), "the press's shot, not the first one");
    assert.ok(html.includes("No takes yet"), "said plainly when nothing has come back");
  });

  it("falls back to the first shot when the address names one that is not there", () => {
    const html = render(FIXTURE_STATE, `${GENERATE}?shot=sh_999`);
    assert.ok(html.includes("Shot 12"), "a stale link degrades, never crashes");
  });

  it("chips are the scene's shots; a second scene is a chip of its own, not a duplicate number", () => {
    const two = withSaltlight(withSecondScene);
    const html = render(two, GENERATE);
    assert.ok(html.includes('aria-label="Scene"'), "more than one scene, so the scene chips appear");
    assert.ok(html.includes("4 · The verse rises") && html.includes("5 · The lamps hold"), "scene names say what each filter contains");
    assert.ok(!html.includes("Shot 20"), "the shot chips stay scene-local — no flattened duplicates");

    const one = render(FIXTURE_STATE, GENERATE);
    assert.ok(!one.includes('aria-label="Scene"'), "one scene needs no scene chips");
  });

  it("puts narrowing filters before the current shot and adds episodes only to a series (#734)", () => {
    const episodic = withSaltlight((p) => ({
      ...withSecondScene(p),
      episodes: [
        { id: "ep_first", version: 1, order: 1, title: "First", scenes: ["sc_04"] },
        { id: "ep_second", version: 1, order: 2, title: "Second", scenes: ["sc_05"] },
      ],
      episodeFiles: { ep_first: "01-first", ep_second: "02-second" },
    }));
    const html = render(episodic, GENERATE);
    const filters = html.indexOf('aria-label="Take filters"');
    const heading = html.indexOf('<h1 class="fy-h1">');
    const grid = html.indexOf('class="fy-takegrid"');
    assert.ok(filters >= 0 && filters < heading && heading < grid, "filters, then current shot, then takes");
    assert.ok(html.includes('aria-label="Episode"') && html.includes(">01</button>") && html.includes(">02</button>"));
    assert.ok(!render(FIXTURE_STATE, GENERATE).includes('fy-takes__filter--episode'), "a film has no empty episode row");
  });

  it("never guesses the mark (review 2026-08-22): an acceptance on a hidden record marks nothing", () => {
    // A per-shot charge-split record carries the acceptance and no media of its own; the grid
    // filters it out. The first cut re-pointed ✓ at the newest visible take — marking takes
    // nobody accepted. Now nothing is marked, and the foot says exactly what is going on.
    const split = withSaltlight((p) => ({
      ...p,
      takes: [
        ...p.takes,
        {
          id: "tk_01J8H0000000000000000000C3",
          jobId: "jb_01J8E0000000000000000000J3",
          coversShots: ["sh_12"],
          kind: "clip" as const,
          provider: "fal",
          model: "seedance-2.0",
          provenance: { canonRevision: 42, sheets: {} },
          references: [],
          params: {},
          cost: { estimatedMicroUsd: 0, actualMicroUsd: 0, actualSource: "provider-reported" as const },
          dispatchedAt: "2026-07-30T14:05:00Z",
          completedAt: "2026-07-30T14:06:00Z",
        },
      ],
      selections: { sh_12: { acceptedTakeId: "tk_01J8H0000000000000000000C3", trimInSec: 0 } },
    }));
    const html = render(split, GENERATE);
    assert.ok(!html.includes("✓ SELECTED"), "no visible take wears a mark it did not earn");
    assert.ok(
      html.includes("accepted take holds no preview"),
      "and the foot explains instead of guessing",
    );
  });
});
