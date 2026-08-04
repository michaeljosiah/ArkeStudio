import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readContainedImageReferences } from "../../src/world/reference-files.js";
import { jpegBytes, pngBytes, webpBytes } from "../queue/fake-provider.js";
import { tempDir } from "../tmp.js";

describe("provider image reference preparation", () => {
  it("reads verified PNG, JPEG, and WebP beneath the world with neutral names", async () => {
    const world = await tempDir("arke-reference-world-");
    await mkdir(join(world, "references"), { recursive: true });
    await writeFile(join(world, "references", "a.png"), pngBytes());
    await writeFile(join(world, "references", "b.jpg"), jpegBytes());
    await writeFile(join(world, "references", "c.webp"), webpBytes());
    const result = await readContainedImageReferences(world, [
      "references/a.png",
      "references/b.jpg",
      "references/c.webp",
    ]);
    assert.deepEqual(result.map((item) => [item.name, item.contentType]), [
      ["reference-01.png", "image/png"],
      ["reference-02.jpg", "image/jpeg"],
      ["reference-03.webp", "image/webp"],
    ]);
  });

  it("rejects traversal, absolute, backslash, ADS, missing, and invalid images", async () => {
    const world = await tempDir("arke-reference-invalid-");
    await writeFile(join(world, "bad.png"), "not an image");
    for (const path of ["../outside.png", "C:/outside.png", "references\\a.png", "a.png:stream", "missing.png", "bad.png"]) {
      await assert.rejects(readContainedImageReferences(world, [path]));
    }
  });

  it("refuses symlinked files even when they point back inside", async () => {
    const world = await tempDir("arke-reference-link-");
    await writeFile(join(world, "real.png"), pngBytes());
    await symlink(join(world, "real.png"), join(world, "linked.png"));
    await assert.rejects(readContainedImageReferences(world, ["linked.png"]), /linked image references/);
  });

  it("rejects more than sixteen references", async () => {
    const world = await tempDir("arke-reference-count-");
    await assert.rejects(
      readContainedImageReferences(world, Array.from({ length: 17 }, () => "a.png")),
      /at most 16/,
    );
  });
});
