import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter } from "react-router";
import { WorldPickerScreen } from "../src/screens/shell.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * The ages on the world cards keep up with the clock (codex, 2026-09-09).
 *
 * The card writes an age rather than a timestamp (design 1a, issue 1007), and an age is computed
 * at render — so on a screen that can sit open for hours with nothing else to re-render it, a
 * card drawn as `now` went on saying `now`, and `59m ago` never became `1h ago`. The screen ticks
 * once a minute; this is that tick, and the fact that it stops when the screen does.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }) });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0),
});

const OPENED = new Date("2026-09-09T12:00:00.000Z");

async function mount(t: TestContext) {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: OPENED });
  const tick = async (ms: number) => {
    await act(async () => t.mock.timers.tick(ms));
  };
  __setStateForTest({
    ...FIXTURE_STATE,
    // Touched a moment before the screen opened, so its first draw is the value that used to
    // stick: `now` is the only age with nowhere lower to fall.
    worlds: [{ ...FIXTURE_STATE.worlds[0]!, updated: new Date(OPENED.getTime() - 5_000).toISOString() }],
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
    __setStateForTest(FIXTURE_STATE);
    t.mock.timers.reset();
  });
  await act(async () => root.render(<MemoryRouter initialEntries={["/worlds"]}><WorldPickerScreen /></MemoryRouter>));
  return { container, tick, root };
}

it("ages the cards while the picker sits open, with nothing else re-rendering it", async (t) => {
  const { container, tick } = await mount(t);
  const age = (): string => container.querySelector(".fy-worldcard__meta .mono")?.textContent ?? "";

  assert.equal(age(), "now", "drawn a moment after the world was touched");
  await tick(60_000);
  assert.equal(age(), "1m ago", "and one minute later it says so, without a store update");
  await tick(59 * 60_000);
  assert.equal(age(), "1h ago", "the step that never arrived before");
});

it("stops ticking with the screen", async (t) => {
  const { root, tick } = await mount(t);
  await act(async () => root.unmount());
  // A tick after the screen is gone must not reach a setState on an unmounted tree.
  await tick(120_000);
});
