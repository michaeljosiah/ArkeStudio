import assert from "node:assert/strict";
import { it } from "node:test";
import { ReviewAnswerSchema, verifiedReviewAnswer, ChapterReviewTargetSchema, chapterReviewSummary, sameReviewFinding, sameChapterReviewSource, type ChapterReview } from "../src/chapter-review.js";

it("requires exact prose and supplied images while preserving uncertainty", () => {
  const finding = { category: "image" as const, certainty: "possible-confusion" as const, quote: "She turned the tablet toward him.", imageBlocks: ["p0.0"], observation: "Screen appears turned away.", impact: "The action is unclear.", correction: "Use a shared view behind the reader." };
  const answer = ReviewAnswerSchema.parse({ facts: [{ quote: finding.quote, claim: "Tablet is shared", kind: "explicit" }, { quote: "Invented", claim: "No", kind: "explicit" }], findings: [finding, { ...finding, quote: "Paraphrase" }, { ...finding, imageBlocks: ["p9.0"] }, { ...finding, imageBlocks: [] }, { ...finding, category: "continuity", imageBlocks: [] }, { ...finding, category: "narration" }] });
  const result = verifiedReviewAnswer(finding.quote, answer, ["p0.0"]);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]!.certainty, "possible-confusion");
  assert.equal(result.facts.length, 1);
  assert.equal(result.rejected, 6);
});
it("refuses oversized answers and unsafe target paths", () => {
  assert.equal(ReviewAnswerSchema.safeParse({ facts: [], findings: [], extra: "ignored?" }).success, false);
  assert.equal(ChapterReviewTargetSchema.safeParse({ worldId: "world", productionId: "../other", chapterId: "chapter" }).success, false);
});

it("bounds long findings to the chat receipt limit while retaining coverage disclosure", () => {
  const findings = Array.from({ length: 5 }, () => ({ observation: "x".repeat(1600) })) as ChapterReview["findings"];
  const summary = chapterReviewSummary({ status: "complete", stale: false, findings });
  assert.ok(summary.length <= 2000); assert.match(summary, /5 findings/); assert.match(summary, /Audio not listened to/);
});

it("only identical findings share a human decision or deduplication identity", () => {
  const finding = { category: "clarity" as const, certainty: "possible-confusion" as const, quote: "She left.", imageBlocks: ["p0.0"], observation: "Movement unclear", impact: "Reader loses position", correction: "Name the exit" };
  assert.equal(sameReviewFinding(finding, structuredClone(finding)), true);
  for (const changed of [{ category: "continuity" as const }, { certainty: "contradiction" as const }, { quote: "He left." },
    { imageBlocks: ["p1.0"] }, { observation: "Movement impossible" }, { impact: "Contradicts the next scene" }, { correction: "Change the next scene" }]) {
    assert.equal(sameReviewFinding(finding, { ...finding, ...changed }), false);
  }
});

it("binds carried decisions to the captured prose, context and image versions", () => {
  const previous = { sourceHash: "source-B", contextHash: "directions-1", images: [{ block: "p0.0", file: "view.png", hash: "pixels-1", textHash: "text-1" }] };
  const captured = { ...structuredClone(previous), sourceHash: "source-A" };
  assert.equal(sameChapterReviewSource(previous, captured), false, "restoring live B cannot make captured A match a decided B");
  assert.equal(sameChapterReviewSource(previous, structuredClone(previous)), true);
  assert.equal(sameChapterReviewSource(previous, { ...previous, contextHash: "directions-2" }), false);
  for (const image of [{ ...previous.images[0]!, hash: "pixels-2" }, { ...previous.images[0]!, textHash: "text-2" }]) {
    assert.equal(sameChapterReviewSource(previous, { ...previous, images: [image] }), false);
  }
});
