import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertPeArchitecture, assertSha256, manifestFor, swapStagedDirectory, verifyManifest } from "./runtime-support.mjs";

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
const cmake = value("--cmake") ?? join(process.env.ProgramFiles, "Microsoft Visual Studio/18/Community/Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe");
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
const app = join(fresh, "app"); mkdirSync(app);
for (const file of ["service.py", "engines.py", "decoder.py", "alignment.py", "kokoro-vocab.json", "NOTICE.txt", "live.py"]) {
  if (file === "live.py" && !existsSync(join(source, file))) continue;
  cpSync(join(source, file), join(app, file));
}
for (const file of ["patch_whisper.py", "pyproject.toml", "uv.lock", "requirements-win-x64.txt"]) cpSync(join(source, file), join(sources, file));
cpSync(join(desktop, "scripts/prepare-speech.mjs"), join(sources, "prepare-speech.mjs"));
cpSync(join(desktop, "speech-runtime-sources.json"), join(notices, "SOURCES.json"));
run(python, ["-E", "-s", "-B", join(source, "audit_runtime.py"), "--output", join(notices, "PYTHON-PACKAGES.json")]);
writeFileSync(join(notices, "REPLACEMENT.txt"), "LGPL components remain replaceable files in python/Lib/site-packages. Their licence texts and complete native sources/build instructions accompany this runtime. You may modify, rebuild, replace and debug these components under their licences; no Arke term restricts the reverse engineering required for that purpose. FFmpeg and espeak remain separate executables. No PyAV/FFmpeg library is bundled in this Python process.\n");
writeFileSync(join(fresh, "runtime-manifest.json"), JSON.stringify(manifestFor(fresh, {
  schemaVersion: 1, name: "pipecat-speech", arch: "x64", protocolVersion: 1, python: metadata.python.version,
  pipecat: "1.15.0", recognizer: metadata.fasterWhisper.version, requirementsSha256: requirementHash,
}), null, 2) + "\n");
verifyManifest(fresh);
const stage = resolve(value("--output") ?? join(desktop, "build-resources/speech/x64"));
swapStagedDirectory(fresh, stage, `${stage}.previous`);
console.log(`Verified private speech runtime staged: ${stage}`);
