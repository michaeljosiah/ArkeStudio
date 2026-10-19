import assert from "node:assert/strict";
import { it, afterEach } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { readTells, type ChapterReview, type ReviewTask, type TellDraft } from "@arke-studio/contracts";
import { ChapterTellsReport } from "../src/components/chapter-tells.js";
const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); dom.document.body.innerHTML = ""; });

// Twenty paragraphs of fifty numbered words: every word names exactly one place.
const body = Array.from({ length: 20 }, (_, p) => Array.from({ length: 50 }, (_, w) => `w${p * 50 + w}`).join(" ")).join("\n\n");
const prose: ReviewTask = { id: "prose", specialist: "prose", state: "complete", images: [], skill: "chapter-prose-review@v1" };
const review = (tasks: ReviewTask[], drafts?: TellDraft[]): ChapterReview => ({ worldId: "world", productionId: "book", chapterId: "one", schemaVersion: 1, id: "11111111-1111-4111-a111-111111111111",
  requestId: "request", title: "One", createdAt: "now", updatedAt: "now", status: "complete", sourceHash: "hash", contextHash: "context", body, images: [], tasks, facts: [], findings: [],
  checks: [], rejectedFindings: 0, stale: false, staleReasons: [], audioListened: false, ...(drafts ? { tells: readTells(body, drafts) } : {}) });
async function render(value: ChapterReview) {
  const container = dom.document.createElement("div"); dom.document.body.append(container); root = createRoot(container as unknown as HTMLElement);
  await act(async () => root!.render(<ChapterTellsReport review={value} />));
  return container;
}

it("shows the chapter's tells, the strip against the line and each crowded passage", async () => {
  const kinds = ["metaphor", "metaphor", "metaphor", "metaphor", "metaphor", "pivot", "pivot", "pivot", "notxy", "three"] as const;
  const crowded: TellDraft[] = kinds.map((kind, i) => ({ kind, quote: `w${300 + i * 10}` }));
  const container = await render(review([prose], [...crowded, { kind: "list", quote: "w900" }, { kind: "pivot", quote: "not in the chapter" }]));
  const text = container.textContent ?? "";
  assert.match(text, /11 tells/); assert.match(text, /1,000 words/); assert.match(text, /11 per 1,000 words/);
  assert.match(container.querySelector('[role="img"]')?.getAttribute("aria-label") ?? "", /start to end: 10, 0, 1\. The line is 8\./);
  assert.equal(container.querySelectorAll(".fy-tells__bar--crowded").length, 1);
  assert.match(text, /10 in 450 words · Metaphor 5 · Pivot sentence 3 · Rule of three 1 · Not X but Y 1/);
  assert.match(container.querySelector(".fy-tells__passage q")?.textContent ?? "", /^w300 w301/);
  assert.match(text, /Not an AI detector/); assert.match(text, /The line is provisional/);
  assert.match(text, /1 tagged quotation was not in the chapter and not counted/);
});

it("says none crowded when the tells are spread out", async () => {
  const container = await render(review([prose], [{ kind: "metaphor", quote: "w10" }, { kind: "pivot", quote: "w600" }]));
  assert.match(container.textContent ?? "", /None crowded\. 2 in 1,000 words, spread out\./);
  assert.equal(container.querySelectorAll(".fy-tells__bar--crowded").length, 0);
});

it("says when the check did not run, and stays silent for reviews from before it existed", async () => {
  const failed = await render(review([{ ...prose, state: "failed", detail: "The prose reviewer returned no tells list." }]));
  assert.match(failed.textContent ?? "", /Not checked\. The prose reviewer returned no tells list\./);
  await act(async () => root!.unmount()); root = undefined;
  const legacy = await render(review([{ id: "script", specialist: "script", state: "complete", images: [], skill: "chapter-script-review@v3" }]));
  assert.equal(legacy.textContent, "");
});
