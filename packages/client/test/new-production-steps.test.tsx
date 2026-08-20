import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { App } from "../src/App.js";
import { EPISODE_LENGTH_CHOICES, VIDEO_KIND_CHOICES, parseEpisodeLength } from "../src/screens/world.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";

/**
 * Creation is two steps, and step one refuses to create past a family that has more than one kind
 * (design turn 83, binding). The screen used to be one page: it revealed the kinds inline and
 * created from step one, so the kind and the numbers that differ between kinds were decided by a
 * button that said `Create production` — and `EPISODE LENGTH`, which turn 53 draws, was never
 * asked at all.
 *
 * These assert the copy the frames specify, because the copy is the binding: an action that names
 * its destination, and a promise beside it that pressing it spends nothing.
 */

function render(path: string): string {
  __setStateForTest(FIXTURE_STATE);
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

describe("creating a production is two steps (design turns 43, 53, 83)", () => {
  const NEW = `/w/${FIXTURE_WORLD_ID}/productions/new`;

  it("step one continues to step two rather than creating, and says which it will do", () => {
    const html = render(NEW);
    // Video is selected by default and has three kinds, so this family cannot create from here.
    assert.match(html, /Continue · what kind of video\?/, "the action names its destination");
    assert.doesNotMatch(html, /Create production/, "and does not offer to create past the kind");
  });

  it("step one promises that pressing it spends nothing", () => {
    assert.match(
      render(NEW),
      /nothing generates · nothing is copied out of the world/,
      "the caption the frame puts under the buttons",
    );
  });

  it("step one holds the format decision only — the kinds belong to step two", () => {
    const html = render(NEW);
    assert.match(html, /New production/);
    for (const medium of ["Story", "Video", "Interactive video"]) {
      assert.match(html, new RegExp(medium), `${medium} is offered`);
    }
    assert.doesNotMatch(html, /Music video/, "kinds are not on step one");
    assert.doesNotMatch(html, /step 2 of 2/, "and neither is step two's counter");
  });

  it("the world stands behind the decision, blurred back", () => {
    const html = render(NEW);
    assert.match(html, /blur\(7px\) saturate\(\.8\)/, "the key art is the backdrop, not a repeated line of text");
  });
});

describe("step two offers every kind and every default (design turn 53)", () => {
  it("all three kinds are offered, Music video among them, in the frame's own words", () => {
    assert.deepEqual(
      VIDEO_KIND_CHOICES.map((k) => k.label),
      ["Short film", "Music video", "Microdrama series"],
      "three kinds, in the drawn order",
    );
    assert.equal(VIDEO_KIND_CHOICES[0]!.body, "One linear work, scenes into a cut.");
    assert.equal(VIDEO_KIND_CHOICES[1]!.body, "Music-led timing, motifs, performance.");
  });

  it("episode length is a range a season can be written from", () => {
    assert.ok(EPISODE_LENGTH_CHOICES.length >= 2, "a choice with one answer would be a toll");
    for (const choice of EPISODE_LENGTH_CHOICES) {
      const range = parseEpisodeLength(choice.id);
      assert.ok(range, `${choice.id} parses`);
      assert.ok(range.min > 0 && range.max >= range.min, `${choice.id} is a real range`);
    }
    assert.deepEqual(parseEpisodeLength("45-75"), { min: 45, max: 75 }, "the Microdrama default");
  });

  it("a range that cannot be read is refused rather than written to the season", () => {
    // The value travels from a select into season.json. A season nobody can read back is worse
    // than a creation that leaves the defaults alone.
    for (const bad of ["", "-", "abc", "75-45", "0-0", "45"]) {
      assert.equal(parseEpisodeLength(bad), null, `"${bad}" is refused`);
    }
  });
});
