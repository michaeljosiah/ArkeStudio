import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { App } from "../src/App.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * A world image opens larger where it stands.
 *
 * Three screens had grown their own copy of this and they had drifted: one disabled its trigger
 * until the picture loaded, two did not. What is asserted is the rendered trigger on each screen
 * that has one — disabled until the picture arrives, absent where the photo is a way in rather
 * than a thing to look at. Whether the dialog is implemented once is a matter for review, not a
 * grep of the source for `showModal()`.
 */

__setStateForTest(FIXTURE_STATE);

function renderAt(path: string): string {
  return renderToString(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

const W = `/w/${FIXTURE_WORLD_ID}`;

describe("image dialog", () => {
  it("will not offer to enlarge a picture that has not arrived", () => {
    // Nothing has loaded in a server render, so no trigger may offer to enlarge anything yet.
    const html = renderAt(`${W}/cast/maren-kest/kit`);
    const at = html.indexOf('aria-label="View larger main photo of Maren Kest"');
    assert.ok(at > 0, "the trigger is rendered");
    const tag = html.slice(html.lastIndexOf("<button", at), html.indexOf(">", at) + 1);
    assert.match(tag, /\bdisabled\b/, "the trigger waits for the image");
  });

  /*
   * The detail page's main photo is a way in, not a thing to look at.
   *
   * It used to open a larger copy of itself — the one thing somebody looking at the picture
   * already has. What the anchor is for is the set it anchors, so it goes there instead. The
   * enlarge behaviour is unchanged everywhere it still makes sense, which the kit page below
   * holds; this asserts the detail page no longer has it at all.
   */
  it("sends the character's main photo to the identity reference set, rather than enlarging it", () => {
    const html = renderAt(`${W}/cast/maren-kest`);
    assert.ok(
      html.includes(`aria-label="Open Maren Kest&#x27;s identity reference set"`),
      "the anchor leads to the set it anchors",
    );
    assert.ok(
      !html.includes('aria-label="View larger main photo of Maren Kest"'),
      "and no longer offers a bigger copy of the picture already on screen",
    );
    assert.ok(!html.includes('aria-haspopup="dialog"'), "nothing on this page opens a dialog from the photo");
  });

  it("opens both panes of the reference page", () => {
    const html = renderAt(`${W}/cast/maren-kest/kit`);
    assert.ok(html.includes('aria-label="View larger main photo of Maren Kest"'), "the main photo opens");
    assert.ok(
      html.includes('aria-label="View larger character sheet for Maren Kest"'),
      "and so does the sheet beside it, which already did",
    );
  });
});
