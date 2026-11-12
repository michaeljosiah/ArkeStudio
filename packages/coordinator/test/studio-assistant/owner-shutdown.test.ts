import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { join } from "node:path";
import { it } from "node:test";
import WebSocket from "ws";
import { FrameSchema, type Frame } from "@arke-studio/contracts";
import { createStudioCoordinator } from "../../src/application/studio-host.js";
import { OllamaEngineService } from "../../src/local-ai/ollama.js";
import { ChildSupervisor, allocateLoopbackPort, isSupervisedProcessCleanupConfirmed } from "../../src/supervisor.js";
import { OLLAMA_VERSION } from "../../src/setup/catalogue.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";
import { until } from "../wait.js";

for (const failedRetirement of [null, "async", "sync"] as const) it(`production shutdown reconciles original native owners${failedRetirement ? ` and closes the world before reporting a ${failedRetirement} retirement failure` : " before private retirement"}`, { timeout: 60_000 }, async () => {
  const { root } = await makeTempRoot(), provider = new FsWorldProvider(root);
  const writer = new ChildSupervisor({ id: "studio-writer-shutdown", command: process.execPath, args: [join(import.meta.dirname, "../fixtures/child.mjs")], readyTimeoutMs: 15_000 });
  let backing: ChildSupervisor | undefined;
  const service = new OllamaEngineService({ appRoot: root, port: await allocateLoopbackPort(), exists: () => true,
    supervise: spec => backing = new ChildSupervisor({ ...spec, command: process.execPath, args: [join(import.meta.dirname, "../fixtures/managed-http-origin.mjs")],
      env: { ...spec.env, SERVICE_VERSION: OLLAMA_VERSION } }) });
  await service.applySettings({ engineUrl: null, modelsDir: null }); await writer.start();
  const writerOrigin = writer.captureProcessOrigin(), backingOrigin = backing?.captureProcessOrigin(); assert(writerOrigin && backingOrigin);
  let closed = false, reconciled = 0, refuse = failedRetirement;
  const coordinator = createStudioCoordinator({ appRoot: root, provider, adapter: null, ollama: { service }, storageHealth: null, systemResources: null,
    recoveryControl: null, recoveryHistory: null, changeLogPath: join(root, "logs", "changes.jsonl"), appVersion: "test",
    studioAssistant: { model: { busy: () => false, run: async () => { throw Error("No inference in shutdown qualification"); },
      stop: async () => { closed = true; assert(!isSupervisedProcessCleanupConfirmed(writerOrigin)); assert(!isSupervisedProcessCleanupConfirmed(backingOrigin)); },
      reconcileRetirement: () => { assert(closed); assert(isSupervisedProcessCleanupConfirmed(writerOrigin)); assert(isSupervisedProcessCleanupConfirmed(backingOrigin)); reconciled++;
        if (refuse === "sync") throw Error("Private retirement did not confirm cleanup");
        return refuse ? Promise.reject(Error("Private retirement did not confirm cleanup")) : Promise.resolve(); },
    } } });
  coordinator.superviseAs("harness", writer);
  let socket: WebSocket | undefined;
  try {
    const session = await coordinator.start(0), frames: Frame[] = [];
    await coordinator.openWorld(WORLD_ID); assert(provider.openStore());
    socket = new WebSocket(`ws://127.0.0.1:${session.port}`); socket.on("message", data => frames.push(FrameSchema.parse(JSON.parse(String(data)))));
    await once(socket, "open"); socket.send(JSON.stringify({ kind: "hello", token: session.token }));
    await until(() => frames.some(frame => frame.kind === "snapshot"), "authenticated production host snapshot");
    const requestId = randomUUID(); socket.send(JSON.stringify({ kind: "studio-assistant", requestId, command: { action: "create" } }));
    await until(() => frames.some(frame => frame.kind === "studio-assistant" && frame.requestId === requestId), "production Studio owner creation");
    if (failedRetirement) await assert.rejects(coordinator.stop(), AggregateError); else await coordinator.stop();
    assert.equal(reconciled, 1); assert(closed); assert.equal(provider.openStore(), null, "private cleanup failure cannot skip durable world closure");
  } finally { refuse = null; socket?.terminate(); await coordinator.stop(); await writer.stopAndConfirm(); await service.dispose(); await provider.close(); }
});
