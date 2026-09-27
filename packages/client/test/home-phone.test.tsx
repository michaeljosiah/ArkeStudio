import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { parseHTML } from "linkedom";
import { MemoryRouter } from "react-router";
import { FirstRunScreen, WorldPickerScreen } from "../src/screens/shell.js";
import { __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * Home and First run below the desktop (design turn 159). The stylesheet chooses between the
 * phone's feature card and the grid, so both must be in the markup at every width; the archive
 * confirm is the one thing the width decides in code, since a phone asks in a sheet.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
let phone = false;
Object.assign(dom.window, {
  getComputedStyle: () => ({ direction: "ltr" }),
  matchMedia: (query: string) => ({ matches: query === "(max-width: 599px)" ? phone : false, addEventListener() {}, removeEventListener() {} }),
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  Event: dom.Event,
  KeyboardEvent: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0),
});

const base = FIXTURE_STATE.worlds[0]!;
const WORLDS = [
  { ...base, worldId: "w-old", slug: "copper-saints", name: "Copper Saints", updated: "2026-09-01T10:00:00.000Z" },
  { ...base, worldId: "w-new", slug: "the-undersong", name: "The Undersong", updated: "2026-09-26T10:00:00.000Z" },
  { ...base, worldId: "w-mid", slug: "meridian-dust", name: "Meridian Dust", updated: "2026-09-20T10:00:00.000Z" },
];

const sent: Array<{ kind: string; worldId?: string }> = [];
__setBridgeForTest({ appVersion: "test", platform: "win32", connect() {}, send(json: string) { sent.push(JSON.parse(json)); }, subscribe() {} });
afterEach(() => { __setStateForTest(FIXTURE_STATE); phone = false; sent.length = 0; });

it("leads with the world last opened, and takes it out of the phone's grid", () => {
  __setStateForTest({ ...FIXTURE_STATE, worlds: WORLDS });
  const html = renderToString(<MemoryRouter initialEntries={["/worlds"]}><WorldPickerScreen /></MemoryRouter>);
  const { document: page } = parseHTML(`<main>${html}</main>`);
  assert.equal(page.querySelector(".fy-homefeature__name")?.textContent, "The Undersong", "the most recently updated, not the first listed");
  const featured = [...page.querySelectorAll(".fy-home-drift--featured .fy-worldcard__name")].map((n) => n.textContent);
  assert.deepEqual(featured, ["The Undersong"], "its grid card is the one a phone hides");
  assert.equal(page.querySelectorAll(".fy-home-drift").length, 3, "the desktop grid still has every world");
  assert.ok(page.querySelector(".fy-homefeature .fy-worldcard__archive"), "the feature carries its own ⋯");
  assert.ok(page.querySelector(".fy-worldcard__chars"), "the characters are their own span, so a phone can drop them");
  assert.ok(!/style="[^"]*transform/.test(html), "the lean is a variable, not an inline transform a phone cannot undo");
});

it("confirms archiving in a sheet on a phone, and in the card elsewhere", async () => {
  __setStateForTest({ ...FIXTURE_STATE, worlds: WORLDS });
  for (const width of ["phone", "desktop"] as const) {
    phone = width === "phone";
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<MemoryRouter initialEntries={["/worlds"]}><WorldPickerScreen /></MemoryRouter>));
      const archive = container.querySelector<HTMLButtonElement>('.fy-home-drift [aria-label="Archive Copper Saints"]')!;
      await act(async () => archive.click());
      if (width === "phone") {
        assert.ok(container.querySelector('.fy-archivesheet[role="dialog"]'), "a sheet from the bottom");
        assert.ok(!container.querySelector(".fy-worldcard__confirm"), "and not the card's own confirm");
        assert.ok(container.textContent?.includes("Archive Copper Saints?"));
        const keep = [...container.querySelectorAll("button")].find((b) => b.textContent === "Keep")!;
        await act(async () => keep.click());
        assert.ok(!container.querySelector(".fy-archivesheet"), "Keep closes it");
        assert.equal(sent.filter((m) => m.kind === "archive-world").length, 0, "and archives nothing");
        await act(async () => archive.click());
        const go = [...container.querySelectorAll<HTMLButtonElement>(".fy-archivesheet button")].find((b) => b.textContent === "Archive")!;
        await act(async () => go.click());
        assert.ok(sent.some((m) => m.kind === "archive-world" && m.worldId === "w-old"));
      } else {
        assert.ok(container.querySelector(".fy-worldcard__confirm"), "the card's own confirm, as shipped");
        assert.ok(!container.querySelector(".fy-archivesheet"));
      }
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  }
});

it("draws First run from classes the widths can reach", () => {
  const html = renderToString(<MemoryRouter initialEntries={["/first-run"]}><FirstRunScreen /></MemoryRouter>);
  assert.ok(html.includes("fy-firstrun__title") && html.includes("fy-firstrun__doors"));
  assert.ok(!html.includes("font-size:56px"), "no inline title size");
  assert.ok(html.includes("fy-firstrun__flank--left"), "the flanks are classes a narrower width can drop");
});
