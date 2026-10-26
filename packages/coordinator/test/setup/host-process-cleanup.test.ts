import assert from "node:assert/strict";
import { it } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStudioCoordinator } from "../../src/application/studio-host.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { ChildSupervisor } from "../../src/supervisor.js";
import { AppStorageService } from "../../src/storage/service.js";
import { RecoveryControlService } from "../../src/recovery/control.js";
import { SetupProcessCleanupPending } from "../../src/setup/process.js";
import type { LocalSetupService } from "../../src/setup/local-setup.js";
import { makeTempRoot } from "../world/helpers.js";
import { until } from "../wait.js";

it("a setup cleanup refusal still stops other native owners and retains minimum settlement until cleanup retries", { timeout: 90000 }, async () => {
  const { root } = await makeTempRoot(), provider = new FsWorldProvider(root);
  const storage = new AppStorageService({ appRoot: root, native: { setRoots: () => {}, stop: async () => {},
    probe: async rootId => ({ state: "measured", source: "host-provided", limitations: [], capacity: {
      volumeId: "synthetic-volume", mappingRevision: rootId, measuredAt: Date.now(), availableBytes: 100 * 1024 ** 3, totalBytes: 200 * 1024 ** 3,
    } }),
  } });
  const control = new RecoveryControlService({ store: { load: async () => ({ version: 1, policyRevision: 1, mode: "automatic", targets: [] }), save: async () => {} } });
  let storageStops = 0, controlStops = 0;
  const storageStop = storage.stop.bind(storage), controlStop = control.stop.bind(control);
  storage.stop = async () => { storageStops++; await storageStop(); };
  control.stop = async () => { controlStops++; await controlStop(); };
  const coordinator = createStudioCoordinator({ provider, adapter: null, appRoot: root, appVersion: "native-cleanup-test", changeLogPath: join(root, "log.jsonl"),
    storageHealth: storage, recoveryControl: control, recoveryHistory: null, setup: {
      externallyPresent: async () => true, run: async () => ({ code: 0, output: "" }), which: async () => null, probeUrl: async () => false,
      diskFreeMb: async () => 1000000, fetchStream: async () => { throw new Error("No downloads in this fixture"); },
    },
  });
  const child = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "child.mjs");
  const worker = new ChildSupervisor({ id: "setup-stop-peer", command: process.execPath, args: [child], readyTimeoutMs: 30000, probeIntervalMs: 50 }, { listDescendants: async () => [] });
  coordinator.superviseAs("voice", worker);
  const setup = (coordinator as unknown as { setup: LocalSetupService }).setup, dispose = setup.dispose.bind(setup);
  let allow = false, settled = false;
  const owner = { kind: "setup" as const, id: "native-install" };
  setup.dispose = async () => {
    if (!allow) throw new SetupProcessCleanupPending();
    settled = await storage.reservations.settle("pending-native", owner); await dispose();
  };
  try {
    await coordinator.start(0); await until(() => worker.status === "healthy", "peer native process ready", 40000);
    await until(() => !coordinator.getState().app.setup?.running, "initial detection settled", 15000);
    const rootId = storage.snapshot().roots[0]!.rootId;
    assert.equal((await storage.reservations.reserve({ id: "pending-native", owner, demands: [{ rootId, remainingBytes: 1024 }] })).status, "reserved");
    await assert.rejects(coordinator.stop(), /Local runtime cleanup did not confirm exit/);
    assert.equal(worker.pid, null, "the failed setup stop cannot skip cleanup of other native owners");
    assert.equal(storageStops, 0); assert.equal(controlStops, 0); assert.equal(storage.reservations.snapshot().records.length, 1);
    await assert.rejects(coordinator.start(), /coordinator is closed/);
    allow = true; await coordinator.stop(); assert(settled); assert.equal(storageStops, 1); assert.equal(controlStops, 1);
    assert.equal(storage.reservations.snapshot().records.length, 0);
  } finally { allow = true; setup.dispose = dispose; await coordinator.stop(); await provider.close(); }
});
