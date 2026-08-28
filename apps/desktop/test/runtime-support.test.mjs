import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertPeArchitecture,
  manifestFor,
  peArchitecture,
  swapStagedDirectory,
  verifyManifest,
} from "../scripts/runtime-support.mjs";

async function pe(machine) {
  const path = join(tmpdir(), `arke-pe-${machine}-${Date.now()}.exe`);
  const bytes = Buffer.alloc(128);
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt32LE(64, 0x3c);
  bytes.write("PE\0\0", 64, "ascii");
  bytes.writeUInt16LE(machine, 68);
  await writeFile(path, bytes);
  return path;
}

describe("runtime preparation primitives", () => {
  it("recognises x64 and arm64 PE files and rejects mismatches", async () => {
    const x64 = await pe(0x8664);
    const arm64 = await pe(0xaa64);
    try {
      assert.equal(peArchitecture(x64), "x64");
      assert.equal(peArchitecture(arm64), "arm64");
      assert.throws(() => assertPeArchitecture(x64, "arm64"), /expected arm64/);
    } finally {
      await rm(x64, { force: true });
      await rm(arm64, { force: true });
    }
  });

  it("creates a stable target-only checksum manifest", async () => {
    const root = join(tmpdir(), `arke-runtime-${Date.now()}`);
    await mkdir(join(root, "nested"), { recursive: true });
    await writeFile(join(root, "voxa.exe"), "one");
    await writeFile(join(root, "nested", "runtime.dll"), "two");
    try {
      const manifest = manifestFor(root, { component: "voxa", arch: "x64" });
      await writeFile(join(root, "runtime-manifest.json"), JSON.stringify(manifest));
      assert.deepEqual(manifest.files.map((file) => file.path), ["nested/runtime.dll", "voxa.exe"]);
      assert.equal(manifest.files.every((file) => /^[A-F0-9]{64}$/.test(file.sha256)), true);
      assert.equal(verifyManifest(root).component, "voxa");
      await writeFile(join(root, "unlisted.dll"), "three");
      assert.throws(() => verifyManifest(root), /every staged file/);
      await rm(join(root, "unlisted.dll"));
      await writeFile(join(root, "voxa.exe"), "changed");
      assert.throws(() => verifyManifest(root), /manifest|checksum|size/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

/**
 * The half of a prepare run that decides what a *failed* prepare costs (#581).
 *
 * Driven directly rather than through `prepare:runtimes`, which wants Windows, a .NET SDK and
 * three network downloads before it reaches the swap. The case that matters here is the one that
 * broke the build in the first place -- the fresh copy never arrives -- and it has to be tried,
 * because its whole job is to do nothing.
 */
describe("swapping a staged runtime into place", () => {
  async function scene() {
    const root = join(tmpdir(), `arke-swap-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    const fresh = join(root, "work", "stage", "ffmpeg");
    const stage = join(root, "build-resources", "ffmpeg");
    const attic = join(root, ".runtime-previous", "ffmpeg");
    await mkdir(fresh, { recursive: true });
    await writeFile(join(fresh, "ffmpeg.exe"), "new");
    return { root, fresh, stage, attic };
  }

  it("replaces the staged copy wholesale, leaving nothing of the old one behind", async () => {
    const { root, fresh, stage, attic } = await scene();
    try {
      await mkdir(join(stage, "doc"), { recursive: true });
      await writeFile(join(stage, "ffmpeg.exe"), "old");
      await writeFile(join(stage, "doc", "stale.html"), "from the previous pin");
      swapStagedDirectory(fresh, stage, attic);
      assert.equal(await readFile(join(stage, "ffmpeg.exe"), "utf8"), "new");
      assert.deepEqual(await readdir(stage), ["ffmpeg.exe"], "a file only the old build had must not survive");
      assert.equal(existsSync(attic), false, "the displaced copy is dropped once the new one is in");
      assert.equal(existsSync(fresh), false, "and the work copy is moved, not left as a duplicate");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stages into an empty build-resources, creating the parent it needs", async () => {
    const { root, fresh, attic } = await scene();
    const stage = join(root, "build-resources", "voxa", "x64");
    try {
      swapStagedDirectory(fresh, stage, attic);
      assert.equal(await readFile(join(stage, "ffmpeg.exe"), "utf8"), "new");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("leaves a working staged copy untouched when the fresh one was never prepared", async () => {
    // #581 exactly: the pinned ffmpeg release was deleted upstream, the download 404'd, and the
    // old clear-then-fetch order had already taken the only ffmpeg on the machine with it.
    const { root, stage, attic } = await scene();
    try {
      await mkdir(stage, { recursive: true });
      await writeFile(join(stage, "ffmpeg.exe"), "old but working");
      assert.throws(() => swapStagedDirectory(join(root, "never-built"), stage, attic), /was never prepared/);
      assert.equal(await readFile(join(stage, "ffmpeg.exe"), "utf8"), "old but working");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("clears a leftover attic rather than swapping the wrong copy into it", async () => {
    // A swap killed part-way leaves the attic populated. The next run must not mistake that for
    // the copy it is displacing, or a two-runs-old ffmpeg becomes the one that gets restored.
    const { root, fresh, stage, attic } = await scene();
    try {
      await mkdir(attic, { recursive: true });
      await writeFile(join(attic, "ffmpeg.exe"), "two runs old");
      await mkdir(stage, { recursive: true });
      await writeFile(join(stage, "ffmpeg.exe"), "old");
      swapStagedDirectory(fresh, stage, attic);
      assert.equal(await readFile(join(stage, "ffmpeg.exe"), "utf8"), "new");
      assert.equal(existsSync(attic), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
