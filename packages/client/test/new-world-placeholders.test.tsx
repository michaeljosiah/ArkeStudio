import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { NewWorldScreen } from "../src/screens/shell.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * The new-world form's placeholders (issue 230).
 *
 * Every field carried the sample world's real values — its name, its logline, its genre, its
 * first character, its first place — sitting exactly where the author's own words go. A form
 * that had not been touched looked filled in, and "Begin in this world" read as ready to press
 * on an empty one. It also anchored the author to one world's genre and naming style at the
 * moment they were supposed to be inventing their own.
 *
 * The sample world is still offered by name where it is genuinely on offer — the launch screen
 * and Settings · Sample world. This is about the fields the author types into.
 */

const UNDERSONG = [
  "The Undersong",
  "drowned god",
  "Coastal fantasy",
  "Maren Kest",
  "tide-caller",
  "The Vigil",
  "lighthouse that listens back",
];

function render(): string {
  // Form mode is the default with no harness; the chat front door replaces these fields entirely.
  __setStateForTest({
    ...FIXTURE_STATE,
    app: {
      ...FIXTURE_STATE.app,
      health: { ...FIXTURE_STATE.app.health, harness: { status: "unavailable", reason: "not configured" } },
    },
  });
  return renderToString(
    <MemoryRouter>
      <NewWorldScreen />
    </MemoryRouter>,
  );
}

function placeholders(html: string): string[] {
  return [...html.matchAll(/placeholder="([^"]*)"/g)].map((m) => m[1]!);
}

describe("the new-world form asks for words rather than showing someone else's (issue 230)", () => {
  it("carries none of the sample world's content in a field the author types into", () => {
    const html = render();
    for (const phrase of UNDERSONG) {
      assert.equal(html.includes(phrase), false, `"${phrase}" is one world's fiction, not this form's chrome`);
    }
  });

  it("says the shape of each answer, so an empty form reads as empty", () => {
    const found = placeholders(render());
    for (const shape of [
      "What this world is called",
      "One sentence about this world",
      "A genre",
      "Their name · one line about them",
      "Its name · one line about it",
    ]) {
      assert.ok(found.includes(shape), `the form asks for ${JSON.stringify(shape)}`);
    }
  });

  it("still teaches the separator the seed fields actually parse on", () => {
    // parseSeed splits "name · one line" into the two halves createSheetFromSentence needs.
    // The example used to demonstrate it; with the example gone the shape has to carry it, or
    // a name typed on its own silently seeds nothing.
    const seeds = placeholders(render()).filter((p) => p.includes("one line"));
    assert.equal(seeds.length, 2, "a character and a place");
    for (const seed of seeds) assert.ok(seed.includes("·"), `${seed} shows the separator`);
  });
});
