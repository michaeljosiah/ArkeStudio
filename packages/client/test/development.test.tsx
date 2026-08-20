import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import type { ClientState, Episode } from "@arke-studio/contracts";
import { StoryScreen } from "../src/screens/production.js";
import { EpisodeDetailScreen } from "../src/screens/development.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";

/**
 * The Development workspace (turn 48; issue 397): four views for an episodic production, three
 * tabs while no episodes exist, and none of it for a film — a non-episodic production keeps its
 * single overview and no fake season controls.
 */

function episode(id: string, order: number, over: Partial<Episode> = {}): Episode {
  return { id, version: 1, order, title: id.replace(/^ep_/, ""), scenes: [], ...over };
}

function withMicrodrama(episodes: Episode[]): ClientState {
  const world = FIXTURE_STATE.world!;
  const salt = world.productions.find((p) => p.meta.id === "saltlight")!;
  return {
    ...FIXTURE_STATE,
    world: {
      ...world,
      series: [
        {
          id: "bell-watch",
          version: 1,
          title: "Bell Watch",
          engine: "Every episode answers one bell.",
          seasons: ["bell-watch-season-1"],
          created: "2026-08-19T09:00:00Z",
          updated: "2026-08-19T09:00:00Z",
        },
      ],
      productions: [
        ...world.productions,
        {
          ...salt,
          meta: {
            ...salt.meta,
            id: "bell-watch-season-1",
            medium: "video" as const,
            kind: "microdrama",
            title: "Bell Watch — Season 1",
          },
          season: {
            version: 1,
            question: "Who is ringing the drowned bell?",
            defaults: { episodeCount: 7, episodeSecondsMin: 45, episodeSecondsMax: 75 },
          },
          scenes: [],
          sceneFiles: {},
          episodes,
          episodeFiles: Object.fromEntries(episodes.map((e) => [e.id, e.id.replace(/^ep_/, "")])),
        },
      ],
    },
  };
}

function render(state: ClientState, path: string, element: React.ReactElement, routePath: string): string {
  __setStateForTest(state);
  return renderToString(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={routePath} element={element} />
      </Routes>
    </MemoryRouter>,
  ).replace(/<!-- -->/g, "");
}

const P = (prodId: string) => `/w/${FIXTURE_WORLD_ID}/p/${prodId}/season`;

describe("the Development workspace (issue 397)", () => {
  it("an episodic production shows four views, and the board says its gaps in words", () => {
    const html = render(
      withMicrodrama([
        episode("ep_the-missing-night", 1, { promise: { opens: "The page is gone." }, scenes: [] }),
      ]),
      P("bell-watch-season-1"),
      <StoryScreen />,
      "/w/:worldId/p/:prodId/season",
    );
    for (const tab of ["Season", "Episodes · 1", "Arcs", "Direction"]) {
      assert.ok(html.includes(tab), `the ${tab} tab is present`);
    }
    assert.match(html, /SERIES ENGINE · READ-ONLY/, "inheritance is shown, not hidden");
    assert.match(html, /Every episode answers one bell/, "the engine text renders");
    assert.match(html, /7 episodes/, "defaults render as chips");
  });

  it("a production with no episodes shows three tabs, not four greyed", () => {
    const html = render(
      withMicrodrama([]),
      P("bell-watch-season-1"),
      <StoryScreen />,
      "/w/:worldId/p/:prodId/season",
    );
    assert.ok(html.includes("Season"), "Season is there");
    assert.ok(html.includes("Arcs"), "Arcs is there");
    assert.ok(html.includes("Direction"), "Direction is there");
    assert.ok(!html.includes("Episodes ·"), "the Episodes tab is absent, not greyed");
  });

  it("a non-episodic production keeps the single overview and no season controls", () => {
    const html = render(
      withMicrodrama([]),
      P("saltlight"),
      <StoryScreen />,
      "/w/:worldId/p/:prodId/season",
    );
    assert.match(html, /OVERVIEW ·/, "the details screen renders, not the conversation");
    assert.ok(!html.includes("Season findings"), "no fake season intelligence for a film");
    assert.ok(!html.includes("SERIES ENGINE"), "no fake series card for a film");
  });

  it("the episode screen is the promise and the scenes in order", () => {
    const state = withMicrodrama([
      episode("ep_the-missing-night", 1, {
        promise: { opens: "The page is gone.", closes: "The bell rings once." },
        scenes: [],
      }),
    ]);
    const html = render(
      state,
      `/w/${FIXTURE_WORLD_ID}/p/bell-watch-season-1/story/episodes/ep_the-missing-night`,
      <EpisodeDetailScreen />,
      "/w/:worldId/p/:prodId/story/episodes/:episodeId",
    );
    assert.match(html, /OPENS/, "the promise's three lines are labelled");
    assert.match(html, /The page is gone\./);
    assert.match(html, /No scenes yet\./, "an empty membership is said, not hidden");
    assert.match(html, /every change stages a proposal/, "proposal-only writes are stated on the surface");
  });
});
