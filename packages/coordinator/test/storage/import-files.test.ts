import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import { AppStorageService } from "../../src/storage/service.js";
import { ImportFileStorage, ImportStorageHeld, type ImportFileSpace } from "../../src/storage/import-files.js";
import { JobArtifactStorage } from "../../src/storage/job-artifacts.js";
import { fileArtifact, retireArtifact } from "../../src/artifacts/filing.js";
import { BrowserMediaImports } from "../../src/artifacts/browser-media-import.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { tempDir } from "../tmp.js";
import { until } from "../wait.js";

const GiB = 1024 ** 3, MiB = 1024 ** 2;
function fixture(root: string, world: string) {
  let clock = Date.now(), free = GiB + 3 * MiB, unavailable = false, roots: readonly { rootId: string; path: string }[] = [];
  const storage = new AppStorageService({ appRoot: root, now: () => clock, native: {
    setRoots(value) { roots = value; }, async stop() {}, async probe(rootId) {
      const isWorld = roots.find(value => value.rootId === rootId)!.path.startsWith(world);
      if (unavailable && isWorld) return { state: "unavailable", source: "host-provided", limitations: ["probe-failed"], capacity: null };
      return { state: "measured", source: "host-provided", limitations: [], capacity: { volumeId: isWorld ? "world-volume" : "spool-volume", mappingRevision: rootId,
        measuredAt: ++clock, availableBytes: isWorld ? free : 100 * GiB, totalBytes: 200 * GiB } };
    },
  } });
  return { storage, space: new ImportFileStorage(storage), advance() { clock += 5001; }, full() { free = 0; clock += 5001; }, unknown() { unavailable = true; clock += 5001; } };
}
async function open() {
  const root = await tempDir("arke-import-space-"), world = await makeTempWorld(), store = await WorldStore.open(world);
  const h = fixture(root, world); return { ...h, root, world, store, initialArtifacts: store.getBundle().artifacts.length };
}

it("a known import competes with result/setup reservations on its actual volume before copying", async () => {
  const h = await open(), source = join(h.root, "selected.bin"), bytes = new Uint8Array(2 * MiB).fill(7);
  await writeFile(source, bytes); const jobs = new JobArtifactStorage(h.storage);
  let competing: Awaited<ReturnType<JobArtifactStorage["reserve"]>> | undefined;
  try {
    competing = await jobs.reserve("competing_job", [{ directory: join(h.world, "artifacts"), role: "generated-media", remainingBytes: 2 * MiB }], h.store.closingSignal);
    const held = await fileArtifact(h.store, { sourcePath: source, importSpace: h.space });
    assert.equal(held.outcome, "refused"); if (held.outcome === "refused") assert.match(held.reason, /already committed/);
    assert.equal(h.store.getBundle().artifacts.length, h.initialArtifacts); assert(!existsSync(join(h.world, "artifacts", "selected.bin")));
    assert.deepEqual(await readFile(source), Buffer.from(bytes)); assert.equal(h.storage.reservations.snapshot().records.length, 1);
    await competing.settle(); h.advance();
    const filed = await fileArtifact(h.store, { sourcePath: source, importSpace: h.space }); assert.equal(filed.outcome, "filed");
    assert.deepEqual(await readFile(join(h.world, "artifacts", "selected.bin")), Buffer.from(bytes));
    assert.equal(h.storage.reservations.snapshot().records.length, 0); assert(!JSON.stringify(h.storage.snapshot()).includes(source));
  } finally { await competing?.settle(); await h.store.close(); await h.storage.stop(); }
});
it("a full or unknown world refuses new payload despite a roomy spool and preserves duplicate creative bytes", async () => {
  const h = await open(), source = join(h.root, "original.txt"); await writeFile(source, "KEEP_CREATIVE_BYTES");
  try {
    const original = await fileArtifact(h.store, { sourcePath: source, importSpace: h.space }); assert.equal(original.outcome, "filed"); if (original.outcome !== "filed") return;
    await retireArtifact(h.store, original.artifact.id); h.full();
    const duplicate = await fileArtifact(h.store, { sourcePath: source, importSpace: h.space }); assert.equal(duplicate.outcome, "deduplicated");
    if (duplicate.outcome === "deduplicated") { assert.equal(duplicate.artifact.id, original.artifact.id); assert.equal(duplicate.artifact.retiredAt, undefined); }
    const other = join(h.root, "new.txt"); await writeFile(other, "DIFFERENT_BYTES");
    const full = await fileArtifact(h.store, { sourcePath: other, importSpace: h.space }); assert.equal(full.outcome, "refused");
    h.unknown(); const unknown = await fileArtifact(h.store, { sourcePath: other, importSpace: h.space }); assert.equal(unknown.outcome, "refused");
    assert(!existsSync(join(h.world, "artifacts", "new.txt"))); assert.equal(await readFile(join(h.world, "artifacts", "original.txt"), "utf8"), "KEEP_CREATIVE_BYTES");
    assert.equal(h.storage.reservations.snapshot().records.length, 0);
  } finally { await h.store.close(); await h.storage.stop(); }
});
it("failed accounting after a payload write retains its valid copy and original source", async () => {
  const h = await open(), source = join(h.root, "retained.txt"); await writeFile(source, "VALID_IMPORTED_BYTES"); let failed = 0, settled = 0;
  const space: ImportFileSpace = { async reserve(_directory, size) { assert.equal(size, Buffer.byteLength("VALID_IMPORTED_BYTES"));
    return { async consumed() { throw new ImportStorageHeld(); }, writeFailed() { failed++; }, async settle() { settled++; } }; } };
  try {
    await assert.rejects(fileArtifact(h.store, { sourcePath: source, importSpace: space }), ImportStorageHeld);
    assert.equal(failed, 1); assert.equal(settled, 1); assert.equal(await readFile(source, "utf8"), "VALID_IMPORTED_BYTES");
    assert.equal(await readFile(join(h.world, "artifacts", "retained.txt"), "utf8"), "VALID_IMPORTED_BYTES");
    assert(!existsSync(join(h.world, "artifacts", "retained.txt.json"))); assert.equal(h.store.getBundle().artifacts.length, h.initialArtifacts);
  } finally { await h.store.close(); await h.storage.stop(); }
});
it("world close during admission refuses late payload writes and drains the original lease", async () => {
  const h = await open(), source = join(h.root, "late.txt"); await writeFile(source, "MUST_NOT_COPY");
  let release!: () => void, entered = false, settled = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const space: ImportFileSpace = { async reserve() { entered = true; await gate; return { async consumed() { assert.fail("No late copy"); }, writeFailed() {}, async settle() { settled++; } }; } };
  try {
    const stopped = assert.rejects(fileArtifact(h.store, { sourcePath: source, importSpace: space })); await until(() => entered, "the original import admission is pending");
    const closing = h.store.close(); assert(h.store.closingSignal.aborted); release(); await stopped; await closing;
    assert.equal(settled, 1); assert(!existsSync(join(h.world, "artifacts", "late.txt"))); assert.equal(await readFile(source, "utf8"), "MUST_NOT_COPY");
  } finally { release(); await h.store.close(); await h.storage.stop(); }
});
it("browser spool admission retains its original owner through cancellation without late payload or consume", async () => {
  let release!: () => void, directory = "", settled = 0;
  const gate = new Promise<void>(resolve => { release = resolve; }), abort = new AbortController();
  const imports = new BrowserMediaImports({ async reserve(path, bytes, signal, role) {
    directory = path; assert.equal(bytes, 1); assert.equal(signal, abort.signal); assert.equal(role, "working-files"); await gate;
    return { async consumed() { assert.fail("No late spool write"); }, writeFailed() {}, async settle() { settled++; } };
  } });
  const files = [{ name: "private.txt", data: "YQ==" }];
  try {
    const stopped = assert.rejects(imports.run(files, () => false, async () => assert.fail("No late consumer"), abort.signal));
    await until(() => !!directory, "the original spool reservation is pending"); abort.abort();
    await assert.rejects(imports.run(files, () => false, async () => {}), /Another browser import/);
    assert.deepEqual(await readdir(directory), []); release(); await stopped;
    assert.equal(settled, 1); assert(!existsSync(directory));
  } finally { release(); }
});
it("restart reconciles only this finite import port after real host exit and never deletes retained bytes", { timeout: 30_000 }, async () => {
  const root = await tempDir("arke-import-restart-"), world = join(root, "artifacts");
  await new Promise<void>((resolve, reject) => execFile(process.execPath, ["--import", "tsx", join(import.meta.dirname, "../fixtures/import-storage-exit.ts"), root],
    { windowsHide: true, timeout: 20_000, maxBuffer: 4096 }, error => error ? reject(error) : resolve()));
  const h = fixture(root, world);
  try {
    await h.storage.start(); assert.equal(h.storage.reservations.snapshot().records.length, 2);
    await h.space.reconcileIdleImports();
    assert.deepEqual(h.storage.reservations.snapshot().records.map(record => record.owner.id), ["unrelated_import"]);
    assert.equal(await readFile(join(world, "retained.bin"), "utf8"), "KEEP_AFTER_RESTART");
    assert(await h.storage.reservations.settle("unrelated_import", { kind: "import", id: "unrelated_import" }), "only the separate fixture owner may settle its unrelated intent");
    const lease = await h.space.reserve(world, 1024, new AbortController().signal);
    await new ImportFileStorage(h.storage).reconcileIdleImports();
    assert.equal(h.storage.reservations.snapshot().records.length, 1, "another instance cannot reconcile this host's live lease");
    await lease.settle();
  } finally { await h.storage.stop(); }
});
