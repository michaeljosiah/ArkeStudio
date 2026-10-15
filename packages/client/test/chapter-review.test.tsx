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
  let replaced = true;
  mock.method(globalThis, "fetch", async () => new Response(replaced ? "replacement pixels" : "reviewed pixels", { headers: { "content-type": "image/png" } }));
  const container = dom.document.createElement("div"); dom.document.body.append(container); root = createRoot(container as unknown as HTMLElement);
  await act(async () => root!.render(<ChapterReviewReport review={review} slug="world" onDecision={() => {}} />));
  await evidenceSettled(container as unknown as HTMLElement);
  assert.equal(container.querySelector("img"), null);
  assert.match(container.textContent ?? "", /Image changed since review/);
  replaced = false;
  const retry = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Retry image")!;
  await act(async () => { retry.click(); });
  await evidenceSettled(container as unknown as HTMLElement);
  assert.match(container.querySelector("img")?.getAttribute("src") ?? "", /^blob:/);
});

it("shows rejected attribution reasons and preserves consolidated source provenance", async () => {
  const value = structuredClone(review), original = value.findings[0]!;
  value.stale = true;
  value.candidates = [original, { ...original, id: "33333333-3333-4333-a333-333333333333", taskId: "visual-2", observation: "The display is directed away from its reader." },
    { ...original, id: "44444444-4444-4444-a444-444444444444", observation: "Wrong sleeve on doctor" }];
  value.groups = [{ representativeId: original.id, memberIds: value.candidates.slice(0,2).map(c => c.id), rationale: "Same screen orientation and correction" }];
  value.assessments = [{ findingId: value.candidates[1]!.id, taskId: "verify-2", verdict: "supported", subject: "Tablet reader", rationale: "Distinct member explanation retained." }, { findingId: value.candidates[2]!.id, taskId: "verify-1", verdict: "rejected", subject: "Patient", rationale: "The sleeve quote belongs to the patient, not the doctor." }];
  const container = dom.document.createElement("div"); dom.document.body.append(container); root = createRoot(container as unknown as HTMLElement);
  await act(async () => root!.render(<ChapterReviewReport review={value} slug="world" onDecision={() => {}} />));
  assert.match(container.textContent ?? "", /2 consolidated findings/);
  assert.match(container.textContent ?? "", /visual-2/);
  assert.match(container.textContent ?? "", /Distinct member explanation retained/);
  assert.match(container.textContent ?? "", /belongs to the patient, not the doctor/);
  assert.match(container.textContent ?? "", /has not completed for this finding/);
});

it("keeps selection by identity when verification removes an earlier candidate", async () => {
  const value = structuredClone(review); value.stale = true;
  value.findings.push({ ...value.findings[0]!, id: "55555555-5555-4555-a555-555555555555", observation: "Second candidate" });
  const container = dom.document.createElement("div"); dom.document.body.append(container); root = createRoot(container as unknown as HTMLElement);
  const render = (v: ChapterReview) => root!.render(<ChapterReviewReport review={v} slug="world" onDecision={() => {}} />);
  await act(async () => render(value));
  await act(async () => { Array.from(container.querySelectorAll("button")).find(b => b.textContent === "Next")!.click(); });
  await act(async () => render({ ...value, findings: [value.findings[1]!, { ...value.findings[0]!, id: "66666666-6666-4666-a666-666666666666", observation: "Third candidate" }] }));
  assert.match(container.textContent ?? "", /Second candidate/);
  assert.doesNotMatch(container.textContent ?? "", /Third candidate/);
});

it("shows conservative verdict changes and both sides of a conflict", async () => {
  const value = structuredClone(review); value.stale = true;
  const original = value.findings[0]!; original.certainty = "cannot-assess";
  const other = { ...original, id: "77777777-7777-4777-a777-777777777777", taskId: "visual-2" };
  value.candidates = [original, other];
  value.assessments = [{ findingId: original.id, taskId: "verify-1", verdict: "supported", effectiveVerdict: "uncertain", visibility: "occluded", basis: "unobservable", subject: "Hidden support", rationale: "Trousers conceal it." },
    { findingId: other.id, taskId: "verify-2", verdict: "rejected", subject: "Hidden support", rationale: "No visible defect." }];
  value.conflicts = [{ memberIds: [original.id, other.id], rationale: "Conflicting interpretations of the same support." }];
  const container = dom.document.createElement("div"); dom.document.body.append(container); root = createRoot(container as unknown as HTMLElement);
  await act(async () => root!.render(<ChapterReviewReport review={value} slug="world" onDecision={() => {}} />));
  assert.match(container.textContent ?? "", /Original model verdict: supported/);
  assert.match(container.textContent ?? "", /Conflicting interpretations/);
  assert.match(container.textContent ?? "", /Trousers conceal it/);
  assert.match(container.textContent ?? "", /No visible defect/);
  // The retained representative need not itself be one of the original conflict members.
  const representative = { ...original, id: "88888888-8888-4888-a888-888888888888" };
  value.candidates.push(representative);
  value.findings = [representative];
  value.groups = [{ representativeId: representative.id, memberIds: [representative.id, original.id], rationale: "Same concealed support" }];
  await act(async () => root!.render(<ChapterReviewReport review={value} slug="world" onDecision={() => {}} />));
  assert.match(container.textContent ?? "", /Conflicting interpretations — kept uncertain/);
  assert.match(container.textContent ?? "", /No visible defect/);
});
