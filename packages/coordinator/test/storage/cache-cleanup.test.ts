import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import { CACHE_CLEANUP_POLICY } from "@arke-studio/contracts";
import { CacheCleanupControl, type CacheCleanupStore } from "../../src/storage/cache-cleanup-control.js";
import { LocalPreviewCache } from "../../src/storage/local-preview-cache.js";
import { windowsCacheFiles, type WindowsCacheFileResult, type WindowsCacheProof } from "../../src/storage/windows-cache-file.js";
import { tempDir } from "../tmp.js";
import { AppStorageService } from "../../src/storage/service.js";
import type { ProcessProbe } from "../../src/child-ledger.js";

const key = "a".repeat(64), planId = "b".repeat(64), bytes = Buffer.from("RIFF fixed local audition fixture");
const hash = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const signal = () => new AbortController().signal;
async function fixture(options: { real?: boolean; store?: CacheCleanupStore; capacity?: { available: number } } = {}) {
  const root = await tempDir("arke-reviewed-cleanup-"), controlPath = join(root, "control.json"), started = Date.now(); let clock = started, deletes = 0;
  const now = () => clock + Date.now() - started;
  let unknown = false, unknownRemoved = false, afterDelete: (() => void | Promise<void>) | undefined;
  const control = new CacheCleanupControl(controlPath, { now, store: options.store });
  const native: typeof windowsCacheFiles = async (input, abort, admitWorker) => {
    if (input.mode === "remove") {
      deletes++;
      if (!options.store) {
        const disk = JSON.parse(await readFile(controlPath, "utf8"));
        assert.equal(disk.pending?.phase, "intended", "durable intent precedes the native mutation");
        assert.equal(disk.pending?.key, input.items[0]?.key);
      }
      if (unknown) return input.items.map(row => ({ key: row.key, state: "unknown", reason: "native" }));
    }
    if (options.real) {
      const result = await windowsCacheFiles(input, abort, admitWorker);
      return result.map(row => row.state === "measured" || row.state === "removed" ? { ...row, proof: { ...row.proof, observedAt: now() } } : row.state === "absent" ? { ...row, observedAt: now() } : row);
    }
    const result: WindowsCacheFileResult[] = [];
    for (const row of input.items) {
      const path = join(input.root, `${row.key}.wav`);
      const directory = await lstat(input.root, { bigint: true });
      const rootIdentity = hash(JSON.stringify([(await realpath(input.root)), String(directory.dev), String(directory.ino), String(directory.birthtimeNs)]));
      const nodeRootIdentity = process.platform === "win32" ? hash(JSON.stringify([(await realpath(input.root)).toLowerCase(), String(directory.dev), String(directory.ino), String(directory.birthtimeNs)])) : rootIdentity;
      let file;
      try { file = await lstat(path, { bigint: true }); } catch (error) {
        if (input.mode !== "reconcile" || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        result.push({ key: row.key, state: "absent", rootIdentity: hash("native-root" + rootIdentity), nodeRootIdentity, observedAt: now() }); continue;
      }
      const body = await readFile(path);
      const fileIdentity = hash(JSON.stringify([String(file.dev), String(file.ino), String(file.birthtimeNs)]));
      const proof: WindowsCacheProof = { nodeRootIdentity,
        nodeFileIdentity: fileIdentity, rootIdentity: hash("native-root" + rootIdentity), fileIdentity: hash("native-file" + fileIdentity),
        modifiedNs: String(file.mtimeNs), writeTicks: String(file.mtimeNs), contentHash: hash(body), bytes: body.length,
        allocatedBytes: Number(file.blocks * 512n), observedAt: now() };
      if (input.mode === "remove") { await unlink(path); await afterDelete?.(); }
      result.push(input.mode === "remove" && unknownRemoved ? { key: row.key, state: "unknown", reason: "native" }
        : { key: row.key, state: input.mode === "remove" ? "removed" : "measured", proof });
    }
    return result;
  };
  const storage = options.capacity ? new AppStorageService({ appRoot: root, now, native: {
    setRoots: () => {}, stop: async () => {}, probe: async (rootId, _signal, after) => {
      clock = Math.max(clock + 1, (after ?? 0) + 1 - (Date.now() - started));
      return { state: "measured", source: "host-provided", limitations: [], capacity: { volumeId: "cleanup-volume",
        mappingRevision: rootId, measuredAt: now(), availableBytes: options.capacity!.available, totalBytes: 100 * 1024 ** 3 } };
    },
  } }) : undefined;
  const cache = new LocalPreviewCache(root, storage, { control, native, now, platform: "win32" });
  await control.open(); await cache.generate(key, async () => bytes, signal());
  return { root, controlPath, control, cache, storage, path: join(root, "local-presets-v1", `${key}.wav`),
    age: () => { clock += CACHE_CLEANUP_POLICY.minAgeMs + 60_000; }, deletes: () => deletes,
    native, now, unknown: () => { unknown = true; }, unknownRemoved: () => { unknownRemoved = true; },
    afterDelete: (fn: () => void | Promise<void>) => { afterDelete = fn; } };
}

it("bounds eligible targets and never prepares recent, unlisted or actively read previews", async () => {
  const h = await fixture();
  assert.equal(await h.cache.prepareCleanup(new Set([key]), signal()), null);
  h.age(); assert.equal(await h.cache.prepareCleanup(new Set(), signal()), null);
  const reader = await h.cache.serve(key); assert(reader?.release);
  assert.equal(await h.cache.prepareCleanup(new Set([key]), signal()), null); reader.release();
  const keys = new Set([key]);
  for (let i = 1; i <= 8; i++) { const id = i.toString(16).repeat(64); keys.add(id); await h.cache.generate(id, async () => bytes, signal()); }
  h.age(); const prepared = await h.cache.prepareCleanup(keys, signal()); assert(prepared);
  assert.equal(prepared.files, 8); assert.equal(h.deletes(), 0); h.cache.close(); h.control.closeAdmission();
});

it("preview deletes nothing; approved execution flushes intent and retires only matching receipts", async () => {
  const h = await fixture(); h.age(); const prepared = await h.cache.prepareCleanup(new Set([key]), signal()); assert(prepared);
  assert.deepEqual(await readFile(h.path), bytes); assert.equal(h.deletes(), 0);
  await assert.rejects(readFile(h.controlPath), { code: "ENOENT" });
  const result = await prepared.run(planId, signal(), () => true);
  assert.equal(result.status, "verified"); assert.equal(result.cleanup.removedFiles, 1); assert.equal(result.cleanup.reclaimedBytes, null);
  assert.equal(result.cleanup.availableAfter, null); assert.equal(h.control.snapshot().pending, false);
  assert.equal((await h.cache.inventory()).entries.length, 0); await assert.rejects(readFile(h.path), { code: "ENOENT" });
  await h.cache.generate(key, async () => bytes, signal()); assert.deepEqual(await h.cache.read(key), bytes);
  h.cache.close(); h.control.closeAdmission();
});

it("reconciles a retained original through its completed owner without repeating deletion", async () => {
  const h = await fixture(); h.age(); h.unknown();
  const prepared = await h.cache.prepareCleanup(new Set([key]), signal()); assert(prepared);
  assert.equal((await prepared.run(planId, signal(), () => true)).status, "unknown");
  assert.equal(await h.cache.read(key), null);
  const result = await h.cache.reconcileCleanup(signal()); assert.equal(result.outcome, "retained");
  assert.equal(h.deletes(), 1); assert.equal(h.control.snapshot().pending, false);
  assert.deepEqual(await h.cache.read(key), bytes); assert.equal(h.control.snapshot().outcomes.at(-1)?.status, "retained");
  h.cache.close(); h.control.closeAdmission();
});

it("does not reconcile a live original operation, then retires only its removed receipt after completion", async () => {
  const h = await fixture(); h.age(); h.unknownRemoved();
  let finish!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  h.afterDelete(async () => { entered(); await new Promise<void>(resolve => { finish = resolve; }); });
  const prepared = await h.cache.prepareCleanup(new Set([key]), signal()); assert(prepared);
  const running = prepared.run(planId, signal(), () => true); await started;
  assert.equal((await h.cache.reconcileCleanup(signal())).outcome, "unconfirmed"); assert.equal(h.control.snapshot().pending, true);
  finish(); assert.equal((await running).status, "unknown");
  assert.equal((await h.cache.reconcileCleanup(signal())).outcome, "removed");
  assert.equal(h.deletes(), 1); assert.equal((await h.cache.inventory()).entries.length, 0);
  await h.cache.generate(key, async () => bytes, signal()); assert.deepEqual(await h.cache.read(key), bytes);
  h.cache.close(); h.control.closeAdmission();
});

it("keeps changed bytes and receipts held, and preserves a successor instead of adopting or deleting it", async () => {
  const h = await fixture(); h.age(); h.unknown();
  const prepared = await h.cache.prepareCleanup(new Set([key]), signal()); assert(prepared);
  await prepared.run(planId, signal(), () => true);
  const original = await readFile(h.path), metadata = await readFile(join(h.root, "local-presets-v1", "receipts.json"));
  await writeFile(h.path, "changed protected fixture");
  assert.equal((await h.cache.reconcileCleanup(signal())).outcome, "unconfirmed");
  await writeFile(h.path, original); // Original modification identity still differs, so remain held.
  assert.equal((await h.cache.reconcileCleanup(signal())).outcome, "unconfirmed");
  await unlink(h.path); await writeFile(h.path, "successor must survive");
  assert.equal((await h.cache.reconcileCleanup(signal())).outcome, "removed");
  assert.equal(await readFile(h.path, "utf8"), "successor must survive"); assert.equal(h.deletes(), 1);
  assert.notDeepEqual(await readFile(join(h.root, "local-presets-v1", "receipts.json")), metadata);
  await assert.rejects(h.cache.generate(key, async () => bytes, signal()));
  h.cache.close(); h.control.closeAdmission();
});

it("reopened authority requires positive absence of both prior owner and worker; probe errors and live/reused PIDs hold", async () => {
  const h = await fixture(); h.age(); h.unknown();
  const prepared = await h.cache.prepareCleanup(new Set([key]), signal()); assert(prepared); await prepared.run(planId, signal(), () => true);
  h.cache.close(); h.control.closeAdmission();
  const disk = JSON.parse(await readFile(h.controlPath, "utf8"));
  disk.pending.owner = { pid: 900001, token: "c".repeat(64), gate: "native-input-v1" }; disk.pending.workerPid = 900002;
  await writeFile(h.controlPath, JSON.stringify(disk));
  let mode: "error" | "owner" | "worker" | "gone" = "error";
  const processProbe: ProcessProbe = async pids => {
    assert.deepEqual(pids, [900001, 900002]); if (mode === "error") throw Error("private probe failure");
    const pid = mode === "owner" ? 900001 : 900002;
    return mode === "gone" ? new Map() : new Map([[pid, { pid, image: "unknown", startedAt: null }]]);
  };
  const control = new CacheCleanupControl(h.controlPath, { now: h.now }); await control.open();
  const cache = new LocalPreviewCache(h.root, undefined, { control, now: h.now, native: h.native, platform: "win32", processProbe });
  for (const state of ["error", "owner", "worker"] as const) {
    mode = state; assert.equal((await cache.reconcileCleanup(signal())).outcome, "unconfirmed"); assert.equal(control.snapshot().pending, true);
  }
  mode = "gone"; assert.equal((await cache.reconcileCleanup(signal())).outcome, "retained");
  assert.equal(h.deletes(), 1); assert.deepEqual(await cache.read(key), bytes); cache.close(); control.closeAdmission();
});

it("rejects changed content, a newly leased reader and revoked approval before native deletion", async () => {
  for (const change of ["content", "reader", "revoke"] as const) {
    const h = await fixture(); h.age(); const prepared = await h.cache.prepareCleanup(new Set([key]), signal()); assert(prepared);
    const reader = change === "reader" ? await h.cache.serve(key) : null;
    if (change === "content") await writeFile(h.path, "changed protected fixture");
    const result = await prepared.run(planId, signal(), () => change !== "revoke");
    assert.equal(result.status, "refused"); assert.equal(h.deletes(), 0);
    assert.deepEqual(await readFile(h.path), change === "content" ? Buffer.from("changed protected fixture") : bytes);
    reader?.release?.(); h.cache.close(); h.control.closeAdmission();
  }
});

it("cancellation between admitted steps preserves later files and reports completed irreversible deletions", async () => {
  const h = await fixture(), second = "c".repeat(64), abort = new AbortController();
  await h.cache.generate(second, async () => bytes, signal()); h.age();
  const prepared = await h.cache.prepareCleanup(new Set([key, second]), signal()); assert(prepared);
  assert.equal(prepared.files, 2);
  h.afterDelete(() => abort.abort());
  const result = await prepared.run(planId, abort.signal, () => !abort.signal.aborted);
  assert.equal(result.status, "cancelled"); assert.equal(result.cleanup.removedFiles, 1); assert.equal(h.deletes(), 1);
  assert.deepEqual(await readFile(join(h.root, "local-presets-v1", `${second}.wav`)), bytes);
  assert.equal(h.control.snapshot().pending, false); h.cache.close(); h.control.closeAdmission();
});

it("measures post-action capacity and stops before later files once the warning headroom is restored", async () => {
  const capacity = { available: 1024 ** 3 + 13 * 1024 ** 2 }, h = await fixture({ capacity }), second = "d".repeat(64);
  try {
    await h.cache.generate(second, async () => bytes, signal()); h.age();
    const prepared = await h.cache.prepareCleanup(new Set([key, second]), signal()); assert(prepared); assert.equal(prepared.files, 2);
    assert(prepared.stopAtAvailableBytes !== null);
    h.afterDelete(() => { capacity.available += 6 * 1024 ** 3; });
    const result = await prepared.run(planId, signal(), () => true);
    assert.equal(result.status, "verified"); assert.equal(result.cleanup.removedFiles, 1); assert.equal(h.deletes(), 1);
    assert.equal(result.cleanup.availableAfter, capacity.available); assert.equal(result.cleanup.reclaimedBytes, null, "external changes cannot be attributed to cleanup");
    assert.deepEqual(await readFile(join(h.root, "local-presets-v1", `${second}.wav`)), bytes);
  } finally { h.cache.close(); h.control.closeAdmission(); await h.storage?.stop(); }
});

it("retains a known deletion count when receipt publication subsequently fails", async () => {
  const h = await fixture(); h.age(); const prepared = await h.cache.prepareCleanup(new Set([key]), signal()); assert(prepared);
  h.afterDelete(() => writeFile(join(h.root, "local-presets-v1", "receipts.json"), "corrupt fixture metadata"));
  const result = await prepared.run(planId, signal(), () => true);
  assert.equal(result.status, "unknown"); assert.equal(result.cleanup.removedFiles, 1); assert.equal(h.control.snapshot().pending, true);
  await assert.rejects(readFile(h.path), { code: "ENOENT" }); h.cache.close(); h.control.closeAdmission();
});

it("uncertain native deletion retains intent and reader/writer exclusion across restart without replay", async () => {
  const h = await fixture(); h.age(); const prepared = await h.cache.prepareCleanup(new Set([key]), signal()); assert(prepared); h.unknown();
  const result = await prepared.run(planId, signal(), () => true);
  assert.equal(result.status, "unknown"); assert.equal(result.cleanup.removedFiles, 0); assert.equal(h.control.snapshot().pending, true);
  await assert.rejects(h.cache.generate(key, async () => { throw Error("must not infer again"); }, signal()));
  assert.deepEqual(await readFile(h.path), bytes); h.cache.close(); h.control.closeAdmission();
  const control = new CacheCleanupControl(h.controlPath); await control.open();
  const next = new LocalPreviewCache(h.root, undefined, { control, platform: "win32" });
  assert.equal(await next.prepareCleanup(new Set([key]), signal()), null); assert.equal(await next.read(key), null);
  assert.equal(h.deletes(), 1); next.close(); control.closeAdmission();
});

it("failed intent persistence prevents native deletion and retains uncertain audit authority", async () => {
  const store: CacheCleanupStore = { load: async () => ({ version: 1, pending: null, outcomes: [] }), save: async () => { throw Error("disk full"); } };
  const h = await fixture({ store }); h.age(); const prepared = await h.cache.prepareCleanup(new Set([key]), signal()); assert(prepared);
  const result = await prepared.run(planId, signal(), () => true);
  assert.equal(result.status, "unknown"); assert.equal(h.deletes(), 0); assert.equal(h.control.snapshot().pending, true);
  assert.deepEqual(await readFile(h.path), bytes); h.cache.close(); h.control.closeAdmission();
});

it("real Windows deletion runs only after its flushed cleanup intent and removes the generated file", { skip: process.platform !== "win32", timeout: 30_000 }, async () => {
  const h = await fixture({ real: true }); h.age(); const prepared = await h.cache.prepareCleanup(new Set([key]), signal()); assert(prepared);
  const result = await prepared.run(planId, signal(), () => true);
  assert.equal(result.status, "verified"); assert.equal(result.cleanup.removedFiles, 1); assert.equal(h.deletes(), 1);
  assert.equal(h.control.snapshot().outcomes.at(-1)?.status, "removed"); await assert.rejects(readFile(h.path), { code: "ENOENT" });
  h.cache.close(); h.control.closeAdmission();
});
