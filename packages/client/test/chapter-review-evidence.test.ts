import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { it } from "node:test";
import type { ChapterReview } from "@arke-studio/contracts";
import { acceptChapterReviewUpdate, readChapterReviewImage } from "../src/lib/chapter-review.js";
const hash = (text: string) => "sha256:" + createHash("sha256").update(text).digest("hex");
it("returns verified immutable bytes and rejects replaced source pixels", async () => {
  const signal = new AbortController().signal;
  const blob = await readChapterReviewImage("/media", hash("original"), signal, async () => new Response("original", { headers: { "content-type": "image/png" } }));
  assert.equal(await blob.text(), "original"); assert.equal(blob.type, "image/png");
  await assert.rejects(readChapterReviewImage("/media", hash("original"), signal, async () => new Response("changed")), /Image changed/);
  assert.equal(await blob.text(), "original", "the displayed blob cannot follow later file replacement");
});
it("bounds declared and streamed evidence and observes cancellation", async () => {
  const signal = new AbortController().signal, limit = 50 * 1024 * 1024 - 1;
  await assert.rejects(readChapterReviewImage("/media", hash("x"), signal, async () => new Response("x", { headers: { "content-length": String(limit + 1) } })), /size limit/);
  await assert.rejects(readChapterReviewImage("/media", hash("x"), signal, async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(limit)); controller.enqueue(new Uint8Array(1)); controller.close();
  } }))), /size limit/);
  const stop = new AbortController(); stop.abort();
  await assert.rejects(readChapterReviewImage("/media", hash("x"), stop.signal, async () => new Response("x")), /abort/i);
});
it("accepts a distinct current run with an earlier clock but ignores an older update of the same run", () => {
  const previous = { id: "old", createdAt: "2030", updatedAt: "2030" } as ChapterReview;
  const next = { ...previous, id: "new", createdAt: "2026", updatedAt: "2026" };
  assert.equal(acceptChapterReviewUpdate(previous, next), next);
  assert.equal(acceptChapterReviewUpdate(previous, { ...previous, updatedAt: "2029" }), previous);
});
