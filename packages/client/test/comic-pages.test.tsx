import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes } from "react-router";
import { DEFAULT_COMIC_SETTINGS, DEFAULT_LETTERING_THRESHOLDS, comicPageHash, ulid, type ClientMessage, type ClientState, type ComicPage, type ComicPageRecord, type ComicPageTake } from "@arke-studio/contracts";
import { ComicPagesScreen, notChecked, sideWidth } from "../src/screens/comic-pages.js";
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

  it("offers Accept anyway again on an accepted take a re-check found fault with (codex on PR 2226)", async () => {
    const one = page();
    const take = ulid();
    const item = one.panels[0]!.lettering[0]!.id;
    const record: ComicPageRecord = { version: 1, accepted: { en: take }, lettering: {}, acknowledged: {}, making: [], takes: [{
      id: take, artifact: ARTIFACT, hash: comicPageHash(one, DEFAULT_COMIC_SETTINGS, "baked"), mode: "baked", model: "gpt-image-2", language: "en", at: AT,
      verification: { status: "compared", reader, normalizationVersion: 1, thresholds: DEFAULT_LETTERING_THRESHOLDS, score: 0.6, speaker: "not-checked", regions: [], at: AT,
        findings: [{ id: `missing:${item}`, kind: "missing", item, expected: "Where are you?" }] },
    }] };
    const m = await mount(withBook([one], { [one.id]: record }));
    assert.ok(button(m.container, "Accept anyway"), "the accepted take's new finding can be kept on the record");
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

  it("never takes a late snapshot of its own earlier save as news, so the next save is not refused as stale", async () => {
    // The Ledger of Nights, drawn (30 October 2026): frames are answered concurrently, so the
    // snapshot after one save arrived after the next save's answer, put the base back a save, and
    // the edit after that was refused "Something changed while this was saving".
    const one = page();
    const state = withBook([one], {});
    const m = await mount(state);
    const saves = () => m.sent.filter((message): message is Extract<ClientMessage, { kind: "save-comic-script" }> => message.kind === "save-comic-script");
    const answer = async (requestId: string, hash: string) => act(async () => __applyEventForTest({ at: AT, type: "comic-script.save-result", requestId, worldId: FIXTURE_WORLD_ID, productionId: "low-water-drawn", chapter: "the-tide", disposition: "saved", version: 1, hash }));
    const type = async (text: string) => {
      await act(async () => props(m.container.querySelector("input[aria-label='Words']")!).onChange({ target: { value: text } }));
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 800)); });
    };
    await type("First.");
    await answer(saves()[0]!.requestId, "sha256:one");
    await type("Second.");
    assert.equal(saves()[1]!.baseHash, "sha256:one");
    await answer(saves()[1]!.requestId, "sha256:two");
    // The snapshot taken after the first save lands now, late.
    const late = structuredClone(state);
    const comic = late.world!.productions.at(-1)! as unknown as { comicScripts: Array<{ hash: string; script: { pages: ComicPage[] } }> };
    comic.comicScripts[0]!.hash = "sha256:one";
    comic.comicScripts[0]!.script.pages[0]!.panels[0]!.lettering[0]!.text = "First.";
    await act(async () => __setStateForTest(late, { connection: "open" }));
    assert.equal(props(m.container.querySelector("input[aria-label='Words']")!).value, "Second.", "the late snapshot does not undo the screen");
    await type("Third.");
    assert.equal(saves()[2]!.baseHash, "sha256:two", "saved on the newest base, not the late snapshot's");
  });

  it("takes another window's return to older words as news once its own saves have caught up (codex on PR 2271)", async () => {
    const one = page();
    const state = withBook([one], {});
    const m = await mount(state);
    const saves = () => m.sent.filter((message): message is Extract<ClientMessage, { kind: "save-comic-script" }> => message.kind === "save-comic-script");
    const answer = async (requestId: string, hash: string) => act(async () => __applyEventForTest({ at: AT, type: "comic-script.save-result", requestId, worldId: FIXTURE_WORLD_ID, productionId: "low-water-drawn", chapter: "the-tide", disposition: "saved", version: 1, hash }));
    const type = async (text: string) => {
      await act(async () => props(m.container.querySelector("input[aria-label='Words']")!).onChange({ target: { value: text } }));
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 800)); });
    };
    const snapshot = async (hash: string, text: string) => {
      const next = structuredClone(state);
      const comic = next.world!.productions.at(-1)! as unknown as { comicScripts: Array<{ hash: string; script: { pages: ComicPage[] } }> };
      comic.comicScripts[0]!.hash = hash;
      comic.comicScripts[0]!.script.pages[0]!.panels[0]!.lettering[0]!.text = text;
      await act(async () => __setStateForTest(next, { connection: "open" }));
    };
    await type("A.");
    await answer(saves()[0]!.requestId, "sha256:a");
    await type("B.");
    await answer(saves()[1]!.requestId, "sha256:b");
    await snapshot("sha256:b", "B.");
    // Another window puts the words back to A: the same text, so the same hash.
    await snapshot("sha256:a", "A.");
    assert.equal(props(m.container.querySelector("input[aria-label='Words']")!).value, "A.");
    await type("C.");
    assert.equal(saves()[2]!.baseHash, "sha256:a");
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

describe("Pages uses the window and says what it is doing (turn 251)", () => {
  const hashOf = (one: ComicPage) => comicPageHash(one, DEFAULT_COMIC_SETTINGS, "baked");

  it("has the whole content area, and sizes the page column from the height (251a)", async () => {
    const m = await mount(withBook([page()], {}));
    assert.ok(m.container.querySelector(".fy-comic-screen[data-screen='comic-pages']"), "not the 1,080 column a page of reading gets");
    assert.equal(m.container.querySelector(".lay-screen"), null);
    // 1920 × 1080 less the head: a 2:3 page stands about 520 wide above what sits under it.
    assert.equal(sideWidth({ width: 1712, height: 1024 }, [2, 3]), Math.round((1024 - 272) * 2 / 3) + 36);
    assert.equal(sideWidth({ width: 900, height: 1400 }, [2, 3]), 900 - 136 - 440, "the script keeps its 440");
    assert.equal(sideWidth({ width: 1600, height: 400 }, [2, 3]), 320, "never a page nobody can read");
  });

  it("says Making on the page, its thumbnail and the button while the record says so (251b)", async () => {
    const one = page();
    const record: ComicPageRecord = { version: 1, accepted: {}, lettering: {}, acknowledged: {}, takes: [],
      making: [{ requestId: ulid(), hash: hashOf(one), mode: "baked", model: "codex-image", language: "en", at: new Date(Date.now() - 72_000).toISOString() }] };
    const m = await mount(withBook([one], { [one.id]: record }));
    const over = m.container.querySelector(".fy-comic__over")!;
    assert.match(over.textContent!, /MakingTake 1 · 1:1\d/, "opened mid-run, it counts the record's takes");
    const press = [...m.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Making")!;
    assert.equal((press as unknown as HTMLButtonElement).disabled, true, "a second press is not offered");
    assert.equal(m.container.querySelector(".fy-comic__thumb.busy")?.getAttribute("aria-busy"), "true");
  });

  it("shows a landed take at once and says Checking until its verdict (251c)", async () => {
    const one = page();
    const old = ulid();
    const landed = ulid();
    const take = (id: string, verification?: ComicPageTake["verification"]): ComicPageTake => ({ id, artifact: ARTIFACT, hash: hashOf(one), mode: "baked", model: "codex-image", language: "en", at: new Date().toISOString(), ...(verification ? { verification } : {}) });
    const record: ComicPageRecord = { version: 1, accepted: { en: old }, lettering: {}, acknowledged: {}, making: [],
      takes: [take(old, { status: "unavailable", reason: "no-reader", at: AT }), take(landed)] };
    const m = await mount(withBook([one], { [one.id]: record }));
    await act(async () => __applyEventForTest({ at: AT, type: "comic.page-made", requestId: ulid(), worldId: FIXTURE_WORLD_ID, productionId: "low-water-drawn", page: one.id, state: "checking", take: landed }));
    assert.match(m.container.querySelector(".fy-comic__takes")!.textContent!, /Take 2 of 2/, "the new take, not the accepted one");
    assert.match(m.container.querySelector(".fy-comic__verdict")!.textContent!, /Checking lettering/);
    assert.equal(button(m.container, "Accept"), undefined, "Accept waits for the verdict");
    assert.equal(button(m.container, "Accept anyway"), undefined);
  });

  it("says the reader can't see pictures, and Choose reader checks again once one is chosen (251d)", async () => {
    const one = page();
    const id = ulid();
    const record: ComicPageRecord = { version: 1, accepted: {}, lettering: {}, acknowledged: {}, making: [], takes: [{
      id, artifact: ARTIFACT, hash: hashOf(one), mode: "baked", model: "codex-image", language: "en", at: AT,
      verification: { status: "unavailable", reason: "reader-failed", detail: "The selected visual reviewer cannot inspect images. No image content was sent.", at: AT } }] };
    const state = withBook([one], { [one.id]: record });
    const m = await mount(state);
    assert.match(m.container.querySelector(".fy-comic__verdict")!.textContent!, /Not checked\s*the reader can’t see pictures/);
    assert.equal(button(m.container, "Check again"), undefined, "checking again with the same reader cannot help");
    await act(async () => props(button(m.container, "Choose reader")!).onClick({}));
    assert.equal(m.sent.some((message) => message.kind === "check-comic-take"), false);

    await act(async () => root?.unmount());
    const chosen = structuredClone(state);
    chosen.app.agents = [...chosen.app.agents.filter((agent) => agent.name !== "page-lettering-reader"),
      { name: "page-lettering-reader", description: "Reads lettering", shippedBrief: "", brief: "", edited: false, model: "github-copilot/claude-opus-5.5" } as never];
    const back = await mount(chosen);
    const check = back.sent.find((message): message is Extract<ClientMessage, { kind: "check-comic-take" }> => message.kind === "check-comic-take");
    assert.equal(check?.take, id, "the take it could not check is read again");
  });

  it("offers Check again on a take that landed while no reader was ready, beside Choose reader", async () => {
    // The 2026-10-31 Undersong pages were made where no reader was ready and kept that verdict in the
    // app, where one was; nothing but changing the chosen model would read them.
    const one = page();
    const id = ulid();
    const record: ComicPageRecord = { version: 1, accepted: {}, lettering: {}, acknowledged: {}, making: [], takes: [{
      id, artifact: ARTIFACT, hash: hashOf(one), mode: "baked", model: "codex-image", language: "en", at: AT,
      verification: { status: "unavailable", reason: "no-reader", at: AT } }] };
    const m = await mount(withBook([one], { [one.id]: record }));
    assert.match(m.container.querySelector(".fy-comic__verdict")!.textContent!, /Not checked\s*no image reader/);
    assert.ok(button(m.container, "Choose reader"));
    await act(async () => props(button(m.container, "Check again")!).onClick({}));
    const check = m.sent.find((message): message is Extract<ClientMessage, { kind: "check-comic-take" }> => message.kind === "check-comic-take");
    assert.equal(check?.take, id);
  });

  it("says why for a time-out, and offers Check again rather than a setting", () => {
    assert.deepEqual(notChecked({ status: "unavailable", reason: "reader-failed", detail: "Review task timed out. It was not retried.", at: AT }), { text: "the reader timed out", reader: false });
    assert.deepEqual(notChecked({ status: "unavailable", reason: "no-reader", at: AT }), { text: "no image reader", reader: true });
  });
});

describe("Arke's pages (turn 249)", () => {
  const PATH = "productions/low-water-drawn/comic/the-tide.json";
  function withDraft(pages: ComicPage[]): ClientState {
    const state = withBook([], {});
    const proposal = { id: "pr_01J8H0000000000000000000Q9", kind: "comic-script", status: "pending", summary: "The tide pages", draftRevision: 2,
      targets: [{ path: PATH, baseVersion: null, baseHash: null }], createdAt: AT } as never;
    state.world!.proposals = [...state.world!.proposals, { proposal, ripple: [], comicScripts: { [PATH]: { version: 1, pages } } } as never];
    return state;
  }

  it("says a chapter has no pages, and offers + Page (249c)", async () => {
    const m = await mount(withBook([], {}));
    assert.match(m.container.textContent!, /1 · The tide has no pages/);
    assert.ok(button(m.container, "+ Page"));
  });

  it("shows Arke's draft dashed, every panel with its passage, and Make waits for Keep (249d)", async () => {
    const drafted = page();
    drafted.panels[0]!.source = { story: "low-water-drawn", chapter: "the-tide", version: 1, paragraphs: [1, 2] };
    const m = await mount(withDraft([drafted, page()]));
    assert.match(m.container.textContent!, /Arke’s draft2 pages from chapter 1/);
    assert.equal(m.container.querySelectorAll(".fy-comic__thumb--draft").length, 2);
    assert.match(m.container.querySelector(".fy-comic__src")!.textContent!, /1.2/);
    const make = [...m.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Make page"))!;
    assert.equal((make as unknown as HTMLButtonElement).disabled, true);
    assert.match(m.container.textContent!, /Keep the draft first/);

    await act(async () => props(button(m.container, "Keep")!).onClick({}));
    const keep = m.sent.find((message) => message.kind === "proposal-accept") as Extract<ClientMessage, { kind: "proposal-accept" }>;
    assert.equal(keep.proposalId, "pr_01J8H0000000000000000000Q9");
    assert.equal(keep.expectedDraftRevision, 2, "kept as drafted, never a later revision");
    await act(async () => props(button(m.container, "Discard")!).onClick({}));
    assert.ok(m.sent.some((message) => message.kind === "proposal-discard"));
  });
});

describe("Style (turn 248)", () => {
  const styleSent = (sent: ClientMessage[]) => sent.filter((message): message is Extract<ClientMessage, { kind: "set-comic-settings" }> => message.kind === "set-comic-settings").at(-1);
  const card = (name: string) => [...dom.document.querySelectorAll(".fy-comic-style")].find((el) => el.querySelector(".fy-comic-style__name")?.textContent === name)!;
  const words = () => dom.document.querySelector("textarea[aria-label='Words for this style']");

  it("shows World look until a style is chosen, then the chosen style's page and name (248b)", async () => {
    const m = await mount(withBook([page()], {}));
    assert.equal(button(m.container, "StyleWorld look") !== undefined, true);
    const state = withBook([page()], {});
    (state.world!.productions.at(-1) as { comic: object }).comic = { ...DEFAULT_COMIC_SETTINGS, style: { words: "Japanese manga.", preset: "manga" } };
    const n = await mount(state);
    const head = n.container.querySelector("button[aria-label='Style: Manga']")!;
    assert.ok(head.querySelector("img[src='./comic-styles/manga.jpg']"), "the style shown by its page");
  });

  it("offers every style as its page; a card seeds the words, which stay editable, and Use style sends them", async () => {
    const m = await mount(withBook([page()], {}));
    await act(async () => props(button(m.container, "StyleWorld look")!).onClick({}));
    const names = [...dom.document.querySelectorAll(".fy-comic-style__name")].map((el) => el.textContent);
    assert.deepEqual(names, ["World look", "Manga", "Superhero", "Clean line", "Noir", "Webtoon", "Painted", "Watercolour", "Ink and wash", "Vintage print", "Your own"]);
    assert.equal(dom.document.querySelectorAll(".fy-comic-style img[src^='./comic-styles/']").length, 9);
    assert.equal(words(), null, "World look has no words of its own");

    await act(async () => props(card("Noir")).onClick({}));
    assert.match(props(words()!).value, /^Crime noir comic/);
    assert.match(dom.document.body.textContent!, /SEEDED BY NOIR/);
    await act(async () => props(words()!).onChange({ target: { value: "Crime noir comic, rain everywhere." } }));
    assert.match(dom.document.body.textContent!, /SEEDED BY NOIR · EDITED/);
    const use = [...dom.document.querySelectorAll("button")].find((b) => b.textContent === "Use style")!;
    await act(async () => props(use).onClick({}));
    assert.deepEqual(styleSent(m.sent)?.settings, { style: { words: "Crime noir comic, rain everywhere.", preset: "noir" } });
  });

  it("World look, or Your own left empty, clears the style (R-21a)", async () => {
    const state = withBook([page()], {});
    (state.world!.productions.at(-1) as { comic: object }).comic = { ...DEFAULT_COMIC_SETTINGS, style: { words: "Japanese manga.", preset: "manga" } };
    const m = await mount(state);
    await act(async () => props(m.container.querySelector("button[aria-label='Style: Manga']")!).onClick({}));
    await act(async () => props(card("Your own")).onClick({}));
    assert.equal(props(words()!).value, "", "Your own starts empty");
    const use = () => [...dom.document.querySelectorAll("button")].find((b) => b.textContent === "Use style")!;
    await act(async () => props(use()).onClick({}));
    assert.deepEqual(styleSent(m.sent)?.settings, { style: null });
  });
});

describe("The page review in Pages (turn 253)", () => {
  const hashOf = (one: ComicPage) => comicPageHash(one, DEFAULT_COMIC_SETTINGS, "baked");
  const read = (findings: Extract<NonNullable<ComicPageTake["verification"]>, { status: "compared" }>["findings"] = []): ComicPageTake["verification"] =>
    ({ status: "compared", reader, normalizationVersion: 1, thresholds: DEFAULT_LETTERING_THRESHOLDS, score: 1, findings, speaker: "not-checked", regions: [], at: AT });
  const reviewed = (findings: Extract<NonNullable<ComicPageTake["review"]>, { status: "compared" }>["findings"], cleared: Array<{ finding: string; reason: string }> = []): ComicPageTake["review"] =>
    ({ status: "compared", reviewer: { id: "harness-vision", version: "1:Claude Opus 5.5" }, references: [], findings, cleared, at: AT });
  const mountTake = async (verification: ComicPageTake["verification"], review: ComicPageTake["review"], acknowledged: ComicPageRecord["acknowledged"] = {}) => {
    const one = page();
    const id = ulid();
    const record: ComicPageRecord = { version: 1, accepted: {}, lettering: {}, acknowledged: Object.keys(acknowledged).length ? { [id]: Object.values(acknowledged)[0]! } : {}, making: [],
      takes: [{ id, artifact: ARTIFACT, hash: hashOf(one), mode: "baked", model: "codex-image", language: "en", at: AT, ...(verification ? { verification } : {}), ...(review ? { review } : {}) }] };
    return { id, m: await mount(withBook([one], { [one.id]: record })) };
  };
  const lines = (container: HTMLElement) => [...container.querySelectorAll(".fy-comic__verdicts .fy-comic__verdict")]
    .map((line) => [...line.children].map((part) => part.textContent?.trim()).filter(Boolean).join(" "));

  it("holds a take whose picture has a fault beside lettering that passes, boxed and listed (253a)", async () => {
    const { id, m } = await mountTake(read(), reviewed([{ id: "review:caption:0", kind: "caption", panel: 1, note: "a pen, but the pier", box: { x: 0, y: 0, w: 1, h: 0.5 } }]));
    assert.match(lines(m.container)[0]!, /^Lettering 1 of 1/);
    assert.match(lines(m.container)[1]!, /^Picture 1 to fix/);
    assert.ok([...m.container.querySelectorAll(".fy-comic__hit span")].some((label) => label.textContent === "Caption"), "boxed on the page");
    assert.match(m.container.querySelector(".fy-comic__finds")!.textContent!, /CaptionPanel 1 · a pen, but the pier/);
    assert.equal(button(m.container, "Accept"), undefined, "Accept waits on the picture too");
    await act(async () => props(button(m.container, "Accept anyway")!).onClick({}));
    const accept = m.sent.find((message): message is Extract<ClientMessage, { kind: "accept-comic-take" }> => message.kind === "accept-comic-take");
    assert.deepEqual([accept?.take, accept?.override?.findings], [id, ["review:caption:0"]], "the override names the picture's fault");
  });

  it("clears writing the panel calls for, struck through with where it is, and offers Accept (253b)", async () => {
    const { m } = await mountTake(read([{ id: "extra:0", kind: "extra", found: "neap" }]), reviewed([], [{ finding: "extra:0", reason: "the ledger, in the scene" }]));
    assert.match(lines(m.container)[0]!, /^Lettering 1 of 1/, "not a fault of the lettering");
    assert.match(lines(m.container)[1]!, /^Picture as written/);
    const row = m.container.querySelector(".fy-comic__find.clear")!;
    assert.equal(row.querySelector("s")?.textContent, "neap");
    assert.match(row.textContent!, /the ledger, in the scene/);
    assert.ok(button(m.container, "Accept"));
  });

  it("offers Accept past a warning, and Seen marks it (253c)", async () => {
    const { id, m } = await mountTake(read(), reviewed([{ id: "review:likeness:0", kind: "likeness", panel: 1, note: "Maren's hair" }]));
    assert.match(lines(m.container)[1]!, /^Picture 1 to look at/);
    assert.ok(button(m.container, "Accept"), "a warning is looked at, not fixed");
    await act(async () => props(button(m.container, "Seen")!).onClick({}));
    const seen = m.sent.find((message): message is Extract<ClientMessage, { kind: "see-comic-warning" }> => message.kind === "see-comic-warning");
    assert.deepEqual([seen?.take, seen?.warning], [id, "likeness"]);
  });

  it("says the picture is not checked and why, with Choose reviewer and Check again (253d)", async () => {
    const { m } = await mountTake(read(), { status: "unavailable", reason: "no-reviewer", at: AT });
    assert.match(lines(m.container)[1]!, /^Picture not checked no reviewer/);
    assert.ok(button(m.container, "Choose reviewer"));
    assert.ok(button(m.container, "Accept anyway"), "never a pass");
    await act(async () => props(button(m.container, "Check again")!).onClick({}));
    assert.ok(m.sent.some((message) => message.kind === "check-comic-take"));
  });

  it("says a take made before there was a review is not checked, and checks it again on a press", async () => {
    const { m } = await mountTake(read(), undefined);
    assert.match(lines(m.container)[1]!, /^Picture not checked/);
    assert.ok(button(m.container, "Check again"));
  });
});
