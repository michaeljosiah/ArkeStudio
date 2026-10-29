import assert from "node:assert/strict";
import { it } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { RecoveryControlSchema, type RecoveryControl } from "@arke-studio/contracts";
import { createStudioCoordinator } from "../../src/application/studio-host.js";
import { ComfyUiEngineService, type EngineServiceDeps } from "../../src/comfyui/engine.js";
import { ProfiledComfyUiEngineService } from "../../src/comfyui/profiled-engine.js";
import { ChildSupervisor } from "../../src/supervisor.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { LocalGpu } from "../../src/local-ai/gpu.js";
import { RecoveryControlService } from "../../src/recovery/control.js";
import { FileRecoveryControlStore } from "../../src/recovery/control-file.js";
import { SupervisorRecovery } from "../../src/recovery/supervisor.js";
import { makeTempRoot } from "../world/helpers.js";
import { until, untilAsync } from "../wait.js";

const CHILD = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "child.mjs");
const settings = { enginePath: null, engineUrl: null, modelsDir: null };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
// Match the supervisor suite's starved-runner startup/settlement tiers. A startup budget
// expiring kills a valid child, so extending only the outer poll cannot repair that failure.
const READY_MS = 30_000, HEALTHY_WAIT_MS = 40_000;
function nativeDeps(root: string, workers: ChildSupervisor[], readyTimeoutMs = 10_000): EngineServiceDeps {
  return { appRoot: root, recipes: [], fileExists: async () => true, listDirectories: async () => [], hashFile: async () => null,
    writeTextFile: async () => {}, readNodeRef: async () => null, createProcessEpoch: randomUUID,
    fetch: async url => url.endsWith("/object_info") ? Response.json({}) : fetch(url), registerSupervisorExitBackstop: () => () => {},
    createSupervisor: spec => {
      const worker = new ChildSupervisor({ ...spec, command: process.execPath, args: [CHILD], env: { COMFYUI_VERSION: "0.37.0" }, probeIntervalMs: 30, readyTimeoutMs },
        { listDescendants: async () => [] }); workers.push(worker); return worker;
    } };
}
function gate(service: ComfyUiEngineService, gpu: LocalGpu) {
  let disk: RecoveryControl = { version: 1, policyRevision: 1, mode: "automatic", targets: [] };
  const control = new RecoveryControlService({ store: { load: async () => structuredClone(disk), save: async value => { disk = structuredClone(value); } } });
  service.configureRecovery((owner, worker) => new SupervisorRecovery({ control, identity: { key: hash(owner.recoveryTarget().role), service: "comfyui" },
    componentDigest: () => owner.recoveryTarget().configurationDigest, ownership: () => owner.recoveryTarget().ownership,
    current: () => owner.ownsSupervisor(worker), acquire: signal => gpu.acquire("ComfyUI", signal) }));
  return control;
}

it("the production host composes managed ComfyUI recovery and verifies its new process epoch", { timeout: 50_000 }, async () => {
  const { root } = await makeTempRoot(), provider = new FsWorldProvider(root), workers: ChildSupervisor[] = [];
  const service = new ComfyUiEngineService(nativeDeps(root, workers));
  const coordinator = createStudioCoordinator({ provider, adapter: null, appRoot: root, storageHealth: null, changeLogPath: join(root, "log.jsonl"), appVersion: "recovery-test", comfyui: { service } });
  try {
    await coordinator.start(0); await until(() => service.baseUrl() !== null, "initial ComfyUI ready", 15_000);
    const previous = workers[0]!.pid!, epoch = service.engineIdentity()!.processEpoch;
    process.kill(previous, "SIGKILL");
    await untilAsync(async () => {
      const state = RecoveryControlSchema.parse(JSON.parse(await readFile(join(root, "operations", "recovery-control.json"), "utf8")));
      return state.targets[0]?.service === "comfyui" && state.targets[0].attempts.length === 1 && state.targets[0].intent === null && service.baseUrl() !== null;
    }, "verified ComfyUI recovery", 30_000);
    assert.equal(workers.length, 1); assert.notEqual(workers[0]!.pid, previous); assert.notEqual(service.engineIdentity()!.processEpoch, epoch);
  } finally { await coordinator.stop(); await provider.close(); }
  assert.equal(workers[0]!.pid, null);
});

it("profile processes retain separate restart targets and a queued crash survives another engine's handover", { timeout: 120_000 }, async () => {
  const { root } = await makeTempRoot(), workers: ChildSupervisor[] = [];
  const service = new ProfiledComfyUiEngineService(nativeDeps(root, workers, READY_MS), "profile-recipe", { id: "comfyui-profile", args: [], customNodesDir: root, nodeRefs: {} });
  const gpu = new LocalGpu(async engine => { if (engine === "ComfyUI") await service.prepareGpuHandover(); }, ["ComfyUI", "Ming"]), control = gate(service, gpu);
  let release: (() => void) | undefined;
  try {
    await service.applySettings(settings); await until(() => service.baseUrls().length === 2, "both profile processes ready", HEALTHY_WAIT_MS);
    const primary = workers.find(worker => worker.id === "comfyui")!, profile = workers.find(worker => worker.id === "comfyui-profile")!,
      primaryPid = primary.pid!, profilePid = profile.pid!, profileEpoch = service.engineIdentity("profile-recipe")!.processEpoch;
    release = await gpu.acquire("Ming", new AbortController().signal); process.kill(primaryPid, "SIGKILL");
    await until(() => gpu.isBusy("ComfyUI"), "primary recovery waiting for GPU", 15_000);
    await service.prepareGpuHandover(); assert.equal(primary.status, "unhealthy"); assert.equal(primary.spawnEpoch, 1);
    assert.equal(profile.pid, profilePid); assert.equal(service.engineIdentity("profile-recipe")!.processEpoch, profileEpoch);
    release(); release = undefined;
    await until(() => {
      assert.notEqual(primary.status, "failed", `primary replacement failed: ${primary.reason}; audit=${control.snapshot().audit}`);
      return primary.status === "healthy" && control.snapshot().control.targets[0]?.intent === null;
    }, "primary replacement ready", HEALTHY_WAIT_MS);
    assert.notEqual(primary.pid, primaryPid); assert.equal(profile.pid, profilePid);
    process.kill(profilePid, "SIGKILL");
    await until(() => {
      assert.notEqual(profile.status, "failed", `profile replacement failed: ${profile.reason}; audit=${control.snapshot().audit}`);
      return profile.status === "healthy" && profile.pid !== profilePid && control.snapshot().control.targets.length === 2 && control.snapshot().control.targets.every(value => value.intent === null);
    }, "profile replacement ready", HEALTHY_WAIT_MS);
    assert.equal(workers.length, 2); assert.deepEqual(control.snapshot().control.targets.map(value => value.attempts.length), [1, 1]);
    assert.equal(new Set(control.snapshot().control.targets.map(value => value.key)).size, 2);
  } finally { release?.(); await service.dispose(); await control.stop(); gpu.stop(); }
});

it("a personal ComfyUI path can start by selection but its crash never receives automatic recovery", { timeout: 40_000 }, async () => {
  const { root } = await makeTempRoot(), workers: ChildSupervisor[] = [], service = new ComfyUiEngineService(nativeDeps(root, workers));
  const gpu = new LocalGpu(async () => {}), control = gate(service, gpu);
  try {
    await control.open(); await control.markCircuitOpen({ key: hash("comfyui"), service: "comfyui" });
    await service.applySettings({ ...settings, enginePath: join(root, "personal") }); await until(() => service.baseUrl() !== null, "selected personal process ready", 15_000);
    process.kill(workers[0]!.pid!, "SIGKILL"); await until(() => workers[0]!.reason?.includes("outside Arke") === true, "personal recovery refusal", 15_000);
    await service.checkNow(); assert.equal(workers.length, 1); assert.equal(workers[0]!.spawnEpoch, 1);
    const targets = control.snapshot().control.targets; assert.equal(targets.length, 1); assert(targets[0]!.circuitOpen); assert.equal(targets[0]!.attempts.length, 0);
  } finally { await service.dispose(); await control.stop(); gpu.stop(); }
});

it("failed controlled disposal retains its process and backstop for a later confirmed stop", { timeout: 40_000 }, async () => {
  const { root } = await makeTempRoot(), workers: ChildSupervisor[] = [], deps = nativeDeps(root, workers); let removed = 0;
  deps.registerSupervisorExitBackstop = () => () => { removed++; };
  const service = new ComfyUiEngineService(deps), gpu = new LocalGpu(async () => {}), control = gate(service, gpu);
  let originalStop: (() => Promise<void>) | undefined;
  try {
    await service.applySettings(settings); await until(() => service.baseUrl() !== null, "owned child ready", 15_000);
    const worker = workers[0]!, stop = worker.stopAndConfirm.bind(worker), pid = worker.pid!;
    originalStop = stop;
    worker.stopAndConfirm = async () => { throw new Error("exit unconfirmed"); };
    await assert.rejects(service.dispose(), /exit unconfirmed/); assert.equal(removed, 0); assert.equal(worker.pid, pid); process.kill(pid, 0);
    worker.stopAndConfirm = stop; await service.dispose(); assert.equal(worker.pid, null); assert.equal(removed, 1);
  } finally { if (originalStop) { workers[0]!.stopAndConfirm = originalStop; await service.dispose(); } await control.stop(); gpu.stop(); }
});

it("early shutdown fences a pending engine resolution before it can create a supervisor", async () => {
  const { root } = await makeTempRoot(), workers: ChildSupervisor[] = [], deps = nativeDeps(root, workers);
  let entered!: () => void, finish!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; }), done = new Promise<void>(resolve => { finish = resolve; });
  deps.fileExists = async () => { entered(); await done; return true; };
  const service = new ComfyUiEngineService(deps);
  const applying = service.applySettings(settings);
  await reading; service.beginShutdown(); finish(); await applying;
  await service.applySettings(settings); assert.equal(workers.length, 0); await service.dispose();
});

it("the production host reports failed ComfyUI exit and permits a later cleanup retry", { timeout: 40_000 }, async () => {
  const { root } = await makeTempRoot(), provider = new FsWorldProvider(root), workers: ChildSupervisor[] = [], service = new ComfyUiEngineService(nativeDeps(root, workers));
  const coordinator = createStudioCoordinator({ provider, adapter: null, appRoot: root, storageHealth: null, changeLogPath: join(root, "log.jsonl"), appVersion: "recovery-test", comfyui: { service } });
  let originalStop: (() => Promise<void>) | undefined;
  try {
    await coordinator.start(0); await until(() => service.baseUrl() !== null, "owned engine ready", 15_000);
    const worker = workers[0]!; originalStop = worker.stopAndConfirm.bind(worker);
    worker.stopAndConfirm = async () => { throw new Error("unconfirmed ComfyUI exit"); };
    await assert.rejects(coordinator.stop(), /Local runtime cleanup did not confirm exit/); assert.ok(worker.pid); process.kill(worker.pid!, 0);
    worker.stopAndConfirm = originalStop; await coordinator.stop(); assert.equal(worker.pid, null);
  } finally { if (originalStop) workers[0]!.stopAndConfirm = originalStop; await coordinator.stop(); await provider.close(); }
});

it("failed shutdown keeps settlement open until the unknown replacement actually exits", { timeout: 120_000 }, async () => {
  const { root } = await makeTempRoot(), provider = new FsWorldProvider(root), workers: ChildSupervisor[] = [], deps = nativeDeps(root, workers);
  const env = { COMFYUI_VERSION: "0.37.0", MODE: "healthy", IGNORE_STOP: "0" };
  deps.createSupervisor = spec => {
      const worker = new ChildSupervisor({ ...spec, command: process.execPath, args: [CHILD], env, probeIntervalMs: 30, readyTimeoutMs: READY_MS }, { listDescendants: async () => [] });
    workers.push(worker); return worker;
  };
  const store = new FileRecoveryControlStore(join(root, "operations", "recovery-control.json")), control = new RecoveryControlService({ store });
  const service = new ComfyUiEngineService(deps);
  const coordinator = createStudioCoordinator({ provider, adapter: null, appRoot: root, storageHealth: null, recoveryHistory: null, recoveryControl: control,
    changeLogPath: join(root, "log.jsonl"), appVersion: "recovery-test", comfyui: { service } });
  type StopSeam = { forceStop(child: unknown): Promise<void> }; let originalStop: StopSeam["forceStop"] | undefined;
  try {
    await coordinator.start(0); await until(() => service.baseUrl() !== null, "initial process ready", HEALTHY_WAIT_MS);
    const worker = workers[0]!, seam = worker as unknown as StopSeam; originalStop = seam.forceStop.bind(worker);
    // A native incompatible response proves the replacement initialized its signal handlers.
    // Waiting for a never-ready clock could kill a starved child before that fixture existed.
    // Retain it by refusing the forced stop, including on POSIX where graceful signals differ.
    seam.forceStop = async () => {}; env.COMFYUI_VERSION = "0.0.0"; env.IGNORE_STOP = "1"; process.kill(worker.pid!, "SIGKILL");
    await until(() => control.snapshot().control.targets[0]?.intent?.phase === "unknown", "replacement retained after unconfirmed cleanup", 70_000);
    assert.ok(worker.pid); await assert.rejects(coordinator.stop(), /Local runtime cleanup did not confirm exit/);
    assert.equal(control.snapshot().accepting, false); assert.ok(control.snapshot().control.targets[0]!.intent);
    seam.forceStop = originalStop; await coordinator.stop(); assert.equal(worker.pid, null);
    const saved = RecoveryControlSchema.parse(await store.load()); assert.equal(saved.targets[0]!.intent, null); assert.equal(saved.targets[0]!.attempts.length, 1);
    const restarted = new RecoveryControlService({ store }); await restarted.open();
    assert.equal(restarted.snapshot().control.targets[0]!.intent, null); await restarted.stop();
  } finally {
    if (originalStop) (workers[0] as unknown as StopSeam).forceStop = originalStop;
    await coordinator.stop(); await provider.close();
  }
});
