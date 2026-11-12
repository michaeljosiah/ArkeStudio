import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdir, open, readFile, rename, symlink, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import { LocalPreviewCache } from "../../src/storage/local-preview-cache.js";
import { AppStorageService } from "../../src/storage/service.js";
import { tempDir } from "../tmp.js";

const key = createHash("sha256").update("fixed local preset fixture").digest("hex");
const bytes = Buffer.from("RIFF bounded local preview fixture");
const signal = () => new AbortController().signal;
const audio = (root: string) => join(root, "local-presets-v1", `${key}.wav`);
const index = (root: string) => join(root, "local-presets-v1", "receipts.json");
async function fixture() {
  const root = await tempDir("arke-owned-preview-");
  return { root, cache: new LocalPreviewCache(root) };
}

it("records only its new producer output and verifies it across a new service instance", async () => {
  const { root, cache } = await fixture();
  assert.equal(await cache.read(key), null);
  await cache.generate(key, async () => bytes, signal());
  const json = JSON.parse(await readFile(index(root), "utf8"));
  assert.equal(json.entries.length, 1); assert.equal(json.entries[0].kind, "local-catalogue-preset-v1");
  assert.equal(json.entries[0].bytes, bytes.length);
  assert(!JSON.stringify(json).includes(root)); assert(!JSON.stringify(json).includes(bytes.toString()));
  assert.deepEqual(await cache.read(key), bytes);
  assert.deepEqual(await new LocalPreviewCache(root).read(key), bytes);
  const facts = await cache.inventory();
  assert.equal(facts.scope, "producer-receipts"); assert.equal(facts.complete, false, "unscanned files are not covered");
  assert.equal(facts.entries[0]?.allocatedBytes, null); assert.equal(facts.entries[0]?.recordedBytes, bytes.length);
  assert.equal(facts.entries[0]?.leased, false);
});

it("holds a writer before producer work begins and refuses overlapping readers/writers across instances", async () => {
  const { root, cache } = await fixture();
  let finish!: (bytes: Uint8Array) => void, entered!: () => void;
  const started = new Promise<void>(done => { entered = done; });
  const work = cache.generate(key, () => { entered(); return new Promise(done => { finish = done; }); }, signal());
  await started;
  const other = new LocalPreviewCache(root);
  try {
    await assert.rejects(other.read(key), /cache needs attention/);
    await assert.rejects(other.generate(key, async () => { throw Error("must not generate twice"); }, signal()), /cache needs attention/);
    assert.equal(await other.serve(key), null);
  } finally { finish(bytes); await work; }
  assert.deepEqual(await other.read(key), bytes);
});

it("holds a served reader across service close and releases idempotently through its host capability", async () => {
  const { root, cache } = await fixture(); await cache.generate(key, async () => bytes, signal());
  const reader = await cache.serve(key); assert(reader?.release);
  cache.close(); assert.equal(await cache.serve(key), null);
  const next = new LocalPreviewCache(root);
  assert.equal((await next.inventory()).entries[0]?.leased, true);
  await assert.rejects(next.generate(key, async () => bytes, signal()), /cache needs attention/);
  reader.release(); reader.release();
  assert.equal((await next.inventory()).entries[0]?.leased, false);
  await next.generate(key, async () => { throw Error("cached output must not regenerate"); }, signal());
});

it("does not adopt, overwrite or remove an unrecorded file, even with the expected hash filename", async () => {
  const { root, cache } = await fixture(); await mkdir(join(root, "local-presets-v1")); await writeFile(audio(root), bytes);
  assert.equal(await cache.read(key), null); assert.equal(await cache.serve(key), null);
  let calls = 0;
  await assert.rejects(cache.generate(key, async () => { calls++; return bytes; }, signal()), /cache needs attention/);
  assert.equal(calls, 0); assert.deepEqual(await readFile(audio(root)), bytes);
  assert.equal((await cache.inventory()).entries.length, 0);
});

it("rejects changed bytes and replaced file identities without repairing or deleting either", async () => {
  for (const replace of [false, true]) {
    const { root, cache } = await fixture(); await cache.generate(key, async () => bytes, signal());
    if (replace) await rename(audio(root), join(root, "retained-original.wav"));
    const changed = Buffer.from("RIFF changed protected bytes"); await writeFile(audio(root), changed);
    await assert.rejects(cache.read(key), /cache needs attention/); assert.equal(await cache.serve(key), null);
    await assert.rejects(cache.generate(key, async () => bytes, signal()), /cache needs attention/);
    assert.deepEqual(await readFile(audio(root)), changed);
    if (replace) assert.deepEqual(await readFile(join(root, "retained-original.wav")), bytes);
  }
});

it("rejects hard links and root symlink/junction escapes", async () => {
  const { root, cache } = await fixture(); await cache.generate(key, async () => bytes, signal());
  await link(audio(root), join(root, "protected-linked.wav"));
  await assert.rejects(cache.read(key), /cache needs attention/); assert.equal(await cache.serve(key), null);
  const escaped = await fixture(), outside = await tempDir("arke-preview-outside-");
  await symlink(outside, join(escaped.root, "local-presets-v1"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(escaped.cache.generate(key, async () => bytes, signal()), /cache needs attention/);
  assert.equal((await escaped.cache.inventory()).state, "unavailable");
  assert.deepEqual(await readFile(join(root, "protected-linked.wav")), bytes);
});

it("rejects corrupt or oversized metadata and refuses late receipt publication over corruption", async () => {
  for (const oversized of [false, true]) {
    const { root, cache } = await fixture(); await cache.generate(key, async () => bytes, signal());
    const corrupt = oversized ? "x".repeat(256 * 1024 + 1) : "not receipts";
    await writeFile(index(root), corrupt);
    await assert.rejects(cache.read(key), /cache needs attention/);
    assert.equal((await cache.inventory()).state, "unavailable");
    assert.deepEqual(await readFile(audio(root)), bytes); assert.equal(await readFile(index(root), "utf8"), corrupt);
  }
  const { root, cache } = await fixture();
  await assert.rejects(cache.generate(key, async () => { await writeFile(index(root), "changed while generating"); return bytes; }, signal()), /cache needs attention/);
  assert.deepEqual(await readFile(audio(root)), bytes, "unpublished output stays protected");
  assert.equal(await cache.serve(key), null);
});

it("cancellation and close prevent late file publication without claiming the producer has stopped early", async () => {
  for (const close of [false, true]) {
    const { root, cache } = await fixture(); const abort = new AbortController();
    let finish!: (bytes: Uint8Array) => void, entered!: () => void;
    const started = new Promise<void>(done => { entered = done; });
    const result = cache.generate(key, () => { entered(); return new Promise(done => { finish = done; }); }, abort.signal);
    const rejected = assert.rejects(result, /cache needs attention/);
    await started; if (close) cache.close(); else abort.abort();
    const next = new LocalPreviewCache(root);
    await assert.rejects(next.generate(key, async () => bytes, signal()), /cache needs attention/);
    finish(bytes); await rejected;
    await assert.rejects(readFile(audio(root)), { code: "ENOENT" });
    await next.generate(key, async () => bytes, signal());
    assert.deepEqual(await next.read(key), bytes);
  }
});

it("bounds audio output and rejects non-hash host keys", async () => {
  const { root, cache } = await fixture();
  await assert.rejects(cache.generate(key, async () => Buffer.alloc(12 * 1024 * 1024 + 1), signal()), /cache needs attention/);
  await assert.rejects(readFile(audio(root)), { code: "ENOENT" });
  for (const bad of ["../world.json", "A".repeat(64), "a".repeat(65)]) {
    await assert.rejects(cache.read(bad)); assert.equal(await cache.serve(bad), null);
  }
});

it("bounds new work when unknown/orphan directory entries have filled the cache", async () => {
  const { root, cache } = await fixture(); const directory = join(root, "local-presets-v1");
  await mkdir(directory);
  for (let start = 0; start < 1024; start += 64) {
    await Promise.all(Array.from({ length: 64 }, (_, offset) => writeFile(join(directory, `protected-${start + offset}`), "")));
  }
  let calls = 0;
  await assert.rejects(cache.generate(key, async () => { calls++; return bytes; }, signal()), /cache needs attention/);
  assert.equal(calls, 0); assert.equal((await readFile(join(directory, "protected-0"))).length, 0);
  assert.equal((await cache.inventory()).entries.length, 0, "unknown files are never adopted as producer receipts");
});

function storageFixture(root: string, initial: number) {
  const started = Date.now(); let base = started, available = initial;
  const now = () => base + Date.now() - started;
  const storage = new AppStorageService({ appRoot: root, now, native: {
    setRoots: () => {}, stop: async () => {}, probe: async (rootId, _signal, after) => {
      base = Math.max(base + 1, (after ?? 0) + 1 - (Date.now() - started));
      return { state: "measured", source: "host-provided", limitations: [], capacity: {
        volumeId: "preview-volume", mappingRevision: rootId, measuredAt: now(), availableBytes: available, totalBytes: 100 * 1024 ** 3,
      } };
    },
  } });
  return { storage, capacity: (value: number) => { available = value; base += 1001; } };
}

it("holds before local inference when shared peak/reserve cannot fit, and cache hits need no new space", async () => {
  const root = await tempDir("arke-preview-space-");
  const h = storageFixture(root, 1024 ** 3), cache = new LocalPreviewCache(root, h.storage);
  let calls = 0;
  try {
    await assert.rejects(cache.generate(key, async () => { calls++; return bytes; }, signal()), /waiting for disk space/);
    assert.equal(calls, 0); assert.equal(h.storage.reservations.snapshot().records.length, 0);
    h.capacity(1024 ** 3 + 13 * 1024 ** 2);
    await cache.generate(key, async () => { calls++; return bytes; }, signal());
    assert.equal(calls, 1); assert.equal(h.storage.reservations.snapshot().records.length, 0);
    h.capacity(0);
    assert.deepEqual(await cache.read(key), bytes);
    await cache.generate(key, async () => { throw Error("must not infer again"); }, signal());
  } finally { cache.close(); await h.storage.stop(); }
});

it("shares one volume's peak across producers and rechecks changed capacity after inference before opening output", async () => {
  const root = await tempDir("arke-preview-shared-space-");
  const h = storageFixture(root, 1024 ** 3 + 13 * 1024 ** 2);
  const first = new LocalPreviewCache(root, h.storage), second = new LocalPreviewCache(root, h.storage);
  let finish!: (bytes: Uint8Array) => void, entered!: () => void;
  const started = new Promise<void>(done => { entered = done; });
  const running = first.generate(key, () => { entered(); return new Promise(done => { finish = done; }); }, signal());
  const rejected = assert.rejects(running, /waiting for disk space/);
  try {
    await started;
    const records = h.storage.reservations.snapshot().records;
    assert.equal(records.length, 1); assert.equal(records[0]?.owner.kind, "preview");
    assert.equal(records[0]?.demands[0]?.remainingBytes, 12 * 1024 ** 2 + 256 * 1024);
    const otherKey = createHash("sha256").update("second preset").digest("hex");
    let calls = 0;
    await assert.rejects(second.generate(otherKey, async () => { calls++; return bytes; }, signal()), /waiting for disk space/);
    assert.equal(calls, 0);
    h.capacity(1024 ** 3); finish(bytes); await rejected;
    await assert.rejects(readFile(audio(root)), { code: "ENOENT" });
    assert.equal(h.storage.reservations.snapshot().records.length, 0);
  } finally { finish(bytes); await rejected; first.close(); second.close(); await h.storage.stop(); }
});

it("retains the exact writer/storage ownership when native file closure is unconfirmed", async t => {
  const root = await tempDir("arke-preview-unknown-close-");
  const h = storageFixture(root, 1024 ** 3 + 13 * 1024 ** 2), cache = new LocalPreviewCache(root, h.storage);
  const probe = await open(join(root, "probe"), "wx");
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  const originalWrite = prototype.writeFile; await probe.close();
  let closeOwned: (() => Promise<void>) | undefined;
  const mocked = t.mock.method(prototype, "writeFile", function(this: FileHandle, ...args: Parameters<FileHandle["writeFile"]>) {
    if (args[0] instanceof Uint8Array) {
      closeOwned = this.close.bind(this);
      t.mock.method(this, "close", async () => { throw Error("private close failure details"); });
    }
    return originalWrite.apply(this, args);
  });
  try {
    await assert.rejects(cache.generate(key, async () => bytes, signal()), /cache needs attention/);
    assert.equal(h.storage.reservations.snapshot().records.length, 1, "uncertain native cleanup retains its durable plan");
    assert.equal(h.storage.reservations.snapshot().records[0]?.owner.kind, "preview");
    const other = new LocalPreviewCache(root, h.storage);
    await assert.rejects(other.read(key), /cache needs attention/);
    await assert.rejects(other.generate(key, async () => { throw Error("must not replay"); }, signal()), /cache needs attention/);
    assert.deepEqual(await readFile(audio(root)), bytes, "unknown output is retained");
  } finally { mocked.mock.restore(); await closeOwned?.(); cache.close(); await h.storage.stop(); }
});
