import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import { AppStorageService } from "../../src/storage/service.js";
import { mingCacheBytes, MingBatchStorage, type MingBatchSpaceLease } from "../../src/storage/ming-batches.js";
import { tempDir } from "../tmp.js";
import { until } from "../wait.js";
import { MingProcess } from "../../src/local-ai/ming.js";

const GiB = 1024 ** 3, ownerId = `ming_123_100000_${"a".repeat(64)}`;
async function fixture(options: {separate?: boolean; cacheBytes?: typeof mingCacheBytes} = {}) {
  const root = await tempDir("ming-storage-"), staging = join(root, "staging"), cache = join(root, "cache");
  let clock = 0, free = 100 * GiB, roots: readonly {rootId: string; path: string}[] = [];
  const storage = new AppStorageService({appRoot: root, now: () => Date.now() + clock, native: {
    setRoots(value) { roots = value; }, async stop() {}, async probe(rootId) {
      const cached = roots.find(root => root.rootId === rootId)?.path === cache;
      return {state: "measured", source: "host-provided", limitations: [], capacity: {volumeId: options.separate && cached ? "cache" : "shared", mappingRevision: rootId,
        measuredAt: Date.now() + clock, availableBytes: options.separate && !cached ? 100 * GiB : free, totalBytes: 200 * GiB}};
    },
  }});
  const space = new MingBatchStorage(storage, ownerId, {cacheGrowthBytes: 100, cacheBytes: options.cacheBytes, intervalMs: 5, ownerSettled: async () => false});
  return {root, staging, cache, storage, space, capacity(bytes: number) { free = bytes; clock += 5001; }, advance() { clock += 5001; }};
}

it("Ming shares one measured volume with other owners and reduces confirmed host input writes", async () => {
  const h = await fixture(); let lease: MingBatchSpaceLease | undefined;
  try {
    lease = await h.space.reserve(h.staging, h.cache, 1000, new AbortController().signal);
    const record = h.storage.reservations.snapshot().records[0]!;
    assert.equal(record.demands.length, 2); assert(record.demands.every(d => d.volumeId === "shared"));
    assert(!JSON.stringify(h.storage.snapshot()).includes(ownerId), "native owner identity stays out of UI diagnostics");
    await lease.consumed(200); assert.equal(h.storage.reservations.snapshot().records[0]!.demands[0]!.remainingBytes, 800);
    h.capacity(GiB + 1000 + 32 * 1024 ** 2 + 65536 + 100);
    const other = await h.storage.reservations.reserve({id: "competing", owner: {kind: "job", id: "other"}, demands: [{rootId: record.demands[0]!.rootId, remainingBytes: 500}]});
    assert.equal(other.status, "held");
    await lease.settle(); assert.equal(h.storage.reservations.snapshot().records.length, 0);
  } finally { await lease?.settle(); await h.storage.stop(); }
});

it("a full cache volume refuses Ming despite a roomy staging volume, before native admission", async () => {
  const h = await fixture({separate: true});
  try {
    h.capacity(GiB);
    await assert.rejects(h.space.reserve(h.staging, h.cache, 1000, new AbortController().signal), /Ming narration is waiting for storage/);
    assert.equal(h.storage.reservations.snapshot().records.length, 0);
  } finally { await h.storage.stop(); }
});

it("native admission rechecks capacity after a GPU wait and releases no unknown native reservation", async () => {
  const h = await fixture(); let lease: MingBatchSpaceLease | undefined;
  try {
    lease = await h.space.reserve(h.staging, h.cache, 1000, new AbortController().signal);
    h.capacity(GiB); await assert.rejects(lease.start(new AbortController().signal), /waiting for storage/);
    await lease.uncertain();
    assert.equal(h.storage.reservations.snapshot().records[0]!.state, "uncertain");
    h.capacity(100 * GiB);
    const record = h.storage.reservations.snapshot().records[0]!;
    const other = await h.storage.reservations.reserve({id: "other", owner: {kind: "job", id: "other"}, demands: [{rootId: record.demands[0]!.rootId, remainingBytes: 1}]});
    assert.equal(other.status, "held"); if (other.status === "held") assert.equal(other.reason, "reconciliation-required");
    await lease.settle(); assert.equal(h.storage.reservations.snapshot().records.length, 0);
  } finally { await lease?.settle(); await h.storage.stop(); }
});

it("monitored growth cancels only the owning batch and retains its disk reservation until settlement", async () => {
  let observed = 1000;
  const h = await fixture({cacheBytes: async () => observed}); let lease: MingBatchSpaceLease | undefined;
  try {
    lease = await h.space.reserve(h.staging, h.cache, 1000, new AbortController().signal); h.advance();
    const signal = await lease.start(new AbortController().signal);
    assert(!signal.aborted); observed = 1101;
    await until(() => signal.aborted, "cache growth cancellation", 1000);
    assert.match(String(signal.reason), /planned growth/);
    assert.equal(h.storage.reservations.snapshot().records.length, 1);
    await lease.stop(); assert.equal(h.storage.reservations.snapshot().records.length, 1);
    await lease.settle(); assert.equal(h.storage.reservations.snapshot().records.length, 0);
  } finally { await lease?.settle(); await h.storage.stop(); }
});

it("reconciliation keeps unknown original owners and clears proven settled reservations without deleting retained files", async () => {
  const root = await tempDir("ming-reconcile-"), retained = join(root, "retained.wav");
  await writeFile(retained, "retained result");
  const records = [{id: "ming_batch_00000000-0000-0000-0000-000000000000", owner: {kind: "scratch", id: ownerId}, state: "active", demands: [{rootId: "old", volumeId: "old-volume", mappingRevision: "old", remainingBytes: 100, reserveBytes: GiB}]}];
  const storage = new AppStorageService({appRoot: root, native: {setRoots() {}, async stop() {}, async probe() {return {state: "unavailable", source: "host-provided", limitations: ["probe-failed"], capacity: null};}},
    store: {async load() { return {version: 1, records}; }, async save() {}}});
  let confirmed = false;
  const space = new MingBatchStorage(storage, ownerId, {ownerSettled: async () => confirmed});
  try {
    await space.reconcile(new AbortController().signal); assert.equal(storage.reservations.snapshot().records[0]!.state, "uncertain");
    confirmed = true; await space.reconcile(new AbortController().signal); assert.equal(storage.reservations.snapshot().records.length, 0);
    assert.equal(await readFile(retained, "utf8"), "retained result");
  } finally { await storage.stop(); }
});

it("cache observation reads only scoped file metadata and honours cancellation", async () => {
  const root = await tempDir("ming-cache-size-"); await mkdir(join(root, "compiler"));
  await writeFile(join(root, "compiler", "module.bin"), Buffer.alloc(123)); await writeFile(join(root, "worker.log"), "abc");
  assert.equal(await mingCacheBytes(root, new AbortController().signal), 126);
  await assert.rejects(mingCacheBytes(root, AbortSignal.abort()));
});

it("stopping an abandoned cache measurement retains its original scan and reservation until the scan settles", async () => {
  let calls = 0, finish!: (value: number) => void;
  const pending = new Promise<number>(resolve => { finish = resolve; });
  const h = await fixture({cacheBytes: async () => ++calls === 1 ? 0 : pending}); let lease: MingBatchSpaceLease | undefined;
  try {
    lease = await h.space.reserve(h.staging, h.cache, 1000, new AbortController().signal); h.advance();
    await lease.start(new AbortController().signal); await until(() => calls === 2, "pending cache read", 1000);
    let settled = false;
    const stopping = lease.settle().then(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve)); assert(!settled); assert.equal(h.storage.reservations.snapshot().records.length, 1);
    finish(0); await stopping; assert.equal(calls, 2); assert.equal(h.storage.reservations.snapshot().records.length, 0);
  } finally { finish(0); await lease?.settle(); await h.storage.stop(); }
});

it("cache growth stops the real owning worker before its disk reservation can be released", {timeout: 90_000}, async () => {
  const h = await fixture(), worker = join(h.root, "worker.mjs"), marker = join(h.root, "pid");
  await writeFile(worker, `import {writeFileSync,appendFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},String(process.pid));let n=0;setInterval(()=>{if(n++<8)appendFileSync('compiler.bin',Buffer.alloc(64));},10);`);
  const owner = new MingProcess(undefined, {prepareCommand: (command, args) => ({command, args: args.slice(1)})});
  let lease: MingBatchSpaceLease | undefined;
  try {
    lease = await h.space.reserve(h.staging, h.cache, 1000, new AbortController().signal); h.advance();
    await assert.rejects(owner.run({python: process.execPath, worker, args: [], cacheRoot: h.cache, storage: lease,
      retain: () => async () => { await lease!.stop(); }}, new AbortController().signal), /planned growth/);
    const pid = Number(await readFile(marker, "utf8")); assert.throws(() => process.kill(pid, 0));
    assert(!owner.running); assert.equal(h.storage.reservations.snapshot().records.length, 1);
    await lease.settle(); assert.equal(h.storage.reservations.snapshot().records.length, 0);
  } finally { await owner.dispose(); await lease?.settle(); await h.storage.stop(); }
});
