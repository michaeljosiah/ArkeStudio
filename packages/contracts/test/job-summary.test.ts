import assert from "node:assert/strict";
import { it } from "node:test";
import { JobSchema, jobSummary, JobSummarySchema, jobOrigin, voiceJobPart } from "../src/index.js";

const job = JobSchema.parse({ id: "jb_01J8F3K2QW9VZX4N7M0RTYB6HC", idempotencyKey: "01J8F3K2QW9VZX4N7M0RTYB6HC",
  worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC", productionId: "book", target: { kind: "voice-preview" },
  provider: "elevenlabs", model: "voice", capability: "voice-tts", estimatedMicroUsd: 300, status: "needs-reconciliation",
  createdAt: "2026-10-16T10:00:00Z", updatedAt: "2026-10-16T10:00:00Z",
  params: { prompt: "p".repeat(100_000), text: "t".repeat(100_000), turns: [{ text: "t".repeat(100_000) }],
    instructions: "direction", purpose: "audiobook", chapterId: "chapter-1", audiobookRunId: "run", part: 1, parts: 2,
    requestId: "request", blocks: ["a", "b"], generationQuoteProduction: true, audioFormat: "mp3" } });

it("omits heavy payloads without changing durable jobs, recovery, routing, groups or costs", () => {
  const summary = JobSummarySchema.parse(jobSummary(job));
  assert.ok(JSON.stringify(summary).length < 2000);
  assert.equal(job.params.text, "t".repeat(100_000));
  assert.deepEqual(summary.omittedParams, ["prompt", "text", "turns", "instructions"]);
  assert.equal(summary.status, "needs-reconciliation"); assert.equal(summary.estimatedMicroUsd, 300);
  assert.deepEqual(summary.params.blocks, ["a", "b"]);
  assert.deepEqual(jobOrigin(summary), jobOrigin(job)); assert.deepEqual(voiceJobPart(summary), { part: 1, parts: 2 });
  assert.equal(JobSchema.safeParse(summary).success, false, "wire summaries cannot be written as durable jobs");
});

it("retains the transcript shown in the voice design candidate chooser", () => {
  assert.equal(jobSummary({ ...job, target: { kind: "voice-design" } }).params.text, job.params.text);
});
