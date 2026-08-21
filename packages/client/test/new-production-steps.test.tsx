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

describe("creating a production is two steps (design turns 43, 53, 83, 99, 100)", () => {
  const NEW = `/w/${FIXTURE_WORLD_ID}/productions/new`;

  it("step one continues to step two rather than creating, and says which it will do", () => {
    const html = render(NEW);
    // Video is selected by default and has five kinds, so this family cannot create from here.
    assert.match(html, /Continue · what kind of video\?/, "the action names its destination");
    assert.doesNotMatch(html, /Create production/, "and does not offer to create past the kind");
  });

  it("step one asks the question rather than naming the dialog, and counts the steps it has", () => {
    const html = render(NEW);
    assert.match(html, /What are you making\?/, "the question is the title (turn 99)");
    assert.doesNotMatch(html, /New production<\/div>/, "the old title is gone");
    assert.match(html, /step 1 of 2/, "Video has a second step, so the counter is true");
  });

  it("step one promises that pressing it spends nothing, in half the words", () => {
    const html = render(NEW);
    assert.match(html, /nothing generates/, "the caption the frame puts under the buttons");
    assert.doesNotMatch(html, /nothing is copied out of the world/, "the joins line already says it");
  });

  it("step one holds the medium decision only — kinds, and interactive, belong to step two", () => {
    const html = render(NEW);
    for (const medium of ["Story", "Video"]) {
      assert.match(html, new RegExp(medium), `${medium} is offered`);
    }
    // Turn 100: interactive video is a kind, so its name must not appear on the first question.
    assert.doesNotMatch(html, /Interactive/, "interactive is a kind now, not a medium");
    assert.doesNotMatch(html, /Music video/, "kinds are not on step one");
    assert.doesNotMatch(html, /step 2 of 2/, "and neither is step two's counter");
  });

  it("the world stands behind the decision, blurred back", () => {
    const html = render(NEW);
    assert.match(html, /blur\(7px\) saturate\(\.8\)/, "the key art is the backdrop, not a repeated line of text");
  });
});

describe("step two offers every kind and every default (design turn 53)", () => {
  it("five kinds are offered, interactive and other among them, in the drawn order", () => {
    assert.deepEqual(
      VIDEO_KIND_CHOICES.map((k) => k.label),
      ["Micro drama · series", "Film · short", "Music video", "Interactive", "Other"],
      "five kinds, in the drawn order (turns 99, 100)",
    );
    assert.equal(VIDEO_KIND_CHOICES[0]!.body, "Episodes, vertical.");
    assert.equal(VIDEO_KIND_CHOICES[3]!.body, "The viewer chooses.");
  });

  it("each kind carries the frame it delivers in, and only a micro drama is vertical", () => {
    // Before turn 99 the aspect travelled for a micro drama alone, so a film could not be made
    // vertical until after it existed — and the state defaulted to 9:16 for everything.
    const byId = new Map(VIDEO_KIND_CHOICES.map((k) => [k.id, k.aspect]));
    assert.equal(byId.get("microdrama"), "9:16");
    for (const id of ["film", "music-video", "interactive", "other"] as const) {
      assert.equal(byId.get(id), "16:9", `${id} delivers landscape unless told otherwise`);
    }
  });

  it("how a season ends is not a default the door can ask (turn 99)", () => {
    const html = render(`/w/${FIXTURE_WORLD_ID}/productions/new`);
    assert.doesNotMatch(html, /ENDING/, "ending is storytelling, and belongs in the conversation");
    assert.doesNotMatch(html, /Cliffhanger/);
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
