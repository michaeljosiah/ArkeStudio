import assert from "node:assert/strict";
import { join } from "node:path";
import { it } from "node:test";
import { AppStorageService } from "../../src/storage/service.js";
import { ImportFileStorage, ImportStorageHeld } from "../../src/storage/import-files.js";
import type { StorageReservation, StorageConsumption } from "../../src/storage/reservations.js";
import { tempDir } from "../tmp.js";
import { until } from "../wait.js";

const GiB = 1024 ** 3, MiB = 1024 ** 2;
async function fixture() {
  const root = await tempDir("arke-import-batch-");
  let saved: unknown = { version: 2, records: [], consumed: [] }, writes = 0, block = false, entered = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const storage = new AppStorageService({ appRoot: root, store: { async load() { return structuredClone(saved); },
    async save(records: readonly StorageReservation[], consumed: readonly StorageConsumption[]) {
      writes++; if (block) { entered = true; await gate; } saved = structuredClone({ version: 2, records, consumed });
    } }, native: { setRoots() {}, async stop() {}, async probe(rootId) {
      return { state: "measured", source: "host-provided", limitations: [], capacity: { volumeId: "shared-volume", mappingRevision: rootId,
        measuredAt: Date.now(), availableBytes: GiB + 4 * MiB + 128 * 1024, totalBytes: 100 * GiB } };
    } } });
  return { root, storage, space: new ImportFileStorage(storage), block() { block = true; }, entered: () => entered, release, writes: () => writes };
}
it("a batch uses one shared reservation and refuses changed destinations, roles and payload budgets", async () => {
  const h = await fixture(), directory = join(h.root, "artifacts"), signal = new AbortController().signal;
  const batch = await h.space.reserveBatch(directory, 4 * MiB, 2, signal);
  try {
    assert.equal(h.storage.reservations.snapshot().records.length, 1);
    await assert.rejects(batch.space.reserve(join(h.root, "other"), MiB, signal), ImportStorageHeld);
    await assert.rejects(batch.space.reserve(directory, MiB, signal, "working-files"), ImportStorageHeld);
    await assert.rejects(batch.space.reserve(directory, 5 * MiB, signal), ImportStorageHeld);
    const first = await batch.space.reserve(directory, 2 * MiB, signal);
    await assert.rejects(batch.space.reserve(directory, MiB, signal), ImportStorageHeld);
    assert.equal(h.storage.reservations.snapshot().records.length, 1, "child filing cannot reserve its parent's bytes a second time");
    await first.consumed(2 * MiB); await first.settle();
    const second = await batch.space.reserve(directory, 2 * MiB, signal); await second.consumed(2 * MiB); await second.settle();
    await assert.rejects(batch.space.reserve(directory, 1, signal), ImportStorageHeld);
  } finally { await batch.settle(); await h.storage.stop(); }
  assert.equal(h.storage.reservations.snapshot().records.length, 0);
});
it("closing a batch retains its original child write until that child confirms settlement", async () => {
  const h = await fixture(), directory = join(h.root, "artifacts"), signal = new AbortController().signal;
  const batch = await h.space.reserveBatch(directory, MiB, 1, signal), child = await batch.space.reserve(directory, MiB, signal);
  try {
    let closed = false; const closing = batch.settle().then(() => { closed = true; });
    await new Promise<void>(resolve => setImmediate(resolve)); assert(!closed); assert.equal(h.storage.reservations.snapshot().records.length, 1);
    await assert.rejects(batch.space.reserve(directory, 0, signal), ImportStorageHeld);
    await child.consumed(MiB); await child.settle(); await closing; assert(closed);
    assert.equal(h.storage.reservations.snapshot().records.length, 0);
  } finally { await child.settle(); await batch.settle(); await h.storage.stop(); }
});
it("cancelled batch revalidation cannot grant a late child or release an unfinished original flush", async () => {
  const h = await fixture(), directory = join(h.root, "artifacts"), abort = new AbortController();
  const batch = await h.space.reserveBatch(directory, MiB, 1, abort.signal);
  try {
    h.block(); const refused = assert.rejects(batch.space.reserve(directory, MiB, abort.signal), ImportStorageHeld);
    await until(h.entered, "the original per-copy admission flush is pending"); abort.abort();
    let closed = false; const closing = batch.settle().then(() => { closed = true; });
    await new Promise<void>(resolve => setImmediate(resolve)); assert(!closed);
    await new ImportFileStorage(h.storage).reconcileIdleImports(); assert.equal(h.storage.reservations.snapshot().records.length, 1);
    h.release(); await refused; await closing; assert.equal(h.storage.reservations.snapshot().records.length, 0);
  } finally { h.release(); await batch.settle(); await h.storage.stop(); }
});
it("a reported empty copy still spends its planned file slot", async () => {
  const h = await fixture(), directory = join(h.root, "artifacts"), signal = new AbortController().signal;
  const batch = await h.space.reserveBatch(directory, 0, 1, signal);
  try {
    const child = await batch.space.reserve(directory, 0, signal); await child.consumed(0); await child.settle();
    await assert.rejects(batch.space.reserve(directory, 0, signal), ImportStorageHeld);
  } finally { await batch.settle(); await h.storage.stop(); }
});
