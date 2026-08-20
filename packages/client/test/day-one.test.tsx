import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { ClientState, WorldChatSummary } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";

/**
 * Day one is frame 53b (design turns 53, 83).
 *
 * What stood here was frame 43b: the world's inventory read back, and a rail of canon seeds. Turn
 * 53 cut it and turn 83 superseded it in whole — the inventory announced what the rail already
 * says, and the seeds guessed at a way of working nobody had done. Turn 83 leaves them a way back,
 * but only once the plain path has been used and found wanting, which is a decision to be taken
 * deliberately rather than by leaving the old screen up.
 */

/** The fixture's production, emptied — scenes, takes and chapters are what end day one. */
function dayOneState(): ClientState {
  const base = FIXTURE_STATE;
  const world = base.world!;
  const production = world.productions[0]!;
  return {
    ...base,
    world: {
      ...world,
      productions: [{ ...production, scenes: [], takes: [], chapters: [] }],
    },
  } as ClientState;
}

function render(state: ClientState, path: string): string {
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

describe("day one is a place to start writing (design turn 53b)", () => {
  const state = dayOneState();
  const prodId = FIXTURE_STATE.world!.productions[0]!.meta.id;
  const PATH = `/w/${FIXTURE_WORLD_ID}/p/${prodId}`;

  it("opens on the production's own name and says nothing is written yet", () => {
    const html = render(state, PATH);
    assert.match(html, /Nothing written yet\. Say what happens, and the first scene takes shape here\./);
    assert.match(
      html,
      new RegExp(FIXTURE_STATE.world!.productions[0]!.meta.title),
      "the heading is the production, not a greeting",
    );
  });

  it("offers a box to type in, and promises it writes nothing", () => {
    const html = render(state, PATH);
    assert.match(html, /role="textbox"/, "a composer, not a button that opens one elsewhere");
    assert.match(html, /talking writes nothing · you accept what you keep/);
  });

  it("offers exactly the two ways in the frame draws", () => {
    const html = render(state, PATH);
    assert.match(html, /Write the first scene/);
    assert.match(html, /Straight to a scene you can shoot\./);
    assert.match(html, /Shape the whole thing first/);
    assert.match(html, /Decide what it is before writing any of it\./);
  });

  it("no longer reads the world's inventory back, and no longer offers seeds", () => {
    const html = render(state, PATH);
    assert.doesNotMatch(html, /KNOWS IS ALREADY HERE/, "the inventory turn 53 cut");
    assert.doesNotMatch(html, /Seeds — open threads and loose ends/, "the seed rail turn 83 superseded");
    assert.doesNotMatch(html, /Day one\. The world walked in with you\./, "and the greeting that framed both");
  });

  it("keeps the delivery aspect reachable, below what the frame draws", () => {
    // Issue 389 postdates 53b, so it is the app's own addition; day one must not lose it, and
    // must not open with it either.
    const html = render(state, PATH);
    const aspectAt = html.indexOf("Delivery aspect");
    const cardsAt = html.indexOf("Shape the whole thing first");
    assert.ok(aspectAt > 0, "still reachable on day one");
    assert.ok(aspectAt > cardsAt, "and beneath the two ways in, not above the heading");
  });
});

describe("what was said on day one is visible where it lands", () => {
  it("Development shows the production thread's opening line", () => {
    const base = dayOneState();
    const world = base.world!;
    const prodId = world.productions[0]!.meta.id;
    const thread: WorldChatSummary = {
      id: "cv_01J8F3K2QW9VZX4N7M0RTYB6HC",
      title: "A salvage crew finds something the water left behind.",
      status: "open",
      updatedAt: "2026-08-20T09:00:00.000Z",
      entryContext: { kind: "production", productionId: prodId },
      pointCount: 0,
      openProposalCount: 0,
      notCarried: [],
    };
    const state: ClientState = { ...base, world: { ...world, conversations: [thread] } };
    const html = render(state, `/w/${FIXTURE_WORLD_ID}/p/${prodId}/story`);
    assert.match(
      html,
      /A salvage crew finds something the water left behind\./,
      "a send that lands on a screen with no trace of it reads as a lost message",
    );
    assert.match(html, /the Development thread · open to keep going/);
  });
});
