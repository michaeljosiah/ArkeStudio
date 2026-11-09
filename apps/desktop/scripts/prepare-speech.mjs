import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertPeArchitecture, assertSha256, manifestFor, swapStagedDirectory, verifyManifest } from "./runtime-support.mjs";
import { verifySpeechRuntime } from "./verify-speech-runtime.mjs";
import { findCmake } from "./find-cmake.mjs";

const args = process.argv.slice(2);
const value = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
if (process.platform !== "win32" || value("--arch") !== "x64") throw new Error("Managed speech currently requires Windows x64");
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(desktop, "../../packages/voice/runtime");
const metadata = JSON.parse(readFileSync(join(desktop, "speech-runtime-sources.json"), "utf8"));
const workRoot = resolve(value("--work") ?? join(desktop, "../../.runtime-work/speech"));
const downloads = resolve(value("--downloads") ?? join(workRoot, "downloads"));
mkdirSync(workRoot, { recursive: true }); mkdirSync(downloads, { recursive: true });
const work = mkdtempSync(join(workRoot, "build-")), fresh = join(work, "stage");
mkdirSync(fresh);
const tar = join(process.env.SystemRoot, "System32/tar.exe");
function run(command, argv, options = {}) {
  const result = spawnSync(command, argv, { cwd: source, stdio: "inherit", shell: false, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
}
function auditPython(python, argv) {
  // Qualification observed one silent native startup exit on a fresh copy. Retry
  // only that silent failure; a Python audit finding fails at once.
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = spawnSync(python, argv, { cwd: source, encoding: "utf8", maxBuffer: 2 * 1024 * 1024, timeout: 60_000 });
    if (result.error) throw result.error;
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.status === 0) return;
    if (result.stdout || result.stderr || attempt === 2) throw new Error(`Private Python audit failed (${result.status})`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
}
async function download(name, url, hash) {
  const path = join(downloads, name);
  if (!existsSync(path)) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${name} download failed (${response.status})`);
    writeFileSync(path, Buffer.from(await response.arrayBuffer()));
  }
  assertSha256(path, hash, name); return path;
}
const archive = await download("python.tar.gz", metadata.python.url, metadata.python.sha256);
run(tar, ["-xf", archive, "-C", fresh]);
const python = join(fresh, "python/python.exe");
assertPeArchitecture(python, "x64");
const requirementFile = join(source, "requirements-win-x64.txt");
const requirementHash = createHash("sha256").update(readFileSync(requirementFile, "utf8").replaceAll("\r\n", "\n")).digest("hex");
if (requirementHash !== metadata.requirementsSha256) throw new Error("The managed speech requirements changed without updating their source pin");
const upstream = await download("faster_whisper-1.2.1-py3-none-any.whl", metadata.fasterWhisper.upstreamUrl, metadata.fasterWhisper.upstreamSha256);
const wheels = join(work, "wheels");
run(python, ["-E", "-s", join(source, "patch_whisper.py"), upstream, wheels]);
const adapted = join(wheels, `faster_whisper-${metadata.fasterWhisper.version}-py3-none-any.whl`);
assertSha256(adapted, metadata.fasterWhisper.wheelSha256, "adapted Faster Whisper");
run(python, ["-E", "-s", "-m", "pip", "--isolated", "install", "--disable-pip-version-check", "--no-deps", "--no-compile", adapted]);
const docoptSource = await download("docopt-0.6.2.tar.gz", metadata.docopt.url, metadata.docopt.sha256);
run(python, ["-E", "-s", join(source, "patch_whisper.py"), docoptSource, wheels, "--docopt"]);
const docoptWheel = join(wheels, "docopt-0.6.2-py3-none-any.whl");
assertSha256(docoptWheel, metadata.docopt.wheelSha256, "pure docopt wheel");
run(python, ["-E", "-s", "-m", "pip", "--isolated", "install", "--disable-pip-version-check", "--no-deps", "--no-compile", docoptWheel]);
run(python, ["-E", "-s", "-m", "pip", "--isolated", "install", "--disable-pip-version-check", "--no-warn-script-location",
  "--only-binary=:all:", "--require-hashes", "--no-deps", "--no-compile", "--cache-dir", join(downloads, "pip"), "-r", requirementFile]);
run(python, ["-E", "-s", "-m", "pip", "check"]);

const notices = join(fresh, "THIRD-PARTY-NOTICES"), sources = join(notices, "source");
mkdirSync(sources, { recursive: true });
for (const item of metadata.sources) {
  cpSync(await download(item.file, item.url, item.sha256), join(sources, item.file));
}
// The stock libsndfile wheel statically embeds several more codecs. Build only
// the WAV/PCM helper Pipecat needs; compressed browser audio uses separate FFmpeg.
const sndSourceRoot = join(work, "sndfile-source"); mkdirSync(sndSourceRoot);
run(tar, ["-xf", join(sources, "libsndfile-1.2.2.tar.xz"), "-C", sndSourceRoot]);
const sndSource = join(sndSourceRoot, "libsndfile-1.2.2"), sndBuild = join(work, "sndfile-build");
const cmake = findCmake(value("--cmake"));
const cmakeArgs = ["-S", sndSource, "-B", sndBuild, "-A", "x64", "-DBUILD_SHARED_LIBS=ON", "-DENABLE_EXTERNAL_LIBS=OFF",
  "-DENABLE_MPEG=OFF", "-DBUILD_PROGRAMS=OFF", "-DBUILD_EXAMPLES=OFF", "-DBUILD_TESTING=OFF", "-DCMAKE_POLICY_VERSION_MINIMUM=3.5"];
run(cmake, cmakeArgs);
run(cmake, ["--build", sndBuild, "--config", "Release", "--parallel", "2"]);
const sndDll = join(sndBuild, "Release/sndfile.dll");
assertPeArchitecture(sndDll, "x64");
cpSync(sndDll, join(fresh, "python/Lib/site-packages/_soundfile_data/libsndfile_x64.dll"));
cpSync(join(sndSource, "COPYING"), join(notices, "LICENSE.libsndfile.txt"));
writeFileSync(join(notices, "LIBSNDFILE-BUILD.txt"), `Arke builds libsndfile 1.2.2 from the accompanying verified source archive.\nMSVC x64, CMake arguments: ${cmakeArgs.slice(6).join(" ")}\nCompressed codec dependencies are disabled.\nThe result replaces soundfile's bundled libsndfile_x64.dll; soundfile Python sources are unchanged.\n`);

const alignment = join(work, "alignment");
run(process.execPath, [join(desktop, "scripts/prepare-alignment.mjs"), "--arch", "x64", "--work", join(work, "alignment-work"), "--output", alignment,
  ...(value("--packages") ? ["--packages", value("--packages")] : []), ...(value("--source") ? ["--source", value("--source")] : [])]);
cpSync(alignment, join(fresh, "alignment"), { recursive: true });
// Reuse the already verified VC runtime for every native Python extension. No
// globally installed developer runtime or GPU/Intel redistributable is required.
for (const file of ["msvcp140.dll", "msvcp140_1.dll", "vcruntime140.dll", "vcruntime140_1.dll", "vcomp140.dll"])
  cpSync(join(alignment, file), join(fresh, "python", file));
const cpuSource = join(work, "ctranslate2-source");
for (const item of metadata.cpuRecognizer.archives) {
  const archive = await download(item.file, item.url, item.sha256);
  cpSync(archive, join(sources, item.file));
  const target = join(cpuSource, item.target); mkdirSync(target, { recursive: true });
  run(tar, ["-xf", archive, "-C", target, "--strip-components", "1"]);
}
const cpuBuild = join(work, "ctranslate2-build");
const cpuFlags = ["-DCMAKE_POLICY_VERSION_MINIMUM=3.5", "-DBUILD_CLI=OFF", "-DBUILD_TESTS=OFF", "-DWITH_MKL=OFF",
  "-DWITH_DNNL=OFF", "-DWITH_CUDA=OFF", "-DWITH_CUDNN=OFF", "-DWITH_OPENBLAS=OFF", "-DWITH_RUY=ON", "-DOPENMP_RUNTIME=COMP"];
run(cmake, ["-S", cpuSource, "-B", cpuBuild, "-A", "x64", ...cpuFlags]);
run(cmake, ["--build", cpuBuild, "--config", "Release", "--parallel", "2"]);
const nativeRecognizer = join(cpuBuild, "Release/ctranslate2.dll");
assertPeArchitecture(nativeRecognizer, "x64");
const ctPackage = join(fresh, "python/Lib/site-packages/ctranslate2");
cpSync(nativeRecognizer, join(ctPackage, "ctranslate2.dll"));
for (const file of ["cudnn64_9.dll", "libiomp5md.dll"]) if (existsSync(join(ctPackage, file))) rmSync(join(ctPackage, file));
writeFileSync(join(notices, "CPU-RECOGNIZER-BUILD.txt"), `CTranslate2 ${metadata.cpuRecognizer.commit}\nCMake MSVC x64 Release: ${cpuFlags.join(" ")}\nThe unmodified Python extension uses this CPU-only Ruy library. Intel MKL/OpenMP and NVIDIA libraries are not redistributed.\nAll exact build sources, including CPU submodules, accompany this copy.\n`);
function collectNotices(directory, prefix = "native") {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name), key = `${prefix}-${entry.name}`;
    if (entry.isDirectory()) collectNotices(path, key);
    else if (/^(license|copying|notice)/i.test(entry.name)) cpSync(path, join(notices, key));
  }
}
collectNotices(cpuSource);
for (const item of metadata.packageNotices) {
  const path = resolve(desktop, "../../licenses/speech", item.file);
  assertSha256(path, item.sha256, item.file); cpSync(path, join(notices, item.file));
}
const app = join(fresh, "app"); mkdirSync(app);
for (const file of ["service.py", "engines.py", "decoder.py", "alignment.py", "kokoro-vocab.json", "NOTICE.txt", "live.py", "smoke.py", "smoke_live.py"]) {
  cpSync(join(source, file), join(app, file));
}
for (const file of ["patch_whisper.py", "pyproject.toml", "uv.lock", "requirements-win-x64.txt"]) cpSync(join(source, file), join(sources, file));
cpSync(join(desktop, "scripts/prepare-speech.mjs"), join(sources, "prepare-speech.mjs"));
cpSync(join(desktop, "speech-runtime-sources.json"), join(notices, "SOURCES.json"));
auditPython(python, ["-E", "-s", "-B", join(source, "audit_runtime.py"), "--notices", notices, "--output", join(notices, "PYTHON-PACKAGES.json")]);
writeFileSync(join(notices, "REPLACEMENT.txt"), "LGPL components remain replaceable files in python/Lib/site-packages. Their licence texts and complete native sources/build instructions accompany this runtime. You may modify, rebuild, replace and debug these components under their licences; no Arke term restricts the reverse engineering required for that purpose. FFmpeg and espeak remain separate executables. No PyAV/FFmpeg library is bundled in this Python process.\n");
writeFileSync(join(fresh, "runtime-manifest.json"), JSON.stringify(manifestFor(fresh, {
  schemaVersion: 1, name: "pipecat-speech", arch: "x64", protocolVersion: 1, python: metadata.python.version,
  pipecat: "1.15.0", recognizer: metadata.fasterWhisper.version, requirementsSha256: requirementHash,
}), null, 2) + "\n");
verifyManifest(fresh);
verifySpeechRuntime(fresh, "x64");
const stage = resolve(value("--output") ?? join(desktop, "build-resources/speech/x64"));
swapStagedDirectory(fresh, stage, `${stage}.previous`);
console.log(`Verified private speech runtime staged: ${stage}`);
