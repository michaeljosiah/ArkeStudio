import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import { parseHTML } from "linkedom";
import { App } from "../src/App.js";
import { __setStateForTest } from "../src/lib/store.js";
import { __resetSettingsReturnForTest } from "../src/lib/settings-return.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * Settings is a sheet over the screen it was opened from (design turn 150; SPEC-042 R-5, R-6).
 *
 * The screen tree keeps rendering the route the person was on while the address is a Settings
 * route, and the sheet renders over it — so leaving is a change of address and not of screen.
 * What this file holds to: the screen behind is the one you came from whichever control took
 * you in, every way out returns there, and a Settings address naming no pane still opens a pane.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
// linkedom has no layout and no frame loop; the app-wide toaster asks for both before it draws.
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }), innerWidth: 1024, innerHeight: 768 });
Object.assign(Object.getPrototypeOf(dom.document.createElement("video")), {
  pause() {},
  play: () => Promise.resolve(),
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0),
});

let where = "";
let go: (to: string) => void = () => {};
/** The real address, and a way to change it the way a remedy's button would — without the gear. */
function Probe() {
  const location = useLocation();
  where = location.pathname + location.search;
  go = useNavigate();
  return null;
}

const open: Array<{ root: Root; container: HTMLElement }> = [];
afterEach(async () => {
  for (const mounted of open.splice(0)) {
    await act(async () => mounted.root.unmount());
    mounted.container.remove();
  }
  __resetSettingsReturnForTest();
});

async function mount(path: string): Promise<HTMLElement> {
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  const root = createRoot(container);
  open.push({ root, container });
  await act(async () => {
    __setStateForTest(FIXTURE_STATE, { connection: "open" });
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Probe />
        <App />
      </MemoryRouter>,
    );
  });
  return container;
}

const screens = (container: HTMLElement): string[] =>
  [...container.querySelectorAll<HTMLElement>("[data-screen]")].map((el) => el.getAttribute("data-screen") ?? "");
const sheet = (container: HTMLElement): HTMLElement | null => container.querySelector('[role="dialog"]');

async function press(container: HTMLElement, selector: string): Promise<void> {
  const control = container.querySelector<HTMLElement>(selector);
  assert.ok(control, `${selector} is on screen`);
  await act(async () => control.click());
}

describe("the Settings sheet (design turn 150)", () => {
  const world = `/w/${FIXTURE_WORLD_ID}`;

  it("opens over the screen it was opened from, and Escape returns there", async () => {
    const page = await mount(world);
    assert.deepEqual(screens(page), ["world-overview"]);
    await press(page, 'button[aria-label="Settings"]');
    assert.equal(where, "/settings/providers");
    // The world's screen is still mounted under the sheet — the same node, not a fresh one.
    const behind = page.querySelector('[data-screen="world-overview"]');
    assert.ok(behind, "the screen behind stays mounted");
    assert.ok(sheet(page), "the sheet is up");
    assert.deepEqual(screens(page), ["world-overview", "settings", "settings-providers"]);
    // The sheet has no chrome of its own: the one gear on screen is the world's, behind it.
    assert.equal(page.querySelectorAll('button[aria-label="Settings"]').length, 1);
    const escape = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
    Object.defineProperty(escape, "key", { value: "Escape" });
    await act(async () => { dom.window.dispatchEvent(escape); });
    assert.equal(where, world);
    assert.equal(sheet(page), null);
    assert.equal(page.querySelector('[data-screen="world-overview"]'), behind, "leaving is a change of address, not of screen");
  });

  it("returns to where it was opened from whichever control opened it (SPEC-042 R-6)", async () => {
    // A remedy's button navigates straight to a Settings address and never touches the gear.
    // The app remembers the last address outside Settings on every change of address, so the
    // sheet still opens over the world and the close still goes back to it.
    const page = await mount(world);
    await act(async () => go("/settings/general"));
    assert.equal(where, "/settings/general");
    assert.deepEqual(screens(page), ["world-overview", "settings", "settings-general"]);
    await press(page, ".fy-settings__close");
    assert.equal(where, world);
    assert.equal(sheet(page), null);
  });

  it("switches panes inside the sheet without disturbing the screen behind", async () => {
    const page = await mount(world);
    await press(page, 'button[aria-label="Settings"]');
    const behind = page.querySelector('[data-screen="world-overview"]');
    await press(page, '.fy-settings__rail a[href="/settings/general"]');
    assert.equal(where, "/settings/general");
    assert.ok(page.querySelector('[data-screen="settings-general"]'));
    assert.equal(page.querySelector('[data-screen="world-overview"]'), behind);
  });

  it("renders the world picker behind a deep link, which is where leaving lands", async () => {
    const page = await mount("/settings/general");
    assert.deepEqual(screens(page), ["world-picker", "settings", "settings-general"]);
    await press(page, ".fy-settings__close");
    assert.equal(where, "/worlds");
  });

  it("opens a pane for a Settings address that names none", async () => {
    const page = await mount("/settings/nothing-here");
    assert.equal(where, "/settings/providers");
    assert.ok(page.querySelector('[data-screen="settings-providers"]'));
  });
});
