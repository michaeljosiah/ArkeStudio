import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { parseHTML } from "linkedom";
import type { ClientMessage } from "@arke-studio/contracts";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { App } from "../src/App.js";
import { ProductionLayout } from "../src/screens/production-shell.js";
import { ProductionDashboardScreen } from "../src/screens/production-dashboard.js";
import { __connectionStatusForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { episodicLayoutFixture, productionsLayoutFixture } from "./productions-layout-fixture.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
let width = 390;
let coarse = true;
const listeners = new Set<() => void>();
Object.assign(dom.window, {
  innerWidth: width, innerHeight: 812,
  matchMedia: (query: string) => ({
    get matches() { const max = /max-width:\s*(\d+)/.exec(query); return max ? width <= Number(max[1]) : query.includes("pointer: coarse") ? coarse : false; },
    addEventListener(_type: string, fn: () => void) { listeners.add(fn); },
    removeEventListener(_type: string, fn: () => void) { listeners.delete(fn); },
  }),
  getComputedStyle: () => ({ direction: "ltr" }),
});
Object.assign(dom.HTMLElement.prototype, {
  focus() {}, scrollIntoView() {},
  showModal(this: HTMLElement) { this.setAttribute("open", ""); },
  close(this: HTMLElement) { this.removeAttribute("open"); },
});
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
const sent: ClientMessage[] = [];
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined; dom.document.body.replaceChildren(); sent.length = 0; width = 390; coarse = true;
  __setBridgeForTest(null); __setStateForTest(productionsLayoutFixture());
});
async function mount(route: string, state = productionsLayoutFixture()) {
  __setStateForTest(state);
  __setBridgeForTest({ connect() {}, subscribe() { return () => {}; }, send(raw: string) { sent.push(JSON.parse(raw)); } } as unknown as ArkeBridge);
  __connectionStatusForTest("open");
  const container = dom.document.createElement("div"); dom.document.body.append(container);
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => root!.render(<MemoryRouter initialEntries={[`/w/${state.world!.meta.worldId}/${route}`]}>{route.endsWith("/cut") ? <Routes><Route path="/w/:worldId/p/:prodId" element={<ProductionLayout />}><Route index element={<ProductionDashboardScreen />} /><Route path="cut" element={<div>Cut workspace</div>} /></Route></Routes> : <App />}</MemoryRouter>));
}
const click = async (selector: string) => {
  const node = dom.document.querySelector(selector); assert.ok(node, selector);
  await act(async () => (node as unknown as HTMLButtonElement).click());
};
const labels = () => [...dom.document.querySelectorAll('[aria-label="Production pages"] a')].map(node => node.textContent);

it("replaces the phone rail with every film destination and switches production through the sheet", async () => {
  await mount("p/saltlight");
  assert.equal(dom.document.querySelector(".fy-prodrail"), null);
  assert.deepEqual(labels(), ["Dashboard", "Cast", "Develop", "Overview", "Scenes", "Artifacts", "Generate", "Cut"]);
  await click(".fy-prodrail__switch");
  const sheet = dom.document.querySelector(".fy-page-sheet[open]"); assert.ok(sheet);
  assert.match(sheet.querySelector('[aria-current="true"]')!.textContent!, /Saltlight/);
  await click(".fy-production-switch-row");
  assert.equal(dom.document.querySelector(".fy-page-sheet[open]"), null);
  assert.deepEqual(labels(), ["Dashboard", "Cast", "Develop", "Overview", "Chapters", "Audiobook", "Artifacts"]);
  await click('[aria-label="Production pages"] a[href$="/story/audiobook"]');
  assert.equal(dom.document.querySelector('[aria-label="Production pages"] [aria-current="page"]')?.textContent, "Audiobook");
});

it("gives episodic and branching productions their own page destinations", async () => {
  await mount("p/saltlight", episodicLayoutFixture());
  assert.deepEqual(labels(), ["Overview", "Episodes", "Story structure", "Cast", "Artifacts", "Generate", "Cut"]);
  await click(".fy-season-arke");
  assert.ok(dom.document.querySelector(".fy-season-arke-sheet[open] .fy-arke"));
  await click('.fy-page-sheet [aria-label="Close"]');
  const state = productionsLayoutFixture(); state.world!.productions[1]!.meta.kind = "interactive";
  await act(async () => __setStateForTest(state));
  assert.ok(labels().includes("Branch map"));
});

it("uses a labelled drawer on a touch Cut, closes on navigation, and keeps the Fold switch menu through resize", async () => {
  width = 984;
  await mount("p/saltlight/cut");
  assert.equal(dom.document.querySelector(".fy-prodrail--folded"), null);
  await click(".fy-production-drawer-toggle");
  assert.ok(dom.document.querySelector(".fy-production-drawer[open]"));
  await click('.fy-production-drawer a[href$="/saltlight"]');
  assert.equal(dom.document.querySelector(".fy-production-drawer[open]"), null);
  await click(".fy-prodrail__switch");
  assert.ok(dom.document.querySelector('[role="menu"]'));
  await act(async () => { width = 900; Object.assign(dom.window, { innerWidth: width }); dom.window.dispatchEvent(new dom.window.Event("resize")); });
  assert.ok(dom.document.querySelector('[role="menu"]'), "resizing keeps the menu open");
  await act(async () => { width = 390; Object.assign(dom.window, { innerWidth: width }); listeners.forEach(fn => fn()); });
  assert.ok(dom.document.querySelector(".fy-production-switch-sheet[open]"), "crossing into phone preserves the open choice as a sheet");
});

it("keeps the desktop folded rail but never hides its labels from a coarse pointer", async () => {
  width = 1360; coarse = false;
  await mount("p/saltlight/cut");
  assert.ok(dom.document.querySelector(".fy-prodrail--folded"));
  await act(async () => { coarse = true; listeners.forEach(fn => fn()); });
  assert.equal(dom.document.querySelector(".fy-prodrail--folded"), null);
  assert.ok(dom.document.querySelector(".fy-production-drawer-toggle"));
});

it("holds step two's creation actions on a phone and preserves WATCH's setup conversation", async () => {
  await mount("productions");
  assert.equal(dom.document.querySelector(".fy-prodcard-slot")?.getAttribute("style"), null);
  assert.equal(dom.document.querySelector(".fy-prodcard")?.getAttribute("style"), null);
  await click(".fy-productions-head button");
  assert.equal(dom.document.querySelector(".fy-production-doors")?.getAttribute("style"), null);
  await click(".fy-door--2");
  assert.ok(dom.document.querySelector(".fy-held-bar"));
  assert.equal(dom.document.querySelector(".fy-production-defaults")?.getAttribute("style"), null);
  assert.ok(dom.document.querySelector('input[aria-label="Name"]'));
  assert.ok(dom.document.querySelector(".fy-held-bar button:last-child")?.hasAttribute("disabled"));
  await click(".fy-held-bar button:first-of-type");
  await click(".fy-door--1");
  assert.ok(dom.document.querySelector('[data-screen="production-setup"]'));
  assert.ok(!sent.some(command => command.kind === "create-production"), "no production is created by choosing a door");
});
