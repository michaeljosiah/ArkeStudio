import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import type { ClientState, Episode, StagedProposal } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { ProductionChatScreen, SceneChatScreen, StoryScreen } from "../src/screens/production.js";
import { EpisodeChatScreen, EpisodeDetailScreen } from "../src/screens/development.js";
import { isDayOne } from "../src/lib/selectors.js";
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

/** A proposal staged against one path, with the gate's own reading of what it would change. */
function stagedAgainst(path: string, fields: Array<[string, string]>, summary: string): StagedProposal {
  return {
    proposal: {
      id: "pr_01J8H0000000000000000000T9",
      kind: "episode-edit",
      summary,
      targets: [{ path, baseVersion: null, baseHash: null }],
      baseCanonRevision: 42,
      reservedCanonIds: [],
      source: "form",
      created: "2026-08-20T18:00:00Z",
      draftRevision: 1,
    },
    ripple: null,
    review: {
      targets: [
        {
          path,
          label: summary,
          kind: "episode · v1",
          action: "create",
          fields: fields.map(([field, proposed]) => ({ field, before: null, proposed })),
        },
      ],
    },
  };
}

function withProposal(state: ClientState, staged: StagedProposal): ClientState {
  return { ...state, world: { ...state.world!, proposals: [staged] } };
}

describe("a press that stages something says so where it was pressed (design turn 92)", () => {
  const PROD = "bell-watch-season-1";

  it("an episode staged and not yet written is a tile on the board, not a gap", () => {
    // The press staged the episode correctly and the board did not change by one character; the
    // only mark was an unlabelled dot in the far corner of the chrome.
    const staged = stagedAgainst(
      `productions/${PROD}/episodes/episode-04.json`,
      [["Title", "Episode 04"], ["Order", "4"]],
      "New episode · Episode 04",
    );
    const html = render(
      withProposal(withMicrodrama([ONE]), staged),
      SEASON(PROD),
      <StoryScreen />,
      "/w/:worldId/p/:prodId/season",
    );
    assert.match(html, /STAGED · NOT WRITTEN YET/, "the tile says what happened to it");
    assert.match(html, /Started\. Waiting on the gate\./);
    assert.match(html, /1 started and waiting on the gate/, "and the board counts it");
    // Seven promised, one written, one started — five untouched, not six.
    assert.match(html, /5 of 7 promised by the season and not started/);
  });

  it("the gate's own labels are what the board reads, whatever their case", () => {
    // The review labels fields for reading — "Title", "Order" — not by the record's key names,
    // and a lowercase lookup silently produced an unnumbered tile carrying a summary for a title.
    const staged = stagedAgainst(
      `productions/${PROD}/episodes/episode-04.json`,
      [["Title", "The answering hour"], ["Order", "4"]],
      "New episode · Episode 04",
    );
    const html = render(
      withProposal(withMicrodrama([ONE]), staged),
      SEASON(PROD),
      <StoryScreen />,
      "/w/:worldId/p/:prodId/season",
    );
    assert.match(html, /The answering hour/, "the staged title, not the proposal's summary");
    assert.doesNotMatch(html, />··</, "and its number, not a placeholder");
  });
});

describe("one control, one destination (design turn 92)", () => {
  it("every episode tile opens the episode's page, written or not", () => {
    // This branched on whether anything was written, so the same click landed in two places
    // according to state a person cannot see before clicking.
    const html = render(
      withMicrodrama([
        episode("ep_written", 1, { promise: { opens: "The page is gone." } }),
        episode("ep_blank", 2),
      ]),
      SEASON("bell-watch-season-1"),
      <StoryScreen />,
      "/w/:worldId/p/:prodId/season",
    );
    // Both tiles are links, so where each leads is in the markup and readable. This assertion is
    // the reason they are links: with onClick the destination never reached the HTML at all, and
    // the test passed just as happily with the branch still in place.
    for (const id of ["ep_written", "ep_blank"]) {
      assert.match(html, new RegExp(`href="[^"]*/p/bell-watch-season-1/episodes/${id}"`), `${id} opens its page`);
    }
    assert.doesNotMatch(html, /href="[^"]*\/story\/episodes\//, "and neither opens a chat");
  });
});

describe("the season level has a wrap-up and an accept (design turn 92)", () => {
  const CHAT = `/w/${FIXTURE_WORLD_ID}/p/bell-watch-season-1/story`;
  const chat = (state: ClientState) =>
    render(state, CHAT, <ProductionChatScreen />, "/w/:worldId/p/:prodId/story");

  it("offers the wrap-up 89a draws, and says why it cannot be pressed yet", () => {
    // Production Chat had a link to Season and nothing else: no way to stage what had been said,
    // no way to accept it. The first hop anybody walks was the one place the pattern was missing.
    const html = chat(withMicrodrama([ONE]));
    assert.match(html, /Wrap up · stage what is settled/);
    assert.match(html, /nothing is settled yet · save a point above to make it ready/);
  });

  it("becomes the staged season under one Accept once wrap-up has run", () => {
    const staged = stagedAgainst(
      "productions/bell-watch-season-1/season.json",
      [["Question", "Who is ringing the drowned bell?"], ["Ending", "She rings to be found."]],
      "The season, as it stands",
    );
    const html = chat(withProposal(withMicrodrama([ONE]), staged));
    assert.match(html, /Ready to accept/);
    assert.match(html, /Accept Proposal/);
    assert.match(html, /She rings to be found\./, "the field the gate says would change");
    assert.match(html, /the gate writes season\.json · nothing else moves/);
    // The rail has two states and never both at once (turns 89, 91).
    assert.doesNotMatch(html, /What it understood/, "the points are not up beside a decision");
  });

  it("a production with no season stages its overview instead", () => {
    const staged = stagedAgainst(
      "productions/saltlight/story.json",
      [["Logline", "One night on the Vigil."]],
      "The story, as it stands",
    );
    const html = render(
      withProposal(withMicrodrama([]), staged),
      `/w/${FIXTURE_WORLD_ID}/p/saltlight/story`,
      <ProductionChatScreen />,
      "/w/:worldId/p/:prodId/story",
    );
    assert.match(html, /the gate writes story\.json · nothing else moves/);
    assert.match(html, /the overview/, "named as what it is, not as a season");
  });
});

describe("an episodic production's front page is its season (design turn 93)", () => {
  const PROD = "bell-watch-season-1";
  const home = (prodId: string) =>
    renderApp(withMicrodrama([ONE]), `/w/${FIXTURE_WORLD_ID}/p/${prodId}`);

  function renderApp(state: ClientState, path: string): string {
    __setStateForTest(state);
    try {
      return renderToString(
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>,
      ).replace(/<!-- -->/g, "");
    } finally {
      __setStateForTest(FIXTURE_STATE);
    }
  }

  it("the production's own address shows the season, not a second screen", () => {
    const html = home(PROD);
    assert.match(html, /data-screen="development"/, "the season page is the front page");
    assert.match(html, /Episodes · 7/);
    assert.doesNotMatch(html, /Nothing written yet/, "and never contradicts it with a day one");
  });

  it("the rail carries Season once, in the first slot", () => {
    const html = home(PROD);
    const labels = [...html.matchAll(/<span class="fy-prodrail__label">([^<]*)</g)].map((m) => m[1]);
    assert.equal(labels[0], "Season", "Season replaces Dashboard rather than sitting beside it");
    assert.equal(labels.filter((l) => l === "Season").length, 1, "and there is no second entry");
    assert.ok(!labels.includes("Dashboard"), "Dashboard is gone for this medium");
  });

  it("every other medium keeps its dashboard, having no season to be", () => {
    const html = renderApp(withMicrodrama([]), `/w/${FIXTURE_WORLD_ID}/p/saltlight`);
    const labels = [...html.matchAll(/<span class="fy-prodrail__label">([^<]*)</g)].map((m) => m[1]);
    assert.equal(labels[0], "Dashboard");
    assert.ok(labels.includes("Overview"), "and its overview beside it");
  });

  it("an empty season says where it gets shaped", () => {
    // A board of dashed tiles says what is missing and not what to do about it.
    const world = FIXTURE_STATE.world!;
    const bare = withMicrodrama([]);
    const stripped: ClientState = {
      ...bare,
      world: {
        ...bare.world!,
        productions: bare.world!.productions.map((prod) =>
          prod.meta.id === PROD ? { ...prod, season: { version: 1, defaults: { episodeCount: 7 } } } : prod,
        ),
      },
    };
    void world;
    const html = renderApp(stripped, `/w/${FIXTURE_WORLD_ID}/p/${PROD}`);
    assert.match(html, /Nothing decided yet\./);
    assert.match(html, /is where the season gets shaped/);
    assert.match(html, /OPEN TO START IT/, "beside the shape it was promised");
  });
});

describe("what counts as day one (design turn 93)", () => {
  const production = FIXTURE_STATE.world!.productions[0]!;
  const empty = { ...production, scenes: [], takes: [], chapters: [], episodes: [], season: null };

  it("an untouched production is on day one", () => {
    assert.equal(isDayOne(empty), true);
  });

  it("a season with a question is not, though it has no scene, take or chapter", () => {
    // This is the whole defect: the check counted three things a microdrama can be a long way
    // into a season without having, so a written season still opened on "Nothing written yet".
    assert.equal(isDayOne({ ...empty, season: { version: 1, question: "Who rings the bell?" } }), false);
    assert.equal(isDayOne({ ...empty, season: { version: 1, ending: "She rings it herself." } }), false);
  });

  it("so is a season with episodes and nothing else", () => {
    assert.equal(isDayOne({ ...empty, episodes: [episode("ep_one", 1)] }), false);
  });

  it("and a season record carrying only its defaults still is", () => {
    // Defaults come from the create form, not from anybody deciding anything (SPEC-023 R-16).
    assert.equal(isDayOne({ ...empty, season: { version: 1, defaults: { episodeCount: 7 } } }), true);
  });
});

describe("the pattern reaches the scene (design turn 94)", () => {
  /** The fixture's own video production has scenes; scene chat needs nothing else. */
  const prod = FIXTURE_STATE.world!.productions.find((p) => p.scenes.length > 0)!;
  const scene = prod.scenes[0]!;
  const CHAT = `/w/${FIXTURE_WORLD_ID}/p/${prod.meta.id}/story/scenes/${scene.id}`;

  it("a scene is talked through in place, not on World Chat", () => {
    // Every level above this one had already stopped sending people to another screen; this was
    // the level where the writing happens, and the one that gets used most.
    const html = render(FIXTURE_STATE, CHAT, <SceneChatScreen />, "/w/:worldId/p/:prodId/story/scenes/:sceneId");
    assert.match(html, /data-screen="scene-chat"/);
    assert.match(html, new RegExp(`SCENE CHAT · ${scene.number}`));
    assert.match(html, /role="textbox"/, "the conversation is here");
    assert.match(html, /How does this one go\?/);
  });

  it("its rail is the same two states as every level above", () => {
    const html = render(FIXTURE_STATE, CHAT, <SceneChatScreen />, "/w/:worldId/p/:prodId/story/scenes/:sceneId");
    assert.match(html, /What it understood/, "points while nothing is staged");
    assert.match(html, /Wrap up · stage what is settled/, "and the wrap-up that ends it");
    assert.doesNotMatch(html, /Accept Proposal/, "nothing staged, so nothing to accept");
  });

  it("a staged scene becomes the accept, and says it creates no shots", () => {
    const stem = prod.sceneFiles[scene.id]!;
    const staged = stagedAgainst(
      `productions/${prod.meta.id}/scenes/${stem}.json`,
      [["Title", "The verse rises"]],
      "Scene · the verse rises",
    );
    const html = render(
      { ...FIXTURE_STATE, world: { ...FIXTURE_STATE.world!, proposals: [staged] } },
      CHAT,
      <SceneChatScreen />,
      "/w/:worldId/p/:prodId/story/scenes/:sceneId",
    );
    assert.match(html, /Accept Proposal/);
    // A script belongs to a scene and creates nothing below it (turn 53).
    assert.match(html, /the gate writes this scene · it creates no shots/);
    assert.doesNotMatch(html, /What it understood/, "one rail, one state at a time");
  });
});
