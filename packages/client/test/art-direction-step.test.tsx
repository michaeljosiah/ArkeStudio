import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { ArtStyleGrid, ArtStyleWords } from "../src/components/art-style-picker.js";
import { ART_STYLE_PRESETS, presetById, seedFrom } from "../src/lib/art-styles.js";
import { proposedMasterLookNote, splitDescription } from "../src/screens/art-direction.js";
import { NewWorldScreen } from "../src/screens/shell.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * Genesis asks for the look (design turn 38). The rule under test is the one that decides what
 * ends up on disk: a preset seeds words and is then discarded, so only the text is stored and an
 * edited preset is the same record as a hand-written look.
 */

describe("the preset library", () => {
  it("offers nine looks and a custom door, all as cards of equal standing", () => {
    assert.equal(ART_STYLE_PRESETS.length, 9);
    const html = renderToString(<ArtStyleGrid selectedId={null} onSelect={() => {}} />);
    for (const preset of ART_STYLE_PRESETS) assert.ok(html.includes(preset.name), preset.name);
    assert.ok(html.includes("Describe your own"));
    // Custom is the selection when nothing was picked — writing your own is not a fallback.
    assert.match(html.slice(html.indexOf("Describe your own") - 400), /is-selected/);
  });

  it("every preset seeds words about the treatment, and none of them is empty", () => {
    for (const preset of ART_STYLE_PRESETS) {
      assert.ok(preset.description.trim().length > 40, `${preset.id} says something`);
      assert.ok(preset.blurb.trim().length > 0);
    }
    assert.equal(new Set(ART_STYLE_PRESETS.map((p) => p.id)).size, 9, "ids are distinct");
  });

  it("says the words were seeded, and says so differently once they are edited", () => {
    const painterly = presetById("painterly-realism")!;
    const seeded = renderToString(
      <ArtStyleWords selectedId={painterly.id} value={painterly.description} onChange={() => {}} />,
    );
    assert.ok(seeded.includes("SEEDED BY PAINTERLY REALISM"));
    assert.ok(!seeded.includes("EDITED"));

    const edited = renderToString(
      <ArtStyleWords selectedId={painterly.id} value={`${painterly.description} And fog.`} onChange={() => {}} />,
    );
    assert.ok(edited.includes("EDITED"), "an edited preset says so — the text is the record now");

    const own = renderToString(<ArtStyleWords selectedId={null} value="Anything." onChange={() => {}} />);
    assert.ok(own.includes("YOUR OWN WORDS"));
  });
});

describe("the art-direction step of genesis", () => {
  const render = () =>
    renderToString(
      <MemoryRouter>
        <NewWorldScreen />
      </MemoryRouter>,
    );

  it("does not ask for the look until the world has been described", () => {
    __setStateForTest(FIXTURE_STATE);
    const html = render();
    assert.ok(!html.includes("STEP 3 OF 3"), "the look is the last question, not the first");
    assert.ok(html.includes("Begin in this world"));
  });

  it("promises the step rather than springing it, so Begin is not a surprise", () => {
    __setStateForTest(FIXTURE_STATE);
    assert.ok(render().includes("One more question"));
  });
});

describe("the words a card seeds", () => {
  it("empties them for the custom door, so nothing is stored that nobody wrote", () => {
    // Pick Editorial print, change your mind, click Describe your own — the box used to keep
    // Editorial print's sentence while the line under it said nothing was seeded, and accepting
    // from there stored those words as if someone had written them.
    assert.equal(seedFrom(null), "");
    assert.equal(seedFrom(presetById("editorial-print")!), presetById("editorial-print")!.description);
  });
});

/**
 * What the review says the proposal does to the master image.
 *
 * This read `proposed?.masterLook ?? direction.masterLook` and captioned the result "master image
 * retained" — so a proposal carrying no image showed the current one, over a promise to keep it,
 * and accepting removed it. A conversation's look change never carries an image, which made that
 * every one of them. Presence, not fallback: the three cases are genuinely different.
 */
describe("the master image on a proposed look", () => {
  it("says it is retained when the proposal carries the same image", () => {
    assert.equal(proposedMasterLookNote("looks/a.png", "looks/a.png", true), "New style · master image retained");
  });

  it("says it is removed when the proposal carries none", () => {
    assert.equal(proposedMasterLookNote(null, "looks/a.png", true), "New style · master image removed");
  });

  it("says it is new when the proposal carries a different one", () => {
    assert.equal(proposedMasterLookNote("looks/b.png", "looks/a.png", true), "New master image");
  });

  it("borrows the current image only while nothing is staged to misdescribe", () => {
    assert.equal(proposedMasterLookNote(null, "looks/a.png", false), "New style · master image retained");
  });
});

/**
 * The heading over a look is typography, not meaning.
 *
 * It is the description's own opening, promoted to display type — and the whole description is
 * what every generation receives. The rule that matters here is that the split never loses a
 * word: heading plus body reads back as what was written, whichever branch produced it.
 */
describe("splitting a look into a heading and a body", () => {
  const rejoin = (split: { title: string; body: string }) => `${split.title} ${split.body}`.trim();
  /** Word sequence, so the assertion is about words kept — not about the punctuation at a seam. */
  const words = (text: string) => text.toLowerCase().match(/[a-z0-9-]+/g) ?? [];

  it("promotes a short first sentence and leaves the rest as the body", () => {
    const split = splitDescription("Painterly and cold. Wide lenses, low sun, no gloss.");
    assert.equal(split.title, "Painterly and cold.");
    assert.equal(split.body, "Wide lenses, low sun, no gloss.");
  });

  it("gives a one-sentence look no body rather than printing it twice", () => {
    const split = splitDescription("A quiet, painterly near-future.");
    assert.equal(split.title, "A quiet, painterly near-future.");
    assert.equal(split.body, "");
  });

  it("breaks a run-on first sentence at its own structure instead of setting it all in display type", () => {
    // The shape a look is actually written in: one long line, the real title before the colon.
    const look =
      "Cinematic painterly 3D animation with an Arcane-like visual sensibility: premium French " +
      "animated-drama production quality, hand-painted textures over stylized 3D forms, expressive " +
      "visible brushwork, no photorealism. The world should feel real enough to believe.";
    const split = splitDescription(look);
    assert.equal(split.title, "Cinematic painterly 3D animation with an Arcane-like visual sensibility");
    assert.ok(split.title.length <= 120, "a heading stays a heading");
    assert.ok(split.body.startsWith("premium French"), split.body.slice(0, 40));
    assert.ok(split.body.endsWith("real enough to believe."), "the later sentences are still there");
  });

  it("falls back to the last comma that fits when there is no structural break", () => {
    const look =
      "Hand-painted textures over stylized three-dimensional forms, expressive visible brushwork, " +
      "graphic shadow masses, restrained colour scripting throughout every frame.";
    const split = splitDescription(look);
    assert.ok(split.title.length <= 120, split.title);
    assert.ok(look.startsWith(split.title), "the heading is the opening, verbatim");
    assert.ok(split.body.endsWith("every frame."), split.body);
    assert.deepEqual(words(rejoin(split)), words(look));
  });

  it("keeps every word: heading plus body is the description again", () => {
    for (const look of [
      "One line only",
      "First. Second. Third.",
      "A: B",
      `${"very long opening clause ".repeat(8)}: and the rest of it.`,
      "No terminator, no colon, just a long line of commas, and more commas, running on and on and on",
    ]) {
      assert.deepEqual(words(rejoin(splitDescription(look))), words(look), look.slice(0, 40));
    }
  });
});
