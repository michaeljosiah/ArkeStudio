import { spawnSync } from "node:child_process";
import { copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mergeUpdateMetadata } from "./merge-update-metadata.mjs";

const publish = process.argv.includes("--publish") ? process.argv[process.argv.indexOf("--publish") + 1] : "never";
if (!new Set(["never", "always"]).has(publish)) throw new Error("--publish must be never or always");

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}`);
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const builder = join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "electron-builder.cmd" : "electron-builder");

for (const arch of ["x64", "arm64"]) {
  run("node", ["scripts/rebuild-native.mjs", "--arch", arch, ...(arch === "arm64" ? ["--allow-missing"] : [])]);
  run(builder, ["--win", "nsis", `--${arch}`, "--publish", publish]);
  copyFileSync("release/latest.yml", `release/latest-${arch}.yml`);
}
mergeUpdateMetadata("release/latest-x64.yml", "release/latest-arm64.yml", "release/latest.yml");
