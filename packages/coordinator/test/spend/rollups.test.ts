import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BenchTakeSchema, JobSchema, TakeSchema, ProductionSpendProjectionSchema, newId,
  type Job, type LedgerEntry, type WorldBundle, type ActualCostSource } from "@arke-studio/contracts";
import { productionSpend, allocateProductionSpend, type SpendEvidence } from "../../src/spend/rollups.js";

const AT = "2026-11-01T00:00:00.000Z";
const WORLD = "01J8F3K2QW9VZX4N7M0RTYB6HC";
const provenance = { canonRevision: 1, sheets: {}, artDirectionVersion: 1, sceneId: "sc_a" };
function fixture() {
  const world = { meta: { worldId: WORLD }, productions: [{ meta: { id: "saltlight", medium: "video", kind: "film", format: "video" },
    scenes: [{ id: "sc_a", shots: [1, 2].map(number => ({ id: `sh_${number}`, number, title: `Shot ${number}` })) }],
    takes: [], selections: {} }] } as unknown as WorldBundle;
  const evidence: SpendEvidence = { jobs: [], ledger: [], bench: [], ledgerUnavailable: false, historyUnavailable: false, benchIncomplete: false };
  const job = (changes: Partial<Job> = {}) => JobSchema.parse({ id: newId("jb"), idempotencyKey: WORLD, worldId: WORLD,
    productionId: "saltlight", target: { kind: "shot", id: "sh_1" }, capability: "video", provider: "fal", model: "video",
    params: { provenance }, estimatedMicroUsd: 101, status: "succeeded", createdAt: AT, updatedAt: AT, ...changes });
  const entry = (job: Job, amount = 101, source: ActualCostSource | undefined = "provider-reported"): LedgerEntry => ({
    ts: AT, worldId: WORLD, productionId: "saltlight", jobId: job.id, provider: job.provider, model: job.model,
    outcome: ["succeeded", "failed", "cancelled"].includes(job.status) ? job.status as "succeeded" : "succeeded",
    estimatedMicroUsd: amount, actualMicroUsd: amount, ...(source ? { actualSource: source } : {}),
  });
  const take = (job: Job, shotId = "sh_1", changes: Record<string, unknown> = {}) => TakeSchema.parse({
    id: newId("tk"), jobId: job.id, coversShots: [shotId], kind: "clip", provider: job.provider, model: job.model, provenance,
    cost: { estimatedMicroUsd: 999, actualMicroUsd: 999 }, dispatchedAt: AT, media: "clip.mp4", ...changes,
  });
  const result = () => { const projection = productionSpend(world, evidence); ProductionSpendProjectionSchema.parse(projection); return projection.productions.saltlight!; };
  return { world, evidence, job, entry, take, result, production: world.productions[0]! };
}

describe("lifetime production spend, turn 255", () => {
  it("counts a ledger charge once and current selection independently of take cost/reviews", () => {
    const f = fixture(), job = f.job(), first = f.take(job), other = f.take(job);
    f.evidence.jobs = [job]; f.evidence.ledger = [f.entry(job)]; f.production.takes = [first, other];
    f.production.selections.sh_1 = { acceptedTakeId: other.id, trimInSec: 0 };
    assert.equal(f.result().total.spentMicroUsd, 101);
    assert.equal(f.result().total.generated, 1, "one result per job/shot, even if filing has duplicate aliases");
    assert.equal(f.result().total.selected, 1);
    f.production.selections = {};
    assert.equal(f.result().total.generated, 1); assert.equal(f.result().total.selected, 0);
  });
  it("allocates successful or failed passes with an exact final remainder", () => {
    const f = fixture(), job = f.job({ status: "failed", target: { kind: "scene-pass", id: "sc_a" },
      params: { shotPlan: [{ shotId: "sh_1", startSec: 0, endSec: 4 }, { shotId: "sh_2", startSec: 4, endSec: 10 }] } });
    f.evidence.jobs = [job]; f.evidence.ledger = [f.entry(job, 101)];
    const value = f.result(); assert.equal(value.total.spentMicroUsd, 101); assert.equal(value.total.generated, 0);
    assert.equal(value.shots.sh_1!.spentMicroUsd, 40); assert.equal(value.shots.sh_2!.spentMicroUsd, 61);
    assert.equal(value.scenes.sc_a!.spentMicroUsd, 101);
  });
  it("counts independent pass segments but excludes their container and shot stills", () => {
    const f = fixture(), job = f.job({ target: { kind: "scene-pass", id: "sc_a" }, params: { shotPlan: [
      { shotId: "sh_1", startSec: 0, endSec: 4 }, { shotId: "sh_2", startSec: 4, endSec: 10 }] } });
    const parent = f.take(job, "sh_1", { coversShots: ["sh_1", "sh_2"] });
    f.production.takes = [parent, f.take(job, "sh_1", { segment: { passTakeId: parent.id, inSec: 0, outSec: 4 } }),
      f.take(job, "sh_2", { segment: { passTakeId: parent.id, inSec: 4, outSec: 10 } })];
    const still = f.job({ capability: "image", params: { provenance, landing: "frame-slot" } });
    f.production.takes.push(f.take(still, "sh_1", { kind: "frame" }));
    f.evidence.jobs = [job, still]; f.evidence.ledger = [f.entry(job, 100), f.entry(still, 20)];
    assert.equal(f.result().total.spentMicroUsd, 120); assert.equal(f.result().total.generated, 2);
  });
  it("excludes a legacy single-shot pass container when only segment evidence survives", () => {
    const f = fixture(), job = f.job();
    const parent = f.take(job), segment = f.take(job, "sh_1", { segment: { passTakeId: parent.id, inSec: 0, outSec: 5 } });
    delete parent.jobId; delete segment.jobId;
    f.production.takes = [parent, segment];
    assert.equal(f.result().total.generated, 1);
    assert.equal(f.result().total.countsPartial, true);
  });
  it("keeps tombstoned Activity jobs and rejects unknown/invalid shot allocations", () => {
    const f = fixture(), job = f.job({ deletedAt: AT, status: "cancelled", target: { kind: "scene-pass", id: "sc_a" },
      params: { shotPlan: [{ shotId: "sh_missing", startSec: 0, endSec: 5 }] } });
    f.evidence.jobs = [job]; f.evidence.ledger = [f.entry(job, 99)];
    assert.equal(f.result().total.spentMicroUsd, 99); assert.equal(f.result().total.unallocatedMicroUsd, 99);
    assert.equal(f.result().total.coverage, "partial");
    assert.equal(f.result().shots.sh_1!.spentMicroUsd, 0);
    assert.equal(allocateProductionSpend(10, [{ shotId: "x", durationSec: NaN }]), null);
    assert.equal(allocateProductionSpend(10, [{ shotId: "x", durationSec: 1 }, { shotId: "x", durationSec: 2 }]), null);
  });
  it("distinguishes empty, missing accounting, failed reads and known partial spend", () => {
    const f = fixture(); assert.equal(f.result().total.coverage, "empty");
    const job = f.job(); f.production.takes = [f.take(job)];
    assert.equal(f.result().total.coverage, "unavailable"); assert.equal(f.result().total.spentMicroUsd, null);
    f.evidence.jobs = [job]; f.evidence.ledger = [f.entry(job)];
    assert.equal(f.result().total.coverage, "complete");
    const missing = f.job({ status: "failed" }); f.evidence.jobs = [job, missing];
    assert.equal(f.result().total.coverage, "partial"); assert.equal(f.result().total.spentMicroUsd, 101);
    f.evidence.ledgerUnavailable = true;
    assert.equal(f.result().total.coverage, "unavailable"); assert.equal(f.result().total.generated, 1);
  });
  it("keeps every source, allowance attempts and local work separate from billed spend", () => {
    const f = fixture();
    const sources: Array<ActualCostSource | undefined> = ["provider-reported", "usage-derived", "mixed-measured", "manifest-derived", "local-zero", "free-plan", "free-credit", "included-plan", undefined];
    const jobs = sources.map(() => f.job({ status: "failed" }));
    f.evidence.jobs = jobs; f.evidence.ledger = jobs.map((job, i) => f.entry(job, 10, sources[i]));
    // Explicitly missing source and estimated amount, not the helper's default source.
    delete (f.evidence.ledger[8] as LedgerEntry).actualSource;
    (f.evidence.ledger[3] as LedgerEntry).actualMicroUsd = null;
    const total = f.result().total;
    assert.equal(total.spentMicroUsd, 50); assert.equal(total.localRuns, 1);
    assert.ok(total.sources.some(source => source.source === "included-plan" && source.microUsd === 0));
    assert.ok(total.sources.some(source => source.source === "unknown-actual"));
    assert.ok(total.sources.some(source => source.source === "estimated"));
  });
  it("joins frozen Bench requests, counts unfiled video and deduplicates a filed copy", () => {
    const f = fixture(), job = f.job({ target: { kind: "bench-take", id: "session/take" }, productionId: undefined });
    const filedId = newId("tk");
    const bench = BenchTakeSchema.parse({ id: newId("tk"), n: 1, requestId: WORLD, jobId: job.id, status: "succeeded", disposition: "open", createdAt: AT,
      media: { file: "clip.mp4", hash: "sha256:" + "a".repeat(64) },
      request: { mode: "video", provider: "fal", model: "video", brief: "A signal", references: [], keyframes: [], params: { kind: "video" }, productionProvenance: provenance,
        filing: { kind: "board", productionId: "saltlight", sceneId: "sc_a", productionTakeId: newId("tk"),
          members: [{ shotId: "sh_1", number: 1, startSec: 0, endSec: 5, takeId: filedId }] } } });
    f.evidence.jobs = [job]; f.evidence.ledger = [f.entry(job)]; f.evidence.bench = [{ sessionId: "session", takes: [bench] }];
    assert.equal(f.result().total.generated, 1); assert.equal(f.result().total.spentMicroUsd, 101);
    f.production.takes = [f.take(job, "sh_1", { id: filedId })]; f.production.selections.sh_1 = { acceptedTakeId: filedId as never, trimInSec: 0 };
    assert.equal(f.result().total.generated, 1); assert.equal(f.result().total.selected, 1);
    assert.equal(f.result().total.spentMicroUsd, 101);
    delete f.production.takes[0]!.jobId;
    assert.equal(f.result().total.generated, 1, "legacy filed aliases without a job id still deduplicate");
    assert.equal(f.result().total.selected, 1);
  });
  it("uses new job attribution even after Bench records disappear, and marks lost candidate evidence", () => {
    const f = fixture(), job = f.job({ target: { kind: "bench-take", id: "gone/gone" }, params: { productionWork: {
      productionId: "saltlight", sceneId: "sc_a", kind: "video", shots: [{ shotId: "sh_1", durationSec: 5, takeId: "old-take" }] } } });
    f.evidence.jobs = [job]; f.evidence.ledger = [f.entry(job)]; f.evidence.benchIncomplete = true;
    assert.equal(f.result().total.spentMicroUsd, 101); assert.equal(f.result().total.countsPartial, true);
  });
  it("retains removed-scene and orphan production money without inventing allocation", () => {
    const f = fixture(), job = f.job({ params: { provenance: { sceneId: "sc_removed" } }, status: "failed" });
    f.evidence.jobs = [job]; f.evidence.ledger = [f.entry(job), f.entry(f.job(), 25)];
    assert.equal(f.result().total.spentMicroUsd, 126); assert.equal(f.result().total.unallocatedMicroUsd, 126);
    assert.equal(f.result().total.coverage, "partial");
  });
});
