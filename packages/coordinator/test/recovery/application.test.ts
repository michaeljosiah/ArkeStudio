import assert from "node:assert/strict";
import { it } from "node:test";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { RecoveryControlSchema } from "@arke-studio/contracts";
import { createStudioCoordinator } from "../../src/application/studio-host.js";
import { OllamaEngineService } from "../../src/local-ai/ollama.js";
import { FileRecoveryControlStore } from "../../src/recovery/control-file.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { ChildSupervisor, allocateLoopbackPort } from "../../src/supervisor.js";
import { OLLAMA_VERSION } from "../../src/setup/catalogue.js";
import type { CatalogueEntry } from "../../src/setup/catalogue.js";
import { devCipher } from "../../src/credentials/dev-cipher.js";
import type { LocalGpu } from "../../src/local-ai/gpu.js";
import { makeTempRoot } from "../world/helpers.js";
import { until, untilAsync } from "../wait.js";

const CHILD = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "child.mjs");
it("the production host's managed Ollama crash uses its default durable recovery control", { timeout: 50_000 }, async () => {
  const { root } = await makeTempRoot(), provider = new FsWorldProvider(root), workers: ChildSupervisor[] = [];
  const service = new OllamaEngineService({ appRoot: root, port: await allocateLoopbackPort(), exists: () => true, registerBackstop: () => () => {},
    supervise: spec => {
      const worker = new ChildSupervisor({ ...spec, command: process.execPath, args: [CHILD], env: { SERVICE_VERSION: OLLAMA_VERSION } }, { listDescendants: async () => [] });
      workers.push(worker); return worker;
    } });
  await service.applySettings({ engineUrl: null, modelsDir: null }, { deferManagedStart: true }); assert.equal(workers.length, 0);
  const coordinator = createStudioCoordinator({ provider, adapter: null, appRoot: root, storageHealth: null, changeLogPath: join(root, "log.jsonl"), appVersion: "recovery-test", ollama: { service } });
  let release: (() => void) | undefined;
  try {
    await coordinator.start(0); assert.equal(coordinator.getState().app.ollama?.state, "ready");
    const gpu = (coordinator as unknown as { localGpu: LocalGpu }).localGpu;
    release = await gpu.acquire("Ming", new AbortController().signal);
    const previous = workers[0]!.pid!; process.kill(previous, "SIGKILL");
    await until(() => gpu.isBusy("Ollama"), "recovery waiting behind creative work", 15_000);
    await service.prepareGpuHandover(); assert.equal(workers[0]!.status, "unhealthy");
    release(); release = undefined;
    await untilAsync(async () => {
      const control = RecoveryControlSchema.parse(JSON.parse(await readFile(join(root, "operations", "recovery-control.json"), "utf8")));
      return control.targets[0]?.attempts.length === 1 && control.targets[0]?.intent === null && service.status().state === "ready" && workers[0]!.pid !== previous;
    }, "production restart's flushed verified outcome", 35_000);
    assert.equal(workers.length, 1, "the existing owner executed the restart");
    assert.equal(coordinator.getState().app.ollama?.state, "ready");
  } finally { release?.(); await coordinator.stop(); await provider.close(); }
  assert.equal(workers[0]!.pid, null);
});

it("a persisted Suggest only policy survives host startup and Refresh cannot reset its supervisor", { timeout: 50_000 }, async () => {
  const { root } = await makeTempRoot(), provider = new FsWorldProvider(root), workers: ChildSupervisor[] = [];
  await new FileRecoveryControlStore(join(root, "operations", "recovery-control.json")).save({ version: 1, policyRevision: 1, mode: "suggest-only", targets: [] });
  const service = new OllamaEngineService({ appRoot: root, port: await allocateLoopbackPort(), exists: () => true, registerBackstop: () => () => {},
    supervise: spec => { const worker = new ChildSupervisor({ ...spec, command: process.execPath, args: [CHILD], env: { SERVICE_VERSION: OLLAMA_VERSION } }, { listDescendants: async () => [] }); workers.push(worker); return worker; } });
  const coordinator = createStudioCoordinator({ provider, adapter: null, appRoot: root, storageHealth: null, changeLogPath: join(root, "log.jsonl"), appVersion: "recovery-test", ollama: { service } });
  try {
    await coordinator.start(0); assert.equal(service.status().state, "ready", "ordinary selected-service startup is retained");
    process.kill(workers[0]!.pid!, "SIGKILL");
    await until(() => service.status().detail?.includes("Suggest only") === true, "persisted policy refusal", 30_000);
    await service.refresh(); assert.equal(workers.length, 1); assert.equal(workers[0]!.pid, null);
    assert.equal(service.status().state, "failed");
  } finally { await coordinator.stop(); await provider.close(); }
});

it("the runtime-update command lets setup own the GPU lease, stop and verified activation", { timeout: 50_000 }, async () => {
  const { root } = await makeTempRoot(), provider = new FsWorldProvider(root), workers: ChildSupervisor[] = [];
  const executable = join(root, "ollama-runtime", "ollama.exe"); await mkdir(dirname(executable), { recursive: true }); await writeFile(executable, "old");
  const service = new OllamaEngineService({ appRoot: root, port: await allocateLoopbackPort(), registerBackstop: () => () => {},
    supervise: spec => { const worker = new ChildSupervisor({ ...spec, command: process.execPath, args: [CHILD], env: { SERVICE_VERSION: OLLAMA_VERSION } }, { listDescendants: async () => [] }); workers.push(worker); return worker; } });
  const payload = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]); let downloads = 0;
  const entry: CatalogueEntry = { id: "ollama-runtime", displayName: "Ollama", purpose: "Test runtime", engine: "ollama", sizeMb: 1, installedMb: 1,
    spec: { kind: "tree", dir: "ollama-runtime", rootMarker: "ollama.exe", version: OLLAMA_VERSION,
      file: { url: "https://example.test/ollama.zip", file: "ollama.zip", sizeMb: 1, magic: [0x50, 0x4b, 0x03, 0x04], sha256: createHash("sha256").update(payload).digest("hex") } } };
  const coordinator = createStudioCoordinator({ provider, adapter: null, appRoot: root, cipher: devCipher(), storageHealth: null,
    changeLogPath: join(root, "log.jsonl"), appVersion: "recovery-test", ollama: { service }, setupExtraEntries: [entry], setup: {
      fetchStream: async () => {
        downloads++; assert.equal(workers[0]!.pid, null, "old process stopped before downloading"); assert.equal(service.baseUrl(), null);
        return { ok: true, status: 200, contentLength: payload.length, acceptRanges: false, contentRangeStart: null, body: (async function* () { yield payload; })() };
      },
      run: async (_command, args) => {
        assert.equal(args[0], "-xf"); const staged = args[3]!; await mkdir(staged, { recursive: true }); await writeFile(join(staged, "ollama.exe"), "updated");
        return { code: 0, output: "" };
      }, which: async () => null, probeUrl: async () => false, diskFreeMb: async () => 100000,
      externallyPresent: async id => id !== "ollama-runtime",
    } });
  const runtime = () => coordinator.getState().app.setup?.components.find(value => value.id === "ollama-runtime");
  try {
    await coordinator.start(0); await until(() => !coordinator.getState().app.setup?.running && runtime()?.state === "present", "initial runtime detection", 15_000);
    assert.equal(service.status().state, "ready");
    coordinator.serverApplication.onMessage!({ kind: "ollama-update-runtime" });
    await until(() => runtime()?.state === "ready" || runtime()?.state === "failed", "runtime update settled", 20_000);
    assert.equal(runtime()?.state, "ready", runtime()?.detail); assert.equal(downloads, 1);
    await until(() => service.status().state === "ready" && workers.length === 2, "verified replacement activation", 15_000);
    assert.equal(await readFile(executable, "utf8"), "updated"); assert.equal(workers[0]!.pid, null); assert.ok(workers[1]!.pid);
  } finally { await coordinator.stop(); await provider.close(); }
});
