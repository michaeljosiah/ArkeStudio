import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { stageDotnetNotices } from "./dotnet-notices.mjs";
import { assertPeArchitecture, assertSha256, manifestFor, swapStagedDirectory, verifyManifest } from "./runtime-support.mjs";

// Build only the qualified target. Compiling an ARM executable is not qualification
// of its native recognition dependencies; ARM keeps its existing backend.
const args = process.argv.slice(2);
const value = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
if (process.platform !== "win32" || value("--arch") !== "x64") throw new Error("Alignment preparation currently requires Windows x64");
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(desktop, "../../packages/voice/runtime/alignment");
const workRoot = resolve(value("--work") ?? resolve(desktop, "../../.runtime-work/alignment"));
mkdirSync(workRoot, { recursive: true });
const work = mkdtempSync(join(workRoot, "build-"));
const fresh = join(work, "stage");
const packages = resolve(value("--packages") ?? join(process.env.USERPROFILE, ".nuget/packages"));
const env = { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_GENERATE_ASPNET_CERTIFICATE: "false" };
function run(command, argv, extra = {}) {
  const result = spawnSync(command, argv, { cwd: source, env, stdio: "inherit", shell: false, ...extra });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
}
const sdk = spawnSync("dotnet.exe", ["--version"], { encoding: "utf8", env });
if (sdk.status !== 0 || !sdk.stdout.trim().startsWith("10.0.2")) throw new Error("The pinned .NET 10.0.2xx SDK is required");
run("dotnet.exe", ["publish", join(source, "Alignment.csproj"), "-p:RestoreLockedMode=true", "-c", "Release", "-r", "win-x64",
  "--self-contained", "true", "-m:1", "-p:BuildInParallel=false", "-p:DebugType=None", "-p:DebugSymbols=false",
  `-p:BaseIntermediateOutputPath=${join(work, "obj")}/`, `-p:BaseOutputPath=${join(work, "bin")}/`,
  "--packages", packages, ...(value("--source") ? ["--source", value("--source")] : []), "-o", fresh]);
const runtimes = join(fresh, "runtimes");
if (existsSync(runtimes)) for (const entry of readdirSync(runtimes)) {
  if (entry === "win-x64") continue;
  const target = resolve(runtimes, entry);
  if (!target.startsWith(resolve(fresh) + sep)) throw new Error("Foreign runtime path escaped the fresh stage");
  rmSync(target, { recursive: true });
}
stageDotnetNotices(fresh, "Arke.LocalAlignment.deps.json", packages);
for (const file of ["NOTICE.txt", "LICENSE.Voxa.txt"]) cpSync(join(source, file), join(fresh, file));
// Keep the adapted MIT implementation inspectable alongside its exact binary.
cpSync(source, join(fresh, "source"), { recursive: true, filter: path => !/[\\/](bin|obj|\.build)([\\/]|$)/.test(path) });
const metadata = JSON.parse(readFileSync(join(desktop, "runtime-sources.json"), "utf8"));
const vc = metadata.voxa.vcRuntime.x64;
const response = await fetch(vc.url);
if (!response.ok) throw new Error(`VC runtime download failed: ${response.status}`);
const archive = join(work, "vclibs.appx");
writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
assertSha256(archive, vc.sha256, "Microsoft VC runtime x64");
const extracted = join(work, "vclibs"); mkdirSync(extracted);
run(join(process.env.SystemRoot, "System32/tar.exe"), ["-xf", archive, "-C", extracted]);
for (const file of ["msvcp140.dll", "msvcp140_1.dll", "vcruntime140.dll", "vcruntime140_1.dll", "vcomp140.dll"]) {
  cpSync(join(extracted, file), join(fresh, file));
  assertPeArchitecture(join(fresh, file), "x64");
}
writeFileSync(join(fresh, "LICENSE.microsoft-vclibs.txt"), "Microsoft Visual C++ Redistributable runtime files. See https://visualstudio.microsoft.com/license-terms/.\n");
assertPeArchitecture(join(fresh, "Arke.LocalAlignment.exe"), "x64");
run(join(fresh, "Arke.LocalAlignment.exe"), ["--self-test"]);
writeFileSync(join(fresh, "runtime-manifest.json"), JSON.stringify(manifestFor(fresh, {
  schemaVersion: 1, component: "acoustic-alignment", arch: "x64", engine: "whisper.cpp/dtw-word-boundaries-v1",
  whisperNet: "1.9.1", dotnetSdk: sdk.stdout.trim(),
}), null, 2) + "\n");
verifyManifest(fresh);
const stage = resolve(value("--output") ?? join(desktop, "build-resources/alignment/x64"));
const outputRelative = relative(work, stage);
if (!isAbsolute(outputRelative) && !outputRelative.startsWith(`..${sep}`) && outputRelative !== "..") throw new Error("Output must be outside the build workspace");
swapStagedDirectory(fresh, stage, `${stage}.previous`);
console.log(`Verified standalone alignment staged: ${stage}`);
