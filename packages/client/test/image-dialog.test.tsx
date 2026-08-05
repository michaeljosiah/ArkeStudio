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
    const shared = readFileSync(join(here, "../src/components/image-dialog.tsx"), "utf8");
    assert.ok(shared.includes("disabled={!available}"), "the trigger waits for the image");
    assert.ok(
      shared.includes("setAvailable(false)"),
      "and stops waiting again when the subject changes, or it enables for the wrong picture",
    );
  });

  it("opens the character's main photo from the detail page", () => {
    const html = renderAt(`${W}/cast/maren-kest`);
    assert.ok(
      html.includes('aria-label="View larger main photo of Maren Kest"'),
      "the main photo is the thing you most want to see properly, and it was the one that could not",
    );
    assert.ok(html.includes('aria-haspopup="dialog"'), "and it says so before you press it");
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
