import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
 * until the picture loaded, two did not. These assertions are mostly about there being one
 * implementation, because that is the property that decays.
 */

__setStateForTest(FIXTURE_STATE);

const here = dirname(fileURLToPath(import.meta.url));

function renderAt(path: string): string {
  return renderToString(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const W = `/w/${FIXTURE_WORLD_ID}`;

describe("image dialog", () => {
  it("is implemented once", () => {
    // A <dialog> anywhere but the shared component means a fourth copy is growing.
    for (const file of ["screens/world.tsx", "screens/character-reference.tsx"]) {
      const source = readFileSync(join(here, "../src", file), "utf8");
      assert.equal(
        count(source, "showModal()"),
        0,
        `${file} should open images through ImageDialog, not its own <dialog>`,
      );
    }
    const shared = readFileSync(join(here, "../src/components/image-dialog.tsx"), "utf8");
    assert.ok(shared.includes("showModal()"), "the shared component is the one that opens it");
  });

  it("returns focus to the trigger when it closes", () => {
    const shared = readFileSync(join(here, "../src/components/image-dialog.tsx"), "utf8");
    assert.ok(
      shared.includes("onClose={() => trigger.current?.focus()}"),
      "closing a dialog that dropped focus leaves the keyboard at the top of the document",
    );
  });

  it("dismisses on a backdrop click", () => {
    const shared = readFileSync(join(here, "../src/components/image-dialog.tsx"), "utf8");
    assert.ok(
      shared.includes("event.target === event.currentTarget"),
      "a click on the dialog itself rather than its panel is the backdrop",
    );
  });

  it("will not offer to enlarge a picture that has not arrived", () => {
    // Nothing has loaded in a server render, so no trigger may offer to enlarge anything yet.
    const html = renderAt(`${W}/cast/maren-kest/kit`);
    const at = html.indexOf('aria-label="View larger main photo of Maren Kest"');
    assert.ok(at > 0, "the trigger is rendered");
    const tag = html.slice(html.lastIndexOf("<button", at), html.indexOf(">", at) + 1);
    assert.match(tag, /\bdisabled\b/, "the trigger waits for the image");
  });

  /*
   * Availability belongs to a picture, not to the component.
   *
   * It used to be a bare boolean reset by an effect, which raced the load it was guarding: a
   * cached image settles during the first paint and the effect's mount pass then cleared it, so
   * the character detail page's main photo — preloaded by the cast page it is reached from — was
   * never clickable at all. Keying it to the subject decides the same thing during render, and
   * still cannot enable for the previous picture, because the key changes with the path.
   */
  it("tracks which picture arrived rather than that one did", () => {
    const shared = readFileSync(join(here, "../src/components/image-dialog.tsx"), "utf8");
    assert.ok(shared.includes("disabled={!available}"), "the trigger waits for the image");
    assert.match(
      shared,
      /const available = loaded === subject/,
      "availability is compared against the picture on screen now",
    );
    assert.match(shared, /const subject = `\$\{worldSlug \?\? ""\}\|\$\{path\}`/, "and the subject is that path");
    assert.ok(
      !/useEffect/.test(shared),
      "with no effect left to race the load it guards",
    );
  });

  /*
   * The other half of the same bug lives in Portrait: a load event that has already fired never
   * fires again, so an image the browser had cached reported nothing at all.
   */
  it("reads availability off a cached image as well as listening for it", () => {
    const portrait = readFileSync(join(here, "../src/components/portrait.tsx"), "utf8");
    assert.match(portrait, /node\.complete/, "an image that already finished is asked directly");
    assert.match(portrait, /node\.naturalWidth > 0/, "and a broken one is not mistaken for a loaded one");
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
