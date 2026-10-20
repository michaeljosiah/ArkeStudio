import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { parseHTML } from "linkedom";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { ReferenceKitSchema } from "@arke-studio/contracts";
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
async function mount(route: string, empty = false, modern = false, indexed = false) {
  const state = castLayoutFixture();
  if (empty) state.world!.sheets = state.world!.sheets.filter(s => s.type !== "character");
  if (modern) state.world!.referenceKits = [ReferenceKitSchema.parse({ sheetId: "maren-kest", tiles: [],
    mainPhoto: { file: "photo.png", source: "upload" },
    compilations: [{ file: "sheet.png", format: "character-sheet", sheetVersion: 1, tiles: [], source: "local", accepted: true, compiledAt: "2026-10-20T00:00:00Z" }],
    looks: [{ id: "ward", file: "ward.png", kind: "costume", prompt: "Ward visit", acceptedAt: "2026-10-20T00:00:00Z" }] })];
  __setStateForTest(state, { sheetRefs: indexed ? { "maren-kest": { tiles: 0, productions: ["saltlight"], artifacts: [], scenes: [], takesByVersion: {}, incomingLinks: [] } } : {} }); __setBridgeForTest({ connect() {}, subscribe() { return () => {}; }, send() {} } as unknown as ArkeBridge); __connectionStatusForTest("open");
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

it("keeps New reachable for the empty Fold cast", async () => {
  width = 984; await mount("cast", true);
  assert.ok(dom.document.querySelector(".fy-cast-mobile-head .fy-kind-new"));
  await click(".fy-cast-mobile-head .fy-kind-new");
  assert.ok(dom.document.querySelector('[data-screen="new-character"]'));
});

it("opens the faction authoring screen from its New action", async () => {
  await mount("factions"); await click(".fy-kind-new");
  assert.ok(dom.document.querySelector('[data-screen="new-faction"]'));
});

for (const indexed of [false, true]) it(`counts accepted cast images with index available=${indexed}`, async () => {
  width = 1200; await mount("cast", false, true, indexed);
  const row = dom.document.querySelector('button.fy-row[aria-label^="Maren Kest,"]')!;
  assert.ok(row);
  assert.match(row.textContent ?? "", /3 refs/);
  assert.match(row.textContent ?? "", indexed ? /1 production/ : /… productions/);
  assert.match(row.getAttribute("aria-label") ?? "", /1 main photo · 1 sheet · 1 look/);
  assert.equal(row.querySelector(".fy-row__meta")?.getAttribute("title"), "1 main photo · 1 sheet · 1 look");
});
for (const indexed of [false, true]) it(`uses the kit count in sheet reach with index available=${indexed}`, async () => {
  width = 1200; await mount("cast/maren-kest", false, true, indexed);
  const label = [...dom.document.querySelectorAll(".lay-stats__label")].find(node => node.textContent === "accepted references")!;
  assert.ok(label);
  assert.equal(label.previousElementSibling?.textContent, "3");
  assert.equal(label.getAttribute("title"), "1 main photo · 1 sheet · 1 look");
});
