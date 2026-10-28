import assert from "node:assert/strict";
import { it } from "node:test";
import { join } from "node:path";
import type { Job, LedgerEntry } from "@arke-studio/contracts";
import { JobQueue, type EnqueueInput, type JobQueueOptions } from "../../src/queue/dispatcher.js";
import { JobJournal } from "../../src/queue/journal.js";
import { AppStorageService } from "../../src/storage/service.js";
import { ArtifactStorageHeld, JobArtifactStorage, SubmissionStorageHeld, type ArtifactWriteSpace } from "../../src/storage/job-artifacts.js";
import { FakeProvider, pngBytes } from "./fake-provider.js";
import { tempDir } from "../tmp.js";
import { until } from "../wait.js";

const GiB = 1024 ** 3, WORLD = "01J8F3K2QW9VZX4N7M0RTYB6HC", OTHER = "01J8F3K2QW9VZX4N7M0RTYB6HD";
const input: EnqueueInput = { worldId: WORLD, provider: "fal", model: "synthetic-image", capability: "image",
  target: { kind: "shot", id: "shot_one" }, params: {}, estimatedMicroUsd: 100, landing: { dir: "incoming" } };
async function fixture(custom?: ArtifactWriteSpace, prepareReferences?: JobQueueOptions["prepareReferences"], checkStorageBeforeSubmission?: () => boolean) {
  const root = await tempDir("arke-submission-space-"), world = join(root, "world"), other = join(root, "other");
  let now = Date.now(), free = 0, appFree = 100 * GiB, roots: readonly { rootId: string; path: string }[] = [];
  const storage = new AppStorageService({ appRoot: root, now: () => now, native: {
    setRoots(value) { roots = value; }, async stop() {}, async probe(rootId) {
      const held = roots.find(row => row.rootId === rootId)!.path.startsWith(world);
      return { state: "measured", source: "host-provided", limitations: [], capacity: { volumeId: held ? "full-world" : "roomy-app",
        mappingRevision: rootId, measuredAt: ++now, availableBytes: held ? free : appFree, totalBytes: 200 * GiB } };
    },
  } });
  const client = new FakeProvider({}); client.inlineArtifacts = [{ name: "image.png", contentType: "image/png", data: pngBytes() }];
  const events: Job[] = [], ledger: LedgerEntry[] = [], space = custom ?? new JobArtifactStorage(storage);
  const create = () => new JobQueue({ journalPath: join(root, "jobs.jsonl"), clients: { fal: client }, getKey: async () => "synthetic",
    emit(event) { if (event.type === "job.updated") events.push(event.job); }, artifactSpace: space, prepareReferences, checkStorageBeforeSubmission,
    submissionStorageRetryMs: 100, artifactRetryMs: 15, baseIntervalMs: 1, pollIntervalMs: 1,
    landInWorld: async (id, work) => { await work(id === WORLD ? world : other); return true; },
    ledger: { async readJobIds() { return new Set(ledger.map(row => row.jobId)); }, async has(id) { return ledger.some(row => row.jobId === id); }, async append(row) { ledger.push(row); } },
  });
  const invalidate = () => { now += 5001; for (const row of roots) storage.writeFailed(row.rootId); };
  const roomy = () => { free = appFree = 100 * GiB; invalidate(); };
  const fullApp = () => { appFree = 0; invalidate(); };
  return { root, storage, client, create, events, ledger, roomy, fullApp };
}
const held = (queue: JobQueue, id: string) => queue.listJobs().find(row => row.id === id)?.error?.startsWith("Not submitted:") === true;
it("disabling the preflight cannot race a deliberate cancellation into provider submission", { timeout: 30_000 }, async () => {
  let queue!: JobQueue;
  const h = await fixture(undefined, undefined, () => { void queue.cancel(queue.listJobs()[0]!.id); return false; });
  queue = h.create();
  try {
    await queue.start(); await queue.enqueue(input);
    await until(() => queue.listJobs()[0]?.status === "cancelled", "cancellation during disabled preflight");
    await queue.waitForIdle(); assert.equal(h.client.submitCount, 0);
  } finally { await queue.dispose(); await queue.waitForIdle(); await h.storage.stop(); }
});
it("an operator can release a preflight hold without bypassing result filing or resubmitting accepted work", { timeout: 30_000 }, async () => {
  let check = true, allowWrites = false, filingChecks = 0;
  const h = await fixture({ async checkSubmission() { throw new SubmissionStorageHeld(); }, async reserve() {
    filingChecks++; if (!allowWrites) throw new ArtifactStorageHeld();
    return { async consumed() {}, writeFailed() {}, async settle() {} };
  } }, undefined, () => check), queue = h.create();
  try {
    await queue.start(); const job = await queue.enqueue(input);
    await until(() => held(queue, job.id), "default preflight hold"); assert.equal(h.client.submitCount, 0);
    check = false; await until(() => h.client.submitCount === 1 && filingChecks > 0, "explicit preference releases submission only");
    assert.notEqual(queue.listJobs()[0]!.status, "succeeded"); allowWrites = true;
    await until(() => queue.listJobs()[0]!.status === "succeeded", "original result files after space returns");
    assert.equal(h.client.submitCount, 1); assert.equal(h.ledger.length, 1);
  } finally { await queue.dispose(); await queue.waitForIdle(); await h.storage.stop(); }
});
it("holds a paid request on its full world volume, survives restart unsent, then submits once after fresh capacity", { timeout: 30_000 }, async () => {
  const h = await fixture(), first = h.create(); let next: JobQueue | undefined;
  try {
    await first.start(); const job = await first.enqueue(input);
    await until(() => held(first, job.id), "unsent destination hold");
    assert.equal(h.client.submitCount, 0); assert.equal(first.listJobs()[0]!.attempt, 0); assert.equal(h.ledger.length, 0);
    const history = await new JobJournal(join(h.root, "jobs.jsonl")).readHistory();
    assert.equal(history.length, 1); assert.equal(history[0]!.error, null, "Headroom observation needs no further write to the full disk");
    assert.equal(h.storage.reservations.snapshot().records.length, 0, "A preflight does not acquire a fake output reservation");
    await first.dispose(); await first.waitForIdle();
    next = h.create(); await next.start(); await until(() => held(next!, job.id), "same unsent identity restored");
    assert.equal(h.client.submitCount, 0); h.roomy();
    await until(() => next!.listJobs()[0]?.status === "succeeded", "fresh capacity releases unsent work", 20_000);
    assert.equal(h.client.submitCount, 1); assert.equal(next.listJobs()[0]!.attempt, 1);
    assert.equal(next.listJobs()[0]!.idempotencyKey, job.idempotencyKey); assert.equal(h.ledger.length, 1);
    assert(h.events.filter(row => row.status === "submitting").every(row => row.error === null));
  } finally { await first.dispose(); await next?.dispose(); await first.waitForIdle(); await next?.waitForIdle(); await h.storage.stop(); }
});

it("a roomy world cannot mask a full app receipt volume, and the warning requires no journal write", { timeout: 30_000 }, async () => {
  const h = await fixture(); h.roomy(); h.fullApp(); const queue = h.create();
  try {
    await queue.start(); const job = await queue.enqueue(input);
    await until(() => held(queue, job.id), "full app volume holds unsent work");
    assert.equal(h.client.submitCount, 0); assert.equal(queue.listJobs()[0]!.attempt, 0);
    const history = await new JobJournal(join(h.root, "jobs.jsonl")).readHistory();
    assert.equal(history.length, 1); assert.equal(history[0]!.status, "queued"); assert.equal(history[0]!.error, null);
    assert.deepEqual(h.storage.reservations.snapshot().records, []); assert.deepEqual(h.storage.reservations.snapshot().consumed, []);
  } finally { await queue.dispose(); await queue.waitForIdle(); await h.storage.stop(); }
});

it("a storage-held job yields its provider lane to another destination and cancellation stays final", { timeout: 30_000 }, async () => {
  const h = await fixture(), queue = h.create();
  try {
    await queue.start(); const blocked = await queue.enqueue(input);
    await until(() => held(queue, blocked.id), "first destination held");
    const unaffected = await queue.enqueue({ ...input, worldId: OTHER });
    await until(() => queue.listJobs().find(row => row.id === unaffected.id)?.status === "succeeded", "unaffected volume progresses");
    assert.equal(h.client.submitCount, 1); await queue.cancel(blocked.id); h.roomy();
    await queue.waitForIdle();
    assert.equal(queue.listJobs().find(row => row.id === blocked.id)?.status, "cancelled");
    assert.equal(h.client.submitCount, 1); assert.equal(h.client.cancelCount, 0, "The held request never reached the provider");
  } finally { await queue.dispose(); await queue.waitForIdle(); await h.storage.stop(); }
});

it("rechecks after reference preparation and does not spend a submission attempt on a new shortage", { timeout: 30_000 }, async () => {
  let checks = 0, prepared = 0;
  const h = await fixture({ async checkSubmission() { if (++checks > 1) throw new SubmissionStorageHeld(); },
    async reserve() { throw new Error("No result should exist"); },
  }, async (_job, videos) => { prepared++; return { videos, audio: [] }; }), queue = h.create();
  try {
    await queue.start(); const job = await queue.enqueue(input);
    await until(() => held(queue, job.id), "post-preparation storage hold");
    assert.equal(checks >= 2, true); assert.equal(prepared, 1); assert.equal(h.client.submitCount, 0);
    assert.equal(queue.listJobs()[0]!.attempt, 0); await queue.cancel(job.id);
  } finally { await queue.dispose(); await queue.waitForIdle(); await h.storage.stop(); }
});

for (const ending of ["cancel", "stop"] as const) it(`an original storage probe that finishes after ${ending} cannot authorize provider I/O`, { timeout: 30_000 }, async () => {
  let finish!: () => void, signal: AbortSignal | undefined;
  const h = await fixture({ async checkSubmission(_directories, captured) { signal = captured; await new Promise<void>(resolve => { finish = resolve; }); },
    async reserve() { throw new Error("No result should exist"); },
  }), queue = h.create();
  try {
    await queue.start(); const job = await queue.enqueue(input);
    await until(() => signal !== undefined, "original preflight entered");
    if (ending === "cancel") await queue.cancel(job.id); else await queue.dispose();
    assert.equal(signal!.aborted, true); finish(); await queue.waitForIdle();
    assert.equal(h.client.submitCount, 0); assert(h.ledger.every(row => row.actualMicroUsd === null), "The existing cancellation ledger invents no provider-reported charge");
    assert.equal(queue.listJobs()[0]!.attempt, 0);
  } finally { finish?.(); await queue.dispose(); await queue.waitForIdle(); await h.storage.stop(); }
});
