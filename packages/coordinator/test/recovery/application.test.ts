import assert from "node:assert/strict";
import { it } from "node:test";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { RecoveryControlSchema } from "@arke-studio/contracts";
import { createStudioCoordinator } from "../../src/application/studio-host.js";
import { OllamaEngineService } from "../../src/local-ai/ollama.js";
import { FileRecoveryControlStore } from "../../src/recovery/control-file.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { ChildSupervisor, allocateLoopbackPort } from "../../src/supervisor.js";
import { OLLAMA_VERSION } from "../../src/setup/catalogue.js";
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
  try {
    await coordinator.start(0); assert.equal(coordinator.getState().app.ollama?.state, "ready");
    const previous = workers[0]!.pid!; process.kill(previous, "SIGKILL");
    await untilAsync(async () => {
      const control = RecoveryControlSchema.parse(JSON.parse(await readFile(join(root, "operations", "recovery-control.json"), "utf8")));
      return control.targets[0]?.attempts.length === 1 && control.targets[0]?.intent === null && service.status().state === "ready" && workers[0]!.pid !== previous;
    }, "production restart's flushed verified outcome", 35_000);
    assert.equal(workers.length, 1, "the existing owner executed the restart");
    assert.equal(coordinator.getState().app.ollama?.state, "ready");
  } finally { await coordinator.stop(); await provider.close(); }
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
