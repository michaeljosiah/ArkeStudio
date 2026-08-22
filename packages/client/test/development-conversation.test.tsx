import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { ClientState } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";

/**
 * Development authors through its conversation, and only through it (design turn 86).
 *
 * The build had grown a second path: a form editor behind "Start the season" and "Edit the
 * direction", sitting beside a "Talk it through" button that opened the thread on another screen.
 * Two ways into one file is how a person ends up asking what the conversation is for — and the
 * answer, that it reads the world and drafts against it while a form cannot, is invisible from a
 * screen offering both.
 */

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

const prodId = FIXTURE_STATE.world!.productions[0]!.meta.id;
/** Development is the conversation (turn 88); the details it settles are next door. */
const DEV = `/w/${FIXTURE_WORLD_ID}/p/${prodId}/story`;
const DETAILS = `/w/${FIXTURE_WORLD_ID}/p/${prodId}/overview`;

describe("Development authors through its conversation (design turn 86)", () => {
  it("puts a composer in the view rather than a button to another screen", () => {
    const html = render(FIXTURE_STATE, DEV);
    assert.match(html, /role="textbox"/, "the conversation is here");
    // The control, not the phrase — prose may legitimately say "talk it through".
    assert.doesNotMatch(html, />Talk it through</, "not a door to somewhere else");
  });

  it("offers no second way to author the same file", () => {
    const html = render(FIXTURE_STATE, DEV);
    for (const editor of ["Start the overview", "Edit the overview", "Propose overview"]) {
      assert.doesNotMatch(html, new RegExp(editor), `${editor} is retired`);
      assert.doesNotMatch(render(FIXTURE_STATE, DETAILS), new RegExp(editor), `${editor} is not next door either`);
    }
  });

  it("says what talking does and does not do", () => {
    assert.match(render(FIXTURE_STATE, DEV), /talking changes nothing · wrap-up stages what you keep/);
  });

  it("keeps what the conversation can reach on the screen", () => {
    // The context pills are the honest version of "it reads the world": naming what is in reach
    // is what makes a receipt checkable rather than a claim.
    const html = render(FIXTURE_STATE, DEV);
    assert.match(html, /in context:/);
    assert.match(html, /cast sheets/);
  });
});

describe("an episodic Development keeps turn 48's layout", () => {
  /** The fixture's production, made episodic — a season plus one episode. */
  function episodic(): ClientState {
    const world = FIXTURE_STATE.world!;
    const production = world.productions[0]!;
    return {
      ...FIXTURE_STATE,
      world: {
        ...world,
        productions: [
          {
            ...production,
            meta: { ...production.meta, medium: "video" as const, kind: "microdrama" },
            season: { version: 1 },
          },
        ],
      },
    } as ClientState;
  }

  it("an episodic production's conversation asks about its season", () => {
    assert.match(render(episodic(), DEV), /What is this season\?/, "the thread knows what it is shaping");
  });

  it("the season carries the thread docked beside it, and still no form editor", () => {
    // Turn 88 took the conversation off this screen because every screen was half a place to
    // make something and half a place to read it. Turns 99 and 100 put it back — docked, in a
    // column of its own — which is a different thing: one artifact, one thread beside it, and
    // never a second way to author the same file.
    const html = render(episodic(), `/w/${FIXTURE_WORLD_ID}/p/${prodId}/season`);
    assert.match(html, /data-dock="conversation"/, "Arke is on the page it is about");
    assert.match(html, /Ask about the season/, "and it is the composer, not a link to one");
    assert.doesNotMatch(html, /Start the season|Edit the season|Propose season change/, "the form editor is retired");
  });

});
