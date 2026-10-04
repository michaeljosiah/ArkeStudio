import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import { ArkeGenerationReceiptDetailSchema, JobSchema, newId, type ConversationActionCard, type Job, type ModelWorldChatAction, type SessionId } from "@arke-studio/contracts";
import { BenchStore } from "../../src/bench/store.js";
import { openBenchSession } from "../../src/bench/service.js";
import { Coordinator } from "../../src/coordinator.js";
import type { EnqueueInput } from "../../src/queue/dispatcher.js";
import type { WorldChatActionAdapterDeps } from "../../src/world-chat/actions.js";
import type { WorldStore } from "../../src/world/store.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

it("persists Bench take identities and exact inputs before approval without reserving or enqueuing", async t => {
  const at = "2026-10-03T12:00:00.000Z";
  const { root, worldDir } = await makeTempRoot();
  const provider = new FsWorldProvider(root, { clock: () => at });
  t.after(() => provider.close());
  await provider.loadWorld(WORLD_ID);
  const store = provider.openStore()!;
  const sessionId = newId("sess") as SessionId;
  const opened = await openBenchSession(worldDir, () => at, { sessionId,
    defaultModel: { provider: "fal", model: "test-image" }, initial: { mode: "image", brief: "A tide clock" } });
  assert.ok(opened);
  const coordinator = new Coordinator({ provider, adapter: null, changeLogPath: join(root, "changes.jsonl"), appVersion: "test",
    manifest: { manifestVersion: 1, generated: "2026-10-03", models: [{ id: "test-image", provider: "fal", capability: "image", displayName: "Test image",
      accepts: { referenceImages: 0, startFrame: false, endFrame: false }, limits: {}, pricing: { kind: "perImage", microUsdPerImage: 10_000 } }] } });
  const internals = coordinator as unknown as {
    conversationActionDependencies(store: WorldStore): WorldChatActionAdapterDeps;
    enqueueWithSpeechChecks(input: EnqueueInput): Promise<Job>;
    jobQueue: { listJobs(): Job[] };
  };
  const admitted: EnqueueInput[] = [];
  const jobs: Job[] = [];
  internals.jobQueue = { listJobs: () => jobs };
  internals.enqueueWithSpeechChecks = async input => {
    admitted.push(input);
    const job = JobSchema.parse({ ...input, id: newId("jb"), status: "queued", createdAt: at, updatedAt: at });
    jobs.push(job);
    return job;
  };
  const quotes = () => internals.conversationActionDependencies(store).benchGenerationQuotes!;
  const action: ModelWorldChatAction = { kind: "bench-generation", sessionId, checkReceiptIds: [newId("check")],
    composer: { mode: "image", provider: "fal", model: "test-image", brief: "a".repeat(50_000), params: { kind: "image", count: 2 } } };
  const id = newId("act");
  const body = await quotes().prepare(action, id, at);
  assert.equal(body.estimatedMicroUsd, 20_000);
  assert.equal(body.prompt, "a".repeat(50_000), "a shared long brief is disclosed once");
  assert.equal(body.quantity, 2);
  assert.deepEqual(await quotes().prepare(action, id, at), body);
  await quotes().validate(action, id);
  assert.deepEqual((await opened.store.fold())!.takes, []);
  assert.deepEqual(admitted, []);
  const frozen = JSON.parse(await readFile(join(worldDir, ".history/world/prepared", `${id}.generation.json`), "utf8"));
  assert.equal((await quotes().dispatch(action, id)).status, "queued");
  assert.deepEqual(admitted, frozen.inputs);
  assert.ok((await opened.store.fold())!.takes.every(take => take.status === "queued" && take.error === undefined));
  assert.deepEqual((await opened.store.fold())!.takes.map(take => take.id), frozen.materialization.reserved.map((take: { id: string }) => take.id));
  assert.equal((await quotes().dispatch(action, id)).status, "running");
  assert.equal(admitted.length, 2, "a fresh dependency composition rejoins rather than admitting again");
});

for (const known of [false, true, "partial", "reservation"] as const) {
  it(`settles unattempted Bench work after interrupted admission (${known === "reservation" ? "uncertain reservation acknowledgement" : known === "partial" ? "partial completion" : known ? "known queue row" : "unknown purchase"}) without retry`, async t => {
    const at = "2026-10-03T12:00:00.000Z";
    const { root, worldDir } = await makeTempRoot();
    const provider = new FsWorldProvider(root, { clock: () => at });
    t.after(() => provider.close());
    await provider.loadWorld(WORLD_ID);
    const store = provider.openStore()!;
    const sessionId = newId("sess") as SessionId;
    const opened = await openBenchSession(worldDir, () => at, { sessionId,
      defaultModel: { provider: "fal", model: "test-image" }, initial: { mode: "image", brief: "A tide clock" } });
    assert.ok(opened);
    const coordinator = new Coordinator({ provider, adapter: null, changeLogPath: join(root, "changes.jsonl"), appVersion: "test",
      manifest: { manifestVersion: 1, generated: "2026-10-03", models: [{ id: "test-image", provider: "fal", capability: "image", displayName: "Test image",
        accepts: { referenceImages: 0, startFrame: false, endFrame: false }, limits: {}, pricing: { kind: "perImage", microUsdPerImage: 10_000 } }] } });
    const internals = coordinator as unknown as {
      conversationActionDependencies(store: WorldStore): WorldChatActionAdapterDeps;
      enqueueWithSpeechChecks(input: EnqueueInput): Promise<Job>;
      jobQueue: { listJobs(): Job[] };
    };
    const jobs: Job[] = [];
    if (known === "reservation") {
      const original = BenchStore.prototype.append;
      let interrupted = false;
      t.mock.method(BenchStore.prototype, "append", async function(this: BenchStore, ...args: Parameters<BenchStore["append"]>) {
        const result = await original.apply(this, args);
        if (this.dir === opened.store.dir && args[0].type === "takes-reserved" && !interrupted) {
          interrupted = true;
          throw new Error("Reservation fsync succeeded but its acknowledgement was lost");
        }
        return result;
      });
    }
    let admissions = 0;
    internals.jobQueue = { listJobs: () => jobs };
    internals.enqueueWithSpeechChecks = async input => {
      admissions++;
      if (known === "partial" && admissions === 1) {
        const job = JobSchema.parse({ ...input, id: newId("jb"), status: "queued", createdAt: at, updatedAt: at });
        jobs.push(job);
        return job;
      }
      if (known) jobs.push(JobSchema.parse({ ...input, id: newId("jb"), status: "failed", error: "Provider refused", createdAt: at, updatedAt: at }));
      throw new Error("Queue append outcome was interrupted");
    };
    const quotes = () => internals.conversationActionDependencies(store).benchGenerationQuotes!;
    const action: ModelWorldChatAction = { kind: "bench-generation", sessionId, checkReceiptIds: [newId("check")],
      composer: { mode: "image", provider: "fal", model: "test-image", brief: "The approved tide clock", params: { kind: "image", count: 3 } } };
    const id = newId("act");
    await quotes().prepare(action, id, at);
    assert.equal((await quotes().dispatch(action, id)).status, "running");
    if (known === "partial") {
      const first = (await opened.store.fold())!.takes[0]!;
      await opened.store.append({ type: "take-completed", takeId: first.id, media: { file: "take.png", hash: `sha256:${"a".repeat(64)}` }, completedAt: at });
    }
    const takes = (await opened.store.fold())!.takes;
    assert.deepEqual(takes.map(take => take.status), known === "partial" ? ["succeeded", "failed", "failed"] : [known ? "failed" : "needs-reconciliation", "failed", "failed"]);
    assert.ok(takes.slice(known === "reservation" ? 0 : known === "partial" ? 2 : 1).every(take => /Not attempted/.test(take.error!)));
    assert.equal(takes[0]!.jobId, jobs[0]?.id);
    const result = await quotes().reconcile({ actionId: id, authority: { id: sessionId } } as ConversationActionCard);
    assert.equal(result?.status, known === "partial" ? "completed" : known ? "failed" : "running");
    if (known) {
      ArkeGenerationReceiptDetailSchema.parse(result!.receipt!.generation);
      assert.equal(result!.receipt!.generation!.authorized, 3);
      assert.equal(result!.receipt!.generation!.completed, known === "partial" ? 1 : 0);
      assert.equal(result!.receipt!.generation!.failed, known === "reservation" ? 0 : 1);
      assert.equal(result!.receipt!.generation!.unattempted, known === "reservation" ? 3 : known === "partial" ? 1 : 2);
      assert.equal(result!.receipt!.generation!.results.length, known === "reservation" ? 0 : known === "partial" ? 2 : 1);
      assert.equal(result!.receipt!.generation!.actualMicroUsd, known === "reservation" ? 0 : null, "only definitely unattempted work has a proven zero charge");
    }
    if (!known) assert.match(result!.detail!, /reconciliation/);
    await quotes().dispatch(action, id);
    assert.equal(admissions, known === "reservation" ? 0 : known === "partial" ? 2 : 1, "a reconstructed service never resubmits uncertain work");
  });
}
