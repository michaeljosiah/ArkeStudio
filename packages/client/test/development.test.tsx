import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import type { ClientState, Episode } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { StoryScreen } from "../src/screens/production.js";
import { EpisodeChatScreen, EpisodeDetailScreen } from "../src/screens/development.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";

/**
 * The season page and the episode pair (design turn 91; supersedes turn 48's four-view strip).
 *
 * A production is exactly one season, so the Season view whose job was to say which season you
 * were in is the page's own header, and what is left as tabs are the two plural things. One level
 * down the same shape repeats: a chat that ends in an accept, and a page whose child is its list.
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
  try {
    return renderToString(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={routePath} element={element} />
        </Routes>
      </MemoryRouter>,
    ).replace(/<!-- -->/g, "");
  } finally {
    __setStateForTest(FIXTURE_STATE);
  }
}

const SEASON = (prodId: string) => `/w/${FIXTURE_WORLD_ID}/p/${prodId}/season`;
const ONE = episode("ep_the-missing-night", 1, { promise: { opens: "The page is gone." } });

describe("the season page (design turn 91)", () => {
  const seasonPage = (episodes: Episode[]) =>
    render(withMicrodrama(episodes), SEASON("bell-watch-season-1"), <StoryScreen />, "/w/:worldId/p/:prodId/season");

  it("has two tabs, and the season itself is the header rather than one of them", () => {
    const html = seasonPage([ONE]);
    assert.match(html, /Episodes · 7/, "the plural things are the tabs");
    assert.match(html, /Arcs · 0/);
    // A view you always land on is not a tab; a tab nobody can explain is worse.
    assert.doesNotMatch(html, /fy-seg__item[^>]*>Season</, "the Season tab is retired");
    assert.doesNotMatch(html, /fy-seg__item[^>]*>Direction</, "and so is Direction's");
    assert.match(html, /THE QUESTION IT ANSWERS/, "what the season is sits in the header");
    assert.match(html, /Who is ringing the drowned bell\?/);
    assert.match(html, /HOW IT ENDS/);
    assert.match(html, /SERIES ENGINE · READ-ONLY/, "inheritance is shown, not hidden");
    assert.match(html, /Every episode answers one bell/);
  });

  it("counts the season it promised, not the episodes that happen to exist", () => {
    // Seven were declared on the day it was made (turn 87), so the board is seven wide at once.
    const html = seasonPage([ONE]);
    assert.match(html, /7 episodes/);
    assert.match(html, /1 written/);
    assert.match(html, /6 of 7 promised by the season and not started/);
    assert.match(html, /OPEN TO START IT/, "the unwritten ones are a place to start, not a gap");
  });

  it("shows the Episodes tab with nothing written, because that is when it is looked for", () => {
    const html = seasonPage([]);
    assert.match(html, /Episodes · 7/, "the tab is not hidden until an episode exists");
    assert.match(html, /0 written/);
  });

  it("says where the season was decided, and that nothing here writes", () => {
    const html = seasonPage([ONE]);
    assert.match(html, /Production Chat/, "one way back into the thread");
    assert.match(html, /every change is a proposal/);
  });

  it("a non-episodic production keeps the single overview and no season controls", () => {
    const html = render(
      withMicrodrama([]),
      SEASON("saltlight"),
      <StoryScreen />,
      "/w/:worldId/p/:prodId/season",
    );
    assert.match(html, /OVERVIEW ·/, "the details screen renders, not the conversation");
    assert.ok(!html.includes("Season findings"), "no fake season intelligence for a film");
    assert.ok(!html.includes("SERIES ENGINE"), "no fake series card for a film");
  });
});

describe("an episode is a chat and a page, not one screen doing both (design turn 91)", () => {
  const state = withMicrodrama([
    episode("ep_the-missing-night", 1, {
      promise: { opens: "The page is gone.", closes: "The bell rings once." },
      scenes: [],
    }),
  ]);
  const CHAT = `/w/${FIXTURE_WORLD_ID}/p/bell-watch-season-1/story/episodes/ep_the-missing-night`;
  const PAGE = `/w/${FIXTURE_WORLD_ID}/p/bell-watch-season-1/episodes/ep_the-missing-night`;

  it("the chat is a conversation about this episode, and nothing else", () => {
    const html = render(state, CHAT, <EpisodeChatScreen />, "/w/:worldId/p/:prodId/story/episodes/:episodeId");
    assert.match(html, /role="textbox"/, "a composer, not a form");
    assert.match(html, /EPISODE CHAT · 01/, "the subject is named");
    assert.match(html, /What happens in this one\?/);
    assert.doesNotMatch(html, /Edit the promise|Propose the promise/, "the promise editor is retired");
  });

  it("the chat's rail says what it understood while nothing is staged", () => {
    const html = render(state, CHAT, <EpisodeChatScreen />, "/w/:worldId/p/:prodId/story/episodes/:episodeId");
    assert.match(html, /What it understood/);
    // The two states are one rail at two moments, so the accept is absent until there is one.
    assert.doesNotMatch(html, /Accept Proposal/, "nothing is staged, so there is nothing to accept");
  });

  it("the page reads the promise and holds no editor", () => {
    const html = render(state, PAGE, <EpisodeDetailScreen />, "/w/:worldId/p/:prodId/episodes/:episodeId");
    assert.match(html, /OPENS/, "the promise's three lines are labelled");
    assert.match(html, /The page is gone\./);
    assert.match(html, /No scenes yet\./, "an empty membership is said, not hidden");
    assert.doesNotMatch(html, /role="textbox"/, "one thread, one place — the chat is next door");
    assert.doesNotMatch(html, /Edit the promise/, "authoring happens in the conversation");
  });

  it("the rail says Season on both of an episode's screens", () => {
    // Both live outside the `season` path, so neither lights a rail item on its own — and the
    // rail goes blank exactly when somebody is two levels deep and most wants to know where
    // they are. Season owns them because it is the level above.
    for (const path of [CHAT, PAGE]) {
      __setStateForTest(state);
      try {
        const html = renderToString(
          <MemoryRouter initialEntries={[path]}>
            <App />
          </MemoryRouter>,
        ).replace(/<!-- -->/g, "");
        const active = html.match(/fy-prodrail__item[^"]*--active[^>]*>[\s\S]*?<span class="fy-prodrail__label">([^<]*)/);
        assert.equal(active?.[1], "Season", `${path} lights Season`);
      } finally {
        __setStateForTest(FIXTURE_STATE);
      }
    }
  });

  it("the page can always be talked to again, and names the level above", () => {
    // An accept is not the end of a subject; a page that cannot be talked to again turns the
    // accept into a one-way door.
    const html = render(state, PAGE, <EpisodeDetailScreen />, "/w/:worldId/p/:prodId/episodes/:episodeId");
    assert.match(html, /Talk it through/);
    assert.match(html, /← Season/);
    assert.match(html, /every change is a proposal/);
  });
});
