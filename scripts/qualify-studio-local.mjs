import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream, constants } from "node:fs";
import { copyFile, lstat, mkdir, open, readFile, readdir, stat, statfs, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { assembleHarness, managedStudioAssistant, harnessProfileDir, v2ProfileEnv } from "../packages/coordinator/src/harness/v2-launch.ts";
import { OllamaEngineService } from "../packages/coordinator/src/local-ai/ollama.ts";
import { RuntimeContentVerifier } from "../packages/coordinator/src/local-ai/runtime-content.ts";
import { ChildSupervisor, allocateLoopbackPort } from "../packages/coordinator/src/supervisor.ts";
import { SetupProcessRunner } from "../packages/coordinator/src/setup/process.ts";
import { systemTar } from "../packages/coordinator/src/setup/local-setup.ts";
import { HarnessStudioModelRunner } from "../packages/coordinator/src/studio-assistant/runner.ts";
import { withLocalGpu } from "../packages/coordinator/src/harness/local-gpu.ts";
import { withModelValidation } from "../packages/coordinator/src/harness/model-validation.ts";
import { LocalGpu } from "../packages/coordinator/src/local-ai/gpu.ts";

const usage = "node --import tsx scripts/qualify-studio-local.mjs --root <new-or-owned-test-directory> --model-store <existing-Ollama-models> --model <installed-model-name> --opencode <pinned-bundled-executable> [--ollama-archive <pinned-x64-zip>]";
const flags = new Map(), allowed = new Set(["--root", "--model-store", "--model", "--opencode", "--ollama-archive"]);
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i], value = process.argv[i + 1];
  assert(allowed.has(key) && value && !value.startsWith("--") && !flags.has(key), usage); flags.set(key, value);
}
for (const key of ["--root", "--model-store", "--model", "--opencode"]) assert(flags.has(key), usage);
assert(process.platform === "win32" && process.arch === "x64", "This qualification targets the pinned Windows x64 composition.");
const root = resolve(flags.get("--root")), sourceModels = resolve(flags.get("--model-store")), writerPath = resolve(flags.get("--opencode"));
const contains = (base, target) => { const rel = relative(base.toLowerCase(), target.toLowerCase()); return rel === "" || !isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep); };
assert(!contains(root, sourceModels) && !contains(sourceModels, root), "The qualification directory and personal model store must be separate.");
let model = flags.get("--model"); assert(model.length <= 505 && /^[a-zA-Z0-9_.:/-]+$/.test(model));
const colon = model.lastIndexOf(":"), slash = model.lastIndexOf("/");
const name = colon > slash ? model.slice(0, colon) : model, tag = colon > slash ? model.slice(colon + 1) : "latest";
const parts = name.split("/");
assert(parts.length <= 8 && [...parts, tag].every(part => part && part !== "." && part !== ".." && /^[a-zA-Z0-9_.-]+$/.test(part)), "Unsupported local model manifest name.");
model = `${name}:${tag}`; assert(model.length <= 505);
const manifestParts = ["manifests", ...(parts[0].includes(".") ? parts : ["registry.ollama.ai", ...(parts.length === 1 ? ["library"] : []), ...parts]), tag];
const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pin = JSON.parse(await readFile(join(project, "packages/coordinator/src/local-ai/ollama-private-pin-x64.json"), "utf8"));
const writerPin = JSON.parse(await readFile(join(project, "packages/coordinator/src/harness/private-writer-pin.json"), "utf8"));
async function digest(path) { const hash = createHash("sha256"); for await (const bytes of createReadStream(path)) hash.update(bytes); return hash.digest("hex"); }
assert.equal((await stat(writerPath)).size, writerPin.bytes); assert.equal(await digest(writerPath), writerPin.sha256);

const owner = join(root, ".arke-studio-qualification.json"), ownerBytes = '{"qualification":"studio-local","version":1}\n';
try { await mkdir(root); await writeFile(owner, ownerBytes, { flag: "wx" }); }
catch (error) { if (error.code !== "EEXIST") throw error; assert.equal(await readFile(owner, "utf8"), ownerBytes, "Refusing an existing directory without this qualification's owner marker."); }
const rootInfo = await lstat(root); assert(rootInfo.isDirectory() && !rootInfo.isSymbolicLink());
// No overlapping qualification may rewrite the same runtime/profile. An unconfirmed native
// cleanup leaves this lock for intervention rather than treating a PID or timeout as proof.
const lockPath = join(root, ".qualification-running"), lock = await open(lockPath, "wx"), lockInfo = await lock.stat();
let nativeOwnersActive = false;
try {
const manifestBytes = await readFile(join(sourceModels, ...manifestParts)), manifest = JSON.parse(manifestBytes);
assert.equal(manifest.schemaVersion, 2); assert(Array.isArray(manifest.layers) && manifest.layers.length <= 15);
const blobs = [manifest.config, ...manifest.layers]; let totalBytes = 0;
for (const blob of blobs) { assert(/^sha256:[a-f0-9]{64}$/.test(blob.digest)); assert(Number.isSafeInteger(blob.size) && blob.size > 0); totalBytes += blob.size; }
assert(totalBytes < 12 * 1024 ** 3);
const disk = await statfs(root); assert(disk.bavail * disk.bsize > totalBytes + 4 * 1024 ** 3 + 5 * 1024 ** 3, "Allow the copied model, runtime expansion and five GiB headroom.");
const runtime = join(root, "ollama-runtime");
if (flags.has("--ollama-archive")) {
  const archive = resolve(flags.get("--ollama-archive")); assert.equal(await digest(archive), pin.archiveSha256);
  await mkdir(runtime, { recursive: true }); const processes = new SetupProcessRunner();
  try { assert.equal((await processes.run(systemTar(), ["-xf", archive, "-C", runtime], AbortSignal.timeout(180_000))).code, 0); }
  finally { await processes.dispose(); }
}
assert(await new RuntimeContentVerifier(runtime, pin).verify(AbortSignal.timeout(60_000), () => true), "The complete pinned runtime must qualify before execution.");
const ownModels = join(root, "models", "ollama"); await mkdir(join(ownModels, "blobs"), { recursive: true });
for (const blob of blobs) {
  const file = blob.digest.replace(":", "-"), source = join(sourceModels, "blobs", file), target = join(ownModels, "blobs", file);
  assert.equal((await stat(source)).size, blob.size); assert.equal(await digest(source), blob.digest.slice(7));
  try { await copyFile(source, target, constants.COPYFILE_EXCL); } catch (error) { if (error.code !== "EEXIST") throw error; }
  assert.equal((await stat(target)).size, blob.size); assert.equal(await digest(target), blob.digest.slice(7));
}
await mkdir(join(ownModels, ...manifestParts.slice(0, -1)), { recursive: true });
try { await writeFile(join(ownModels, ...manifestParts), manifestBytes, { flag: "wx" }); }
catch (error) { if (error.code !== "EEXIST") throw error; assert((await readFile(join(ownModels, ...manifestParts))).equals(manifestBytes)); }
process.stdout.write(JSON.stringify({ phase: "pinned runtime and copied model qualified", blobs: blobs.length, logicalBytes: totalBytes, downloaded: false, sharedPersonalFiles: false }) + "\n");

const studioRoot = join(root, "studio-live"), profile = harnessProfileDir(studioRoot);
const marker = `STUDIO_PRIVATE_${randomBytes(12).toString("hex")}`, answer = `STUDIO_ANSWER_${randomBytes(12).toString("hex")}`;
const logFile = join(root, "logs", "engines", "ollama.log");
async function excludes(directory) {
  let entries = 0, bytes = 0, files = 0;
  const scan = async path => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      assert(++entries <= 1024); const file = join(path, entry.name);
      const info = await lstat(file); assert(!info.isSymbolicLink());
      if (info.isDirectory()) { await scan(file); continue; }
      assert(info.isFile()); bytes += info.size; assert(info.size <= 64 * 1024 ** 2 && bytes <= 128 * 1024 ** 2);
      const content = await readFile(file); files++;
      assert(!content.includes(Buffer.from(marker)) && !content.includes(Buffer.from(answer)), "Private payload retained in qualification profile/logs.");
    }
  };
  await scan(directory); assert(files > 0);
}
for (const [cycle, role] of ["studio-assistant", "diagnostic-specialist"].entries()) {
  const before = (await readFile(logFile, "utf8").catch(() => "")).length;
  const service = new OllamaEngineService({ appRoot: root, port: await allocateLoopbackPort() });
  const wiring = await assembleHarness({ appRoot: studioRoot, ollamaEndpoint: () => service.endpoint(),
    v2: { bundledPath: writerPath, runCommand: async (command, args, timeout, env) => {
      if (command === "where" || command === "which") return { status: 1, stdout: "" };
      assert.equal(command, writerPath); assert.deepEqual(args, ["--version"]);
      return new Promise(resolve => execFile(command, args, { env, timeout, maxBuffer: 4096, windowsHide: true, encoding: "utf8" },
        (error, stdout) => resolve({ status: error ? 1 : 0, stdout })));
    } },
    // Disposable native qualification carries no personal credentials; production ownership,
    // exact payload, byte pin and socket gates still run through the shared factory.
    createSupervisor: (spec, deps) => new ChildSupervisor({ ...spec, inheritEnv: false, env: {
      ...Object.fromEntries(["SYSTEMROOT", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "TEMP", "TMP"].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]])),
      ...v2ProfileEnv(profile), APPDATA: join(profile, "roaming"), LOCALAPPDATA: join(profile, "local"),
    } }, deps),
  });
  assert(wiring.adapter && wiring.supervisor);
  const gpu = new LocalGpu(async () => {}), adapter = withModelValidation(withLocalGpu(wiring.adapter, gpu), async () => ({}));
  const options = managedStudioAssistant(wiring, service);
  const runner = new HarnessStudioModelRunner({ adapter: () => adapter, scratch: join(studioRoot, "turns"), sessionInput: async value => value,
    destination: options.destination, privateTransport: options.privateTransport, timeoutMs: 600_000 });
  try {
    nativeOwnersActive = true;
    await service.applySettings({ engineUrl: null, modelsDir: null }); assert.equal(service.status().state, "ready");
    await wiring.relaunchHarness({}); await wiring.supervisor.start(); assert.equal(wiring.supervisor.status, "healthy"); await adapter.init();
    const deadline = Date.now() + 30_000;
    while (!(await adapter.listModels()).some(row => row.provider === "ollama" && row.id === model)) {
      assert(Date.now() < deadline, "The real model catalogue did not become ready."); await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert(!/POST\s+"\/v1\/chat\/completions"/.test((await readFile(logFile, "utf8")).slice(before)), "Startup replayed a private request.");
    process.stdout.write(JSON.stringify({ phase: "native model turn starting", cycle, role }) + "\n");
    let approvals = 0;
    const prompt = `Synthetic qualification ${marker}_${cycle}. Reply with exactly {"kind":"reply","text":"${answer}_${cycle}"}. No commentary, tools or extra words.`;
    const started = Date.now();
    const response = await runner.run({ role, model: `ollama/${model}`, prompt }, AbortSignal.timeout(600_000), async disclosure => {
      approvals++; assert(disclosure.local); assert.equal(disclosure.prompt, prompt); return { cloudApproved: false };
    });
    assert.equal(approvals, 1); assert(response.includes(`${answer}_${cycle}`)); assert(!runner.busy()); assert(!gpu.isBusy("Ollama"));
    assert.equal(((await readFile(logFile, "utf8")).slice(before).match(/POST\s+"\/v1\/chat\/completions"/g) ?? []).length, 1);
    for (const directory of [profile, join(root, "runtime-home", "ollama"), join(root, "logs")]) await excludes(directory);
    const canary = join(profile, "qualification-detector-control"); await writeFile(canary, marker, { flag: "wx" });
    try { await assert.rejects(excludes(profile), /Private payload retained/); }
    finally { assert.equal(await readFile(canary, "utf8"), marker); await unlink(canary); }
    process.stdout.write(JSON.stringify({ phase: "native model turn passed", cycle, role, milliseconds: Date.now() - started, oneInference: true, payloadExcludedFromProfiles: true }) + "\n");
  } finally {
    const stopped = await Promise.allSettled([runner.stop(), adapter.dispose(), wiring.supervisor.stopAndConfirm(), service.dispose()]);
    const failures = stopped.filter(row => row.status === "rejected").map(row => row.reason);
    await runner.reconcileRetirement(); assert(!runner.busy()); gpu.stop();
    if (failures.length) throw new AggregateError(failures, "Native qualification cleanup was not fully confirmed.");
    nativeOwnersActive = false;
    for (const directory of [profile, join(root, "runtime-home", "ollama"), join(root, "logs")]) await excludes(directory);
    process.stdout.write(JSON.stringify({ phase: "both native owners cleaned", cycle }) + "\n");
  }
}
for (const blob of blobs) assert.equal(await digest(join(sourceModels, "blobs", blob.digest.replace(":", "-"))), blob.digest.slice(7));
assert((await readFile(join(sourceModels, ...manifestParts))).equals(manifestBytes));
process.stdout.write(JSON.stringify({ liveMainAndSpecialist: true, reusedProfileAfterRestart: true, noStartupReplay: true, originalWeightsUnchanged: true }) + "\n");
} finally {
  await lock.close();
  if (!nativeOwnersActive) {
    const current = await lstat(lockPath);
    if (current.isFile() && !current.isSymbolicLink() && current.dev === lockInfo.dev && current.ino === lockInfo.ino && current.size === 0) await unlink(lockPath);
  }
}
