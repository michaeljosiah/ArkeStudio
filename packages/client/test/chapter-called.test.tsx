import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { ChapterSummary, ClientState } from "@arke-studio/contracts";
import { BookStrip } from "../src/screens/chapter-overview.js";
import { SavedLookCollection } from "../src/components/saved-look-collection.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }), innerWidth: 1600, innerHeight: 1000 });
Object.assign(dom.HTMLElement.prototype, { focus() {}, scrollIntoView() {} });
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) });

/** A book that opens on an unnumbered prologue: its second chapter is the book's Chapter 1. */
const BOOK: ChapterSummary[] = [
  { id: "prologue", file: "01-prologue", order: 1, title: "Prologue", status: "drafted", version: 1 },
  { id: "gold-on-gold", file: "02-gold-on-gold", order: 2, title: "Gold on Gold", status: "drafted", version: 1 },
];
const state: ClientState = { ...FIXTURE_STATE, world: { ...FIXTURE_STATE.world!, productions: FIXTURE_STATE.world!.productions.map((p) => (p.meta.id === "saltlight" ? { ...p, chapters: BOOK } : p)) } };

const roots: Root[] = [];
async function render(node: ReactNode): Promise<HTMLElement> {
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(node));
  return container;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  dom.document.body.innerHTML = "";
  __setBridgeForTest(null);
  __setStateForTest(FIXTURE_STATE);
});

describe("chapters named as the book calls them (issue 3240, SPEC-047 R-2)", () => {
  it("an unnumbered Prologue first leaves the second chapter Chapter 1 on the book strip and the look chooser", async () => {
    const strip = await render(<BookStrip chapters={BOOK.map((c) => ({ id: c.id, order: c.order, title: c.title, words: 900, planned: false }))} current="gold-on-gold" onChapter={() => {}} />);
    assert.equal(strip.querySelector(".fy-chov__book b")?.textContent, "Chapter 1", "its place is 2, its number 1");
    assert.deepEqual([...strip.querySelectorAll(".fy-chov__seg")].map((segment) => segment.getAttribute("aria-label")), ["Prologue", "Chapter 1 · Gold on Gold"], "the prologue goes by its title alone");

    __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send() {} } as unknown as ArkeBridge);
    await act(async () => __setStateForTest(state, { connection: "open" }));
    await render(<SavedLookCollection worldId={FIXTURE_WORLD_ID} productionId="saltlight" sheetId="maren-kest" name="Maren Kest" chapterOrder={2} currentId={null} sourceOrder={1} onChoose={() => {}} onClose={() => {}} />);
    assert.equal(dom.document.body.querySelector('[data-testid="saved-look-use"]')?.textContent, "Use for Chapter 1");
    assert.match(dom.document.body.textContent ?? "", /For Chapter 1/);
    assert.equal(dom.document.body.querySelector(".fy-savedlook__status")?.textContent, "Used for Chapter 1 · from Prologue");
  });
});
