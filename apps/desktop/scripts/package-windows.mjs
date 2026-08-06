// Windows x64 only.
//
// ARM64 was built until 0.2.9 and should not have been. better-sqlite3 is a per-ABI native
// addon with no ARM64 prebuild published for Electron, so it has to be cross-compiled — and
// the MSVC ARM64 tools are a separate Visual Studio component that no build machine here has
// had. `rebuild-native --allow-missing` swallowed that, so every ARM64 installer we ever
// produced shipped with the derived index silently switched off. A build that quietly drops a
// feature is worse than no build. Windows on ARM runs the x64 binary under emulation, which is
// the honest fallback until the toolchain is in place on the machines that package.
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const publish = process.argv.includes("--publish") ? process.argv[process.argv.indexOf("--publish") + 1] : "never";
if (!new Set(["never", "always"]).has(publish)) throw new Error("--publish must be never or always");

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}`);
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const builder = join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "electron-builder.cmd" : "electron-builder");

// No --allow-missing: with one architecture there is no reason to tolerate a native build
// failure, and tolerating it is exactly how the ARM64 gap went unnoticed.
run("node", ["scripts/rebuild-native.mjs", "--arch", "x64"]);
run(builder, ["--win", "nsis", "--x64", "--publish", publish]);
// electron-builder writes release/latest.yml for the single arch it built; that IS the feed.
