import assert from "node:assert/strict";
import { it } from "node:test";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import WebSocket from "ws";
import { FrameSchema, unavailableSystemResources, type Frame } from "@arke-studio/contracts";
import { createStudioCoordinator } from "../src/application/studio-host.js";
import { SystemResourceService } from "../src/system-resources.js";
import { AppStorageService } from "../src/storage/service.js";
import { FsWorldProvider } from "../src/world/provider.js";
import { makeTempRoot } from "./world/helpers.js";
import { until } from "./wait.js";

it("publishes host observations only after authenticated refresh and retains them in reconnect state without journal/export leakage", { timeout: 30_000 }, async () => {
  const { root } = await makeTempRoot(), provider = new FsWorldProvider(root), log = join(root, "logs", "coordinator.jsonl");
  let probes = 0, storageProbes = 0;
  const storageHealth = new AppStorageService({ appRoot: root, native: { setRoots() {}, async stop() {}, async probe() {
    storageProbes++; return { state: "unsupported", source: "host-provided", limitations: ["unsupported-filesystem"], capacity: null };
  } } });
  const resources = new SystemResourceService(async () => { probes++; const value = unavailableSystemResources(Date.now());
    value.cpu = { source: "node-os", state: "measured", measuredAt: value.at, value: 17 }; return value; });
  const coordinator = createStudioCoordinator({ provider, adapter: null, appRoot: root, storageHealth, recoveryHistory: null, recoveryControl: null,
    systemResources: resources, changeLogPath: log, appVersion: "system-test" });
  let socket: WebSocket | undefined;
  try {
    const session = await coordinator.start(0); assert.equal(probes, 0, "No recurring background collection on startup");
    await until(() => storageProbes > 0, "existing startup storage observation"); const before = storageProbes;
    socket = new WebSocket(`ws://127.0.0.1:${session.port}`); const frames: Frame[] = [];
    socket.on("message", raw => frames.push(FrameSchema.parse(JSON.parse(raw.toString())))); await once(socket, "open");
    socket.send(JSON.stringify({ kind: "hello", token: session.token, lastSeq: 0 }));
    await until(() => frames.some(frame => frame.kind === "snapshot"), "authenticated snapshot");
    socket.send(JSON.stringify({ kind: "refresh-system-resources" }));
    await until(() => frames.some(frame => frame.kind === "event" && frame.event.type === "system.resources"), "system resource event");
    assert.equal(coordinator.getState().app.systemResources?.cpu.value, 17);
    assert.equal(storageProbes, before, "Resource-only polling does not accelerate SPEC-062 storage collection");
    const closed = once(socket, "close"); socket.close(); await closed;
    socket = new WebSocket(`ws://127.0.0.1:${session.port}`); const replay: Frame[] = [];
    socket.on("message", raw => replay.push(FrameSchema.parse(JSON.parse(raw.toString())))); await once(socket, "open");
    socket.send(JSON.stringify({ kind: "hello", token: session.token, lastSeq: 0 }));
    await until(() => replay.some(frame => frame.kind === "snapshot"), "reconnect resource snapshot");
    const snapshot = replay.find(frame => frame.kind === "snapshot"); assert(snapshot?.kind === "snapshot");
    assert.equal(snapshot.state.app.systemResources?.cpu.value, 17);
    const bundle = await coordinator.diagnostics(); assert(!JSON.stringify(bundle).includes('systemResources'));
    assert(!JSON.stringify(bundle).includes('system.resources'));
  } finally { socket?.close(); await coordinator.stop(); await provider.close(); }
  assert(!(await readFile(log, "utf8")).includes('"type":"system.resources"'));
});
