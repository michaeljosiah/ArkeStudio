import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { installKrea2Node } from "../install-comfyui-krea2.mjs";

test("installs offline, verifies an existing copy and refuses changed source without blessing it", async () => {
  const engine = await mkdtemp(join(tmpdir(), "arke-krea-install-"));
  try {
    await writeFile(join(engine, "main.py"), "# test engine");
    const target = await installKrea2Node(engine);
    assert.equal((await readFile(join(target, ".arke-content-id"), "utf8")).trim(), "a0cd00681448ab63232463c83f12e0364456da59");
    assert.equal(await installKrea2Node(engine), target);
    await rm(join(target, ".arke-content-id"));
    await writeFile(join(target, "image_edit_encode_rebalance.py"), "# user changes");
    await assert.rejects(installKrea2Node(engine), /Existing file differs/);
    assert.equal(await readFile(join(target, "image_edit_encode_rebalance.py"), "utf8"), "# user changes");
    await assert.rejects(readFile(join(target, ".arke-content-id")), { code: "ENOENT" });
  } finally {
    await rm(engine, { recursive: true, force: true });
  }
});

test("refuses unknown Python modules and a directory that is not a ComfyUI installation", async () => {
  const engine = await mkdtemp(join(tmpdir(), "arke-krea-install-"));
  try {
    await assert.rejects(installKrea2Node(engine), { code: "ENOENT" });
    await writeFile(join(engine, "main.py"), "# test engine");
    const target = join(engine, "custom_nodes", "ComfyUI-ConditioningKrea2Rebalance");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "extra.py"), "# user extension");
    await assert.rejects(installKrea2Node(engine), /Unrecognised node code/);
    await assert.rejects(readFile(join(target, ".arke-content-id")), { code: "ENOENT" });
  } finally {
    await rm(engine, { recursive: true, force: true });
  }
});
