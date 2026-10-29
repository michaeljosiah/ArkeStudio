import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdir, writeFile, readFile, symlink, link } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as pause, setImmediate as nextTurn } from "node:timers/promises";
import { StorageInventorySchema } from "@arke-studio/contracts";
import { readStorageInventory, StorageInventoryCollector, type InventoryReading } from "../../src/storage/inventory.js";
import { tempDir } from "../tmp.js";

async function until(check: () => boolean) {
  const end = Date.now() + 3000;
  while (!check()) { assert(Date.now() < end, "inventory did not settle"); await pause(5); }
}

it("measures only requested scope, classifies world files, skips links and leaves protected media untouched", async () => {
  const root = await tempDir("arke-inventory-"), world = join(root, "world");
  const files = [ ["artifacts/retired.wav", 11], ["productions/story/takes/take-a/clip.mp4", 17], ["exports/edition/output.zip", 23], [".cache/preview.wav", 7], ["world.yaml", 3] ] as const;
  for (const [name, size] of files) { const parts = name.split("/"); await mkdir(join(world, ...parts.slice(0, -1)), { recursive: true }); await writeFile(join(world, ...parts), Buffer.alloc(size, 42)); }
  const closed = join(root, "closed-world"); await mkdir(closed); await writeFile(join(closed, "private.wav"), Buffer.alloc(99));
  await symlink(closed, join(world, "linked-world"), process.platform === "win32" ? "junction" : "dir");
  await link(join(world, "artifacts", "retired.wav"), join(world, "artifacts", "shared.wav"));
  const result = await readStorageInventory({ path: world, kind: "world" }, new AbortController().signal);
  assert.equal(result.complete, false, "skipped links leave an explicitly partial inventory");
  assert.deepEqual(result.counts, { artifacts: { bytes: 22, files: 2 }, takes: { bytes: 17, files: 1 }, publications: { bytes: 23, files: 1 }, temporary: { bytes: 7, files: 1 }, other: { bytes: 3, files: 1 } });
  for (const [name, size] of files) assert.deepEqual(await readFile(join(world, ...name.split("/"))), Buffer.alloc(size, 42));
  assert.equal((await readFile(join(closed, "private.wav"))).length, 99);
});

it("resumes after bounded slices and cancellation prevents the next slice", async () => {
  const root = await tempDir("arke-inventory-slices-");
  for (let start = 0; start < 1005; start += 50) await Promise.all(Array.from({ length: Math.min(50, 1005 - start) }, (_, i) => writeFile(join(root, String(start + i)), "x")));
  let yields = 0;
  const result = await readStorageInventory({ path: root, kind: "models" }, new AbortController().signal, [], { yield: async () => { yields++; } });
  assert(yields > 0); assert.equal(result.counts.models?.bytes, 1005); assert(result.complete);
  const stop = new AbortController();
  await assert.rejects(readStorageInventory({ path: root, kind: "models" }, stop.signal, [], { yield: async () => { stop.abort(); } }), { name: "AbortError" });
});

it("excludes separately registered nested roots and distinguishes absent from unreadable roots", async () => {
  const root = await tempDir("arke-inventory-nested-"), nested = join(root, "other"); await mkdir(nested);
  await writeFile(join(root, "weights"), "weights"); await writeFile(join(nested, "preview"), "preview");
  const result = await readStorageInventory({ path: root, kind: "models" }, new AbortController().signal, [nested]);
  assert.equal(result.counts.models?.bytes, 7);
  const missing = await readStorageInventory({ path: join(root, "absent"), kind: "downloads" }, new AbortController().signal);
  assert(missing.complete); assert.equal(missing.counts.downloads?.bytes, 0);
  const invalid = await readStorageInventory({ path: join(root, "weights"), kind: "downloads" }, new AbortController().signal);
  assert(!invalid.complete); assert.deepEqual(invalid.counts, {});
});

it("publishes anonymous counts, discards a closed world's late result and stops without starting new reads", async () => {
  const root = await tempDir("arke-inventory-owner-"); let calls = 0, publish = 0;
  let finish!: (value: InventoryReading) => void;
  const collector = new StorageInventoryCollector({ changed: () => { publish++; }, read: async () => { calls++; return await new Promise(resolve => { finish = resolve; }); } });
  collector.setRoots([{ path: join(root, "private-first"), kind: "world" }]); collector.start(); await until(() => calls === 1);
  collector.setRoots([{ path: join(root, "private-next"), kind: "models" }]);
  finish({ counts: { artifacts: { bytes: 99, files: 1 } }, complete: true, at: Date.now() });
  await until(() => calls === 2); assert.equal(collector.snapshot().categories.find(row => row.category === "artifacts")!.logicalBytes, null);
  finish({ counts: { models: { bytes: 7, files: 1 } }, complete: true, at: Date.now() }); await until(() => !collector.snapshot().scanning);
  const snapshot = StorageInventorySchema.parse(collector.snapshot()); assert.equal(snapshot.categories.find(row => row.category === "models")!.logicalBytes, 7);
  assert.equal(snapshot.allocatedBytes, null); assert.equal(snapshot.reclaimableBytes, null); assert(!JSON.stringify(snapshot).includes(root)); assert(!JSON.stringify(snapshot).includes("private-"));
  collector.stop(); const stoppedAt = publish; collector.refresh(); await pause(20); assert.equal(calls, 2); assert.equal(publish, stoppedAt);
});

it("a slow filesystem call becomes unknown and keeps its read slot until the original call settles", async () => {
  const root = await tempDir("arke-inventory-timeout-"); let calls = 0;
  let finish!: (value: InventoryReading) => void;
  const collector = new StorageInventoryCollector({ changed: () => {}, timeoutMs: 10, read: async () => { calls++; return await new Promise(resolve => { finish = resolve; }); } });
  collector.setRoots([{ path: root, kind: "models" }]); collector.start(); await until(() => calls === 1); await pause(30);
  collector.refresh(); assert.equal(calls, 1); assert.equal(collector.snapshot().categories.find(row => row.category === "models")!.logicalBytes, null);
  collector.stop(); finish({ counts: { models: { bytes: 99, files: 1 } }, complete: true, at: Date.now() }); await until(() => !collector.snapshot().scanning);
  assert.equal(collector.snapshot().categories.find(row => row.category === "models")!.logicalBytes, null); assert.equal(calls, 1);
});

it("reuses producer receipts without scanning their subtree or promising reclaimable allocation", async () => {
  const root = await tempDir("arke-inventory-receipts-"), cached = join(root, "previews");
  let excluded: readonly string[] = [], calls = 0;
  const collector = new StorageInventoryCollector({ changed: () => {}, read: async (_root, _signal, skip) => {
    calls++; excluded = skip ?? []; return { counts: { temporary: { bytes: 3, files: 1 } }, complete: true, at: Date.now() };
  } });
  collector.setRoots([{ path: root, kind: "temporary" }]);
  collector.record({ path: cached, kind: "temporary" }, { counts: { temporary: { bytes: 11, files: 2 } }, complete: false, at: Date.now() });
  collector.start(); await until(() => calls === 1 && !collector.snapshot().scanning);
  assert.deepEqual(excluded, [cached]);
  let row = collector.snapshot().categories.find(row => row.category === "temporary")!;
  assert.equal(row.logicalBytes, 14); assert.equal(row.state, "partial");
  collector.record({ path: cached, kind: "temporary" }, { counts: { temporary: { bytes: 7, files: 1 } }, complete: false, at: Date.now() });
  row = collector.snapshot().categories.find(row => row.category === "temporary")!;
  assert.equal(row.logicalBytes, 10); assert.equal(row.files, 2); assert.equal(calls, 1); collector.stop();
});

it("a large scan may exceed the stall deadline while metadata keeps progressing", async context => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let progress!: () => void, finish!: (value: InventoryReading) => void, signal!: AbortSignal;
  const collector = new StorageInventoryCollector({ changed: () => {}, timeoutMs: 100, read: async (_root, current, _excluded, ports) => {
    signal = current; progress = ports!.progress!;
    return await new Promise(resolve => { finish = resolve; });
  } });
  context.after(() => collector.stop());
  collector.setRoots([{ path: join(process.cwd(), "inventory-progress-fixture"), kind: "models" }]);
  collector.start(); context.mock.timers.tick(1);
  for (let step = 0; step < 10; step++) { context.mock.timers.tick(50); progress(); }
  assert.equal(signal.aborted, false);
  finish({ counts: { models: { bytes: 42, files: 1 } }, complete: true, at: Date.now() });
  await nextTurn();
  assert.equal(collector.snapshot().categories.find(row => row.category === "models")!.logicalBytes, 42);
  assert.equal(collector.snapshot().scanning, false);
});
