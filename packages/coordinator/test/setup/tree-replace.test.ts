import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mergePreserving } from "../../src/setup/local-setup.js";
import { tempDir } from "../tmp.js";

/**
 * The carry a managed replace performs (SPEC-021 R-20, D18; issue 592): an unoverridden install
 * keeps its checkpoints inside the tree being swapped, so what the user added must cross — and
 * what the new archive ships at the same path must not be overwritten by the old copy.
 */
describe("merging the old tree's folders into the new one", () => {
  it("carries the user's additions, keeps the new runtime's own files, and merges nested folders", async () => {
    const root = await tempDir("arke-tree-replace-");
    const old = join(root, "previous", "ComfyUI", "models");
    const fresh = join(root, "current", "ComfyUI", "models");
    await mkdir(join(old, "checkpoints"), { recursive: true });
    await mkdir(join(old, "loras"), { recursive: true });
    await mkdir(join(fresh, "checkpoints"), { recursive: true });
    await writeFile(join(old, "checkpoints", "sd_xl_base_1.0.safetensors"), "six gigabytes, verified");
    await writeFile(join(old, "checkpoints", "put_checkpoints_here"), "old placeholder");
    await writeFile(join(old, "loras", "style.safetensors"), "user lora");
    await writeFile(join(fresh, "checkpoints", "put_checkpoints_here"), "new placeholder");

    assert.equal(await mergePreserving(old, fresh), true);
    assert.equal(await readFile(join(fresh, "checkpoints", "sd_xl_base_1.0.safetensors"), "utf8"), "six gigabytes, verified");
    assert.equal(await readFile(join(fresh, "loras", "style.safetensors"), "utf8"), "user lora", "a folder the new archive lacks crosses whole");
    assert.equal(
      await readFile(join(fresh, "checkpoints", "put_checkpoints_here"), "utf8"),
      "new placeholder",
      "a file the new runtime ships wins the collision",
    );
    assert.equal(await stat(join(old, "checkpoints", "sd_xl_base_1.0.safetensors")).catch(() => null), null, "moved, not copied");
  });

  it("a source that does not exist carries nothing and is not a failure", async () => {
    const root = await tempDir("arke-tree-replace-");
    assert.equal(await mergePreserving(join(root, "nowhere"), join(root, "current")), true);
  });
});
