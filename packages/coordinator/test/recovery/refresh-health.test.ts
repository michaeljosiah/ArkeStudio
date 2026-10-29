import assert from "node:assert/strict";
import { once } from "node:events";
import { join } from "node:path";
import { it } from "node:test";
import WebSocket from "ws";
import { FrameSchema, type Frame } from "@arke-studio/contracts";
import { createStudioCoordinator } from "../../src/application/studio-host.js";
import { AppSettingsFile } from "../../src/app-settings.js";
import { OllamaEngineService } from "../../src/local-ai/ollama.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import type { LocalGpu } from "../../src/local-ai/gpu.js";
import { FakeProvider } from "../queue/fake-provider.js";
import { makeTempRoot } from "../world/helpers.js";
import { until } from "../wait.js";

it("an authenticated Ollama health refresh succeeds during creative work without unloading another engine", { timeout: 30_000 }, async () => {
  const { root } = await makeTempRoot(), provider = new FsWorldProvider(root);
  await new AppSettingsFile(join(root, "settings.json")).setOllama({ engineUrl: "http://127.0.0.1:28102" });
  let probes = 0, unloads = 0, forbidUnload = false, healthy = true;
  const service = new OllamaEngineService({ appRoot: root, port: 28103, fetch: async () => {
    probes++; return Response.json({ version: "test" }, { status: healthy ? 200 : 503 });
  } });
  const comfy = Object.assign(new FakeProvider(), { unload: async () => { unloads++; if (forbidUnload) throw new Error("Do not evict creative models for a health check."); } });
  const coordinator = createStudioCoordinator({ provider, adapter: null, appRoot: root, storageHealth: null,
    changeLogPath: join(root, "log.jsonl"), appVersion: "health-refresh-test", ollama: { service }, dispatchClients: { comfyui: comfy } });
  let socket: WebSocket | undefined, release: (() => void) | undefined;
  const frames: Frame[] = [];
  try {
    const session = await coordinator.start(0);
    socket = new WebSocket(`ws://127.0.0.1:${session.port}`);
    socket.on("message", raw => frames.push(FrameSchema.parse(JSON.parse(String(raw)))));
    await once(socket, "open"); socket.send(JSON.stringify({ kind: "hello", token: session.token }));
    await until(() => frames.some(frame => frame.kind === "snapshot"), "authenticated application");
    const gpu = (coordinator as unknown as { localGpu: LocalGpu }).localGpu;
    release = await gpu.acquire("Ming", new AbortController().signal);
    forbidUnload = true; const before = unloads;
    for (const ready of [true, false, true]) {
      healthy = ready; const previous = probes;
      socket.send(JSON.stringify({ kind: "ollama-refresh" }));
      await until(() => probes > previous && service.status().state === (ready ? "ready" : "failed"), "read-only health refresh without GPU admission");
      assert.equal(unloads, before); assert.equal(gpu.isBusy("Ming"), true);
    }
    assert(!frames.some(frame => frame.kind === "event" && frame.event.type === "command.failed"));
  } finally { forbidUnload = false; release?.(); socket?.close(); await coordinator.stop(); await provider.close(); }
});
