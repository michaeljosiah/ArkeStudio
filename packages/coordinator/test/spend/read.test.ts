import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BenchTakeSchema, JobSchema, newId, orderedShots, type LedgerEntry } from "@arke-studio/contracts";
import { WorldStore } from "../../src/world/store.js";
import { BenchStore, sessionDir } from "../../src/bench/store.js";
import { readProductionSpend } from "../../src/spend/read.js";
import { makeTempWorld, makeTempRoot, WORLD_ID } from "../world/helpers.js";
import { closeOnCleanup, tempDir } from "../tmp.js";
import { startLedgerCoordinator } from "./seeded-ledger.js";
const AT = "2026-11-01T00:00:00.000Z";

async function fixture() {
  const dir = await makeTempWorld(); const store = await WorldStore.open(dir); closeOnCleanup(() => store.close());
  const world = structuredClone(store.getBundle());
  const production = world.productions.find(production => production.meta.id === "saltlight")!;
  world.productions = [production]; production.takes = []; production.selections = {};
  const scene = production.scenes[0]!, shot = orderedShots(scene)[0]!;
  const root = await tempDir("arke-spend-history-");
  const jobsPath = join(root, "jobs.jsonl"), ledgerPath = join(root, "ledger.jsonl");
  const job = JobSchema.parse({ id: newId("jb"), idempotencyKey: WORLD_ID, worldId: WORLD_ID, productionId: production.meta.id,
    target: { kind: "shot", id: shot.id }, capability: "video", provider: "fal", model: "video", params: { provenance: { sceneId: scene.id } },
    estimatedMicroUsd: 100, status: "failed", createdAt: AT, updatedAt: AT, deletedAt: AT });
  const entry: LedgerEntry = { ts: AT, worldId: WORLD_ID, productionId: production.meta.id, jobId: job.id, provider: "fal", model: "video", outcome: "failed", estimatedMicroUsd: 100, actualMicroUsd: 75, actualSource: "provider-reported" };
  const read = async () => (await readProductionSpend({ world, worldDir: dir, jobsPath, ledgerPath })).productions[production.meta.id]!;
  return { dir, world, root, production, scene, shot, job, entry, jobsPath, ledgerPath, read };
}

describe("read-only lifetime evidence", () => {
  it("reopens complete history including tombstones, and never repairs a torn input", async () => {
    const f = await fixture();
    await writeFile(f.jobsPath, JSON.stringify(f.job) + "\n"); await writeFile(f.ledgerPath, JSON.stringify(f.entry) + "\n");
    assert.equal((await f.read()).total.spentMicroUsd, 75);
    const torn = JSON.stringify(f.entry) + '\n{"torn'; await writeFile(f.ledgerPath, torn);
    const value = await f.read(); assert.equal(value.total.coverage, "partial"); assert.equal(value.total.spentMicroUsd, 75);
    assert.equal(await readFile(f.ledgerPath, "utf8"), torn, "analytics performs no tail repair");
    assert.equal((await f.read()).total.spentMicroUsd, 75, "a replacement reader reconstructs the same total");
  });
  it("distinguishes an unreadable ledger from a missing one", async () => {
    const f = await fixture(); await mkdir(f.ledgerPath);
    const value = await f.read(); assert.equal(value.total.spentMicroUsd, null); assert.equal(value.total.coverage, "unavailable");
    assert.ok(value.total.problems.includes("ledger-unreadable"));
  });
  it("keeps a produced Bench candidate after media deletion, without changing the normal fold", async () => {
    const f = await fixture(), id = newId("sess") as never;
    const bench = new BenchStore(sessionDir(f.dir, id)); await bench.create(id, AT);
    const filedId = newId("tk");
    const take = BenchTakeSchema.parse({ id: newId("tk"), n: 1, requestId: WORLD_ID, status: "succeeded", disposition: "open", createdAt: AT, jobId: f.job.id,
      request: { mode: "video", provider: "fal", model: "video", brief: "A signal", references: [], keyframes: [], params: { kind: "video" },
        productionProvenance: { canonRevision: 1, sheets: {}, artDirectionVersion: 1 },
        filing: { kind: "board", productionId: f.production.meta.id, sceneId: f.scene.id, productionTakeId: newId("tk"),
          members: [{ shotId: f.shot.id, number: f.shot.number, startSec: 0, endSec: 5, takeId: filedId }] } },
      media: { file: "clip.mp4", hash: "sha256:" + "a".repeat(64) } });
    await bench.append({ type: "takes-reserved", takes: [{ id: take.id, n: 1, requestId: WORLD_ID, request: take.request, createdAt: AT }] }, { at: AT });
    await bench.append({ type: "take-job", takeId: take.id, jobId: f.job.id }, { at: AT });
    await bench.append({ type: "take-completed", takeId: take.id, media: take.media!, completedAt: AT }, { at: AT });
    await bench.append({ type: "take-deleted", takeId: take.id }, { at: AT });
    await writeFile(f.jobsPath, JSON.stringify({ ...f.job, target: { kind: "bench-take", id: `${id}/${take.id}` }, status: "succeeded" }) + "\n");
    await writeFile(f.ledgerPath, JSON.stringify({ ...f.entry, outcome: "succeeded" }) + "\n");
    assert.equal((await bench.fold())!.takes.length, 0);
    assert.equal((await f.read()).total.generated, 1);
    assert.equal((await f.read()).total.spentMicroUsd, 75);
    assert.equal((await bench.fold())!.takes.length, 0, "analytics does not restore the deleted wall entry");
  });
  it("publishes the open world's projection and refreshes ledger changes through the coordinator", async () => {
    const { root } = await makeTempRoot(); const host = await startLedgerCoordinator(root);
    try {
      await host.send({ kind: "open-world", worldId: WORLD_ID });
      await host.send({ kind: "production-spend-refresh", worldId: WORLD_ID });
      assert.equal(host.coordinator.getState().productionSpend?.worldId, WORLD_ID);
      const jobId = newId("jb") as LedgerEntry["jobId"];
      await host.coordinator.recordLedger({ ts: AT, worldId: WORLD_ID, productionId: "saltlight", jobId,
        provider: "fal", model: "lost-job", outcome: "failed", estimatedMicroUsd: 42, actualMicroUsd: 42, actualSource: "provider-reported" });
      await host.send({ kind: "production-spend-refresh", worldId: WORLD_ID });
      const value = host.coordinator.getState().productionSpend!.productions.saltlight!;
      assert.equal(value.total.spentMicroUsd, 42); assert.equal(value.total.unallocatedMicroUsd, 42);
      assert.equal(value.total.coverage, "partial");

    } finally { await host.close(); }
    assert.equal(host.coordinator.getState().productionSpend, undefined);
  });
});
