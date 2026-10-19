import assert from "node:assert/strict";
import { it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { parseHTML } from "linkedom";
import { DEFAULT_STORY_PDF_SETTINGS, type StoryEdition } from "@arke-studio/contracts";
import { StoryEditionFiles } from "../src/components/story-publish.js";
import { StoryPdfPreview } from "../src/components/story-pdf-preview.js";
import { parkedDrafts, parkedKey, waitForChapterSaves } from "../src/lib/chapter-drafts.js";
import { __applyEventForTest, __setStateForTest, subscribeChapterSaveResults } from "../src/lib/store.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
const edition: StoryEdition = { id: "00000000-0000-4000-8000-000000000001", worldId: FIXTURE_WORLD_ID, productionId: "test-book", createdAt: "2026-10-19T12:00:00Z", fingerprint: "a".repeat(64), status: "preview", phase: "Ready to preview",
  settings: { title: "A synthetic book", author: "", language: "en", description: "", label: "Draft two", cover: null, chapterIds: ["one", "two"], outputs: ["pdf"], pdf: DEFAULT_STORY_PDF_SETTINGS, avoidEmDashes: false },
  files: [{ format: "pdf", name: "story.pdf", bytes: 5000, sha256: "b".repeat(64), pdf: { pageCount: 4, pageLabels: ["Title", "Contents", "1", "2"], chapters: [{ id: "one", title: "The same title", physicalPage: 3, pageNumber: 1, destination: "one" }, { id: "two", title: "The same title", physicalPage: 4, pageNumber: 2, destination: "two" }] } }] };

it("PDF stays preview-only until ready and never offers audiobook or Kindle handoff", () => {
  const preview = renderToString(<StoryEditionFiles edition={edition} />);
  assert.match(preview, /Book · PDF/); assert.match(preview, /4 pages/); assert.doesNotMatch(preview, /Save PDF|Listen on your phone|Read on Kindle|audio/);
  const ready = renderToString(<StoryEditionFiles edition={{ ...edition, status: "ready" }} />);
  assert.match(ready.replaceAll("<!-- -->", ""), /Save PDF/); assert.match(ready, /story-edition-media/); assert.doesNotMatch(ready, /Listen on your phone|Read on Kindle/);
});

it("renders authenticated captured pages with bounded navigation, selectable text and cancellation", async t => {
  const urls: string[] = [], renders: Array<[number, number]> = []; let destroyed = 0, lastSignal: AbortSignal | undefined;
  const load = async (url: string, signal: AbortSignal) => {
    urls.push(url); lastSignal = signal;
    return { pageCount: 4, async render(page: number, _width: number, zoom: number, _canvas: HTMLCanvasElement, text: HTMLDivElement) { renders.push([page, zoom]); const span = document.createElement("span"); span.textContent = `Ọlá's page ${page}`; text.replaceChildren(span); }, async destroy() { destroyed++; } };
  };
  const node = document.createElement("div"); document.body.append(node); const root = createRoot(node);
  t.after(() => node.remove());
  await act(async () => root.render(<StoryPdfPreview edition={edition} load={load} />));
  assert.match(urls[0]!, /story-preview-media\/00000000-0000-4000-8000-000000000001\/story.pdf/);
  assert.equal(node.querySelector("iframe, object, embed, a"), null, "no native viewer or delivery shortcut");
  assert.equal(node.querySelector(".fy-pdf-text")!.textContent, "Ọlá's page 1");
  const button = (label: string) => [...node.querySelectorAll("button")].find(row => row.textContent === label)!;
  assert.equal(button("Previous page").disabled, true);
  await act(async () => button("Next page").click());
  assert.deepEqual(renders.at(-1), [2, 1]);
  const select = node.querySelectorAll("select");
  Object.defineProperty(select[1], "value", { configurable: true, value: "4" });
  await act(async () => select[1]!.dispatchEvent(new dom.Event("change", { bubbles: true })));
  assert.deepEqual(renders.at(-1), [4, 1]); assert.equal(button("Next page").disabled, true);
  Object.defineProperty(select[0], "value", { configurable: true, value: "1.5" });
  await act(async () => select[0]!.dispatchEvent(new dom.Event("change", { bubbles: true })));
  assert.deepEqual(renders.at(-1), [4, 1.5]);
  const page = node.querySelector("input")!;
  page.value = "99"; await act(async () => page.dispatchEvent(new dom.Event("input", { bubbles: true })));
  assert.equal(renders.at(-1)![0], 4);
  await act(async () => root.unmount());
  assert.equal(lastSignal!.aborted, true); assert.equal(destroyed, 1);
});

it("refuses a PDF whose parsed page count differs from its captured descriptor", async t => {
  let rendered = false;
  const node = document.createElement("div"); document.body.append(node); const root = createRoot(node);
  t.after(async () => { await act(async () => root.unmount()); node.remove(); });
  await act(async () => root.render(<StoryPdfPreview edition={edition} load={async () => ({ pageCount: 1, async render() { rendered = true; }, async destroy() {} })} />));
  assert.match(node.querySelector('[role="alert"]')!.textContent!, /could not be opened/); assert.equal(rendered, false);
});

it("waits for an editor's chained save and blocks refused or disconnected drafts", async t => {
  __setStateForTest(FIXTURE_STATE, { connection: "open" });
  const chapter = { file: "01-one", title: "One" }, key = parkedKey(FIXTURE_WORLD_ID, "test-book", chapter.file);
  const first = "01J8G0000000000000000000A1", second = "01J8G0000000000000000000A2";
  t.after(() => parkedDrafts.clear());
  parkedDrafts.set(key, { value: "new", baseHash: "old", landedBody: "old", cancel() {} });
  const off = subscribeChapterSaveResults(result => {
    if (result.requestId === first) parkedDrafts.set(key, { value: "newer", baseHash: "new", landedBody: "new", cancel() {} });
    else parkedDrafts.delete(key);
  });
  t.after(off);
  let finished = false;
  const waiting = waitForChapterSaves(FIXTURE_WORLD_ID, "test-book", [chapter], new AbortController().signal).then(() => { finished = true; });
  const saved = (requestId: string) => __applyEventForTest({ type: "chapter.save-result", at: edition.createdAt, worldId: FIXTURE_WORLD_ID, productionId: "test-book", chapterFile: chapter.file, requestId, disposition: "saved", hash: "new" });
  saved(first); await Promise.resolve(); assert.equal(finished, false);
  saved(second); await waiting; assert.equal(finished, true);
  parkedDrafts.set(key, { value: "unsaved", baseHash: "old", landedBody: null, conflict: true });
  await assert.rejects(waitForChapterSaves(FIXTURE_WORLD_ID, "test-book", [chapter], new AbortController().signal), /Open “One”/);
  parkedDrafts.set(key, { value: "offline", baseHash: "old", landedBody: null });
  await assert.rejects(waitForChapterSaves(FIXTURE_WORLD_ID, "test-book", [chapter], new AbortController().signal), /unsaved draft/);
});
