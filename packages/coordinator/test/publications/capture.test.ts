import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { tempDir } from "../tmp.js";
import { makeTempWorld } from "../world/helpers.js";
import { WorldStore } from "../../src/world/store.js";
import { WorldLockDeposedError } from "../../src/world/lock.js";
import { capturePublicationInputs, type PublicationCaptureRequest } from "../../src/publications/capture.js";
import { PublicationFileError } from "../../src/publications/files.js";

const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const changed = (error: unknown) => error instanceof PublicationFileError && error.code === "source-changed";

async function fixture(t: TestContext) {
  const world = await makeTempWorld();
  const scratch = await tempDir("arke-publication-scratch-");
  // Cache files keep these deliberately synthetic dependencies out of the authored-world scan.
  await mkdir(join(world, ".cache"), { recursive: true });
  await writeFile(join(world, ".cache/selection.json"), '{"take":"A"}');
  const bytes = Buffer.alloc(2 * 1024 * 1024 + 37, 42);
  await writeFile(join(world, ".cache/source.mp4"), bytes);
  const store = await WorldStore.open(world);
  t.after(async () => {
    try { await store.close(); }
    catch (error) { if (!(error instanceof WorldLockDeposedError)) throw error; }
  });
  const request: PublicationCaptureRequest = {
    receipt: {
      version: 1, compiler: { compiler: "test-publication", compilerVersion: "1" }, timelineRevision: 7,
      records: [{ key: "selection", sha256: digest('{"take":"A"}') }],
      media: [{ key: "movie", sha256: digest(bytes), byteLength: bytes.length }],
      resolvedPlanSha256: digest("A 0-10"), settingsSha256: digest("review"),
    },
    records: { selection: ".cache/selection.json" }, media: { movie: ".cache/source.mp4" },
  };
  return { store, world, scratch, request, bytes };
}

it("pins source bytes independently of later editing and disposes only its own capture", async t => {
  const f = await fixture(t);
  await writeFile(join(f.scratch, "unrelated.txt"), "keep");
  const captured = await capturePublicationInputs(f.store, f.request, f.scratch);
  await writeFile(join(f.world, ".cache/source.mp4"), "new source");
  await writeFile(join(f.world, ".cache/selection.json"), '{"take":"B"}');
  assert.deepEqual(await readFile(captured.media.movie!), f.bytes);
  assert.equal(captured.receipt.timelineRevision, 7);
  assert.match(captured.fingerprint, /^[a-f0-9]{64}$/);
  await captured.dispose(); await captured.dispose();
  assert.deepEqual(await readdir(f.scratch), ["unrelated.txt"]);
});

it("refuses a changed selection at the same timeline revision before returning copies", async t => {
  const f = await fixture(t);
  await writeFile(join(f.world, ".cache/selection.json"), '{"take":"B"}');
  await assert.rejects(capturePublicationInputs(f.store, f.request, f.scratch), changed);
  assert.deepEqual(await readdir(f.scratch), []);
});

it("rechecks records and sources after copying and cleans an interrupted capture", async t => {
  for (const path of [".cache/selection.json", ".cache/source.mp4"]) {
    const f = await fixture(t);
    await assert.rejects(capturePublicationInputs(f.store, f.request, f.scratch, {
      onCopied: async () => { await writeFile(join(f.world, path), "changed during capture"); },
    }), changed);
    assert.deepEqual(await readdir(f.scratch), []);
  }
});

it("cancels after a copy and releases all handles and temporary files", async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  await assert.rejects(capturePublicationInputs(f.store, f.request, f.scratch, {
    signal: controller.signal, onCopied: () => controller.abort(),
  }), { name: "AbortError" });
  assert.deepEqual(await readdir(f.scratch), []);
  await writeFile(join(f.world, ".cache/source.mp4"), "handles closed");
});

it("world close aborts capture and drains it without a deadlock", async t => {
  const f = await fixture(t);
  let closing: Promise<void> | undefined;
  await assert.rejects(capturePublicationInputs(f.store, f.request, f.scratch, {
    onCopied: () => { closing = f.store.close(); },
  }), { name: "AbortError" });
  await closing;
  assert.deepEqual(await readdir(f.scratch), []);
});

it("holds app writes until all copied dependencies have been acknowledged", async t => {
  const f = await fixture(t);
  let mutation: Promise<void> | undefined;
  const captured = await capturePublicationInputs(f.store, f.request, f.scratch, {
    onCopied: () => {
      mutation = f.store.ownedWrite(() => writeFile(join(f.world, ".cache/selection.json"), '{"take":"B"}'));
    },
  });
  await mutation;
  assert.deepEqual(await readFile(captured.media.movie!), f.bytes);
  await captured.dispose();
});

it("refuses path-map mismatches and oversized media without leaving a partial snapshot", async t => {
  const f = await fixture(t);
  await assert.rejects(capturePublicationInputs(f.store, { ...f.request, media: {} }, f.scratch), /match the receipt/);
  await assert.rejects(capturePublicationInputs(f.store, f.request, f.scratch, { limits: { assetBytes: 10 } }), /byte limits/);
  assert.deepEqual(await readdir(f.scratch), []);
});

it("refuses ownership loss during capture and leaves the successor's lock alone", async t => {
  const f = await fixture(t);
  const successor = { pid: process.pid, startedAt: "2099-01-01T00:00:00.000Z" };
  await assert.rejects(capturePublicationInputs(f.store, f.request, f.scratch, {
    onCopied: () => writeFile(join(f.world, "world.lock"), JSON.stringify(successor)),
  }), WorldLockDeposedError);
  assert.deepEqual(await readdir(f.scratch), []);
  await assert.rejects(f.store.close(), WorldLockDeposedError);
  assert.deepEqual(JSON.parse(await readFile(join(f.world, "world.lock"), "utf8")), successor);
});

it("rejects escaping and linked source paths and preserves outside files", async t => {
  const f = await fixture(t);
  for (const movie of ["../source.mp4", "/source.mp4", "C:/source.mp4", ".cache/../source.mp4", ".cache/CON.mp4"]) {
    await assert.rejects(capturePublicationInputs(f.store, { ...f.request, media: { movie } }, f.scratch),
      (error: unknown) => error instanceof PublicationFileError && error.code === "unsafe-path");
  }
  const outside = await tempDir("arke-publication-linked-source-");
  await writeFile(join(outside, "source.mp4"), f.bytes);
  await symlink(outside, join(f.world, ".cache/linked"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(capturePublicationInputs(f.store, {
    ...f.request, media: { movie: ".cache/linked/source.mp4" },
  }, f.scratch), (error: unknown) => error instanceof PublicationFileError && error.code === "unsafe-path");
  assert.deepEqual(await readdir(f.scratch), []);
  assert.deepEqual(await readFile(join(outside, "source.mp4")), f.bytes);
});

it("bounds copies by declared lengths even when a larger file fits the host limit", async t => {
  const f = await fixture(t);
  f.request.receipt.media[0]!.byteLength = 1;
  await assert.rejects(capturePublicationInputs(f.store, f.request, f.scratch),
    (error: unknown) => error instanceof PublicationFileError && error.code === "limit-exceeded");
  assert.deepEqual(await readdir(f.scratch), []);
});
