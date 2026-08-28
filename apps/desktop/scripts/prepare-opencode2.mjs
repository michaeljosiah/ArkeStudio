// Stage the bundled OpenCode v2 harness (issue 327 §9, SPEC-016 R-7).
//
// Bundled rather than installed at setup, deliberately: the adapter is written against a
// measured, pinned build, and a setup-time `npm install @opencode-ai/cli@beta` floats with
// the beta dist-tag — ahead of the pin into an unstable API, or behind it into the gate's
// rejection. The bundle keeps binary and adapter in lockstep, needs no Node, npm, network
// or PATH mutation at install time, and updates only when a release moves the pin (which
// re-runs the issue's spike by rule).
//
// Only the executable is staged. The platform package also carries ~60 MB of source maps,
// which are debugging aids for upstream, not something 350 MB of installer should carry.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertPeArchitecture, assertSha256, manifestFor, SUPPORTED_ARCHES, swapStagedDirectory } from "./runtime-support.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "../..");
const metadata = JSON.parse(readFileSync(join(desktopRoot, "runtime-sources.json"), "utf8"));
const args = process.argv.slice(2);

function value(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const arch = value("--arch") ?? "x64";
if (!SUPPORTED_ARCHES.has(arch)) throw new Error("--arch must be x64 or arm64");
if (process.platform !== "win32") throw new Error("Windows runtime preparation must run on Windows");
const source = metadata.opencode2?.[arch];
if (!source) throw new Error(`no pinned opencode2 build for ${arch}`);

const work = resolve(value("--work") ?? join(repoRoot, ".runtime-work", `opencode2-${arch}`));
const staged = join(desktopRoot, "build-resources", "opencode2");
// Built in the work directory and swapped into build-resources once verified, for the reason
// prepare-runtimes gives: clearing the stage in front of a download that then fails costs the
// working copy as well as the build (#581).
const stage = join(work, "stage");
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
mkdirSync(stage, { recursive: true });

// System32's bsdtar, resolved the same way prepare-runtimes does: a PATH that prefers GNU
// tar (Git Bash, MSYS2) reads `C:` in an absolute archive path as a remote host and fails.
function tarPath() {
  const system32 = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "tar.exe");
  return existsSync(system32) ? system32 : "tar.exe";
}

async function download(url, path, expected, label) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${label} download failed (HTTP ${response.status})`);
  writeFileSync(path, Buffer.from(await response.arrayBuffer()));
  assertSha256(path, expected, label);
}

const tarball = join(work, `opencode2-${arch}.tgz`);
await download(source.url, tarball, source.sha256, `opencode2 ${arch} platform package`);
const extracted = join(work, "package-root");
mkdirSync(extracted, { recursive: true });
const untar = spawnSync(tarPath(), ["-xzf", tarball, "-C", extracted], { stdio: "inherit", shell: false });
if (untar.status !== 0) throw new Error(`tar failed with exit code ${untar.status}`);

const binary = join(extracted, "package", "bin", "opencode2.exe");
if (!existsSync(binary)) throw new Error("the platform package did not contain bin/opencode2.exe");
cpSync(binary, join(stage, "opencode2.exe"));
assertPeArchitecture(join(stage, "opencode2.exe"), arch);

// The staged binary must BE the pin, and must run on this machine — asked, not assumed.
// This probe's one job is catching an incoherent pin (sha bumped, version field stale), so
// the match is boundary-anchored: a stale version that happens to prefix the new build's
// must not pass. Executable when the arches match, and on ARM64 hosts too — Windows on ARM
// runs x64 under emulation, which is the packaged story (see package-windows.mjs).
if (arch === process.arch || process.arch === "arm64") {
  const probe = spawnSync(join(stage, "opencode2.exe"), ["--version"], { encoding: "utf8", shell: false, timeout: 30_000 });
  const reported = (probe.stdout ?? "").trim();
  const pinned = new RegExp(`(^|[\\s v])${metadata.opencode2.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|\\s)`);
  if (probe.status !== 0 || !pinned.test(reported)) {
    throw new Error(
      `staged opencode2 did not answer with the pinned version: expected ${metadata.opencode2.version}, got "${reported || probe.stderr || "no output"}"`,
    );
  }
}

await download(
  metadata.opencode2.license.url,
  join(stage, "LICENSE.opencode2.txt"),
  metadata.opencode2.license.sha256,
  "opencode2 licence text",
);

writeFileSync(
  join(stage, "runtime-manifest.json"),
  `${JSON.stringify(
    manifestFor(stage, { schemaVersion: 1, component: "opencode2", arch, version: metadata.opencode2.version }),
    null,
    2,
  )}\n`,
);

const attic = join(desktopRoot, ".runtime-previous");
swapStagedDirectory(stage, staged, join(attic, "opencode2"));
rmSync(attic, { recursive: true, force: true });

console.log(`[prepare-opencode2] staged verified opencode2 ${metadata.opencode2.version} (${arch})`);
