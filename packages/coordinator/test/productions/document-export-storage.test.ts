import assert from "node:assert/strict";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import type { AudiobookReader } from "@arke-studio/contracts";
import { exportManuscript } from "../../src/productions/manuscript.js";
import { exportScript, scriptManifestPath } from "../../src/productions/audiobook-lines.js";
import { ImportFileStorage, ImportStorageHeld, type ImportFileSpace } from "../../src/storage/import-files.js";
import { AppStorageService } from "../../src/storage/service.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { tempDir } from "../tmp.js";

const production = "the-ledger-of-nights", now = () => "2026-10-28T12:00:00.000Z";
const narrator: AudiobookReader = { provider: "kokoro", model: "kokoro-82m", voiceId: "bm_george", label: "George" };
const writers = {
  docx: (store: WorldStore, fileSpace: ImportFileSpace) => exportManuscript(store, production, "docx", { fileSpace, exportId: "ms_01J9SCRIPT00000000000ABCDEF", language: "en", now }),
  epub: (store: WorldStore, fileSpace: ImportFileSpace) => exportManuscript(store, production, "epub", { fileSpace, exportId: "ms_01J9SCRIPT00000000000ABCDEF", language: "en", now }),
  script: (store: WorldStore, fileSpace: ImportFileSpace) => exportScript(store, production, "narrator", { fileSpace, scope: "all", label: "Narrator", narrator, exportId: "01J9SCRIPT00000000000ABCDEF", now }),
};
async function fixture(fullDestination = false) {
  const dir = await makeTempWorld(), root = await tempDir("arke-document-space-"), store = await WorldStore.open(dir);
  let clock = Date.now(), roots: readonly { rootId: string; path: string }[] = [];
  const storage = new AppStorageService({ appRoot: root, now: () => clock, native: {
    setRoots(value) { roots = value; }, async stop() {}, async probe(rootId) {
      const path = roots.find(row => row.rootId === rootId)!.path;
      const final = path.endsWith("exports") && !path.endsWith(join(".cache", "exports"));
      return { state: "measured", source: "host-provided", limitations: [], capacity: { volumeId: final ? "delivery-volume" : "staging-volume",
        mappingRevision: rootId, measuredAt: ++clock, availableBytes: final && fullDestination ? 0 : 100 * 1024 ** 3, totalBytes: 200 * 1024 ** 3 } };
    },
  } });
  return { dir, store, storage, space: new ImportFileStorage(storage, "export"), close: async () => { await store.close(); await storage.stop(); } };
}

for (const [kind, write] of Object.entries(writers)) {
  it(`${kind} export admits measured output and metadata before writing, then settles all volumes`, async () => {
    const h = await fixture(), demands: Array<{ directory: string; bytes: number; consumed: number }> = [];
    const fileSpace: ImportFileSpace = { async reserve(directory, bytes, signal, role) {
      const demand = { directory, bytes, consumed: 0 }; demands.push(demand);
      const lease = await h.space.reserve(directory, bytes, signal, role);
      return { ...lease, async consumed(count) { demand.consumed += count; await lease.consumed(count); } };
    } };
    try {
      const result = await write(h.store, fileSpace), output = join(h.dir, result.output);
      assert.equal(demands.length, kind === "script" ? 3 : 2);
      assert.equal(demands[0]!.bytes, (await stat(output)).size);
      assert.equal(demands[0]!.consumed, demands[0]!.bytes);
      assert.equal(demands[1]!.bytes, 0, "rename never reserves a second payload copy");
      if (kind === "script") {
        assert.equal(demands[2]!.bytes, (await stat(join(h.dir, scriptManifestPath(production, "narrator")))).size);
        assert.equal(demands[2]!.consumed, demands[2]!.bytes);
      }
      assert.equal(h.storage.reservations.snapshot().records.length, 0);
    } finally { await h.close(); }
  });

  it(`${kind} export cannot borrow free staging space from a full destination volume`, async () => {
    const h = await fixture(true), previous = join(h.dir, "exports", "previous.txt");
    await mkdir(join(h.dir, "exports"), { recursive: true }); await writeFile(previous, "PREVIOUS_EXPORT");
    try {
      await assert.rejects(write(h.store, h.space), ImportStorageHeld);
      assert.deepEqual(await readdir(join(h.dir, ".cache", "exports")), []);
      assert.deepEqual(await readdir(join(h.dir, "exports")), ["previous.txt"]);
      assert.equal(await readFile(previous, "utf8"), "PREVIOUS_EXPORT");
      assert.equal(h.storage.reservations.snapshot().records.length, 0);
    } finally { await h.close(); }
  });
}

for (const [kind, write] of Object.entries(writers)) it(`world close during ${kind} admission drains the late lease and prevents publication`, async () => {
  const h = await fixture(); let enter!: () => void, release!: () => void, settled = 0;
  const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const fileSpace: ImportFileSpace = { async reserve() {
    enter(); await gate;
    return { async consumed() { assert.fail("No late payload"); }, writeFailed() {}, async settle() { settled++; } };
  } };
  try {
    const exporting = write(h.store, fileSpace); void exporting.catch(() => {});
    await entered; const closing = h.store.close(); assert(h.store.closingSignal.aborted);
    release(); await assert.rejects(exporting); await closing;
    assert.equal(settled, 1); assert.deepEqual(await readdir(join(h.dir, "exports")), []);
  } finally { release?.(); await h.close(); }
});
