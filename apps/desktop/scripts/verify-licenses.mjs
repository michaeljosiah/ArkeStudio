// The licence gate (SPEC-016 R-9, D5): every component present in build-resources/ must have
// its obligations recorded in THIRD-PARTY-NOTICES.md BEFORE it may be bundled. A missing row
// fails the package step — a licence question found here is a task, not a shipping delay.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { assertPeArchitecture, verifyManifest } from "./runtime-support.mjs";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const noticesPath = resolve(here, "../../../THIRD-PARTY-NOTICES.md");
const buildResources = resolve(here, "../build-resources");

// build-resources subdirectory → the notice row that must exist for it.
const REQUIRED_ROW = {
  opencode: "OpenCode",
  opencode2: "OpenCode 2",
  voxa: "Voxa",
  ffmpeg: "ffmpeg",
  "espeak-ng": "espeak-ng",
};

const notices = readFileSync(noticesPath, "utf8");
const failures = [];

// Components always in the bundle regardless of build-resources.
for (const always of ["better-sqlite3", "Electron", "SQLite", "Geist"]) {
  if (!notices.includes(always)) failures.push(`"${always}" ships in every build but has no notice row`);
}

if (existsSync(buildResources)) {
  for (const entry of readdirSync(buildResources, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const required = REQUIRED_ROW[entry.name];
    if (required === undefined) {
      failures.push(`build-resources/${entry.name} is staged for bundling but is not a known component — record it before shipping it`);
      continue;
    }
    if (!notices.includes(required)) {
      failures.push(`build-resources/${entry.name} is staged but "${required}" has no row in THIRD-PARTY-NOTICES.md`);
    }
    // GPL components must carry the never-linked arrangement in their recorded obligations (R-10).
    if (entry.name === "espeak-ng" && !/espeak-ng[^|]*\|[^|]*GPL[^|]*\|[^|]*[Nn]ever linked/s.test(notices)) {
      failures.push("espeak-ng is staged but its notice row does not record the never-linked arrangement (R-10)");
    }
  }
}

// x64 only — the packaged architecture (see scripts/package-windows.mjs). The per-arch shape
// below is kept so that restoring a second target is a one-line change, not a rewrite.
/*
 * The bundled v2 harness is REQUIRED (issue 327 §9). The v1 entry in the yml was specced
 * but never staged, so every installer quietly shipped without a harness and PATH installs
 * covered the gap invisibly — the same silent-absence failure ffmpeg lived through (#279).
 * The harness is what authoring stands on; its absence is a packaging failure, not a state.
 *
 * OUTSIDE the per-arch loop, like ffmpeg: opencode2 stages flat (one directory, the packaged
 * architecture), so an arch-loop check would demand one binary be two architectures the day
 * the arm64 target returns. The packaged arch is asserted at package time (afterPack).
 */
if (process.argv.includes("--require-runtimes")) {
  const opencode2 = join(buildResources, "opencode2");
  if (!existsSync(join(opencode2, "opencode2.exe"))) {
    failures.push("opencode2 runtime is required but opencode2.exe is absent — run prepare:opencode2");
  } else {
    try {
      verifyManifest(opencode2);
    } catch (error) {
      failures.push(`opencode2: ${String(error)}`);
    }
    if (!existsSync(join(opencode2, "LICENSE.opencode2.txt"))) {
      failures.push("opencode2 is staged but its licence text is absent");
    }
  }
}

if (process.argv.includes("--require-runtimes")) for (const arch of ["x64"]) {
  const voxa = join(buildResources, "voxa", arch);
  const espeak = join(buildResources, "espeak-ng", arch);
  for (const [component, root, executable] of [
    ["Voxa", voxa, "voxa.exe"],
    ["espeak-ng", espeak, "espeak-ng.exe"],
  ]) {
    if (!existsSync(join(root, executable))) {
      failures.push(`${component} ${arch} runtime is required but ${executable} is absent`);
      continue;
    }
    if (!existsSync(join(root, "runtime-manifest.json"))) failures.push(`${component} ${arch} has no checksum manifest`);
    else {
      try { verifyManifest(root); } catch (error) { failures.push(`${component} ${arch}: ${String(error)}`); }
    }
    try {
      assertPeArchitecture(join(root, executable), arch);
    } catch (error) {
      failures.push(String(error));
    }
  }
  if (!existsSync(join(voxa, "LICENSE.voxa.txt"))) failures.push(`Voxa ${arch} licence text is absent`);
  if (!existsSync(join(voxa, "THIRD-PARTY-NOTICES", "PACKAGES.txt"))) failures.push(`Voxa ${arch} dependency notice index is absent`);
  if (!existsSync(join(voxa, "THIRD-PARTY-NOTICES", "DOTNET-LICENSE.txt"))) failures.push(`Voxa ${arch} .NET licence is absent`);
  if (!existsSync(join(voxa, "THIRD-PARTY-NOTICES", "DOTNET-THIRD-PARTY-NOTICES.txt"))) failures.push(`Voxa ${arch} .NET notices are absent`);
  if (existsSync(join(voxa, "THIRD-PARTY-NOTICES", "PACKAGES.txt"))) {
    for (const row of readFileSync(join(voxa, "THIRD-PARTY-NOTICES", "PACKAGES.txt"), "utf8").trim().split("\n")) {
      const packageId = row.split(" | ")[0];
      const prefix = packageId.replaceAll("/", "-") + "--";
      if (!readdirSync(join(voxa, "THIRD-PARTY-NOTICES")).some((name) => name.startsWith(prefix))) {
        failures.push(`Voxa ${arch} dependency ${packageId} has no retained licence text`);
      }
    }
  }
  if (!existsSync(join(voxa, "LICENSE.microsoft-vclibs.txt"))) failures.push(`Microsoft VC runtime ${arch} notice is absent`);
  for (const runtime of [
    "msvcp140.dll", "msvcp140_1.dll", "vcruntime140.dll",
    ...(arch === "x64" ? ["vcruntime140_1.dll"] : []), "vcomp140.dll",
  ]) {
    if (!existsSync(join(voxa, runtime))) failures.push(`Voxa ${arch} native dependency ${runtime} is absent`);
  }
  if (!existsSync(join(espeak, "LICENSE.espeak-ng.txt"))) failures.push(`espeak-ng ${arch} licence/source offer is absent`);
  if (!existsSync(join(espeak, "SOURCE-espeak-ng-1.52.0.zip"))) failures.push(`espeak-ng ${arch} source archive is absent`);
  if (arch === "arm64") {
    if (!existsSync(join(espeak, "LICENSE.pcaudiolib.txt"))) failures.push("ARM64 pcaudiolib licence text is absent");
    if (!existsSync(join(espeak, "LICENSE.libc++.txt"))) failures.push("ARM64 libc++ licence text is absent");
    if (!existsSync(join(espeak, "SOURCE-arm64-dependency-1.src.tar.zst"))) failures.push("ARM64 espeak source package is absent");
    if (!existsSync(join(espeak, "SOURCE-arm64-dependency-2.src.tar.zst"))) failures.push("ARM64 pcaudiolib source package is absent");
  }
  if (!existsSync(join(espeak, "share", "espeak-ng-data"))) failures.push(`espeak-ng ${arch} data directory is absent`);
}

if (failures.length > 0) {
  console.error("licence gate FAILED (SPEC-016 R-9):");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("licence gate: every bundled component has recorded obligations");
