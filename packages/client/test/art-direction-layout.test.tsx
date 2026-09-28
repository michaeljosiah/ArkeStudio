import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { parseHTML } from "linkedom";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { App } from "../src/App.js";
import { __connectionStatusForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { artDirectionLayoutFixture } from "./art-direction-layout-fixture.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
let width = 390, touch = true;
Object.assign(dom.window, { innerHeight: 812, getComputedStyle: () => ({ direction: "ltr" }), matchMedia: (query: string) => ({ matches: query.includes("hover: none") ? touch : width <= Number(/max-width:\s*(\d+)/.exec(query)?.[1] ?? 0), addEventListener() {}, removeEventListener() {} }) });
Object.assign(dom.HTMLElement.prototype, { scrollIntoView() {}, focus() {}, showModal(this: Element) { this.setAttribute("open", ""); }, close(this: Element) { this.removeAttribute("open"); } });
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined; const commands: { kind: string }[] = [];
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; dom.document.body.replaceChildren(); commands.length = 0; width = 390; touch = true; __setBridgeForTest(null); });
async function mount(route = "art-direction", mode = "normal") {
  const state = artDirectionLayoutFixture(mode);
  __setStateForTest(state); __setBridgeForTest({ connect() {}, subscribe() { return () => {}; }, send(raw: string) { commands.push(JSON.parse(raw)); } } as unknown as ArkeBridge); __connectionStatusForTest("open");
  const container = dom.document.createElement("div"); dom.document.body.append(container); root = createRoot(container as unknown as HTMLElement);
  await act(async () => root!.render(<MemoryRouter initialEntries={[`/w/${state.world!.meta.worldId}/${route}`]}><App /></MemoryRouter>));
}
const click = async (selector: string) => { const node = dom.document.querySelector(selector); assert.ok(node, selector); await act(async () => (node as unknown as HTMLButtonElement).click()); };

for (const mode of ["normal", "empty"]) it(`puts touch doors outside both ${mode} picture frames`, async () => {
  width = 1360; await mount("art-direction", mode);
  assert.equal(dom.document.querySelectorAll(".fy-artpicture > .fy-artdirection__hover").length, 2);
  assert.equal(dom.document.querySelectorAll(".fy-artdirection__master .fy-artdirection__hover,.fy-artdirection__keyart .fy-artdirection__hover").length, 0);
});
it("retains hover doors on a desktop and opens world models from the phone row", async () => {
  touch = false; await mount(); await click(".fy-artdirection__models-row");
  assert.ok(dom.document.querySelector('[data-testid="models-card"]'));
  assert.equal(dom.document.querySelectorAll(".fy-artdirection__master .fy-artdirection__hover,.fy-artdirection__keyart .fy-artdirection__hover").length, 2);
});
it("shows the complete long title on request and keeps history words in the document", async () => {
  await mount("art-direction", "long"); await click(".fy-artdirection__read-title");
  assert.ok(dom.document.querySelector("h1.is-expanded"));
  assert.ok(dom.document.querySelector(".fy-artdirection__history-copy")!.textContent!.length > 100);
  assert.equal(dom.document.querySelector(".fy-artdirection__history")!.getAttribute("title"), null);
});
it("sets the authored look from the held phone footer", async () => {
  await mount("art-direction/propose");
  assert.equal(dom.document.querySelector(".fy-artproposal__buttons"), null);
  await click(".fy-artproposal__foot button:last-child");
  assert.ok(commands.some(c => c.kind === "set-art-direction"));
});
it("keeps short wide titles complete and opens the full historical description", async () => {
  await mount("art-direction", "wide");
  const title = dom.document.querySelector(".fy-artdirection__detail h1")!;
  assert.ok(title.textContent!.length <= 70);
  assert.equal(title.hasAttribute("data-collapsible"), false);
  await click(".fy-artdirection__history");
  assert.equal(dom.document.querySelector("dialog[open] .fy-artdirection__history-full")?.textContent,
    "First sentence. Remaining visual guidance must stay available.");
});
it("accepts the staged proposal from the held phone footer", async () => {
  await mount("art-direction/propose", "staged");
  assert.ok(dom.document.querySelector(".fy-artproposal__foot")!.textContent!.includes("Accept · world look"));
  await click(".fy-artproposal__foot button:last-child");
  assert.ok(commands.some(c => c.kind === "proposal-accept"));
});

it("holds the selected master-look acceptance at the foot without generating again", async () => {
  await mount(); await click(".fy-artdirection__hover button");
  await click("dialog[open] .fy-gendialog__previews-grid button");
  const foot = dom.document.querySelector("dialog[open] .fy-gendialog__actions")!;
  assert.ok(foot.textContent!.includes("Use this"));
  assert.ok(!foot.textContent!.includes("Generate"));
  await click("dialog[open] .fy-gendialog__actions button");
  assert.ok(commands.some(c => c.kind === "use-master-look"));
  assert.ok(!commands.some(c => c.kind === "generate-master-look"));
});
