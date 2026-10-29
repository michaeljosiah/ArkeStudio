import assert from "node:assert/strict";
import { it } from "node:test";
import { DomainEventSchema, JobSchema, JobSummarySchema, SetupStatusSchema, jobSummary, storageWaitingWork, type JobSummary } from "../src/index.js";

const at = "2026-10-28T22:00:00Z", now = Date.parse(at);
const base = JobSchema.parse({ id: "jb_01J8F3K2QW9VZX4N7M0RTYB6HC", idempotencyKey: "01J8F3K2QW9VZX4N7M0RTYB6HC",
  worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC", target: { kind: "shot" }, provider: "fixture", model: "fixture", capability: "image",
  estimatedMicroUsd: 0, status: "queued", params: { prompt: "PRIVATE_CONTENT" }, createdAt: at, updatedAt: at });
const held: JobSummary = { ...base, storageWait: { phase: "submission", reason: "space", observedAt: at } };

it("carries current waits through compact events/snapshots while rejecting them from durable jobs", () => {
  const compact = jobSummary(held);
  assert.deepEqual(compact.storageWait, held.storageWait);
  assert.equal(JobSummarySchema.safeParse(compact).success, true);
  assert.equal(DomainEventSchema.safeParse({ type: "job.updated", at, job: compact }).success, true);
  assert.equal(JobSchema.safeParse(held).success, false);
  assert(!JSON.stringify(compact).includes("PRIVATE_CONTENT"));
  assert.equal(JobSummarySchema.safeParse({ ...held, storageWait: { ...held.storageWait, path: "PRIVATE_PATH" } }).success, false);
});

it("counts owner-reported current phases, never prose, historical terminal jobs or future observations", () => {
  const result: JobSummary = { ...held, id: "jb_01J8F3K2QW9VZX4N7M0RTYB6HD", status: "running", storageWait: { phase: "result", reason: "unavailable", observedAt: at } };
  assert.deepEqual(storageWaitingWork([held, held, result, { ...base, error: "Not submitted: waiting for storage" }], null, now),
    { unsubmitted: 1, completed: 1, downloads: 0, unverified: 1, total: 2 });
  for (const status of ["succeeded", "failed", "cancelled", "needs-reconciliation"] as const) {
    assert.equal(storageWaitingWork([{ ...result, status }], null, now).total, 0);
  }
  assert.equal(storageWaitingWork([{ ...held, status: "running" }, { ...result, status: "queued" }, { ...held, deletedAt: at }], null, now).total, 0);
  assert.equal(storageWaitingWork([held], null, now - 1).total, 0);
  assert.equal(storageWaitingWork([held], null, now + 3600_000).total, 1, "An unchanged live hold is not cleared by a presentation timer");
});

it("counts only selected downloads currently blocked by disk, with no optional-offer or dependency false alarms", () => {
  const component = { id: "selected", displayName: "Selected model", purpose: "Fixture", sizeMb: 1, installLocation: null, state: "blocked", blockedBy: "disk" };
  const setup = SetupStatusSchema.parse({ components: [component, component,
    { ...component, id: "optional", state: "available" }, { ...component, id: "paused", state: "paused" },
    { ...component, id: "dependency", blockedBy: "dependency" }, { ...component, id: "ready", state: "ready" }], diskFreeMb: 0, running: false });
  assert.deepEqual(storageWaitingWork([], setup, now), { unsubmitted: 0, completed: 0, downloads: 1, unverified: 0, total: 1 });
});
