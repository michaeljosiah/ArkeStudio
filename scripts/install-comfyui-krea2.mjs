import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../vendor/comfyui/ComfyUI-ConditioningKrea2Rebalance/", import.meta.url));
const manifest = JSON.parse(await readFile(join(source, "manifest.json"), "utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Never bless or overwrite a different user checkout. Verify the complete Python module first. */
export async function installKrea2Node(engineDir) {
  const engine = resolve(engineDir);
  await readFile(join(engine, "main.py"));
  const target = join(engine, "custom_nodes", "ComfyUI-ConditioningKrea2Rebalance");
  const expected = Object.keys(manifest.files);
  const present = await readdir(target).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const file of present) {
    if ((file.endsWith(".py") || file.endsWith(".pyc") || file.endsWith(".pyd")) && !expected.includes(file)) {
      throw new Error(`Unrecognised node code: ${join(target, file)}`);
    }
  }
  for (const file of expected) {
    if (hash(await readFile(join(source, file))) !== manifest.files[file]) {
      throw new Error(`Vendored source failed verification: ${file}`);
    }
    const existing = await readFile(join(target, file)).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (existing !== null && hash(existing) !== manifest.files[file]) {
      throw new Error(`Existing file differs; left untouched: ${join(target, file)}`);
    }
  }
  await mkdir(target, { recursive: true });
  for (const file of expected) {
    await copyFile(join(source, file), join(target, file), constants.COPYFILE_EXCL).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    if (hash(await readFile(join(target, file))) !== manifest.files[file]) {
      throw new Error(`Installed node failed verification: ${file}`);
    }
  }
  await writeFile(join(target, ".arke-content-id"), `${manifest.commit}\n`, "utf8");
  return target;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error("Usage: node scripts/install-comfyui-krea2.mjs <ComfyUI directory>");
  const target = await installKrea2Node(process.argv[2]);
  console.log(`Verified Krea 2 node: ${target}\nRestart ComfyUI if the node was not already loaded, then re-verify in Arke.`);
}
