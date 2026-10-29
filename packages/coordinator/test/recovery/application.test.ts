import assert from "node:assert/strict";
import { it } from "node:test";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { RecoveryControlSchema, FrameSchema, ulid, type Frame } from "@arke-studio/contracts";
import { once } from "node:events";
import WebSocket from "ws";
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
    await until(() => coordinator.getState().app.recoveryHistory?.actions?.some(row => row.action === "restart-managed-runtime" && row.service === "ollama" && row.automatic && row.outcome === "verified") === true,
      "historical outcome of the owned restart", 5000);
  } finally { release?.(); await coordinator.stop(); await provider.close(); }
  assert.equal(workers[0]!.pid, null);
});

it("a persisted Suggest only policy survives host startup and Refresh cannot reset its supervisor", { timeout: 50_000 }, async () => {
  const { root } = await makeTempRoot(), provider = new FsWorldProvider(root), workers: ChildSupervisor[] = [];
  await new FileRecoveryControlStore(join(root, "operations", "recovery-control.json")).save({ version: 1, policyRevision: 1, mode: "suggest-only", targets: [] });
  const service = new OllamaEngineService({ appRoot: root, port: await allocateLoopbackPort(), exists: () => true, registerBackstop: () => () => {},
    supervise: spec => { const worker = new ChildSupervisor({ ...spec, command: process.execPath, args: [CHILD], env: { SERVICE_VERSION: OLLAMA_VERSION } }, { listDescendants: async () => [] }); workers.push(worker); return worker; } });
  const coordinator = createStudioCoordinator({ provider, adapter: null, appRoot: root, storageHealth: null, changeLogPath: join(root, "log.jsonl"), appVersion: "recovery-test", ollama: { service } });
  let client: WebSocket | undefined, creative: (() => void) | undefined;
  try {
    const session = await coordinator.start(0); assert.equal(service.status().state, "ready", "ordinary selected-service startup is retained");
    process.kill(workers[0]!.pid!, "SIGKILL");
    await until(() => service.status().detail?.includes("Suggest only") === true, "persisted policy refusal", 30_000);
    await service.refresh(); assert.equal(workers.length, 1); assert.equal(workers[0]!.pid, null);
    assert.equal(service.status().state, "failed");
    await until(() => coordinator.getState().app.recoveryPolicy?.targets.some(target => target.retryAvailable) === true, "reviewed retry availability", 10000);
    const target = coordinator.getState().app.recoveryPolicy!.targets.find(target => target.retryAvailable)!;
    const frames: Frame[] = []; client = new WebSocket(`ws://127.0.0.1:${session.port}`);
    client.on("message", data => frames.push(FrameSchema.parse(JSON.parse(String(data))))); await once(client, "open");
    client.send(JSON.stringify({ kind: "hello", token: session.token })); await until(() => frames.some(frame => frame.kind === "snapshot"), "authenticated repair owner");
    const previewId = ulid(); client.send(JSON.stringify({ kind: "recovery-action", requestId: previewId, command: { action: "preview-retry", resourceKey: target.key } }));
    const result = (id: string) => frames.findLast(frame => frame.kind === "event" && frame.event.type === "recovery.action-result" && frame.event.result.requestId === id);
    await until(() => result(previewId) !== undefined, "exact retry review");
    const preview = result(previewId)!; assert(preview.kind === "event" && preview.event.type === "recovery.action-result" && preview.event.result.plan);
    const plan = preview.event.result.plan; assert.equal(preview.event.result.status, "preview"); assert.equal(workers[0]!.pid, null, "preview starts no process");
    assert(!JSON.stringify(plan).includes("componentDigest"));
    const gpu = (coordinator as unknown as { localGpu: LocalGpu }).localGpu; creative = await gpu.acquire("Ming", new AbortController().signal);
    const approvalId = ulid(); client.send(JSON.stringify({ kind: "recovery-action", requestId: approvalId, command: { action: "approve-retry", planId: plan.id } }));
    await until(() => gpu.isBusy("Ollama"), "reviewed recovery behind admitted work", 10000); assert.equal(workers[0]!.pid, null);
    creative(); creative = undefined;
    await until(() => { const frame = result(approvalId); return frame?.kind === "event" && frame.event.type === "recovery.action-result" && frame.event.result.status === "verified"; }, "owner-verified retry result", 15000);
    assert.equal(workers.length, 1); assert.equal(service.status().state, "ready");
    const disk = RecoveryControlSchema.parse(JSON.parse(await readFile(join(root, "operations", "recovery-control.json"), "utf8")));
    assert.equal(disk.mode, "suggest-only"); assert.equal(disk.targets[0]!.lastOutcome?.automatic, false); assert.equal(disk.targets[0]!.attempts.length, 0);
    const repeated = ulid(); client.send(JSON.stringify({ kind: "recovery-action", requestId: repeated, command: { action: "approve-retry", planId: plan.id } }));
    await until(() => result(repeated) !== undefined, "duplicate approval refusal");
    const refused = result(repeated); assert(refused?.kind === "event" && refused.event.type === "recovery.action-result" && refused.event.result.status === "refused");
  } finally { creative?.(); client?.close(); await coordinator.stop(); await provider.close(); }
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
