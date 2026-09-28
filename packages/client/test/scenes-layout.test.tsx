import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter } from "react-router";
import type { ClientMessage } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { __connectionStatusForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { scenesLayoutFixture } from "./scenes-layout-fixture.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
let width = 390;
const listeners = new Set<() => void>();
Object.assign(dom.window, {
  innerWidth: 390, innerHeight: 797, getComputedStyle: () => ({ direction: "ltr" }),
  matchMedia: (query: string) => ({
    matches: query.split(",").some(part => (!part.includes("hover:") || part.includes("hover: none")) && (!part.includes("pointer:") || part.includes("pointer: coarse")) && [...part.matchAll(/\((min|max)-width: (\d+)px\)/g)].every(([, kind, value]) => kind === "min" ? width >= Number(value) : width <= Number(value))),
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  }),
});
Object.assign(dom.HTMLElement.prototype, {
  getBoundingClientRect: () => ({ x: 0, y: 0, left: 0, top: 0, right: 44, bottom: 44, width: 44, height: 44 }),
  showModal(this: HTMLElement) { this.setAttribute("open", ""); },
  close(this: HTMLElement) { this.removeAttribute("open"); },
  scrollIntoView() {},
});
Object.assign(Object.getPrototypeOf(dom.document.createElement("video")), { pause() {}, play: () => Promise.resolve() });
Object.assign(globalThis, {
  window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0), cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
});
let root: Root | null = null;
let sent: ClientMessage[] = [];
const base = "/w/" + scenesLayoutFixture().world!.meta.worldId + "/p/saltlight/scenes";
async function mount(route = "/sc_04", size = 390) {
  width = size; sent = [];
  const host = dom.document.createElement("div"); dom.document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    __setBridgeForTest({ connect() {}, subscribe() { return () => {}; }, send(raw: string) { sent.push(JSON.parse(raw)); } } as unknown as ArkeBridge);
    __setStateForTest(scenesLayoutFixture()); __connectionStatusForTest("open");
    root!.render(<MemoryRouter initialEntries={[base + route]}><App /></MemoryRouter>);
  });
}
afterEach(async () => { await act(async () => root?.unmount()); root = null; dom.document.body.replaceChildren(); __setBridgeForTest(null); __connectionStatusForTest("closed"); });
const find = (selector: string) => dom.document.querySelector(selector) as unknown as HTMLElement;
const textButton = (text: string, scope = "body") => [...find(scope).querySelectorAll("button")].find(button => button.textContent?.trim() === text) as HTMLElement;
const click = async (element: HTMLElement) => { assert.ok(element); await act(async () => element.click()); };
const commands = () => sent.filter((message): message is Extract<ClientMessage, {kind: "scene-command"}> => message.kind === "scene-command").map(message => message.command);

it("gives a phone scene its own back row, two views, read-only scripts and an Arke sheet", async () => {
  await mount();
  assert.ok(find(".fy-scene-back")); assert.equal(find(".fy-production-mobile-nav"), null); assert.equal(find(".fy-titlebar"), null);
  assert.deepEqual([...find('.fy-sw__tabs').querySelectorAll('button')].map(e => e.textContent), ["Storyboard", "Preview"]);
  assert.equal(find('.fy-swrow__scripteditor'), null); assert.ok(find('.fy-swrow__script-read'));
  assert.equal(find('.fy-scene-dock[open]'), null);
  await click(find('.fy-sw__rail')); assert.ok(find('.fy-scene-dock[open]'));
});

it("moves a shot from its touch sheet without dragging", async () => {
  await mount(); await click(find('.fy-swrow__frameactions > button:last-child'));
  const sheet = '.fy-frame-actions-sheet[open]';
  assert.ok(textButton('Move up', sheet).hasAttribute('disabled'));
  await click(textButton('Move down', sheet));
  assert.deepEqual(commands(), [{kind: "move-shot", shotId: "sh_12", to: {after: "sh_13"}}]);
  assert.equal(find(sheet), null);
});

it("inserts after a shot through the same canonical scene writer", async () => {
  await mount(); await click(find('.fy-swrow__frameactions > button:last-child'));
  await click(textButton('Insert a shot after', '.fy-frame-actions-sheet[open]'));
  assert.equal(commands()[0]?.kind, "insert-shot");
  assert.deepEqual((commands()[0] as {at: unknown}).at, {after: "sh_12"});
});

it("keeps delete behind its existing confirmation", async () => {
  await mount(); await click(find('.fy-swrow__frameactions > button:last-child'));
  await click(textButton('Delete shot', '.fy-frame-actions-sheet[open]'));
  assert.ok(find('[role=alertdialog]')); assert.deepEqual(commands(), []);
});

it("offers the synopsis from the phone page menu as a sheet", async () => {
  await mount(); await click(find('.fy-scene-back > button:last-child'));
  await click(textButton('Scene details', '.fy-scene-page-menu[open]'));
  assert.ok(find('.fy-page-sheet[open] .fy-sbsynopsis'));
});

it("opens a shot's page actions and inspector without leaving a floating button over Stage", async () => {
  await mount('/sc_04/shots/sh_12?view=stage');
  assert.equal(find('.fy-sw__rail'), null);
  await click(find('.fy-stage-inspector-open')); assert.ok(find('.fy-stage-inspector-sheet[open]'));
  await click(find('.fy-stage-inspector-sheet[open] .ui-iconbtn'));
  await click(find('.fy-scene-back > button:last-child'));
  assert.ok(textButton('Open in generator', '.fy-scene-page-menu[open]'));
  await click(textButton('Ask Arke', '.fy-scene-page-menu[open]')); assert.ok(find('.fy-scene-dock[open]'));
});

it("starts a Fold with both rails put away and shows Flow as a touch list", async () => {
  await mount('/sc_04', 984);
  assert.ok(find('.fy-production-drawer-toggle')); assert.equal(find('.fy-production-drawer[open]'), null);
  assert.equal(find('.fy-scene-dock[open]'), null); assert.ok(find('.fy-sw__rail'));
  await click(textButton('Flow', '.fy-sw__tabs')); assert.ok(find('[data-touch-list=true]'));
  assert.ok(textButton('Add shot', '[data-touch-list=true]'));
});

it("returns to Storyboard when a Fold running Flow becomes a phone", async () => {
  await mount('/sc_04', 984); await click(textButton('Flow', '.fy-sw__tabs'));
  await act(async () => { width = 390; for (const listener of listeners) listener(); });
  assert.equal(find('[data-testid=workspace-flow]'), null); assert.ok(find('[data-testid=workspace-rows]'));
});

it("retains every camera field behind More on a compact shot", async () => {
  await mount('/sc_04/shots/sh_12');
  assert.equal(find('[aria-label="Shot focus"]'), null);
  assert.ok(find('[aria-label="Shot movement"]'));
  await click(find('[aria-label="More camera settings"]'));
  assert.ok(find('[aria-label="Shot focus"]')); assert.ok(find('[aria-label="Shot grade"]'));
});

it("keeps Rename reachable after the phone replaces the editable title", async () => {
  await mount('/sc_04/shots/sh_12');
  await click(find('.fy-scene-back > button:last-child')); await click(textButton('Rename', '.fy-scene-page-menu[open]'));
  const input = find('.fy-scene-rename input');
  const key = Object.keys(input).find(name => name.startsWith('__reactProps$'))!;
  await act(async () => (input as unknown as Record<string, {onChange: (event: {target: {value: string}}) => void}>)[key]!.onChange({target: {value: 'A new name'}}));
  await click(textButton('Save name', '.fy-scene-rename[open]'));
  assert.deepEqual(commands(), [{kind: 'edit-shot', shotId: 'sh_12', change: {title: 'A new name'}}]);
});
