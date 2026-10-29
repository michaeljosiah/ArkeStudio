import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import { exportWorld } from "../../src/takes/export.js";
import { ImportFileStorage, ImportStorageHeld, type ImportFileSpace } from "../../src/storage/import-files.js";
import { JobArtifactStorage } from "../../src/storage/job-artifacts.js";
import { AppStorageService } from "../../src/storage/service.js";
import { tempDir } from "../tmp.js";

async function fixture() {
  const root = await tempDir("arke-export-space-"), source = join(root, "source"), target = join(root, "exports", "world");
  await mkdir(join(source, ".history"), { recursive: true });
  await mkdir(join(source, ".cache")); await mkdir(join(source, "empty"));
  await writeFile(join(source, "world.json"), "CREATIVE_WORLD");
  await writeFile(join(source, ".history", "retained.json"), "HISTORY");
  await writeFile(join(source, ".cache", "preview"), "NOT_EXPORTED");
  return { root, source, target };
}

it("plans the whole export before payload writes, keeps history and settles after copies close", async () => {
  const { root, source } = await fixture(), consumed: number[] = [], alias = join(root, "destination-alias");
  await mkdir(join(root, "exports"));
  await symlink(join(root, "exports"), alias, process.platform === "win32" ? "junction" : "dir");
  const target = join(alias, "world");
  let settled = false;
  const fileSpace: ImportFileSpace = { async reserve(directory, bytes, signal, role) {
    assert.equal(directory, await realpath(target)); assert.equal(role, "exports"); assert(!signal.aborted);
    assert.equal(bytes, Buffer.byteLength("CREATIVE_WORLDHISTORY") + 4 * 64 * 1024);
    assert.deepEqual(await readdir(target), []);
    return { async consumed(bytes) { consumed.push(bytes); }, writeFailed() { assert.fail("No write failed"); }, async settle() {
      settled = true; assert.equal(await readFile(join(target, ".history", "retained.json"), "utf8"), "HISTORY");
    } };
  } };
  await exportWorld(source, target, { fileSpace });
  assert(settled); assert.equal(consumed.reduce((a, b) => a + b, 0), Buffer.byteLength("CREATIVE_WORLDHISTORY"));
  assert(existsSync(join(target, "empty"))); assert(!existsSync(join(target, ".cache")));
  assert.equal(await readFile(join(source, "world.json"), "utf8"), "CREATIVE_WORLD");
});

it("a full destination holds the export against a competing job without copying payload", async () => {
  const { root, source, target } = await fixture(), GiB = 1024 ** 3;
  let clock = Date.now();
  const storage = new AppStorageService({ appRoot: root, now: () => clock, native: {
    setRoots() {}, async stop() {}, async probe(rootId) { return { state: "measured", source: "host-provided", limitations: [],
      capacity: { volumeId: "destination", mappingRevision: rootId, measuredAt: ++clock, availableBytes: GiB + 1024 * 1024, totalBytes: 100 * GiB } }; },
  } });
  const jobs = new JobArtifactStorage(storage), exports = new ImportFileStorage(storage, "export");
  const competing = await jobs.reserve("other_job", [{ directory: join(root, "landing"), role: "generated-media", remainingBytes: 900 * 1024 }], new AbortController().signal);
  try {
    await assert.rejects(exportWorld(source, target, { fileSpace: exports }), ImportStorageHeld);
    assert.deepEqual(await readdir(target), []); assert.equal(storage.reservations.snapshot().records.length, 1);
    assert.equal(await readFile(join(source, "world.json"), "utf8"), "CREATIVE_WORLD");
    await competing.settle(); clock += 5001;
    await exportWorld(source, join(root, "exports", "retry"), { fileSpace: exports });
    assert.equal(storage.reservations.snapshot().records.length, 0);
  } finally { await competing.settle(); await storage.stop(); }
});

it("cancellation during admission closes the late lease without writing a payload", async () => {
  const { source, target } = await fixture(), controller = new AbortController(); let settled = 0;
  const fileSpace: ImportFileSpace = { async reserve() {
    controller.abort();
    return { async consumed() { assert.fail("No bytes after cancellation"); }, writeFailed() {}, async settle() { settled++; } };
  } };
  await assert.rejects(exportWorld(source, target, { fileSpace, signal: controller.signal }));
  assert.deepEqual(await readdir(target), []); assert.equal(settled, 1);
});

it("source growth during admission cannot consume the old export budget", async () => {
  const { source, target } = await fixture(); let settled = 0;
  const fileSpace: ImportFileSpace = { async reserve() {
    await writeFile(join(source, "world.json"), "A_LARGER_CREATIVE_WORLD");
    return { async consumed() {}, writeFailed() {}, async settle() { settled++; } };
  } };
  await assert.rejects(exportWorld(source, target, { fileSpace }), /source world changed/);
  assert(!existsSync(join(target, "world.json"))); assert.equal(settled, 1);
  assert.equal(await readFile(join(source, "world.json"), "utf8"), "A_LARGER_CREATIVE_WORLD");
});

it("failed accounting preserves copied files and the source, and retry never overwrites the partial export", async () => {
  const { source, target } = await fixture(); let settled = 0;
  const fileSpace: ImportFileSpace = { async reserve() { return {
    async consumed() { throw new Error("accounting unavailable"); }, writeFailed() {}, async settle() { settled++; },
  }; } };
  await assert.rejects(exportWorld(source, target, { fileSpace }), /accounting unavailable/);
  assert.equal(settled, 1); assert.equal(await readFile(join(target, "world.json"), "utf8"), "CREATIVE_WORLD");
  await assert.rejects(exportWorld(source, target), /export already exists/);
  assert.equal(await readFile(join(source, "world.json"), "utf8"), "CREATIVE_WORLD");
  assert.equal(await readFile(join(target, "world.json"), "utf8"), "CREATIVE_WORLD");
});

it("a nested destination is rejected before creating anything in the source world", async () => {
  const { source } = await fixture();
  await assert.rejects(exportWorld(source, join(source, "new-parent", "copy")), /outside the source world/);
  assert(!existsSync(join(source, "new-parent")));
});

it("linked source directories are not copied as portable world content", async () => {
  const { root, source, target } = await fixture(), outside = join(root, "outside");
  await mkdir(outside); await writeFile(join(outside, "private.txt"), "OUTSIDE_CONTENT");
  await symlink(outside, join(source, "linked"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(exportWorld(source, target), /linked or special files/);
  assert(!existsSync(target)); assert.equal(await readFile(join(outside, "private.txt"), "utf8"), "OUTSIDE_CONTENT");
});

it("a destination reached through a source alias is rejected before making nested directories", async () => {
  const { root, source } = await fixture(), alias = join(root, "alias");
  await symlink(source, alias, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(exportWorld(source, join(alias, "new-parent", "copy")), /outside the source world/);
  assert(!existsSync(join(source, "new-parent")));
});
