import assert from "node:assert/strict";
import { it } from "node:test";
import { ClientMessageSchema, HistoricalReviewDecisionSchema, REVIEW_NOTE_MAX, ReviewDecisionSchema } from "../src/index.js";

const review = { ts: "2026-09-28T12:00:00Z", takeId: "tk_01J8F3K2QW9VZX4N7M0RTYB6HC", shotId: "sh_12", decision: "reject", by: "user", citation: { sheet: "maren-kest", field: "appearance", note: "a".repeat(REVIEW_NOTE_MAX) } };
it("bounds both the rejection frame and a new persisted decision at the same limit", () => {
  const frame = { kind: "reject-take", worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC", productionId: "saltlight", takeId: review.takeId, citation: review.citation };
  assert.ok(ClientMessageSchema.safeParse(frame).success); assert.ok(ReviewDecisionSchema.safeParse(review).success);
  const citation = { ...review.citation, note: review.citation.note + "a" };
  assert.equal(ClientMessageSchema.safeParse({ ...frame, citation }).success, false);
  assert.equal(ReviewDecisionSchema.safeParse({ ...review, citation }).success, false);
});
it("keeps pre-bound journal notes readable without truncating them", () => {
  const historical = { ...review, citation: { ...review.citation, note: "old".repeat(REVIEW_NOTE_MAX) } };
  assert.equal(HistoricalReviewDecisionSchema.parse(historical).citation?.note, historical.citation.note);
});
