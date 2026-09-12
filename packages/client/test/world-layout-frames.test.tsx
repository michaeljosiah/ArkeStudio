import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { App } from "../src/App.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";

/**
 * Which world screens are a fixed frame (issue 1007).
 *
 * Art direction and the gate screens are laid out as a frame whose columns scroll inside
 * themselves, and they used to take their height from `100vh` minus a constant. The constant
 * was 28px optimistic with nothing above them and had no answer at all for the founding
 * notice, so the edit sheet's Save, World Chat's composer and the key art all sat below the
 * fold. `fy-content--fill` makes the column measure itself and hand the screen the remainder;
 * a page that scrolls must not get it, or its own scrolling is what breaks.
 *
 * What the fill does at a width — the floor under art direction, the banner keeping its own
 * height, the stacked gate released from the fill below 1100px — is layout, which no text read
 * of the stylesheet can show; the reasons stand beside those rules in fidelity.css, and the
 * measurement belongs to a browser: the headless layout check is issue 1110, run beside the
 * design gate rather than from this suite.
 */

function at(path: string): string {
  __setStateForTest(FIXTURE_STATE);
  return renderToString(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

const W = `/w/${FIXTURE_WORLD_ID}`;

describe("the world's fixed-frame screens (issue 1007)", () => {
  it("fills the column on art direction, the gate screens and World Chat", () => {
    for (const path of [
      `${W}/art-direction`,
      `${W}/chat`,
      `${W}/chat/wc_01J8F3K2QW9VZX4N7M0RTYB01`,
      `${W}/cast/maren-kest/edit`,
      `${W}/canon/new`,
      `${W}/canon/ce_01J8F3K2QW9VZX4N7M0RTYB01/thread`,
    ]) {
      assert.match(at(path), /fy-content fy-content--fill/, path);
    }
  });

  /*
   * A bookmarked or typed address may end in a slash, and the router renders the route either
   * way (codex, 2026-09-09). A check anchored on the end of the path quietly said no to those,
   * which took the fill off and put the composer, Save or the key art back below the fold.
   */
  it("reads a trailing slash as the same route", () => {
    for (const path of [`${W}/art-direction`, `${W}/chat`, `${W}/cast/maren-kest/edit`]) {
      assert.match(at(`${path}/`), /fy-content fy-content--fill/, `${path}/ is still a fixed frame`);
    }
    assert.match(at(`${W}/`), /did not land|fy-app/, "and /w/<id>/ still renders the world");
  });

  it("leaves the pages that scroll alone", () => {
    for (const path of [W, `${W}/cast`, `${W}/canon`, `${W}/artifacts`, `${W}/productions`, `${W}/bible`]) {
      assert.doesNotMatch(at(path), /fy-content--fill/, path);
    }
  });
});
