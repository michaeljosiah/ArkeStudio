import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { parseHTML } from "linkedom";
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

function desktopChromeAt(path: string): string {
  const { document } = parseHTML(renderAt(path));
  // Turn 162 adds chrome behind character sheets on phones. CSS hides this backdrop on
  // desktop, where these routes remain full-frame gates; the browser smoke checks that rule.
  document.querySelector(".fy-character-generation__backdrop")?.remove();
  return document.toString();
}

function systemControl(html: string): string {
  return parseHTML(html).document.querySelector('[data-system-trigger]')?.outerHTML ?? '';
}

/**
 * A screen that carries the wordmark and no controls. None does today: startup did, until the
 * launch surface took its place with a lockup of its own (below). Kept, because the exception
 * should be written down here the day one comes back rather than merely being true.
 */
const WITHOUT_CONTROLS = new Set<string>();
/**
 * Full-frame compositions that draw themselves exactly as approved: the accept gates, and the
 * launch surface ahead of everything, which carries its own lockup over the loop and no chrome
 * of any kind (design master turn 158).
 */
const WITHOUT_CHROME = new Set([
  "startup",
  "onboarding",

  "art-direction-proposal",
  "replace-main-photo",
  "model-sheet-generate",
]);

describe("app chrome", () => {
  it("keeps the character context behind phone generation sheets", () => {
    for (const id of ["replace-main-photo", "model-sheet-generate"]) {
      const screen = SCREENS.find((entry) => entry.id === id)!;
      const { document } = parseHTML(renderAt(screen.samplePath));
      const backdrop = document.querySelector(".fy-character-generation__backdrop");
      assert.ok(backdrop, id);
      assert.equal(backdrop.querySelectorAll(".fy-titlebar__brand").length, 1);
      assert.equal(backdrop.querySelector('.fy-character-tabs [aria-current="page"]')?.textContent, "Reference");
    }
  });

  it("mounts one app-level queue toaster, on every screen", () => {
    // Sonner portals on the client, but its root is mounted once, at the app; a screen that lost
    // it would lose every notification. The region it renders is the surface that proves it.
    for (const path of ["/worlds", "/settings/providers", `/w/${FIXTURE_WORLD_ID}`]) {
      assert.equal(count(renderAt(path), 'aria-label="Notifications alt+T"'), 1, path);
    }
  });

  for (const screen of SCREENS) {
    it(`${screen.id} carries exactly one wordmark, centred`, () => {
      const html = desktopChromeAt(screen.samplePath);
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

    it(`${screen.id} puts activity, settings and the account on the right, in that order`, () => {
      const html = desktopChromeAt(screen.samplePath);
      if (WITHOUT_CHROME.has(screen.id)) {
        assert.ok(!html.includes("fy-titlebar__side--right"), `${screen.id} is a full-frame gate`);
        return;
      }
      if (WITHOUT_CONTROLS.has(screen.id)) {
        assert.ok(
          !html.includes('aria-label="Settings"') && !html.includes('aria-label="Arke account"'),
          `${screen.id} is the exception and has no controls`,
        );
        return;
      }
      const right = html.indexOf("fy-titlebar__side--right");
      const activity = html.indexOf('aria-label="Activity');
      const settings = html.indexOf('aria-label="Settings"');
      const account = html.indexOf('aria-label="Arke account"');
      assert.ok(right >= 0, "the right-hand side of the bar exists");
      assert.ok(activity > right, "activity sits inside it, not on the left as the world screens had it");
      assert.ok(settings > activity, "and settings follows activity — same order everywhere");
      assert.ok(account > settings, "and the account comes last (design turn 151): the person, after the screen's controls");
      assert.equal(count(html, 'aria-label="Settings"'), 1, "one way to settings, not two");
      assert.equal(count(html, 'aria-label="Arke account"'), 1, "one account control, and it never opens a page");
    });

    it(`${screen.id} puts System before Activity without a proposal shortcut`, () => {
      const html = renderAt(screen.samplePath);
      if (WITHOUT_CHROME.has(screen.id) || WITHOUT_CONTROLS.has(screen.id)) return;
      const document = parseHTML(html).document;
      assert.equal(document.querySelectorAll('[data-system-trigger]').length, 1);
      assert.equal(document.querySelector('button.fy-iconbtn[aria-label^="Proposals"]'), null);
      assert.ok(html.indexOf('data-system-trigger') < html.indexOf('aria-label="Activity'));
    });
  }

  it("keeps System available with and without a world, independently of proposal decisions", () => {
    assert.ok(systemControl(renderAt(`/w/${FIXTURE_WORLD_ID}`)));
    assert.ok(!systemControl(renderAt(`/w/${FIXTURE_WORLD_ID}`)).includes('fy-iconbtn__dot'));
    __setStateForTest({ ...FIXTURE_STATE, world: null });
    assert.ok(systemControl(renderAt('/worlds')));
    __setStateForTest(FIXTURE_STATE);
  });

  it("retains the proposal review route and waiting decisions", () => {
    const html = renderAt(`/w/${FIXTURE_WORLD_ID}/proposals`);
    assert.ok(html.includes('data-screen="proposals"'));
    assert.equal(parseHTML(html).document.querySelector('.fy-proposals__count')?.textContent, '1 waiting');
    assert.ok(systemControl(html));
  });
});
