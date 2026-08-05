import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { ArtStyleGrid, ArtStyleWords } from "../src/components/art-style-picker.js";
import { ART_STYLE_PRESETS, presetById } from "../src/lib/art-styles.js";
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
