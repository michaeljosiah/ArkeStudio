import assert from "node:assert/strict";
import { it } from "node:test";
import { join } from "node:path";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import type { Job, LedgerEntry } from "@arke-studio/contracts";
import { JobQueue, type EnqueueInput } from "../../src/queue/dispatcher.js";
import { JobJournal, type JobStateStore } from "../../src/queue/journal.js";
import { ArtifactResultFiles } from "../../src/queue/artifact-files.js";
import { AppStorageService } from "../../src/storage/service.js";
import { ArtifactStorageHeld, JobArtifactStorage, type ArtifactWriteSpace } from "../../src/storage/job-artifacts.js";
import { FakeProvider, pngBytes } from "./fake-provider.js";
import { tempDir } from "../tmp.js";
import { until, untilAsync } from "../wait.js";

const GiB = 1024 ** 3;
const input: EnqueueInput = { worldId: '01J8F3K2QW9VZX4N7M0RTYB6HC', provider: 'fake', model: 'synthetic-image', capability: 'image',
  target: { kind: 'shot', id: 'shot_one' }, params: {}, estimatedMicroUsd: 100, landing: { dir: 'incoming', name: 'result.png' } };
async function fixture(inline = false, custom?: ArtifactWriteSpace) {
  const root = await tempDir('arke-result-queue-'), world = join(root, 'world'), journalPath = join(root, 'queue', 'jobs.jsonl');
  let clock = Date.now(), free = 0, roots: readonly { rootId: string; path: string }[] = [], fetches = 0;
  const storage = new AppStorageService({ appRoot: root, now: () => clock, native: {
    setRoots(value) { roots = value; }, async stop() {}, async probe(rootId) {
      const isWorld = roots.find(value => value.rootId === rootId)!.path.startsWith(world);
      return { state: 'measured', source: 'host-provided', limitations: [], capacity: { volumeId: isWorld ? 'world-volume' : 'app-volume', mappingRevision: rootId,
        measuredAt: ++clock, availableBytes: isWorld ? free : 100 * GiB, totalBytes: 200 * GiB } };
    },
  } });
  const fake = new FakeProvider({ reportsCost: true }); fake.costMicroUsd = 37;
  const artifacts = [{ name: 'result.png', contentType: 'image/png', data: pngBytes() }];
  if (inline) fake.inlineArtifacts = artifacts; else fake.artifacts = artifacts;
  fake.onFetch = () => { fetches++; };
  const ledger: LedgerEntry[] = [], events: Job[] = [], space = custom ?? new JobArtifactStorage(storage);
  const create = (journal?: JobStateStore, verify?: () => Promise<void>) => new JobQueue({ journalPath, ...(journal ? { journal } : {}), clients: { fake }, getKey: async () => 'synthetic',
    emit(event) { if (event.type === 'job.updated') events.push(event.job); }, artifactSpace: space, artifactRetryMs: 15,
    landInWorld: async (_worldId, work) => { await work(world, verify); return true; }, baseIntervalMs: 1, pollIntervalMs: 5,
    ledger: { async readJobIds() { return new Set(ledger.map(value => value.jobId)); }, async has(id) { return ledger.some(value => value.jobId === id); }, async append(value) { ledger.push(value); } } });
  const freeWorld = () => { free = 10 * GiB; clock += 5001; for (const value of roots) if (value.path.startsWith(world)) storage.writeFailed(value.rootId); };
  return { root, world, journalPath, storage, fake, artifacts, ledger, events, create, freeWorld, fetches: () => fetches };
}

it("a full world holds a completed remote result despite a roomy app drive, then files the same bytes without another fetch or submit", { timeout: 30_000 }, async () => {
  const h = await fixture(), queue = h.create();
  try {
    await queue.start(); const job = await queue.enqueue(input);
    await until(() => queue.listJobs().find(value => value.id === job.id)?.error?.includes('waiting for storage') === true, 'measured world storage hold');
    const held = queue.listJobs()[0]!; assert.equal(held.status, 'running'); assert(held.providerJobId); assert(held.resultReceiptId);
    assert.equal(h.fake.submitCount, 1); assert.equal(h.fetches(), 1);
    const files = new ArtifactResultFiles(h.journalPath); assert.deepEqual([...(await files.read(held))!.artifacts[0]!.data], [...pngBytes()]);
    assert.equal((await readdir(join(h.world, '.staging', job.id))).length, 0, 'Admission precedes world payload writes');
    h.freeWorld(); await until(() => queue.listJobs()[0]?.status === 'succeeded', 'local filing after fresh admission');
    assert.equal(h.fake.submitCount, 1); assert.equal(h.fetches(), 1); assert.equal(h.ledger.length, 1); assert.equal(h.ledger[0]!.actualMicroUsd, 37);
    assert.deepEqual([...await readFile(join(h.world, 'incoming', 'result.png'))], [...pngBytes()]);
    assert.equal(h.storage.reservations.snapshot().records.length, 0);
  } finally { await queue.dispose(); await queue.waitForIdle(); await h.storage.stop(); }
});

it("ownership loss after staging preserves verified bytes, and restart reserves only publication metadata for that prefix", { timeout: 30_000 }, async () => {
  const plans: number[] = [];
  const h = await fixture(false, { async reserve(_id, demands, _signal, sameVolume) {
    if (sameVolume) plans.push(demands.reduce((sum, value) => sum + value.remainingBytes, 0));
    return { async consumed() {}, writeFailed() {}, async settle() {} };
  } }); let checks = 0, next: JobQueue | undefined;
  const queue = h.create(undefined, async () => { if (++checks >= 2) throw new Error('synthetic ownership loss'); });
  try {
    await queue.start(); const job = await queue.enqueue(input);
    await until(() => queue.listJobs()[0]?.error?.includes('waiting for the owning world') === true, 'ownership recheck before publication');
    const staged = join(h.world, '.staging', job.id, 'result.png'); assert.deepEqual([...await readFile(staged)], [...pngBytes()]);
    await assert.rejects(readFile(join(h.world, 'incoming', 'result.png')), { code: 'ENOENT' });
    await queue.dispose(); await queue.waitForIdle();
    next = h.create(); await next.start(); await until(() => next!.listJobs()[0]?.status === 'succeeded', 'same verified staging prefix filed');
    assert.equal(plans[0], pngBytes().length + 2 * 64 * 1024); assert.equal(plans.at(-1), 64 * 1024);
    assert.equal(h.fake.submitCount, 1); assert.equal(h.fetches(), 1); assert.deepEqual([...await readFile(join(h.world, 'incoming', 'result.png'))], [...pngBytes()]);
  } finally { await queue.dispose(); await next?.dispose(); await queue.waitForIdle(); await next?.waitForIdle(); await h.storage.stop(); }
});

it("files a smaller regenerated result over its existing ordinary destination after normal storage admission", { timeout: 30_000 }, async () => {
  const h = await fixture(), directory = join(h.world, 'incoming'), previous = Buffer.concat([pngBytes(), pngBytes()]);
  await mkdir(directory, { recursive: true }); await writeFile(join(directory, 'result.png'), previous);
  const queue = h.create();
  try {
    await queue.start(); await queue.enqueue(input);
    await until(() => queue.listJobs()[0]?.error?.includes('waiting for storage') === true, 'new bytes still require admission');
    assert.deepEqual(await readFile(join(directory, 'result.png')), previous);
    h.freeWorld(); await until(() => queue.listJobs()[0]?.status === 'succeeded', 'new smaller result replaces the requested destination');
    assert.deepEqual(await readFile(join(directory, 'result.png')), Buffer.from(pngBytes()));
    assert.equal(h.fake.submitCount, 1); assert.equal(h.fetches(), 1); assert.equal(h.ledger.length, 1);
  } finally { await queue.dispose(); await queue.waitForIdle(); await h.storage.stop(); }
});

it("a pre-upgrade inline receipt survives repeated held restarts without an unmigrated nonce hiding it", { timeout: 30_000 }, async () => {
  const h = await fixture(true), disk = new JobJournal(h.journalPath), at = new Date().toISOString();
  const legacy: Job = { ...input, id: 'jb_01J8F3K2QW9VZX4N7M0RTYB6HD', idempotencyKey: '01J8F3K2QW9VZX4N7M0RTYB6HD',
    status: 'running', providerJobId: 'legacy-accepted', providerResultKind: 'inline', providerCostMicroUsd: 37, attempt: 1, error: null, createdAt: at, updatedAt: at };
  const directory = join(h.root, 'queue', 'inline-artifacts', legacy.id);
  await disk.append(legacy); await mkdir(directory, { recursive: true });
  await writeFile(join(directory, '0.bin'), pngBytes());
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ remoteId: legacy.providerJobId, artifacts: [{ name: 'result.png', contentType: 'image/png' }] }));
  const queues: JobQueue[] = [];
  try {
    for (let restart = 0; restart < 2; restart++) {
      const queue = h.create(); queues.push(queue); await queue.start();
      await until(() => queue.listJobs()[0]?.error?.includes('waiting for storage') === true, 'legacy result retained during destination hold');
      assert.equal(queue.listJobs()[0]!.resultReceiptId, undefined); await queue.dispose(); await queue.waitForIdle();
    }
    h.freeWorld(); const final = h.create(); queues.push(final); await final.start();
    await until(() => final.listJobs()[0]?.status === 'succeeded', 'same legacy result filed after another restart');
    assert.equal(h.fake.submitCount, 0); assert.equal(h.fake.pollCount, 0); assert.equal(h.fetches(), 0);
    assert.deepEqual(await readFile(join(h.world, 'incoming', 'result.png')), Buffer.from(pngBytes()));
    assert.deepEqual(await readFile(join(directory, '0.bin')), Buffer.from(pngBytes())); assert.equal(h.ledger[0]!.actualMicroUsd, 37);
  } finally { for (const queue of queues) { await queue.dispose(); await queue.waitForIdle(); } await h.storage.stop(); }
});

it("a partial publication reuses its verified destination and reserves only the remaining rename after restart", { timeout: 30_000 }, async () => {
  let narrow = false, checks = 0; const plans: number[] = [];
  const h = await fixture(false, { async reserve(_id, demands, _signal, sameVolume) {
    const need = demands.reduce((sum, value) => sum + value.remainingBytes, 0);
    if (sameVolume) { plans.push(need); if (narrow && need > 64 * 1024) throw new ArtifactStorageHeld(); }
    return { async consumed() {}, writeFailed() {}, async settle() {} };
  } }); h.artifacts.push({ name: 'second.png', contentType: 'image/png', data: pngBytes() });
  const queue = h.create(undefined, async () => { if (++checks >= 3) throw new Error('owner lost after first rename'); }); let next: JobQueue | undefined;
  try {
    await queue.start(); const job = await queue.enqueue(input);
    await until(() => queue.listJobs()[0]?.error?.includes('waiting for the owning world') === true, 'partial rename retained');
    const destination = join(h.world, 'incoming', 'result.png'), before = await stat(destination);
    assert.deepEqual(await readFile(join(h.world, '.staging', job.id, 'second.png')), Buffer.from(pngBytes()));
    await queue.dispose(); await queue.waitForIdle(); narrow = true;
    next = h.create(); await next.start(); await until(() => next!.listJobs()[0]?.status === 'succeeded', 'remaining rename needs no duplicate payload');
    assert.equal(plans.at(-1), 64 * 1024); assert.equal((await stat(destination)).ino, before.ino);
    assert.deepEqual(next.listJobs()[0]!.landedFiles, ['incoming/result.png', 'incoming/second.png']);
    assert.equal(h.fake.submitCount, 1); assert.equal(h.fetches(), 1); assert.equal(h.ledger.length, 1);
  } finally { await queue.dispose(); await next?.dispose(); await queue.waitForIdle(); await next?.waitForIdle(); await h.storage.stop(); }
});

it("already-published exact bytes need no new storage grant when only job settlement remains", { timeout: 30_000 }, async () => {
  let published = false, renames = 0, worldReservations = 0;
  const h = await fixture(false, { async reserve(_id, _demands, _signal, sameVolume) {
    if (sameVolume) { worldReservations++; if (published) throw new ArtifactStorageHeld(); }
    return { async consumed(_directory, bytes) { if (sameVolume && bytes === 64 * 1024 && ++renames === 2) { published = true; throw new Error('accounting failed after both renames'); } }, writeFailed() {}, async settle() {} };
  } }); h.artifacts.push({ name: 'second.png', contentType: 'image/png', data: pngBytes() });
  const queue = h.create(undefined, async () => { if (published) throw new Error('hold settlement until reopen'); }); let next: JobQueue | undefined;
  try {
    await queue.start(); await queue.enqueue(input); await until(() => published && queue.listJobs()[0]?.error?.includes('waiting') === true, 'both outputs retained before settlement');
    await queue.dispose(); await queue.waitForIdle(); const before = worldReservations;
    next = h.create(); await next.start(); await until(() => next!.listJobs()[0]?.status === 'succeeded', 'verified published files adopted without writes');
    assert.equal(worldReservations, before); assert.deepEqual(next.listJobs()[0]!.landedFiles, ['incoming/result.png', 'incoming/second.png']);
    assert.equal(h.fake.submitCount, 1); assert.equal(h.fetches(), 1); assert.equal(h.ledger.length, 1);
  } finally { await queue.dispose(); await next?.dispose(); await queue.waitForIdle(); await next?.waitForIdle(); await h.storage.stop(); }
});

it("the pre-submit result nonce recovers exact inline bytes and cost when every accepted-facts append rejects", { timeout: 30_000 }, async () => {
  const h = await fixture(true), disk = new JobJournal(h.journalPath);
  const submit = h.fake.submit.bind(h.fake); h.fake.submit = async (...args) => ({ ...await submit(...args), costMicroUsd: 37 });
  const queue = h.create({ readHistory: () => disk.readHistory(), drain: () => disk.drain(), async append(job) {
    if (job.providerJobId !== null) throw Object.assign(new Error('synthetic journal full'), { code: 'ENOSPC' });
    await disk.append(job);
  } }); let next: JobQueue | undefined;
  try {
    await queue.start(); await queue.enqueue(input); const files = new ArtifactResultFiles(h.journalPath);
    await untilAsync(async () => { const job = queue.listJobs()[0]; return !!job?.resultReceiptId && !!await files.read(job); }, 'complete nonce-bound response despite unavailable journal');
    await queue.dispose(); await queue.waitForIdle();
    const rows = await disk.readHistory(); assert.equal(rows.at(-1)?.status, 'submitting'); assert.equal(rows.at(-1)?.providerJobId, null);
    assert(rows.at(-1)?.resultReceiptId, 'This nonce flushed before the sole provider call'); h.freeWorld();
    next = h.create(); await next.start(); await until(() => next!.listJobs()[0]?.status === 'succeeded', 'receipt binds the witnessed response to its authorized call');
    assert.equal(h.fake.submitCount, 1); assert.equal(h.fake.pollCount, 0); assert.equal(h.fetches(), 0);
    assert.equal(h.ledger.length, 1); assert.equal(h.ledger[0]!.actualMicroUsd, 37);
  } finally { await queue.dispose(); await next?.dispose(); await queue.waitForIdle(); await next?.waitForIdle(); await h.storage.stop(); }
});

it("restart recovers the verified completed remote result and its reported cost even when the provider can no longer retrieve it", { timeout: 30_000 }, async () => {
  const h = await fixture(), queue = h.create(); let next: JobQueue | undefined;
  try {
    await queue.start(); await queue.enqueue(input);
    await until(() => queue.listJobs()[0]?.error?.includes('waiting for storage') === true, 'saved result held on world volume');
    const identity = queue.listJobs()[0]!.resultReceiptId;
    await queue.dispose(); await queue.waitForIdle(); h.freeWorld();
    h.fake.onFetch = () => { throw new Error('Provider result expired; no retrieval is allowed'); };
    next = h.create(); const report = await next.start(); assert.equal(report[0]?.detail, 'resumed durable provider result');
    await until(() => next!.listJobs()[0]?.status === 'succeeded', 'receipt-only restart filing');
    assert.equal(next.listJobs()[0]!.resultReceiptId, identity); assert.equal(h.fake.submitCount, 1); assert.equal(h.fetches(), 1);
    assert.equal(h.ledger.length, 1); assert.equal(h.ledger[0]!.actualMicroUsd, 37);
  } finally { await queue.dispose(); await next?.dispose(); await queue.waitForIdle(); await next?.waitForIdle(); await h.storage.stop(); }
});

it("an inline result held before its receipt remains reconciliation-only after restart, never a synthetic poll or automatic generation", { timeout: 30_000 }, async () => {
  const h = await fixture(true, { async reserve() { throw new ArtifactStorageHeld(); } }), queue = h.create(); let next: JobQueue | undefined;
  try {
    await queue.start(); await queue.enqueue(input);
    await until(() => queue.listJobs()[0]?.error?.includes('waiting for fresh storage') === true, 'accepted inline result storage hold');
    assert.equal(queue.listJobs()[0]?.providerResultKind, 'inline'); await queue.dispose(); await queue.waitForIdle();
    next = h.create(); await next.start(); assert.equal(next.listJobs()[0]?.status, 'needs-reconciliation');
    assert.equal(h.fake.submitCount, 1); assert.equal(h.fake.pollCount, 0); assert.equal(h.fetches(), 0); assert.equal(h.ledger.length, 0);
  } finally { await queue.dispose(); await next?.dispose(); await queue.waitForIdle(); await next?.waitForIdle(); await h.storage.stop(); }
});

it("cancelling a result-storage hold preserves its complete prefix across restart without further provider or file work", { timeout: 30_000 }, async () => {
  let reserves = 0, blocked = false;
  const h = await fixture(true, { async reserve() {
    reserves++; if (blocked) throw new ArtifactStorageHeld();
    return { async consumed() { blocked = true; throw Object.assign(new Error('synthetic accounting write failure'), { code: 'ENOSPC' }); }, writeFailed() {}, async settle() {} };
  } }), queue = h.create(); let next: JobQueue | undefined;
  try {
    await queue.start(); await queue.enqueue(input);
    await until(() => blocked && queue.listJobs()[0]?.error?.includes('storage') === true, 'complete prefix retained without manifest');
    const job = queue.listJobs()[0]!, files = new ArtifactResultFiles(h.journalPath), directory = files.directory(job);
    const blob = (await readdir(directory)).find(value => value.endsWith('.bin'))!; const before = await readFile(join(directory, blob));
    await queue.cancel(job.id); await queue.dispose(); await queue.waitForIdle(); const beforeRestart = reserves;
    next = h.create(); await next.start(); assert.equal(next.listJobs()[0]?.status, 'cancelled');
    assert.deepEqual(await readFile(join(directory, blob)), before); assert.equal(reserves, beforeRestart); assert.equal(h.fake.submitCount, 1); assert.equal(h.fake.pollCount, 0);
    assert.equal(h.ledger.length, 1);
  } finally { await queue.dispose(); await next?.dispose(); await queue.waitForIdle(); await next?.waitForIdle(); await h.storage.stop(); }
});
