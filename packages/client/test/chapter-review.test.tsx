import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { it, afterEach, mock } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { ChapterReview } from "@arke-studio/contracts";
import { ChapterReviewReport } from "../src/components/chapter-review.js";
const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); dom.document.body.innerHTML = ""; mock.restoreAll(); });
const review: ChapterReview = { worldId: "world", productionId: "book", chapterId: "one", schemaVersion: 1, id: "11111111-1111-4111-a111-111111111111", requestId: "request", title: "One", createdAt: "now", updatedAt: "now", status: "complete", sourceHash: "hash", contextHash: "context", body: "He read the tablet.", images: [{ block: "p0.0", file: "tablet.png", hash: "sha256:" + createHash("sha256").update("reviewed pixels").digest("hex") }], tasks: [{ id: "visual", specialist: "visual", state: "complete", images: ["p0.0"], skill: "chapter-visual-review@v1" }], facts: [], findings: [{ id: "22222222-2222-4222-a222-222222222222", taskId: "visual", offset: 0, category: "image", certainty: "possible-confusion", quote: "He read the tablet.", imageBlocks: ["p0.0"], observation: "The screen faces away.", impact: "Reading looks impossible.", correction: "Turn the screen toward its reader.", decision: "open" }], checks: [], rejectedFindings: 1, stale: false, staleReasons: [], audioListened: false };
it("shows the source beside visual evidence and records a deliberate exception", async () => {
  const container = dom.document.createElement("div"); dom.document.body.append(container); root = createRoot(container as unknown as HTMLElement);
  mock.method(globalThis, "fetch", async () => new Response("reviewed pixels", { headers: { "content-type": "image/png" } }));
  const decisions: unknown[][] = [];
  await act(async () => root!.render(<ChapterReviewReport review={review} slug="world" onDecision={(...args) => decisions.push(args)} />));
  assert.match(container.textContent ?? "", /Audio delivery not listened to/);
  assert.equal(container.querySelector("blockquote")?.textContent, review.body);
  await evidenceSettled(container as unknown as HTMLElement);
  assert.match(container.querySelector("img")?.getAttribute("src") ?? "", /^blob:/);
  const button = Array.from(container.querySelectorAll("button")).find(b => b.textContent === "Keep intentionally")!;
  await act(async () => { button.click(); });
  assert.deepEqual(decisions, [[review.findings[0]!.id, "intentional", undefined]]);
});
it("hides mutable image evidence and disables decisions for stale results", async () => {
  const container = dom.document.createElement("div"); dom.document.body.append(container); root = createRoot(container as unknown as HTMLElement);
  await act(async () => root!.render(<ChapterReviewReport review={{ ...review, stale: true, staleReasons: ["Image changed"] }} slug="world" onDecision={() => assert.fail("stale decision")} />));
  assert.equal(container.querySelector("img"), null);
  assert.match(container.textContent ?? "", /Image changed/);
  const decision = Array.from(container.querySelectorAll("button")).find(b => b.textContent === "Dismiss finding")!;
  assert.equal(decision.hasAttribute("disabled"), true);
});

async function evidenceSettled(container: HTMLElement) {
  const deadline = Date.now() + 5000;
  while (container.textContent?.includes("Checking image evidence") && Date.now() < deadline) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
  assert.doesNotMatch(container.textContent ?? "", /Checking image evidence/);
}
it("refuses changed pixels even while the report is still marked current", async () => {
  mock.method(globalThis, "fetch", async () => new Response("replacement pixels", { headers: { "content-type": "image/png" } }));
  const container = dom.document.createElement("div"); dom.document.body.append(container); root = createRoot(container as unknown as HTMLElement);
  await act(async () => root!.render(<ChapterReviewReport review={review} slug="world" onDecision={() => {}} />));
  await evidenceSettled(container as unknown as HTMLElement);
  assert.equal(container.querySelector("img"), null);
  assert.match(container.textContent ?? "", /Image changed since review/);
});
