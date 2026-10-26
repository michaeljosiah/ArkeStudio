import assert from "node:assert/strict";
import { it } from "node:test";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { FrameSchema, RecoveryHistorySchema, emptyRecoveryHistory, type Frame, type DomainEvent } from "@arke-studio/contracts";
import { createStudioCoordinator } from "../../src/application/studio-host.js";
import { AppStorageService } from "../../src/storage/service.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { makeTempRoot } from "../world/helpers.js";
import { until, untilAsync } from "../wait.js";
import { RecoveryHistoryService } from "../../src/recovery/history.js";
import { RecoveryControlService } from "../../src/recovery/control.js";
import { ComfyUiEngineService } from "../../src/comfyui/engine.js";
import { ChildSupervisor } from "../../src/supervisor.js";

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
    assert.equal(frame.state.app.recoveryPolicy?.mode, "automatic");
    const modeRequest = "01ARZ3NDEKTSV4RRFFQ69G5FAV", preferencesRequest = "01ARZ3NDEKTSV4RRFFQ69G5FAW", acknowledgeRequest = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
    for (const command of [
      { kind: "recovery-set-mode", requestId: modeRequest, mode: "suggest-only" },
      { kind: "recovery-set-preferences", requestId: preferencesRequest, preferences: { desktopOptIn: true, transientMuted: true } },
      { kind: "recovery-history-control", requestId: acknowledgeRequest, command: { action: "acknowledge", incidentId: incident.id } },
    ]) client.send(JSON.stringify(command));
    await until(() => [modeRequest, preferencesRequest, acknowledgeRequest].every(requestId => frames.some(frame => frame.kind === "event" && frame.event.type === "recovery.command-result" && frame.event.result.requestId === requestId && frame.event.result.status === "saved")), "flushed host recovery settings receipts", 15_000);
    assert.equal(coordinator.getState().app.recoveryPolicy?.mode, "suggest-only");
    const updated = RecoveryHistorySchema.parse(JSON.parse(await readFile(path, "utf8")));
    assert.deepEqual(updated.preferences, { transientMuted: true, desktopOptIn: true }); assert.ok(updated.incidents.find(value => value.id === incident.id)?.acknowledgedAt);
    assert.notEqual(updated.incidents.find(value => value.id === incident.id)?.phase, "recovered", "acknowledgement did not resolve the fault");
    const pageRequest = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
    client.send(JSON.stringify({ kind: "recovery-history-read", requestId: pageRequest, query: { filter: "all", pageSize: 50 } }));
    await until(() => frames.some(frame => frame.kind === "event" && frame.event.type === "recovery.history-page" && frame.event.requestId === pageRequest), "authenticated retained history page", 5000);
    const response = frames.find(frame => frame.kind === "event" && frame.event.type === "recovery.history-page" && frame.event.requestId === pageRequest);
    assert(response?.kind === "event" && response.event.type === "recovery.history-page"); assert.equal(response.event.page.status, "ready");
    assert(response.event.page.incidents.some(value => value.id === incident.id));
    const exported = await coordinator.diagnostics(); const recovery = exported.recovery as { history: { incidents: { id: string }[] } };
    assert(recovery.history.incidents.some(value => value.id === incident.id));
    const saved = await readFile(path, "utf8"); assert(!saved.includes(root)); assert(!saved.includes("the-undersong"));
  } finally { client?.close(); await coordinator.stop(); await provider.close(); }
  const journal = await readFile(log, "utf8"); assert(!journal.includes('"type":"recovery.'));
});

for (const command of ["history", "mode"] as const) it(`a stalled host ${command} command cannot hold shutdown ahead of confirmed native cleanup`, { timeout: 45_000 }, async () => {
  const { root } = await makeTempRoot(), provider = new FsWorldProvider(root), events: DomainEvent[] = [];
  let entered!: () => void, finish!: () => void;
  const writing = new Promise<void>(resolve => { entered = resolve; }), finishWrite = new Promise<void>(resolve => { finish = resolve; });
  const history = new RecoveryHistoryService({ stopTimeoutMs: 20, store: { load: async () => emptyRecoveryHistory(), save: async value => { if (value.preferences.desktopOptIn) { entered(); await finishWrite; } } } });
  const control = new RecoveryControlService({ stopTimeoutMs: 20, store: {
    load: async () => ({ version: 1, policyRevision: 1, mode: "automatic", targets: [] }),
    save: async value => { if (command === "mode" && value.mode === "suggest-only") { entered(); await finishWrite; } },
  } });
  let worker: ChildSupervisor | undefined;
  const service = new ComfyUiEngineService({ appRoot: root, recipes: [], fileExists: async () => true, listDirectories: async () => [], hashFile: async () => null,
    createProcessEpoch: randomUUID,
    writeTextFile: async () => {}, readNodeRef: async () => null, fetch: async url => url.endsWith("/object_info") ? Response.json({}) : fetch(url), registerSupervisorExitBackstop: () => () => {},
    createSupervisor: spec => worker = new ChildSupervisor({ ...spec, command: process.execPath, args: [join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "child.mjs")], env: { COMFYUI_VERSION: "0.37.0" }, probeIntervalMs: 30, readyTimeoutMs: 10000 }, { listDescendants: async () => [] }) });
  const coordinator = createStudioCoordinator({ provider, adapter: null, appRoot: root, storageHealth: null, recoveryHistory: history, recoveryControl: control, comfyui: { service }, changeLogPath: join(root, "log.jsonl"), appVersion: "shutdown-test", observeEvent: event => events.push(event) });
  let client: WebSocket | undefined, timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const session = await coordinator.start(0); await until(() => service.baseUrl() !== null, "owned child ready", 15000);
    client = new WebSocket(`ws://127.0.0.1:${session.port}`); const frames: Frame[] = [];
    client.on("message", raw => frames.push(FrameSchema.parse(JSON.parse(raw.toString())))); await once(client, "open");
    client.send(JSON.stringify({ kind: "hello", token: session.token, lastSeq: 0 })); await until(() => frames.some(frame => frame.kind === "snapshot"), "authenticated host", 5000);
    const requestId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    client.send(JSON.stringify(command === "mode" ? { kind: "recovery-set-mode", requestId, mode: "suggest-only" }
      : { kind: "recovery-set-preferences", requestId, preferences: { desktopOptIn: true } })); await writing;
    assert.ok(worker!.pid);
    // The diagnostic writer has its own injected 20 ms bound. Whole-host native cleanup also
    // includes platform process inspection, so permit normal CI load without unblocking I/O.
    await Promise.race([coordinator.stop(), new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(`native cleanup did not finish with ${command} I/O blocked (audit ${command === "mode" ? control.snapshot().audit : history.snapshot().audit}, child ${worker!.pid === null ? "exited" : "retained"})`)), 15000); })]);
    assert.equal(worker!.pid, null); assert.equal(command === "mode" ? control.snapshot().audit : history.snapshot().audit, "unavailable");
    finish(); await history.flush();
    assert(!events.some(event => event.type === "recovery.command-result" && event.result.requestId === requestId && event.result.status === "saved"));
  } finally { if (timeout) clearTimeout(timeout); finish(); client?.close(); await coordinator.stop(); await provider.close(); }
});
