// Build the Electron-ABI binary for the aliased better-sqlite3 copy (SPEC-003 R-7, §2.9).
//
// The workspace holds two copies of the module: `better-sqlite3` (Node ABI — tests and the
// dev coordinator) and the alias `better-sqlite3-electron` (this one), which must match the
// Electron ABI the desktop shell runs on. @electron/rebuild matches modules by their inner
// package name — which the alias shares with the Node copy — so it cannot target one without
// the other. Instead: try the published prebuild (fast when the Electron ABI is covered),
// and fall back to a source build with node-gyp 13, which knows current Visual Studio.
// Idempotent via the .electron-abi marker.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const electronVersion = require("electron/package.json").version;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const moduleDir = join(repoRoot, "node_modules", "better-sqlite3-electron");
const marker = join(moduleDir, ".electron-abi");
const markerContent = `electron-${electronVersion}`;

if (!existsSync(moduleDir)) {
  console.error(`[rebuild-native] ${moduleDir} missing — run npm install first`);
  process.exit(1);
}

try {
  if (readFileSync(marker, "utf8") === markerContent) {
    console.log(`[rebuild-native] better-sqlite3-electron already at Electron ${electronVersion}`);
    process.exit(0);
  }
} catch {
  /* no marker yet */
}

const run = (cmd, args) =>
  spawnSync(cmd, args, { cwd: moduleDir, stdio: "inherit", shell: process.platform === "win32" });

console.log(`[rebuild-native] trying published prebuild for Electron ${electronVersion}…`);
const prebuildBin = join(
  repoRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "prebuild-install.cmd" : "prebuild-install",
);
const prebuilt = run(prebuildBin, ["-r", "electron", "-t", electronVersion, "-f"]);

if (prebuilt.status !== 0) {
  console.log("[rebuild-native] no prebuild — compiling against Electron headers (node-gyp 13)…");
  const compiled = run("npm", [
    "exec",
    "-y",
    "--package=node-gyp@13",
    "--",
    "node-gyp",
    "rebuild",
    `--target=${electronVersion}`,
    `--arch=${process.arch}`,
    "--dist-url=https://electronjs.org/headers",
  ]);
  if (compiled.status !== 0) {
    console.error("[rebuild-native] build failed — the derived index will be disabled in the app");
    process.exit(compiled.status ?? 1);
  }
}

writeFileSync(marker, markerContent, "utf8");
console.log("[rebuild-native] done");
