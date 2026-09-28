import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { parseHTML } from "linkedom";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { App } from "../src/App.js";
import { __connectionStatusForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { castLayoutFixture } from "./cast-layout-fixture.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
let width = 390;
const scrolled = new Set<Element>();
Object.assign(dom.window, { innerHeight: 812, getComputedStyle: () => ({ direction: "ltr" }), matchMedia: (query: string) => ({ matches: width <= Number(/max-width:\s*(\d+)/.exec(query)?.[1] ?? 0), addEventListener() {}, removeEventListener() {} }) });
Object.assign(dom.HTMLElement.prototype, { scrollIntoView(this: Element) { scrolled.add(this); }, focus() {}, showModal() {}, close() {} });
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; dom.document.body.replaceChildren(); width = 390; scrolled.clear(); __setBridgeForTest(null); });
async function mount(route: string) {
  const state = castLayoutFixture();
  __setStateForTest(state); __setBridgeForTest({ connect() {}, subscribe() { return () => {}; }, send() {} } as unknown as ArkeBridge); __connectionStatusForTest("open");
  const container = dom.document.createElement("div"); dom.document.body.append(container); root = createRoot(container as unknown as HTMLElement);
  await act(async () => root!.render(<MemoryRouter initialEntries={[`/w/${state.world!.meta.worldId}/${route}`]}><App /></MemoryRouter>));
}
const click = async (selector: string) => { const node = dom.document.querySelector(selector); assert.ok(node, selector); await act(async () => (node as unknown as HTMLButtonElement).click()); };

for (const [route, label] of [["cast", "Characters"], ["locations", "Locations"], ["factions", "Factions"], ["props", "Props"]]) {
  it(`keeps ${label} current, brings its kind chip into view and uses the compact cast container`, async () => {
    await mount(route!);
    const nav = dom.document.querySelector('[aria-label="Kind of sheet"]')!;
    const active = nav.querySelector('[aria-current="page"]'); assert.ok(active?.textContent?.startsWith(label!));
    assert.ok(scrolled.has(active!)); assert.equal(nav.querySelectorAll('[aria-current="page"]').length, 1);
    assert.ok(dom.document.querySelector(".fy-content--cast"));
    for (const node of dom.document.querySelectorAll(".fy-kind-grid,.fy-kind-grid .fy-gridcard__frame")) assert.equal(node.getAttribute("style"), null);
  });
}

it("places the phone character heading before its photo and preserves accessible actions", async () => {
  await mount("cast/maren-kest");
  const sheet = dom.document.querySelector(".fy-sheet")!;
  assert.equal(sheet.firstElementChild?.className, "fy-sheet__header");
  assert.equal(sheet.querySelectorAll("h1").length, 1);
  assert.equal(sheet.querySelector('[aria-label="Character pages"] [aria-current="page"]')?.textContent, "Overview");
  assert.ok(sheet.querySelector('[aria-label="Read the sheet"]'));
  assert.ok(sheet.querySelector('[aria-label="Talk about them"]'));
  assert.ok(sheet.querySelector('[aria-label="Unlock"]'));
  assert.equal(sheet.querySelector(".fy-voicecard__wave svg")?.getAttribute("width"), "100%");
  await click('[aria-label="Rename"]');
  assert.ok(sheet.querySelector(".fy-sheet-inline-form input"));
});

it("retains the desktop character's photo-first order and labelled read action", async () => {
  width = 1360; await mount("cast/maren-kest");
  const sheet = dom.document.querySelector(".fy-sheet")!;
  assert.equal(sheet.firstElementChild?.className, "fy-sheet__side");
  assert.ok([...sheet.querySelectorAll("button")].some(e => e.textContent === "Read the sheet"));
});

it("opens the new prop form without submitting a creation", async () => {
  await mount("props");
  assert.equal(dom.document.querySelector(".fy-props-create--open"), null);
  await click(".fy-kind-new");
  assert.ok(dom.document.querySelector('.fy-props-create--open input[aria-label="Prop name"]'));
  assert.equal(dom.document.querySelector(".fy-kind-new")?.getAttribute("aria-expanded"), "true");
});
