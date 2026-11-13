import assert from "node:assert/strict";
import { it } from "node:test";
import { join } from "node:path";
import { Coordinator } from "../../src/coordinator.js";
import { ComfyUiEngineService } from "../../src/comfyui/engine.js";
import { JobQueue } from "../../src/queue/dispatcher.js";
import { JobJournal } from "../../src/queue/journal.js";
import { SubmissionStorageHeld } from "../../src/storage/job-artifacts.js";
import { AppStorageService } from "../../src/storage/service.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";
import { until } from "../wait.js";
import { FakeProvider } from "./fake-provider.js";

it("shutdown and restart preserve a submission-held job without waiting for capacity or buying it", { timeout: 30_000 }, async () => {
  const { root } = await makeTempRoot(), journalPath = join(root, "queue", "jobs.jsonl");
  const client = new FakeProvider();
  const seed = new JobQueue({ journalPath, clients: { comfyui: client }, getKey: async () => "", emit() {},
    ledger: { async readJobIds() { return new Set(); }, async has() { return false; }, async append() {} },
    artifactSpace: { async checkSubmission() { throw new SubmissionStorageHeld(); }, async reserve() { throw new Error("unsubmitted"); } },
    landInWorld: async () => false,
  });
  await seed.start();
  const job = await seed.enqueue({ worldId: WORLD_ID, provider: "comfyui", model: "comfyui-draft-image", capability: "image",
    target: { kind: "shot", id: "shot_one" }, params: {}, estimatedMicroUsd: 0, landing: { dir: "incoming" } });
  await seed.dispose(); await seed.waitForIdle(); await seed.drain();
  const before = await new JobJournal(journalPath).readHistory();

  for (let restart = 0; restart < 2; restart++) {
    const provider = new FsWorldProvider(root);
    await provider.loadWorld(WORLD_ID);
    const service = new ComfyUiEngineService({ appRoot: root, recipes: [],
      fetch: async () => { throw new Error("offline"); }, fileExists: async () => false,
      listDirectories: async () => [], hashFile: async () => null, writeTextFile: async () => {}, readNodeRef: async () => null,
      createSupervisor: () => { throw new Error("no worker may start"); }, registerSupervisorExitBackstop: () => () => {},
      createProcessEpoch: () => "test", homeDir: root,
    });
    // A ready external engine, with dispatch held before any provider request.
    service.baseUrl = () => "http://127.0.0.1:8188";
    service.waitUntilReady = async () => true;
    const owners: string[] = [];
    const storage = new AppStorageService({ appRoot: root, native: {
      setRoots() {}, async stop() {}, async probe() {
        return { state: "unavailable", source: "host-provided", capacity: null, limitations: [] };
      },
    } });
    const coordinator = new Coordinator({ provider, adapter: null, appRoot: root, appVersion: "test",
      dispatchClients: { comfyui: client }, comfyui: { service }, storageHealth: storage, changeLogPath: join(root, "changes.jsonl"),
      onShutdownWait: owner => owners.push(owner),
    });
    await coordinator.start(0);
    try {
      await until(() => coordinator.getState().app.jobs.some(row => row.id === job.id && row.storageWait?.phase === "submission"), "storage-held job")
        .catch(error => { throw new Error(JSON.stringify(coordinator.getState().app.jobs), { cause: error }); });
      const stoppingAt = Date.now();
      await coordinator.stop();
      assert(Date.now() - stoppingAt < 5000, "shutdown does not wait for the 30-second storage retry");
      const after = await new JobJournal(journalPath).readHistory();
      assert.deepEqual(after, before, "shutdown writes no cancellation or submission for saved queued work");
      assert.equal(after.at(-1)?.status, "queued");
      assert.equal(after.at(-1)?.attempt, 0);
      assert.equal(client.submitCount, 0);
      assert(owners.includes("active jobs and queue journal"));
      assert.equal(owners.at(-1), "recovery control");
    } finally { await coordinator.stop(); await provider.close(); }
  }
});
