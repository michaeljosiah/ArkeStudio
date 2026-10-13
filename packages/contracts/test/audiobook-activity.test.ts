import assert from "node:assert/strict";
import { it } from "node:test";
import { audiobookActivityCost, audiobookActivityLive, audiobookActivityPath, audiobookActivityTitle, audiobookJobRun, audiobookRequestCost, AudiobookActivitySchema, type Job } from "../src/index.js";

const at = "2026-10-10T12:00:00.000Z";
const run = AudiobookActivitySchema.parse({
  id: "01J8F3K2QW9VZX4N7M0RTYB6HD", worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC", productionId: "bell-watch", chapterId: "crossing", chapterFile: "01-crossing",
  chapterTitle: "The crossing", productionTitle: "Bell Watch", worldName: "The Undersong", scope: "chapter", phase: "aligning", startedAt: at, updatedAt: at,
  toMake: 20, made: 6, flagged: 0, requests: 4, request: 2, estimatedMicroUsd: 400000, models: ["A reader"], local: false, jobs: [],
});
const job = (id: string, extra: Partial<Job> = {}): Job => ({
  id, idempotencyKey: run.id, worldId: run.worldId, productionId: run.productionId, target: { kind: "voice-preview", id: "narrator" }, capability: "voice-tts", provider: "google", model: "reader", params: {},
  estimatedMicroUsd: 100000, status: "succeeded", providerJobId: "provider-request", attempt: 1, error: null, createdAt: at, updatedAt: at, ...extra,
});

it("names the chapter operation and keeps alignment live, with the accepted read estimate", () => {
  assert.equal(audiobookActivityTitle(run), "The crossing · Aligning narration");
  assert.ok(audiobookActivityLive(run));
  assert.equal(audiobookActivityCost(run, []), "~$0.40 for this read");
  assert.equal(audiobookActivityPath(run), `/w/${run.worldId}/p/bell-watch/story/chapters/crossing?view=audiobook`);
  assert.equal(audiobookActivityTitle({ ...run, phase: "reading", scope: "block" }), "The crossing · Re-reading block");
});

it("excludes reused requests from this read's bill and distinguishes missing provider evidence", () => {
  const done = { ...run, phase: "interrupted" as const, jobs: [{ id: "old", index: 1, reused: true }, { id: "paid", index: 2, reused: false }, { id: "uncertain", index: 3, reused: false }] };
  const jobs = [job("old", { providerCostMicroUsd: 900000 }), job("paid", { providerCostMicroUsd: 123000 }), job("uncertain", { status: "needs-reconciliation" })];
  assert.equal(audiobookActivityCost(done, jobs), "$0.12 reported · 1 request charge unknown for this read");
  assert.equal(audiobookRequestCost(jobs[2]!).label, "charge unknown");
  assert.equal(audiobookRequestCost(job("rejected", { status: "failed", providerJobId: null, submissionRejected: true })).label, "not charged");
  assert.match(audiobookActivityCost({ ...done, jobs: [{ id: "missing", index: 1, reused: false }] }, []), /^1 request charge unknown/);
  assert.equal(audiobookActivityCost({ ...done, jobs: [{ id: "old", index: 1, reused: true }] }, jobs), "$0.00 this read");
});

it("preserves block destinations and stops quoting an accepted total after Stop", () => {
  assert.match(audiobookActivityPath({ ...run, scope: "block", block: "p1.0" }), /view=audiobook&block=p1.0$/);
  const stopping = { ...run, phase: "stopping" as const, jobs: [{ id: "paid", index: 1, reused: false }, { id: "pending", index: 2, reused: false }] };
  assert.equal(audiobookActivityCost(stopping, [job("paid", { providerCostMicroUsd: 50000 }), job("pending", { status: "running" })]), "$0.05 reported · 1 request charge unknown for this read");
});

it("does not invent grouping for legacy jobs or borrow another world's run", () => {
  const held = { ...run, jobs: [{ id: "paid", index: 1, reused: false }, { id: "old", index: 2, reused: true }] };
  assert.equal(audiobookJobRun(job("paid"), [held]), held);
  assert.equal(audiobookJobRun(job("paid", { worldId: "01J8F3K2QW9VZX4N7M0RTYB6HE" }), [held]), undefined);
  assert.equal(audiobookJobRun(job("legacy", { params: { chapterId: "crossing" } }), [held]), undefined);
  assert.equal(audiobookJobRun(job("old"), [held]), undefined);
  const durable = job("durable", { params: { audiobookRunId: run.id, audiobookRequest: 2 }, providerCostMicroUsd: 230000 });
  assert.equal(audiobookJobRun(durable, [run]), run, "exact durable association survives the gap after enqueue");
  assert.equal(audiobookActivityCost({ ...run, phase: "interrupted", jobs: [] }, [durable]), "$0.23 this read");
});
