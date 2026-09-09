import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { parseHTML } from "linkedom";
import { App } from "../src/App.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { FIXTURE_WORLD_ID, SCREENS } from "../src/screens/registry.js";

/**
 * Where a production screen puts the rest of itself.
 *
 * `.fy-prodwrap` — the column the production rail leaves for the screen — is a fixed-height flex
 * box that clips, and it has to be: the Cut and the scene workspace measure their own panes
 * against it, and a wrap that scrolled would take their inner scrollers away. Nothing in it gives
 * a screen a scroll, so a screen that is only a page of content is cut off at the window with no
 * way to reach the remainder. Measured at 1418x802 by laying the real stylesheets over the real
 * SSR output, `production-cast` came to 798 against the 758 it was given: the last row of world
 * characters ended mid-card, and the page grows with every guest, world character and wardrobe
 * row, so the gap widens with the world rather than staying a hairline.
 *
 * The fix is per screen, not on the column, so this checks the choice was made at all: every
 * screen under `/w/:worldId/p/:prodId` either carries a class the stylesheet gives a scroll of
 * its own, or is one of the layouts below that place their scrollers inside themselves. A new
 * screen rendering a bare `<div data-screen="…">` is neither, and lands here rather than in a
 * screenshot.
 */

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The layouts that are right to leave in the fixed column, each because it scrolls further in.
 * A name belongs here only if the screen would break by scrolling as a whole.
 */
const FIXED_HEIGHT_LAYOUTS = new Map<string, string>([
  ["fy-story", "the thread beside what it settled: the log and the side panel each scroll"],
  ["fy-sw", "the scene and chapter workspaces: a grid of panes that scroll separately"],
  ["fy-cutcols", "the Cut: three columns and a timeline, none of which move together"],
  ["fy-gen", "the generate workspace: form, viewer and takes, each with its own overflow"],
  ["fy-arkewrap", "Generate beside its dock — the page inside it is .fy-prodmain"],
  ["lay-screen", "the shared <Screen> wrapper, only ever a bounded loading or refusal state here"],
]);

/**
 * Class names the stylesheets hand a scroll of their own, read out of the CSS rather than listed,
 * so a screen that adopts `.fy-prodscroll` needs no edit here — and so deleting the overflow from
 * one of these rules fails the screens that were relying on it instead of passing quietly.
 */
function scrollingClasses(css: string): Set<string> {
  const found = new Set<string>();
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const stack: string[] = [];
  let buffer = "";
  for (const ch of clean) {
    if (ch === "{") {
      stack.push(buffer.trim());
      buffer = "";
      continue;
    }
    if (ch === "}") {
      const selector = stack.pop() ?? "";
      // At-rules close on a body that is whitespace by now; a declaration block closes on its
      // own declarations, which is how the two are told apart without tracking nesting depth.
      if (/overflow(-y)?\s*:\s*(auto|scroll)/.test(buffer)) {
        for (const part of selector.split(",")) {
          const bare = /^\.([A-Za-z0-9_-]+)$/.exec(part.trim());
          if (bare) found.add(bare[1]!);
        }
      }
      buffer = "";
      continue;
    }
    buffer += ch;
  }
  return found;
}

const SCROLLING = new Set([
  ...scrollingClasses(readFileSync(join(here, "../src/screens/fidelity.css"), "utf8")),
  ...scrollingClasses(readFileSync(join(here, "../src/components/layout.css"), "utf8")),
]);

const P = `/w/${FIXTURE_WORLD_ID}/p/saltlight`;

/**
 * The registry carries a film, so the episodic routes and the season's own page have no sample
 * path in it. They render under the same column and are named here so the rule covers the whole
 * route tree rather than the part the fixture happens to reach.
 */
const EPISODIC: Array<{ id: string; samplePath: string }> = [
  { id: "story-overview (season)", samplePath: `${P}/season` },
  { id: "episode-chat", samplePath: `${P}/story/episodes/ep_01` },
  { id: "episode-detail", samplePath: `${P}/episodes/ep_01` },
  { id: "branch-map", samplePath: `${P}/branch-map` },
];

const UNDER_PRODUCTION = [...SCREENS.filter((s) => s.samplePath.includes("/p/")), ...EPISODIC];

/** The screen's root: the one element `.fy-prodwrap` holds. */
function screenRoot(path: string): { classes: string[]; markup: string } {
  __setStateForTest(FIXTURE_STATE);
  const html = renderToString(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  const wrap = document.querySelector(".fy-prodwrap");
  assert.ok(wrap, `${path} never mounted the production column`);
  const root = wrap.children[0];
  assert.ok(root, `${path} left the production column empty`);
  return {
    classes: String(root.getAttribute("class") ?? "").split(/\s+/).filter(Boolean),
    markup: String(root.outerHTML).slice(0, 120),
  };
}

describe("the production column's scroll", () => {
  it("covers every screen the production route tree can mount", () => {
    // A tripwire, not a derivation: a new route under /p/ that nobody listed here would otherwise
    // be audited by a test that never renders it. 20 with the production's own artifacts page,
    // which arrived carrying the scroll column and is what named it.
    assert.equal(UNDER_PRODUCTION.length, 20);
    assert.equal(new Set(UNDER_PRODUCTION.map((s) => s.id)).size, 20, "one entry per screen");
  });

  it("gives .fy-prodscroll a scroll and a containing block", () => {
    const css = readFileSync(join(here, "../src/screens/fidelity.css"), "utf8");
    const rule = /\.fy-prodscroll\s*\{([^}]*)\}/.exec(css);
    assert.ok(rule, "the stylesheet still declares .fy-prodscroll");
    assert.match(rule[1]!, /overflow-y\s*:\s*auto/, "the screen can reach the rest of itself");
    assert.match(rule[1]!, /min-height\s*:\s*0/, "or the flex item refuses to shrink and clips again");
    // Without this an absolutely positioned control resolves against .fy-app and lands against
    // the window, a rail's width from the column it was placed in.
    assert.match(rule[1]!, /position\s*:\s*relative/, "the screen is its own containing block");
  });

  it("leaves the column clipping, so the screens keep choosing", () => {
    const css = readFileSync(join(here, "../src/screens/fidelity.css"), "utf8");
    const rule = /\.fy-prodwrap\s*\{([^}]*)\}/.exec(css);
    assert.ok(rule, "the stylesheet still declares .fy-prodwrap");
    assert.match(rule[1]!, /overflow\s*:\s*hidden/, "the Cut and the workspaces size against it");
  });

  it("never leaves a screen with no scroll and no scrolling panes", () => {
    for (const screen of UNDER_PRODUCTION) {
      const { classes, markup } = screenRoot(screen.samplePath);
      const scrolls = classes.find((c) => SCROLLING.has(c));
      const fixed = classes.find((c) => FIXED_HEIGHT_LAYOUTS.has(c));
      assert.ok(
        scrolls || fixed,
        `${screen.id} (${screen.samplePath}) is clipped at the window: its root carries ` +
          `${classes.length === 0 ? "no class at all" : classes.join(" ")}, which neither scrolls ` +
          `nor places its own scrollers. Add fy-prodscroll to it, or name the layout in ` +
          `FIXED_HEIGHT_LAYOUTS if it really is a fixed frame — ${markup}`,
      );
    }
  });

  it("scrolls the cast, which grows with the world", () => {
    // The screen the measurement caught: 798 against 758 at 1418x802, and every guest, world
    // character and wardrobe row adds to the first number.
    assert.ok(screenRoot(`${P}/cast`).classes.includes("fy-prodscroll"));
  });
});
