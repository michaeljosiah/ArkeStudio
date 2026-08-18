import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { App } from "../src/App.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_WORLD_ID, SCREENS } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * The chrome is the same on every screen, or it is not chrome.
 *
 * This started as five different bars: the world put settings and activity on the left, home
 * put them on the right as words, three other screens had neither and a bare "Arke" in the
 * corner instead. Nothing about that was visible from any one screen — you only see it by
 * walking all forty-one, which is what this does.
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

/**
 * Startup is the single exception, and it is written down here rather than merely being true:
 * nothing is configured yet and the only thing that has happened is the download the screen is
 * already showing, so it carries the wordmark and no controls.
 */
const WITHOUT_CONTROLS = new Set(["startup"]);
/**
 * Full-frame compositions that draw themselves exactly as approved: the accept gates, and the
 * launch screen ahead of everything, which is a plate with its own lockup on it and no chrome
 * of any kind (design master 75a).
 */
const WITHOUT_CHROME = new Set([
  "launch",
  "art-direction-proposal",
  "replace-main-photo",
  "model-sheet-generate",
]);

describe("app chrome", () => {
  it("mounts one app-level queue toaster", () => {
    const app = readFileSync(join(here, "../src/App.tsx"), "utf8");
    assert.equal(
      count(app, "<QueueToaster"),
      1,
      "Sonner portals on the client, but its root is mounted once here",
    );
  });

  for (const screen of SCREENS) {
    it(`${screen.id} carries exactly one wordmark, centred`, () => {
      const html = renderAt(screen.samplePath);
      if (WITHOUT_CHROME.has(screen.id)) {
        assert.equal(count(html, 'class="fy-titlebar__brand"'), 0, `${screen.id} is a full-frame gate`);
        return;
      }
      assert.equal(
        count(html, 'class="fy-titlebar__brand"'),
        1,
        `${screen.samplePath} should draw the chrome once — no screen without it, none with two`,
      );
      assert.ok(
        html.includes(">Arke</span>") && html.includes(">Studio</span>"),
        "the full lockup, not an initial",
      );
    });

    it(`${screen.id} puts activity and settings on the right, in that order`, () => {
      const html = renderAt(screen.samplePath);
      if (WITHOUT_CHROME.has(screen.id)) {
        assert.ok(!html.includes("fy-titlebar__side--right"), `${screen.id} is a full-frame gate`);
        return;
      }
      if (WITHOUT_CONTROLS.has(screen.id)) {
        assert.ok(
          !html.includes('aria-label="Settings"'),
          `${screen.id} is the exception and has no controls`,
        );
        return;
      }
      const right = html.indexOf("fy-titlebar__side--right");
      const activity = html.indexOf('aria-label="Activity"');
      const settings = html.indexOf('aria-label="Settings"');
      assert.ok(right >= 0, "the right-hand side of the bar exists");
      assert.ok(activity > right, "activity sits inside it, not on the left as the world screens had it");
      assert.ok(settings > activity, "and settings follows activity — same order everywhere");
      assert.equal(count(html, 'aria-label="Settings"'), 1, "one way to settings, not two");
    });

    it(`${screen.id} puts proposals before activity, never between it and settings`, () => {
      const html = renderAt(screen.samplePath);
      if (WITHOUT_CHROME.has(screen.id) || WITHOUT_CONTROLS.has(screen.id)) return;
      const proposals = html.indexOf('aria-label="Proposals"');
      if (proposals < 0) return; // no world open: the icon has nowhere to go, which is its own test
      const activity = html.indexOf('aria-label="Activity"');
      assert.ok(
        proposals < activity,
        "proposals prepends — activity and settings are a settled pair and splitting them reopens it",
      );
      assert.equal(count(html, 'aria-label="Proposals"'), 1, "one way to proposals, not two");
    });
  }

  it("shows proposals only while a world is open, and dots it only when something waits", () => {
    const world = renderAt(`/w/${FIXTURE_WORLD_ID}`);
    assert.ok(world.includes('aria-label="Proposals"'), "a world is open, so the icon exists");
    assert.ok(
      world.includes("Proposals — 1 awaiting a decision"),
      "the title counts what waits rather than saying something vague",
    );
    assert.ok(
      world.indexOf("fy-iconbtn__dot") > 0,
      "and the dot is lit, the same signal activity uses",
    );
  });

  it("says plainly when nothing is waiting", () => {
    __setStateForTest({
      ...FIXTURE_STATE,
      world: { ...FIXTURE_STATE.world!, proposals: [] },
    });
    const html = renderAt(`/w/${FIXTURE_WORLD_ID}`);
    __setStateForTest(FIXTURE_STATE);
    assert.ok(html.includes("Proposals — nothing waiting"), "the icon stays, the claim changes");
    assert.ok(
      !html.includes("fy-iconbtn__dot"),
      "an unlit dot is worse than none: it teaches you to ignore the lit one",
    );
  });

  it("centres the wordmark on the window, not on the row", () => {
    // Desktop parks its native window controls in the top-right ~138px and the bar reserves that
    // margin, so a flex-centred mark lands ~69px left of true centre on desktop and dead centre
    // in a browser — the same code drawing two different layouts. Absolute placement is the fix,
    // and this is the assertion that keeps it.
    const css = readFileSync(join(here, "../src/screens/fidelity.css"), "utf8");
    const rule = css.slice(css.indexOf(".fy-titlebar__brand {"));
    const body = rule.slice(0, rule.indexOf("}"));
    assert.ok(body.includes("position: absolute"), "the wordmark is placed, not flowed");
    assert.ok(body.includes("left: 50%") && body.includes("translateX(-50%)"), "and placed at the middle");
  });
});
