import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { ClientState } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * A world that would not open used to look exactly like one still opening (issue 571): the
 * request is fire-and-forget, so with no world in the snapshot every screen under `/w/:worldId`
 * rendered its loader and nothing ever ended it. The refusal is what ends it.
 */

const OTHER_WORLD = "01M0F0DPTXSFXA50JQTM391BXX";
const REASON = ".history/characters/bray-half-hitch/v6.md: history snapshot conflicts with the committed version";

function render(state: ClientState, path = `/w/${FIXTURE_WORLD_ID}`): string {
  __setStateForTest(state);
  return renderToString(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

const refused: ClientState = {
  ...FIXTURE_STATE,
  world: null,
  worldOpenFailure: { worldId: FIXTURE_WORLD_ID, reason: REASON },
};

describe("a refused world open, on screen (issue 571)", () => {
  it("says so, and says why, instead of the loader", () => {
    const html = render(refused);
    assert.ok(html.includes("This world did not open"), "the state is named");
    assert.ok(html.includes("history snapshot conflicts"), "with the reason it was refused");
    assert.ok(html.includes("Try again"), "and a way to ask again");
    assert.equal(html.includes("opening the world"), false, "the loader is done");
  });

  it("still loads when there is no refusal — an absent world is not a refused one", () => {
    const html = render({ ...FIXTURE_STATE, world: null });
    assert.ok(html.includes("opening the world"), "a world on its way still says so");
    assert.equal(html.includes("This world did not open"), false);
  });

  it("states it on a production route too, which is a sibling tree and not a child", () => {
    // `/w/:worldId/p/:prodId` renders under ProductionLayout, not WorldLayout. A refusal surfaced
    // only in the world tree leaves every production screen on its loader — and productions are
    // where the world in the report kept its work.
    const html = render(refused, `/w/${FIXTURE_WORLD_ID}/p/the-drowning-season`);
    assert.ok(html.includes("This world did not open"));
    assert.ok(html.includes("history snapshot conflicts"));
  });

  it("offers a way out where the layout draws no chrome", () => {
    // The fixed workspaces render no AppChrome — their child supplies the breadcrumb — so a
    // refusal in that slot with only Try again strands anybody who reloaded at such a URL.
    const html = render(refused, `/w/${FIXTURE_WORLD_ID}/art-direction/propose`);
    assert.ok(html.includes("This world did not open"));
    assert.ok(html.includes("Worlds"), "and a route back that is not a retry");
  });

  it("keeps another world's refusal off this world's screen", () => {
    // The failure sits in the snapshot until some world opens, so a person who gives up on one
    // world and opens another must not be met by the first one's refusal.
    const html = render({
      ...FIXTURE_STATE,
      worldOpenFailure: { worldId: OTHER_WORLD, reason: REASON },
    });
    assert.equal(html.includes("This world did not open"), false);
  });
});
