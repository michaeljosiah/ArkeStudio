import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes } from "react-router";
import type { ClientState } from "@arke-studio/contracts";
import { episodeThumbnailPath, filterTakeEpisodes, GenerateScreen } from "../src/screens/production.js";
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

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }), innerWidth: 1024, innerHeight: 768 });
Object.assign(Object.getPrototypeOf(dom.document.createElement("video")), {
  pause() {},
  play: () => Promise.resolve(),
});
Object.assign(dom.HTMLElement.prototype, { scrollIntoView() {} });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (callback: (time: number) => void) => setTimeout(() => callback(0), 0),
});

interface Mounted {
  container: HTMLElement;
  root: Root;
}

const open: Mounted[] = [];

async function mount(state: ClientState, path = GENERATE): Promise<Mounted> {
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    __setStateForTest(state);
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={ROUTE} element={<GenerateScreen />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  const mounted = { container, root };
  open.push(mounted);
  return mounted;
}

afterEach(async () => {
  for (const mounted of open.splice(0)) {
    await act(async () => mounted.root.unmount());
    mounted.container.remove();
  }
  dom.document.body.replaceChildren();
  __setStateForTest(FIXTURE_STATE);
});

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

function episodicState(count = 2): ClientState {
  return withSaltlight((production) => {
    const withScenes = withSecondScene(production);
    const episodes = Array.from({ length: count }, (_, index) => {
      const order = index + 1;
      return {
        id: `ep_${String(order).padStart(3, "0")}`,
        version: 1,
        order,
        title: order === 1 ? "First" : order === 2 ? "Second" : order === 80 ? "Finale Run" : `Chapter ${order}`,
        scenes: order === 1 ? ["sc_04"] : order === 2 ? ["sc_05"] : [],
      };
    });
    return {
      ...withScenes,
      meta: { ...withScenes.meta, kind: "series" },
      episodes,
      episodeFiles: Object.fromEntries(episodes.map((episode) => [episode.id, `${episode.order}-${episode.title}`])),
    };
  });
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
    assert.ok(html.includes('title="4 · The verse rises"'), "the full clipped label is recoverable on hover");
    assert.ok(html.includes('class="fy-takechip__scene-label"'), "ellipsis belongs to the label inside the flex chip");
    assert.ok(!html.includes("Shot 20"), "the shot chips stay scene-local — no flattened duplicates");

    const one = render(FIXTURE_STATE, GENERATE);
    assert.ok(!one.includes('aria-label="Scene"'), "one scene needs no scene chips");
  });

  it("puts narrowing filters before the current shot and adds episodes only to a series (#734)", () => {
    const episodic = episodicState();
    const html = render(episodic, GENERATE);
    const filters = html.indexOf('aria-label="Take filters"');
    const heading = html.indexOf('<h1 class="fy-h1">');
    const grid = html.indexOf('class="fy-takegrid"');
    assert.ok(filters >= 0 && filters < heading && heading < grid, "filters, then current shot, then takes");
    assert.ok(html.includes('role="combobox"') && html.includes('aria-label="Episode"'));
    assert.ok(html.includes('value="01 · First"'), "one episode is always selected");
    assert.ok(!html.includes(">All</button>"), "there is no season-wide episode state");
    assert.ok(!html.includes("The lamps hold"), "scenes outside the selected episode are not rendered");
    assert.ok(!render(FIXTURE_STATE, GENERATE).includes('fy-takes__filter--episode'), "a film has no empty episode row");
  });

  it("searches a hundred-episode season by number or title without rendering a hundred chips", () => {
    const state = episodicState(100);
    const production = state.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!;
    assert.deepEqual(filterTakeEpisodes(production.episodes, "80 finale").map((episode) => episode.id), ["ep_080"]);
    assert.deepEqual(filterTakeEpisodes(production.episodes, "chapter 37").map((episode) => episode.id), ["ep_037"]);

    const html = render(state, GENERATE);
    assert.ok(html.includes('value="01 · First"'));
    assert.equal((html.match(/fy-takes__episode-option/g) ?? []).length, 0, "the closed picker keeps the large list out of the page");
  });

  it("derives a deep-linked shot's episode and an episode image from accepted take media", () => {
    const state = episodicState();
    const production = state.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!;
    assert.equal(
      episodeThumbnailPath(production, production.episodes[0]!),
      "productions/saltlight/takes/tk_01J8F0000000000000000000B2/frame.png",
    );

    const html = render(state, `${GENERATE}?shot=sh_20`);
    assert.ok(html.includes('value="02 · Second"'), "the address selects the shot's parent episode");
    assert.ok(html.includes("Shot 20"));
    assert.ok(!html.includes("Shot 12"), "shots remain inside the selected episode");
  });

  it("resets scene and shot scope when another episode is selected", async () => {
    const mounted = await mount(episodicState(3));
    let input = mounted.container.querySelector<HTMLInputElement>('input[aria-label="Episode"]')!;
    await act(async () => input.click());
    const second = [...mounted.container.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((option) => option.textContent?.includes("02 · Second"))!;
    await act(async () => second.click());

    assert.equal(input.value, "02 · Second");
    assert.ok(mounted.container.textContent?.includes("Shot 20"), "the first shot in the new episode is selected");
    assert.ok(!mounted.container.textContent?.includes("Shot 12"), "the old episode's shots leave the scope");

    await act(async () => input.click());
    const empty = [...mounted.container.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((option) => option.textContent?.includes("03 · Chapter 3"))!;
    await act(async () => empty.click());
    input = mounted.container.querySelector<HTMLInputElement>('input[aria-label="Episode"]')!;
    assert.equal(input.value, "03 · Chapter 3", "an unfinished episode keeps the navigator available");
    assert.ok(mounted.container.textContent?.includes("Nothing to review yet"));
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
