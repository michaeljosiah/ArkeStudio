import assert from "node:assert/strict";
import { it } from "node:test";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import WebSocket from "ws";
import { FrameSchema, RecoveryHistorySchema, type Frame, type DomainEvent } from "@arke-studio/contracts";
import { createStudioCoordinator } from "../../src/application/studio-host.js";
import { AppStorageService } from "../../src/storage/service.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { makeTempRoot } from "../world/helpers.js";
import { until, untilAsync } from "../wait.js";

it("warns about measured disk pressure before opening a world, persists one incident and replays it on authenticated reconnect", { timeout: 40_000 }, async () => {
  const { root } = await makeTempRoot(), provider = new FsWorldProvider(root), events: DomainEvent[] = [];
  const storageHealth = new AppStorageService({ appRoot: root, native: { setRoots: () => {}, stop: async () => {}, probe: async rootId => ({
    state: "measured", source: "host-provided", limitations: [], capacity: { volumeId: "synthetic-volume", mappingRevision: rootId, measuredAt: Date.now(),
      availableBytes: 2 * 1024 ** 3, totalBytes: 500 * 1024 ** 3 },
  }) } });
  const log = join(root, "log.jsonl"), path = join(root, "operations", "recovery-history.json");
  const coordinator = createStudioCoordinator({ provider, adapter: null, appRoot: root, storageHealth, changeLogPath: log, appVersion: "incident-test", observeEvent: event => events.push(event) });
  let client: WebSocket | undefined;
  try {
    const session = await coordinator.start(0);
    await until(() => coordinator.getState().app.recoveryHistory?.incidents.some(value => value.kind === "storage-pressure") === true, "proactive disk incident", 15_000);
    assert.equal(coordinator.getState().world, null);
    const incident = coordinator.getState().app.recoveryHistory!.incidents.find(value => value.kind === "storage-pressure")!;
    await until(() => events.some(event => event.type === "recovery.notice" && event.notice.incidentId === incident.id), "flushed warning budget", 15_000);
    await coordinator.wakeStorage();
    await untilAsync(async () => RecoveryHistorySchema.parse(JSON.parse(await readFile(path, "utf8"))).incidents.some(value => value.id === incident.id), "durable incident", 15_000);
    const frames: Frame[] = []; client = new WebSocket(`ws://127.0.0.1:${session.port}`);
    client.on("message", raw => frames.push(FrameSchema.parse(JSON.parse(raw.toString())))); await once(client, "open");
    client.send(JSON.stringify({ kind: "hello", token: session.token, lastSeq: 0 }));
    await until(() => frames.some(frame => frame.kind === "snapshot"), "authenticated recovery snapshot", 15_000);
    const frame = frames.find(frame => frame.kind === "snapshot"); assert(frame?.kind === "snapshot");
    assert(frame.state.app.recoveryHistory!.incidents.some(value => value.id === incident.id));
    assert.equal(events.filter(event => event.type === "recovery.notice" && event.notice.incidentId === incident.id).length, 1);
    const saved = await readFile(path, "utf8"); assert(!saved.includes(root)); assert(!saved.includes("the-undersong"));
  } finally { client?.close(); await coordinator.stop(); await provider.close(); }
  const journal = await readFile(log, "utf8"); assert(!journal.includes('"type":"recovery.history"')); assert(!journal.includes('"type":"recovery.notice"'));
});
