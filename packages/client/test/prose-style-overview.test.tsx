import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import type { ClientState, ProseStyle } from "@arke-studio/contracts";
import { StoryScreen } from "../src/screens/production.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * The style the book is written in, on the Overview (design turn 128, issue 896): cards under
 * the overview's, at the overview's measure, said to be settled in Develop and read by every
 * draft and revision. Voice and samples read aloud; point of view and tense do not.
 */

const STYLE: ProseStyle = {
  version: 2,
  pov: "close third",
  tense: "past",
  voice: "Short declaratives. Weather and stone before feeling.",
  samples: ["Six, and the tide not yet called.", "You do not read the ledger; you check it."],
};

function saltlight(proseStyle: ProseStyle | null): ClientState {
  const world = FIXTURE_STATE.world!;
  return {
    ...FIXTURE_STATE,
    world: {
      ...world,
      productions: world.productions.map((production) =>
        production.meta.id === "saltlight"
          ? {
              ...production,
              story: { version: 3, logline: "At slack water, a bell-keeper must answer a drowned city.", spine: "I. The bells still answer her." },
              proseStyle,
            }
          : production,
      ),
    },
  };
}

function overview(state: ClientState): string {
  __setStateForTest(state);
  try {
    return renderToString(
      <MemoryRouter initialEntries={[`/w/${FIXTURE_WORLD_ID}/p/saltlight/overview`]}>
        <Routes>
          <Route path="/w/:worldId/p/:prodId/overview" element={<StoryScreen />} />
        </Routes>
      </MemoryRouter>,
    ).replace(/<!-- -->/g, "");
  } finally {
    __setStateForTest(FIXTURE_STATE);
  }
}

describe("the style the book is written in, on the Overview (turn 128)", () => {
  it("draws point of view, tense, voice and the samples as cards under the overview's, with where it was settled", () => {
    const html = overview(saltlight(STYLE));
    assert.match(html, /The story, as it stands/);
    assert.match(html, /LOGLINE/, "the overview's own cards come first");
    assert.match(html, /v2 · settled in Develop · read by every draft and every revision/);
    assert.match(html, /POINT OF VIEW/);
    assert.match(html, /close third/);
    assert.match(html, /TENSE/);
    assert.match(html, /VOICE/);
    assert.match(html, /Weather and stone before feeling\./);
    assert.match(html, /SAMPLES · 2/);
    assert.match(html, /Six, and the tide not yet called\./);
    assert.ok(html.indexOf("LOGLINE") < html.indexOf("POINT OF VIEW"), "the style sits under the overview");
  });

  it("says nothing about a style that is not settled", () => {
    const html = overview(saltlight(null));
    assert.match(html, /The story, as it stands/);
    assert.doesNotMatch(html, /POINT OF VIEW|settled in Develop/);
  });
});
