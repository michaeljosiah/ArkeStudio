import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ComfyUiDigestCache } from "../src/comfyui-digest-cache.js";

describe("ComfyUI checkpoint digest receipts", () => {
  it("reuses an unchanged digest across launches, invalidates on file change, and lets Re-verify bypass it", async () => {
    const root = await mkdtemp(join(tmpdir(), "arke-comfyui-digests-"));
    const appRoot = join(root, "app");
    const checkpoint = join(root, "models", "checkpoint.safetensors");
    await mkdir(join(root, "models"));
    await writeFile(checkpoint, "first checkpoint");

    const firstDigest = createHash("sha256").update("first checkpoint").digest("hex");
    assert.equal(await new ComfyUiDigestCache(appRoot).hashFile(checkpoint), firstDigest);

    let reads = 0;
    const restarted = new ComfyUiDigestCache(appRoot, async () => {
      reads += 1;
      return "a".repeat(64);
    });
    assert.equal(await restarted.hashFile(checkpoint), firstDigest);
    assert.equal(reads, 0, "an unchanged checkpoint is not opened again after restart");

    await writeFile(checkpoint, "changed checkpoint bytes");
    assert.equal(await restarted.hashFile(checkpoint), "a".repeat(64));
    assert.equal(reads, 1, "changed filesystem identity invalidates the receipt");

    const forced = new ComfyUiDigestCache(appRoot, async () => {
      reads += 1;
      return "b".repeat(64);
    });
    assert.equal(await forced.hashFile(checkpoint, undefined, true), "b".repeat(64));
    assert.equal(reads, 2, "manual Re-verify reads unchanged bytes again");
  });

  it("refuses a digest when the checkpoint changes during its read", async () => {
    const root = await mkdtemp(join(tmpdir(), "arke-comfyui-digests-"));
    const checkpoint = join(root, "checkpoint.safetensors");
    await writeFile(checkpoint, "before");
    const cache = new ComfyUiDigestCache(join(root, "app"), async (path) => {
      await writeFile(path, "changed during verification");
      return "a".repeat(64);
    });

    assert.equal(await cache.hashFile(checkpoint), null);

    let reads = 0;
    const retried = new ComfyUiDigestCache(join(root, "app"), async () => {
      reads += 1;
      return "b".repeat(64);
    });
    assert.equal(await retried.hashFile(checkpoint), "b".repeat(64));
    assert.equal(reads, 1, "an unstable read leaves no reusable receipt");
  });
});
