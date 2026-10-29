import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes } from "react-router";
import { DEFAULT_COMIC_SETTINGS, DEFAULT_LETTERING_THRESHOLDS, comicPageHash, ulid, type ClientMessage, type ClientState, type ComicPage, type ComicPageRecord } from "@arke-studio/contracts";
import { ComicPagesScreen } from "../src/screens/comic-pages.js";
import { productionPages } from "../src/lib/production-navigation.js";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";

/** A graphic novel's Pages (design turn 247, SPEC-064): the strip, the editor, takes and findings, Export. */
const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }), innerWidth: 1440, innerHeight: 900 });
Object.assign(dom.HTMLElement.prototype, { focus() {}, scrollIntoView() {} });
Object.assign(globalThis, {
  window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node,
  Event: dom.Event, KeyboardEvent: dom.Event, IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0),
});

const AT = "2026-10-29T09:00:00.000Z";
const ARTIFACT = "ar_01J8G0000000000000000000P1";
const reader = { id: "harness-vision", version: "1:Claude Sonnet 5" };

function page(): ComicPage {
  return { id: ulid(), layout: "feature", status: "draft", panels: [
    { id: ulid(), description: "Maren on the pier.", characters: ["maren-kest"], lettering: [{ id: ulid(), kind: "speech", speaker: "maren-kest", text: "Where are you?" }] },
  ] };
}

function withBook(pages: ComicPage[], records: Record<string, ComicPageRecord>): ClientState {
  const state = structuredClone(FIXTURE_STATE);
  const base = state.world!.productions[0]!;
  const comic = { ...structuredClone(base), meta: { ...base.meta, id: "low-water-drawn", title: "Low Water, drawn", format: "story", medium: "story", kind: "graphic-novel" },
    chapters: [{ id: "the-tide", order: 1, title: "The tide", file: "01-the-tide.md", words: 0, version: 1, hash: "sha256:c", status: "draft" }],
    scenes: [], episodes: [], takes: [],
    comic: DEFAULT_COMIC_SETTINGS,
    comicScripts: [{ chapter: "the-tide", hash: "sha256:base", script: { version: 1, pages } }],
    comicPages: Object.entries(records).map(([id, record]) => ({ page: id, hash: `sha256:${id}`, record })) };
  state.world!.productions = [...state.world!.productions, comic] as never;
  state.world!.artifacts = [...state.world!.artifacts, { id: ARTIFACT, file: "page.png", kind: "image" } as never];
  return state;
}

let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null; __setBridgeForTest(null); __setStateForTest(FIXTURE_STATE);
  dom.document.body.innerHTML = "";
});
async function mount(state: ClientState) {
  const sent: ClientMessage[] = [];
  __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send: (json: string) => { sent.push(JSON.parse(json)); } } satisfies ArkeBridge);
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    __setStateForTest(state, { connection: "open" });
    root!.render(<MemoryRouter initialEntries={[`/w/${FIXTURE_WORLD_ID}/p/low-water-drawn/story/pages`]}>
      <Routes><Route path="/w/:worldId/p/:prodId/story/pages" element={<ComicPagesScreen />} /></Routes>
    </MemoryRouter>);
  });
  return { container, sent };
}
const props = (el: Element) => (el as unknown as Record<string, Record<string, any>>)[Object.keys(el).find((key) => key.startsWith("__reactProps$"))!]!;
const button = (container: HTMLElement, text: string) => [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);

describe("Pages (turn 247)", () => {
  it("puts Pages on a graphic novel's rail in place of Audiobook", () => {
    const labels = productionPages({ hasChapters: true, isEpisodic: false, isBranching: false, hasPages: true }).map(([, label]) => label);
    assert.ok(labels.includes("Pages"));
    assert.ok(!labels.includes("Audiobook"));
  });

  it("quotes the page, then makes it until it passes on the price shown for every attempt (247b)", async () => {
    const one = page();
    const m = await mount(withBook([one], {}));
    const quote = m.sent.find((message): message is Extract<ClientMessage, { kind: "quote-comic-page" }> => message.kind === "quote-comic-page")!;
    assert.equal(quote.page, one.id);
    await act(async () => __applyEventForTest({ at: AT, type: "comic.page-quote", requestId: quote.requestId, worldId: FIXTURE_WORLD_ID, productionId: "low-water-drawn", page: one.id,
      quote: { ok: true, model: "gpt-image-2", modelName: "GPT Image 2", mode: "baked", aspect: "2:3", microUsd: 250_000, brief: "A page.", riding: ["Maren Kest"], missing: [] } }));
    assert.match(m.container.textContent!, /GPT Image 2 · 2:3 · Maren Kest ride · ~\$0\.25 · up to 3 · ~\$0\.75/);
    await act(async () => props(button(m.container, "Make page")!).onClick({}));
    const make = m.sent.find((message): message is Extract<ClientMessage, { kind: "make-comic-page" }> => message.kind === "make-comic-page")!;
    assert.equal(make.untilPasses, true);
    assert.equal(make.confirmedMicroUsd, 750_000);
  });

  it("holds Make after an edit until the words are saved and priced again (codex on PR 2226)", async () => {
    const one = page();
    const m = await mount(withBook([one], {}));
    const first = m.sent.find((message): message is Extract<ClientMessage, { kind: "quote-comic-page" }> => message.kind === "quote-comic-page")!;
    await act(async () => __applyEventForTest({ at: AT, type: "comic.page-quote", requestId: first.requestId, worldId: FIXTURE_WORLD_ID, productionId: "low-water-drawn", page: one.id,
      quote: { ok: true, model: "gpt-image-2", modelName: "GPT Image 2", mode: "baked", aspect: "2:3", microUsd: 250_000, brief: "A page.", riding: [], missing: [] } }));
    assert.equal((button(m.container, "Make page") as unknown as HTMLButtonElement).disabled, false);
    await act(async () => props(m.container.querySelector("input[aria-label='Words']")!).onChange({ target: { value: "Where now?" } }));
    assert.equal((button(m.container, "Make page") as unknown as HTMLButtonElement).disabled, true, "the old price is for the old words");
    await act(async () => props(button(m.container, "Make page")!).onClick({}));
    assert.equal(m.sent.some((message) => message.kind === "make-comic-page"), false);
  });

  it("draws a take's findings, and Accept anyway covers every blocking one (247c)", async () => {
    const one = page();
    const take = ulid();
    const item = one.panels[0]!.lettering[0]!.id;
    const record: ComicPageRecord = { version: 1, accepted: {}, lettering: {}, acknowledged: {}, making: [], takes: [{
      id: take, artifact: ARTIFACT, hash: comicPageHash(one, DEFAULT_COMIC_SETTINGS, "baked"), mode: "baked", model: "gpt-image-2", language: "en", at: AT,
      verification: { status: "compared", reader, normalizationVersion: 1, thresholds: DEFAULT_LETTERING_THRESHOLDS, score: 0.6, speaker: "not-checked", regions: [], at: AT,
        findings: [{ id: `altered:${item}`, kind: "altered", item, expected: "Where are you?", found: "WHER ARE YOU?", box: { x: 0.1, y: 0.5, w: 0.3, h: 0.07 } }] },
    }] };
    const m = await mount(withBook([one], { [one.id]: record }));
    assert.match(m.container.querySelector(".fy-comic__verdict")!.textContent!, /1 to fix/);
    assert.equal(m.container.querySelector(".fy-comic__hit")?.textContent, "Altered");
    assert.match(m.container.querySelector(".fy-comic__finds")!.textContent!, /Where are you\?WHER ARE YOU\?/);
    assert.equal(button(m.container, "Accept"), undefined, "no one-press accept past a finding");
    await act(async () => props(button(m.container, "Accept anyway")!).onClick({}));
    const accept = m.sent.find((message): message is Extract<ClientMessage, { kind: "accept-comic-take" }> => message.kind === "accept-comic-take")!;
    assert.deepEqual(accept.override, { findings: [`altered:${item}`] });
  });

  it("says a check that could not run is not checked, never a pass (247e)", async () => {
    const one = page();
    const record: ComicPageRecord = { version: 1, accepted: {}, lettering: {}, acknowledged: {}, making: [], takes: [{
      id: ulid(), artifact: ARTIFACT, hash: comicPageHash(one, DEFAULT_COMIC_SETTINGS, "baked"), mode: "baked", model: "gpt-image-2", language: "en", at: AT,
      verification: { status: "unavailable", reason: "no-reader", at: AT } }] };
    const m = await mount(withBook([one], { [one.id]: record }));
    assert.match(m.container.querySelector(".fy-comic__verdict")!.textContent!, /Not checked\s*no image reader/);
    assert.equal(button(m.container, "Accept"), undefined);
    assert.ok(button(m.container, "Accept anyway"));
  });

  it("saves the chapter's script a moment after an edit, on the base it read", async () => {
    const one = page();
    const m = await mount(withBook([one], {}));
    const words = m.container.querySelector<HTMLInputElement>("input[aria-label='Words']")!;
    await act(async () => props(words).onChange({ target: { value: "Where are you now?" } }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 800)); });
    const save = m.sent.find((message): message is Extract<ClientMessage, { kind: "save-comic-script" }> => message.kind === "save-comic-script")!;
    assert.equal(save.baseHash, "sha256:base");
    assert.equal(save.pages[0]!.panels[0]!.lettering[0]!.text, "Where are you now?");
  });

  it("keeps a new, empty panel here until it is written, and holds Export meanwhile (codex on PR 2226)", async () => {
    const m = await mount(withBook([page()], {}));
    const panel = [...m.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Panel")!;
    await act(async () => props(panel).onClick({}));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 800)); });
    assert.equal(m.sent.some((message) => message.kind === "save-comic-script"), false, "an empty panel would be refused unanswered");
    assert.equal((button(m.container, "Export") as unknown as HTMLButtonElement).disabled, true);
  });

  it("opens another chapter's own pages while this one's save is in flight (codex on PR 2226)", async () => {
    const state = withBook([page()], {});
    const comic = state.world!.productions.at(-1)! as unknown as { chapters: unknown[]; comicScripts: unknown[] };
    const salt = page(); salt.panels[0]!.description = "Salt on the boards.";
    comic.chapters.push({ id: "salt", order: 2, title: "Salt", file: "02-salt.md", words: 0, version: 1, hash: "sha256:s", status: "draft" });
    comic.comicScripts.push({ chapter: "salt", hash: "sha256:salt", script: { version: 1, pages: [salt] } });
    const m = await mount(state);
    await act(async () => props(m.container.querySelector("input[aria-label='Words']")!).onChange({ target: { value: "Edited in the tide." } }));
    const tab = [...m.container.querySelectorAll("button[role='tab']")].find((b) => b.textContent?.includes("Salt"))!;
    await act(async () => props(tab).onClick({}));
    assert.equal(m.sent.filter((message) => message.kind === "save-comic-script").length, 1, "the tide's edit went first");
    assert.equal(props(m.container.querySelector("textarea[aria-label='Panel 1']")!).value, "Salt on the boards.");
  });

  it("keeps a refused save's pages unsaved (codex on PR 2226)", async () => {
    const m = await mount(withBook([page()], {}));
    await act(async () => props(m.container.querySelector("input[aria-label='Words']")!).onChange({ target: { value: "Mine." } }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 800)); });
    const save = m.sent.find((message): message is Extract<ClientMessage, { kind: "save-comic-script" }> => message.kind === "save-comic-script")!;
    await act(async () => __applyEventForTest({ at: AT, type: "comic-script.save-result", requestId: save.requestId, worldId: FIXTURE_WORLD_ID, productionId: "low-water-drawn", chapter: "the-tide", disposition: "refused", reason: "the script changed" }));
    assert.equal((button(m.container, "Export") as unknown as HTMLButtonElement).disabled, true, "still unsaved");
    assert.equal(props(m.container.querySelector("input[aria-label='Words']")!).value, "Mine.");
  });

  it("holds Export while a page has no accepted take, with Go to (247g)", async () => {
    const m = await mount(withBook([page(), page()], {}));
    await act(async () => props(button(m.container, "Export")!).onClick({}));
    const sheet = dom.document.body.textContent!;
    assert.match(sheet, /0 of 2 accepted/);
    assert.match(sheet, /Page 1 · no accepted take/);
    const exportPress = [...dom.document.querySelectorAll("button")].filter((b) => b.textContent === "Export").at(-1)!;
    assert.equal((exportPress as unknown as HTMLButtonElement).disabled, true);
  });
});
