import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { installQwen21Runtime } from "../install-comfyui-qwen21.mjs";

it("Qwen runtime installation verifies identical files and refuses to bless altered code", async () => {
  const engine = await mkdtemp(join(tmpdir(), "arke-qwen-"));
  try {
    await writeFile(join(engine, "main.py"), "# fake engine\n");
    const target = await installQwen21Runtime(engine);
    const marker = await readFile(join(target, ".arke-content-id"), "utf8");
    assert.match(marker.trim(), /^[a-f0-9]{64}$/);
    assert.equal(await installQwen21Runtime(engine), target);
    await writeFile(join(target, "__init__.py"), "# user changes\n");
    await assert.rejects(installQwen21Runtime(engine), /Existing file differs/);
    assert.equal(await readFile(join(target, "__init__.py"), "utf8"), "# user changes\n");
  } finally { await rm(engine, { recursive: true, force: true }); }
});

it("Qwen runtime installation rejects extra executable code and invalid engine roots", async () => {
  const engine = await mkdtemp(join(tmpdir(), "arke-qwen-"));
  try {
    await assert.rejects(installQwen21Runtime(engine));
    await writeFile(join(engine, "main.py"), "# fake engine\n");
    const target = join(engine, "custom_nodes", "ArkeQwen21Runtime");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "extra.py"), "# unknown code\n");
    await assert.rejects(installQwen21Runtime(engine), /Unrecognised node code/);
    await assert.rejects(readFile(join(target, ".arke-content-id")));
  } finally { await rm(engine, { recursive: true, force: true }); }
});
