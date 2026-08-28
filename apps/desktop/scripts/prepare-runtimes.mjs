import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
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

const arch = value("--arch");
if (!arch || !SUPPORTED_ARCHES.has(arch)) throw new Error("--arch must be x64 or arm64");
if (process.platform !== "win32") throw new Error("Windows runtime preparation must run on Windows");

const work = resolve(value("--work") ?? join(repoRoot, ".runtime-work", arch));
const staged = join(desktopRoot, "build-resources");
/*
 * Everything is built inside the work directory and swapped into build-resources at the very end
 * (#581). This script used to clear the staged directories right here, before the first download
 * ran, so the day the pinned ffmpeg release was deleted upstream the clear still happened and the
 * download then 404'd -- taking a working staged copy with it and leaving the retry worse off
 * than the first attempt. See swapStagedDirectory.
 *
 * ffmpeg stages flat rather than per-architecture, because main.ts looks for
 * `resources/ffmpeg/ffmpeg.exe` and electron-builder copies this directory wholesale. One
 * architecture is prepared per invocation, so the directory is replaced wholesale each time.
 */
const voxaStage = join(work, "stage", "voxa");
const espeakStage = join(work, "stage", "espeak-ng");
const ffmpegStage = join(work, "stage", "ffmpeg");
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
mkdirSync(ffmpegStage, { recursive: true });
mkdirSync(voxaStage, { recursive: true });
mkdirSync(espeakStage, { recursive: true });

function run(command, commandArgs, options = {}) {
  const result = spawnSync(commandPath(command), commandArgs, {
    cwd: options.cwd ?? repoRoot,
    stdio: "inherit",
    shell: false,
    env: options.env ?? process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}`);
}

function commandPath(command) {
  // Windows ships bsdtar at a known path, and it is the one this script means. A shell whose
  // PATH prefers GNU tar — Git Bash and MSYS2 both do — reads the `C:` in an absolute archive
  // path as a remote host and fails with "Cannot connect to C: resolve failed". Resolving the
  // binary rather than escaping the path: `--force-local` would cure GNU tar and bsdtar rejects
  // the flag outright, so the flag cannot be passed unconditionally.
  if (command === "tar.exe") {
    const system32 = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "tar.exe");
    return existsSync(system32) ? system32 : command;
  }
  if (command !== "cmake.exe") return command;
  const candidates = [
    command,
    join(process.env["ProgramFiles"] ?? "C:\\Program Files", "CMake", "bin", "cmake.exe"),
    join(process.env["ProgramFiles"] ?? "C:\\Program Files", "Microsoft Visual Studio", "18", "Community", "Common7", "IDE", "CommonExtensions", "Microsoft", "CMake", "CMake", "bin", "cmake.exe"),
    join(process.env["ProgramFiles"] ?? "C:\\Program Files", "Microsoft Visual Studio", "2022", "Community", "Common7", "IDE", "CommonExtensions", "Microsoft", "CMake", "CMake", "bin", "cmake.exe"),
  ];
  return candidates.find(existsSync) ?? command;
}

async function download(url, path, expected, label) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${label} download failed (HTTP ${response.status})`);
  writeFileSync(path, Buffer.from(await response.arrayBuffer()));
  assertSha256(path, expected, label);
}

function extract(archive, destination) {
  mkdirSync(destination, { recursive: true });
  run("tar.exe", ["-xf", archive, "-C", destination]);
}

function copyDirectoryContents(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) cpSync(join(from, entry), join(to, entry), { recursive: true });
}

function pruneForeignRuntimes(root) {
  const runtimes = join(root, "runtimes");
  if (!existsSync(runtimes)) return;
  const keep = `win-${arch}`;
  for (const entry of readdirSync(runtimes)) {
    if (entry !== keep) rmSync(join(runtimes, entry), { recursive: true, force: true });
  }
}

/**
 * The GPLv2 section 3(b) offer, valid three years from the build that carries it.
 *
 * Written out with the build's own version and commit in it, so a copy found on a disk years
 * from now names exactly which binaries it answers for rather than pointing at whatever the
 * project happens to ship by then.
 */
function writtenOffer(ffmpeg) {
  return [
    "WRITTEN OFFER FOR CORRESPONDING SOURCE CODE",
    "",
    `This copy of Arke Studio includes ffmpeg ${ffmpeg.version} (build ${ffmpeg.release}), a GPL`,
    "build which contains GPL-licensed components including libx264. ffmpeg is invoked as a",
    "separate subprocess and is never linked into Arke Studio itself.",
    "",
    `The complete corresponding source for FFmpeg is included beside this file as`,
    `SOURCE-ffmpeg-${ffmpeg.commit}.tar.gz.`,
    "",
    "For any other GPL-licensed component of these binaries -- including libx264 and the exact",
    "build scripts, configuration and patches used to produce them -- the copyright holder hereby",
    "offers, valid for three years from the date this copy was distributed, to give any third",
    "party a complete machine-readable copy of the corresponding source code, for no more than",
    "the cost of physically performing source distribution.",
    "",
    "To request it, open an issue at:",
    "  https://github.com/michaeljosiah/ArkeStudio/issues",
    "",
    "This offer is made under section 3(b) of the GNU General Public License version 2, and",
    "extends to anyone in possession of this copy, whether or not they obtained it directly.",
    "",
  ].join(String.fromCharCode(13, 10));
}

function writeManifest(root, component, extra) {
  writeFileSync(
    join(root, "runtime-manifest.json"),
    `${JSON.stringify(manifestFor(root, { schemaVersion: 1, component, arch, ...extra }), null, 2)}\n`,
  );
}

function stageVoxaNotices(root) {
  const notices = join(root, "THIRD-PARTY-NOTICES");
  mkdirSync(notices, { recursive: true });
  const deps = JSON.parse(readFileSync(join(root, "Voxa.ArkeSidecar.deps.json"), "utf8"));
  const packages = Object.entries(deps.libraries)
    .filter(([, value]) => value.type === "package")
    .map(([id, value]) => ({ id, path: value.path }));
  const rows = [];
  const mitText = `Permission is hereby granted, free of charge, to any person obtaining a copy\n` +
    `of this software and associated documentation files (the "Software"), to deal\n` +
    `in the Software without restriction, including without limitation the rights\n` +
    `to use, copy, modify, merge, publish, distribute, sublicense, and/or sell\n` +
    `copies of the Software, and to permit persons to whom the Software is\n` +
    `furnished to do so, subject to the following conditions:\n\n` +
    `The above copyright notice and this permission notice shall be included in all\n` +
    `copies or substantial portions of the Software.\n\n` +
    `THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\n` +
    `IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\n` +
    `FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\n` +
    `AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\n` +
    `LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\n` +
    `OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\n` +
    `SOFTWARE.\n`;
  for (const item of packages) {
    const packageRoot = join(process.env["USERPROFILE"], ".nuget", "packages", ...item.path.split("/"));
    const nuspec = readdirSync(packageRoot).find((name) => name.endsWith(".nuspec"));
    if (!nuspec) throw new Error(`${item.id} has no restored NuGet metadata`);
    const xml = readFileSync(join(packageRoot, nuspec), "utf8");
    const license = /<license[^>]*type="([^"]+)"[^>]*>([^<]+)<\/license>/i.exec(xml);
    if (!license) throw new Error(`${item.id} has no declared NuGet licence`);
    rows.push(`${item.id} | ${license[1]}: ${license[2]}`);
    const candidates = readdirSync(packageRoot).filter((name) => /^(license|third.?party)/i.test(name));
    for (const candidate of candidates) {
      if (statSync(join(packageRoot, candidate)).isFile()) {
        cpSync(join(packageRoot, candidate), join(notices, `${item.id.replaceAll("/", "-")}--${candidate}`));
      }
    }
    if (license[1].toLowerCase() === "expression" && license[2].toUpperCase() === "MIT" && candidates.length === 0) {
      const authors = /<authors>([^<]+)<\/authors>/i.exec(xml)?.[1] ?? "the package authors";
      writeFileSync(
        join(notices, `${item.id.replaceAll("/", "-")}--LICENSE.txt`),
        `Copyright (c) ${authors}\n\n${mitText}`,
      );
    }
  }
  writeFileSync(join(notices, "PACKAGES.txt"), `${rows.sort().join("\n")}\n`);
  for (const [source, target] of [
    [join(process.env["ProgramFiles"], "dotnet", "LICENSE.txt"), "DOTNET-LICENSE.txt"],
    [join(process.env["ProgramFiles"], "dotnet", "ThirdPartyNotices.txt"), "DOTNET-THIRD-PARTY-NOTICES.txt"],
  ]) {
    if (!existsSync(source)) throw new Error(`${target} is unavailable from the pinned .NET SDK`);
    cpSync(source, join(notices, target));
  }
}

const localVoxa = value("--voxa-source") ?? process.env["ARKE_VOXA_SOURCE"];
const voxaSource = join(work, "voxa-source");
if (localVoxa) {
  cpSync(resolve(localVoxa), voxaSource, { recursive: true, filter: (source) => !/[\\/](bin|obj|\.git)[\\/]?$/.test(source) });
} else {
  run("git.exe", ["clone", "--filter=blob:none", "--no-checkout", metadata.voxa.repository, voxaSource]);
  run("git.exe", ["checkout", "--detach", metadata.voxa.commit], { cwd: voxaSource });
}

const dotnetVersion = spawnSync("dotnet.exe", ["--version"], { encoding: "utf8", shell: false });
const actualDotnetSdk = dotnetVersion.stdout.trim();
if (dotnetVersion.status !== 0 || !actualDotnetSdk.startsWith(`${metadata.dotnetSdkFeatureBand}.`)) {
  throw new Error(`dotnet ${metadata.dotnetSdkFeatureBand}.x is required, got ${actualDotnetSdk || "unavailable"}`);
}
const rid = `win-${arch}`;
run(
  "dotnet.exe",
  [
    "publish",
    join(voxaSource, metadata.voxa.project),
    "-c",
    "Release",
    "-r",
    rid,
    "--self-contained",
    "true",
    "-p:PublishSingleFile=false",
    "-p:DebugSymbols=false",
    "-p:DebugType=None",
    "-p:ContinuousIntegrationBuild=true",
    "-o",
    voxaStage,
  ],
  { cwd: voxaSource },
);
pruneForeignRuntimes(voxaStage);
const publishedVoxa = join(voxaStage, "Voxa.ArkeSidecar.exe");
if (!existsSync(publishedVoxa)) throw new Error("Voxa publish did not produce Voxa.ArkeSidecar.exe");
renameSync(publishedVoxa, join(voxaStage, "voxa.exe"));
cpSync(join(voxaSource, "LICENSE"), join(voxaStage, "LICENSE.voxa.txt"));
stageVoxaNotices(voxaStage);
const vcRuntimeArchive = join(work, `vclibs-${arch}.appx`);
await download(
  metadata.voxa.vcRuntime[arch].url,
  vcRuntimeArchive,
  metadata.voxa.vcRuntime[arch].sha256,
  `Microsoft VC runtime ${arch}`,
);
const vcRuntimeExtracted = join(work, `vclibs-${arch}`);
extract(vcRuntimeArchive, vcRuntimeExtracted);
const vcRuntimeFiles = [
  "msvcp140.dll",
  "msvcp140_1.dll",
  "vcruntime140.dll",
  ...(arch === "x64" ? ["vcruntime140_1.dll"] : []),
  "vcomp140.dll",
];
for (const file of vcRuntimeFiles) {
  cpSync(join(vcRuntimeExtracted, file), join(voxaStage, file));
  assertPeArchitecture(join(voxaStage, file), arch);
}
writeFileSync(
  join(voxaStage, "LICENSE.microsoft-vclibs.txt"),
  "Microsoft Visual C++ Redistributable runtime files. See https://visualstudio.microsoft.com/license-terms/.\n",
);
assertPeArchitecture(join(voxaStage, "voxa.exe"), arch);
for (const native of ["onnxruntime.dll", "onnxruntime_providers_shared.dll"]) {
  const path = join(voxaStage, native);
  if (existsSync(path)) assertPeArchitecture(path, arch);
}
writeManifest(voxaStage, "voxa", {
  version: metadata.voxa.version,
  protocolVersion: metadata.voxa.protocolVersion,
  sourceCommit: metadata.voxa.commit,
  dotnetSdk: actualDotnetSdk,
});

const espeakArchive = join(work, basename(metadata.espeakNg.windowsX64Url));
await download(
  metadata.espeakNg.windowsX64Url,
  espeakArchive,
  metadata.espeakNg.windowsX64Sha256,
  "espeak-ng Windows runtime",
);
const espeakExtracted = join(work, "espeak-x64");
extract(espeakArchive, espeakExtracted);
const piperRoot = join(espeakExtracted, "piper-phonemize");
copyDirectoryContents(join(piperRoot, "share"), join(espeakStage, "share"));
const sourceArchive = join(work, "espeak-ng-source.zip");
await download(metadata.espeakNg.sourceUrl, sourceArchive, metadata.espeakNg.sourceSha256, "espeak-ng source");
const sourceExtracted = join(work, "espeak-source");
extract(sourceArchive, sourceExtracted);
const sourceRoot = join(sourceExtracted, readdirSync(sourceExtracted)[0]);

if (arch === "x64") {
  cpSync(join(piperRoot, "bin", "espeak-ng.exe"), join(espeakStage, "espeak-ng.exe"));
  cpSync(join(piperRoot, "bin", "espeak-ng.dll"), join(espeakStage, "espeak-ng.dll"));
} else {
  const packages = join(work, "msys2-arm64");
  mkdirSync(packages, { recursive: true });
  for (const [index, artifact] of metadata.espeakNg.windowsArm64Packages.entries()) {
    const archive = join(work, `arm64-runtime-${index}.pkg.tar.zst`);
    await download(artifact.url, archive, artifact.sha256, `ARM64 runtime package ${index + 1}`);
    extract(archive, packages);
  }
  const bin = join(packages, "clangarm64", "bin");
  for (const file of ["espeak-ng.exe", "libespeak-ng.dll", "libpcaudio-0.dll", "libc++.dll"]) {
    cpSync(join(bin, file), join(espeakStage, file));
    assertPeArchitecture(join(espeakStage, file), "arm64");
  }
  const packageData = join(packages, "clangarm64", "share", "espeak-ng-data");
  rmSync(join(espeakStage, "share", "espeak-ng-data"), { recursive: true, force: true });
  cpSync(packageData, join(espeakStage, "share", "espeak-ng-data"), { recursive: true });
  cpSync(join(packages, "clangarm64", "share", "licenses", "pcaudiolib", "COPYING"), join(espeakStage, "LICENSE.pcaudiolib.txt"));
  cpSync(join(packages, "clangarm64", "share", "licenses", "libc++", "LICENSE"), join(espeakStage, "LICENSE.libc++.txt"));
  for (const [index, artifact] of metadata.espeakNg.windowsArm64Sources.entries()) {
    const source = join(espeakStage, `SOURCE-arm64-dependency-${index + 1}.src.tar.zst`);
    await download(artifact.url, source, artifact.sha256, `ARM64 source package ${index + 1}`);
  }
}

const espeakExe = join(espeakStage, "espeak-ng.exe");
if (!existsSync(espeakExe)) throw new Error("espeak-ng staging is missing espeak-ng.exe");
assertPeArchitecture(espeakExe, arch);
cpSync(join(sourceRoot, "COPYING"), join(espeakStage, "LICENSE.espeak-ng.txt"));
cpSync(sourceArchive, join(espeakStage, "SOURCE-espeak-ng-1.52.0.zip"));
writeManifest(espeakStage, "espeak-ng", {
  version: metadata.espeakNg.version,
  sourceRevision: arch === "x64" ? metadata.espeakNg.commit : "MSYS2 g0d451f8c + pinned dependency packages",
});

/*
 * ffmpeg and ffprobe (#279).
 *
 * Nothing staged these before, so `build-resources/ffmpeg` never existed, electron-builder logged
 * "file source doesn't exist" and packaged happily, and every released installer had export
 * silently unavailable -- the absence was stated in the UI rather than crashed on, which is why it
 * went unnoticed through two releases.
 *
 * A GPL build, deliberately: libx264 is GPL-only and the export presets are written around -crf,
 * which an LGPL build accepts and then ignores, producing output whose quality setting means
 * nothing. It is invoked as a separate executable and never linked, the arrangement espeak-ng
 * already makes here.
 */
const ffmpegSource = metadata.ffmpeg[arch];
if (!ffmpegSource) throw new Error(`no pinned ffmpeg build for ${arch}`);
const ffmpegArchive = join(work, `ffmpeg-${arch}.zip`);
await download(ffmpegSource.url, ffmpegArchive, ffmpegSource.sha256, `ffmpeg ${arch}`);
const ffmpegWork = join(work, "ffmpeg");
rmSync(ffmpegWork, { recursive: true, force: true });
extract(ffmpegArchive, ffmpegWork);
const ffmpegRoot = join(ffmpegWork, readdirSync(ffmpegWork)[0]);
const ffmpegBin = join(ffmpegRoot, "bin");
for (const entry of readdirSync(ffmpegBin)) {
  // ffplay is a media player, not part of what Arke invokes; shipping it is 30MB of surface for
  // a feature that does not exist.
  if (entry === "ffplay.exe") continue;
  cpSync(join(ffmpegBin, entry), join(ffmpegStage, entry));
}
for (const binary of ["ffmpeg.exe", "ffprobe.exe"]) {
  const staged = join(ffmpegStage, binary);
  if (!existsSync(staged)) throw new Error(`ffmpeg staging is missing ${binary}`);
  assertPeArchitecture(staged, arch);
}
cpSync(join(ffmpegRoot, "LICENSE.txt"), join(ffmpegStage, "LICENSE.ffmpeg.txt"));
/*
 * GPL corresponding source, in two parts.
 *
 * FFmpeg's own source ships beside the binary, pinned to the commit the build reports. That is
 * not the whole obligation: this is a GPL build, so libx264 is compiled *into* avcodec rather
 * than sitting beside it as a separate file, and Arke redistributes x264's code whether or not
 * it can point at a file containing it (Codex round 1). The revision BtbN built cannot be read
 * off the release, and shipping some other x264 tarball would look like compliance without being
 * it -- so everything the archive does not cover is carried by a written offer under GPLv2
 * section 3(b), which is a real obligation with a real duration rather than a formality.
 */
await download(
  metadata.ffmpeg.sourceUrl,
  join(ffmpegStage, `SOURCE-ffmpeg-${metadata.ffmpeg.commit}.tar.gz`),
  metadata.ffmpeg.sourceSha256,
  "ffmpeg source",
);
writeFileSync(join(ffmpegStage, "WRITTEN-OFFER.ffmpeg.txt"), writtenOffer(metadata.ffmpeg));
writeManifest(ffmpegStage, "ffmpeg", { version: metadata.ffmpeg.version, sourceRevision: metadata.ffmpeg.release });

/*
 * All three components are downloaded, checksummed, architecture-checked and manifested; only
 * now does build-resources change. Held to the end rather than swapped as each finishes, so that
 * a failure in the third leaves the other two exactly as they were -- a mixed-vintage stage is
 * harmless, but there is no reason to create one.
 */
const attic = join(desktopRoot, ".runtime-previous");
for (const [component, fresh, destination] of [
  ["voxa", voxaStage, join(staged, "voxa", arch)],
  ["espeak-ng", espeakStage, join(staged, "espeak-ng", arch)],
  ["ffmpeg", ffmpegStage, join(staged, "ffmpeg")],
]) {
  swapStagedDirectory(fresh, destination, join(attic, component));
}
rmSync(attic, { recursive: true, force: true });

console.log(`[prepare-runtimes] staged verified ${arch} Voxa, espeak-ng and ffmpeg runtimes`);
