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
import { assertPeArchitecture, assertSha256, manifestFor, SUPPORTED_ARCHES } from "./runtime-support.mjs";

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
const voxaStage = join(staged, "voxa", arch);
const espeakStage = join(staged, "espeak-ng", arch);
rmSync(work, { recursive: true, force: true });
rmSync(voxaStage, { recursive: true, force: true });
rmSync(espeakStage, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
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
if (dotnetVersion.status !== 0 || dotnetVersion.stdout.trim() !== metadata.dotnetSdk) {
  throw new Error(`dotnet ${metadata.dotnetSdk} is required, got ${dotnetVersion.stdout.trim() || "unavailable"}`);
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

console.log(`[prepare-runtimes] staged verified ${arch} Voxa and espeak-ng runtimes`);
