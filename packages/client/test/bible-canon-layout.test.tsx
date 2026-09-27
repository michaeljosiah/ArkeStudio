import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { parseHTML } from "linkedom";
import type { ClientMessage } from "@arke-studio/contracts";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { BibleScreen } from "../src/screens/bible.js";
import { CanonScreen, CanonThreadScreen } from "../src/screens/world.js";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
const listeners = new Set<() => void>();
let phone = true;
Object.assign(dom.window, {
  innerWidth: 390, innerHeight: 797,
  matchMedia: (query: string) => ({ matches: query.includes("max-width") && phone, addEventListener: (_: string, fn: () => void) => listeners.add(fn), removeEventListener: (_: string, fn: () => void) => listeners.delete(fn) }),
  getComputedStyle: () => ({ direction: "ltr" }),
});
Object.assign(dom.HTMLElement.prototype, { focus() {}, scrollIntoView() {}, showModal(this: HTMLElement) { this.setAttribute("open", ""); }, close(this: HTMLElement) { this.removeAttribute("open"); } });
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
const sent: ClientMessage[] = [];
let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  dom.document.body.replaceChildren();
  __setBridgeForTest(null);
  __setStateForTest(FIXTURE_STATE);
  sent.length = 0;
  phone = true;
});

async function mount(route: string) {
  const state = structuredClone(FIXTURE_STATE);
  state.app.health.harness = { status: "healthy" };
  state.world!.bible = { present: true, version: 3, updated: "2026-09-27", text: "## The tides\n\nThe harbour <br> keeps the ledger." };
  __setStateForTest(state);
  __setBridgeForTest({ connect() {}, subscribe() { return () => {}; }, send(raw: string) { sent.push(JSON.parse(raw)); } } as unknown as ArkeBridge);
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => root!.render(<MemoryRouter initialEntries={[`/w/${state.world!.meta.worldId}/${route}`]}><Routes>
    <Route path="/w/:worldId/bible" element={<BibleScreen />} />
    <Route path="/w/:worldId/canon" element={<CanonScreen />} />
    <Route path="/w/:worldId/canon/:entryId/thread" element={<CanonThreadScreen />} />
  </Routes></MemoryRouter>));
  return state;
}
async function change(selector: string, value: string) {
  const node = dom.document.querySelector(selector)!;
  const key = Object.keys(node).find(key => key.startsWith("__reactProps$"))!;
  const props = (node as unknown as Record<string, { onChange(event: { target: { value: string } }): void }>)[key]!;
  await act(async () => props.onChange({ target: { value } }));
}
const button = (text: string, within: ParentNode = dom.document as unknown as Document) =>
  [...within.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === text)!;

it("keeps the thread's settlement in its sheet and retains the draft across close and resize", async () => {
  const entry = FIXTURE_STATE.world!.canon.find(entry => entry.status === "open")!;
  await mount(`canon/${entry.id}/thread`);
  assert.equal(dom.document.querySelector("textarea"), null);
  await act(async () => (dom.document.querySelector(".fy-thread-peek") as unknown as HTMLButtonElement).click());
  const sheet = dom.document.querySelector("dialog")!;
  assert.ok(sheet.hasAttribute("open"));
  await change("dialog textarea", "Odile taught the Chorister.");
  await act(async () => button("Settle thread", sheet as unknown as ParentNode).click());
  const command = sent.find(message => message.kind === "settle-thread");
  assert.ok(command?.kind === "settle-thread");
  assert.equal(command.entryId, entry.id);
  assert.equal(command.statement, "Odile taught the Chorister.");
  assert.equal(command.resolvedType, "lore");
  await act(async () => (sheet.querySelector('[aria-label="Close"]') as unknown as HTMLButtonElement).click());
  assert.equal(dom.document.querySelector("dialog"), null);
  await act(async () => { phone = false; for (const notify of listeners) notify(); });
  assert.match(dom.document.querySelector(".fy-thread-preview")?.textContent ?? "", /Odile taught the Chorister\./);
  assert.equal(dom.document.querySelectorAll("textarea").length, 1);
  await act(async () => button("Settle thread").click());
  assert.equal(sent.filter(message => message.kind === "settle-thread" && message.statement === "Odile taught the Chorister.").length, 2);
});

it("restores Bible versions and confirms read-aloud inside the contents sheet", async () => {
  const state = await mount("bible");
  await act(async () => (dom.document.querySelector(".fy-bible-contents") as unknown as HTMLButtonElement).click());
  const sheet = dom.document.querySelector("dialog")!;
  await act(async () => button("Restore", sheet as unknown as ParentNode).click());
  assert.ok(sent.some(message => message.kind === "restore-bible" && message.version === 2));
  await act(async () => (sheet.querySelector('[aria-label="Read The tides aloud"]') as unknown as HTMLButtonElement).click());
  const command = sent.find(message => message.kind === "read-bible-section");
  assert.ok(command?.kind === "read-bible-section");
  await act(async () => __applyEventForTest({
    type: "voice.audio", at: "2026-09-27T12:00:00Z", worldId: state.world!.meta.worldId, requestId: command.requestId,
    sheetVersion: 3, purpose: "bible-section", sectionHeading: "The tides", provider: "elevenlabs", model: "eleven_multilingual_v2", voiceId: "narrator",
    status: "confirmation-required", format: "wav", file: null, cached: false, characterCount: 36, estimatedMicroUsd: 1200, confirmationToken: "quoted",
  }));
  const confirmation = sheet.querySelector(".fy-read-confirmation")!;
  assert.ok(confirmation, "the quote stays inside the native modal");
  assert.equal(dom.document.querySelector(".fy-editordialog"), null);
  const confirm = [...confirmation.querySelectorAll("button")].find(node => node.textContent?.startsWith("Confirm "))!;
  await act(async () => (confirm as unknown as HTMLButtonElement).click());
  assert.equal(sent.filter(message => message.kind === "read-bible-section").length, 2);
  assert.equal(sheet.querySelector(".fy-read-confirmation"), null);
});

it("keeps canon grid and answer geometry in classes and provides the phone's New door", async () => {
  const state = await mount("canon");
  assert.equal(dom.document.querySelector(".fy-canon-grid")?.getAttribute("style"), null);
  assert.ok(dom.document.querySelector(".fy-document-head .fy-phone-only"));
  assert.ok(dom.document.querySelector(".fy-canon-corner"), "desktop corner has a class the phone rule hides");
  await change(".fy-askbar input", "Who rings the bells?");
  await act(async () => button("Ask").click());
  const command = sent.find(message => message.kind === "canon-ask");
  assert.ok(command?.kind === "canon-ask");
  await act(async () => __applyEventForTest({ type: "canon.answer", at: "2026-09-27T12:00:00Z", worldId: state.world!.meta.worldId, askId: command.askId, result: { outcome: "answer", searched: 1, claims: [{ entryId: "CANON-002", text: "The keepers ring.", excerpt: "The keepers ring." }] } }));
  assert.equal(dom.document.querySelector(".fy-canon-result")?.getAttribute("style"), null);
  assert.ok(button("Save as lore note"));
});
