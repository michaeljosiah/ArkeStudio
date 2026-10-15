import assert from "node:assert/strict";
import { it } from "node:test";
import { ReviewAnswerSchema, verifiedReviewAnswer, ChapterReviewTargetSchema, chapterReviewSummary, type ChapterReview } from "../src/chapter-review.js";

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
