import assert from "node:assert/strict";
import { it } from "node:test";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import WebSocket from "ws";
import { FrameSchema, type Frame } from "@arke-studio/contracts";
import { createStudioCoordinator } from "../../src/application/studio-host.js";
import { AppStorageService } from "../../src/storage/service.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";
import { until } from "../wait.js";

it("projects startup/world/wake readings into authenticated reconnect snapshots without a model", async () => {
  const { root } = await makeTempRoot(), provider = new FsWorldProvider(root);
  let now = 600_000, stopped = false;
  const storageHealth = new AppStorageService({ appRoot: root, now: () => now, native: {
    setRoots: () => {}, stop: async () => { stopped = true; },
    probe: async (rootId, _signal, after) => {
      if (after !== undefined) now = Math.max(now, after + 1);
      return { state: "measured", source: "host-provided", limitations: [], capacity: {
        volumeId: "volume-a", mappingRevision: rootId, measuredAt: now, availableBytes: 20 * 1024 ** 3, totalBytes: 500 * 1024 ** 3,
      } };
    },
  } });
  const log = join(root, "logs", "coordinator.jsonl");
  const coordinator = createStudioCoordinator({ provider, adapter: null, appRoot: root, storageHealth, changeLogPath: log, appVersion: "storage-test" });
  let client: WebSocket | null = null;
  try {
    const session = await coordinator.start(0);
    await until(() => coordinator.getState().app.storageHealth?.roots[0]?.state === "measured", "startup storage reading");
    await coordinator.openWorld(WORLD_ID);
    await until(() => coordinator.getState().app.storageHealth?.roots.length === 2, "active world destination");
    assert(!JSON.stringify(coordinator.getState().app.storageHealth).includes(root));
    now += 1_000; await coordinator.wakeStorage();
    await until(() => coordinator.getState().app.storageHealth?.roots.every(value => value.state === "measured") === true, "wake refresh");
    client = new WebSocket(`ws://127.0.0.1:${session.port}`);
    const frames: Frame[] = []; client.on("message", raw => frames.push(FrameSchema.parse(JSON.parse(raw.toString()))));
    await once(client, "open"); client.send(JSON.stringify({ kind: "hello", token: session.token, lastSeq: 0 }));
    await until(() => frames.some(frame => frame.kind === "snapshot"), "authenticated snapshot");
    const snapshot = frames.find(frame => frame.kind === "snapshot"); assert(snapshot?.kind === "snapshot");
    assert.equal(snapshot.state.app.storageHealth!.roots.length, 2);
    assert.equal(snapshot.state.app.storageHealth!.admission!.state, "available");
  } finally {
    client?.close(); await coordinator.stop(); await provider.close();
  }
  assert(stopped); assert(!(await readFile(log, "utf8")).includes('"type":"storage.health"'), "replaceable readings are not journal authority");
});

it("the production factory enables scoped observation by default", async () => {
  const { root } = await makeTempRoot(), provider = new FsWorldProvider(root);
  const coordinator = createStudioCoordinator({ provider, adapter: null, appRoot: root, changeLogPath: join(root, "logs", "coordinator.jsonl"), appVersion: "storage-test" });
  try {
    await coordinator.start(0);
    await until(() => coordinator.getState().app.storageHealth?.roots[0]?.state === (process.platform === "win32" ? "measured" : "unsupported"), "host default observation", 20_000);
    assert.equal(coordinator.getState().app.storageHealth!.roots.length, 1);
  } finally { await coordinator.stop(); await provider.close(); }
});
