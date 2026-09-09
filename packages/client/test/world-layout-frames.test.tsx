import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

/*
 * The fill and the columns go together (codex, 2026-09-09).
 *
 * Below 1100px the gate stacks, and a stacked gate held to the viewport gives the whole column
 * to the understanding rail — `flex: none` at its own intrinsic height — while the conversation
 * shrinks under its `overflow: hidden` and takes the transcript and composer with it. One column
 * on top of another has to scroll the page.
 */
describe("the fill releases the gate when the gate stacks", () => {
  const css = readFileSync(new URL("../src/screens/fidelity.css", import.meta.url), "utf8");

  /**
   * The narrow block that stacks the chat gate. The stylesheet has several `max-width: 1100px`
   * blocks, so this one is found by the rule that stacks the gate and read back to its own
   * `@media` — which is the whole point of the assertion below: the release has to be in the
   * same block as the stack, not merely somewhere in the file.
   */
  function narrowBlock(): string {
    const stack = css.indexOf(".fy-chat__wrap .fy-gate { flex-direction: column; }");
    assert.ok(stack > 0, "the gate stacks somewhere");
    const at = css.lastIndexOf("@media (max-width: 1100px) {", stack);
    assert.ok(at > 0, "inside a max-width: 1100px block");
    const close = css.indexOf("\n}", at);
    assert.ok(close > stack, "and that block closes after it");
    return css.slice(at, close);
  }

  it("stacks the gate and releases it in the same block", () => {
    const block = narrowBlock();
    assert.match(block, /\.fy-chat__wrap \.fy-gate \{ flex-direction: column; \}/, "the gate stacks here");
    assert.match(block, /\.fy-content--fill > \.fy-chat__wrap > \.fy-gate \{ flex: 0 0 auto; height: auto; \}/,
      "and the fill lets go of it here");
    assert.doesNotMatch(block, /fy-artdirection/, "art direction is a row at this width and keeps the fill");
    // And only the gate that stacks is released. The edit sheet, the canon thread and the
    // new-entry gate are still two columns here, and two columns that each scroll are exactly
    // what the fill is for — releasing them would put Save back below the fold.
    assert.doesNotMatch(block, /fy-content--fill > \.fy-gate/, "the gates that stay rows keep the fill");
  });
});
