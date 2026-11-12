import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter } from "react-router";
import { App } from "../src/App.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * Edit the sheet opens the edit screen for every kind of sheet (issue 2773). Only the cast's
 * address was routed, so a place or a faction fell through to the catch-all and landed on the
 * world picker instead.
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
  requestAnimationFrame: (cb: (time: number) => void) => setTimeout(() => cb(0), 0),
});

const WORLD_ID = FIXTURE_STATE.world!.meta.worldId;

describe("Edit the sheet", () => {
  for (const [detail, screen] of [
    ["cast/maren-kest", "character-edit"],
    ["locations/the-vigil", "location-edit"],
    ["factions/the-ebb-council", "faction-edit"],
  ] as const) {
    it(`opens ${screen} from ${detail}`, async () => {
      __setStateForTest(FIXTURE_STATE, { connection: "open" });
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      try {
        await act(async () => root.render(<MemoryRouter initialEntries={[`/w/${WORLD_ID}/${detail}`]}><App /></MemoryRouter>));
        const edit = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Edit the sheet");
        assert.ok(edit, "the sheet offers Edit");
        await act(async () => edit.click());
        assert.equal(container.querySelector('[data-screen="world-picker"]'), null, "not on the world picker");
        assert.ok(container.querySelector(`[data-screen="${screen}"]`), `Edit lands on ${screen}`);
      } finally {
        await act(async () => root.unmount());
        container.remove();
      }
    });
  }
});
