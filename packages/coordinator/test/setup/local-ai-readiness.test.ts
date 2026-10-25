import assert from "node:assert/strict";
import { join } from "node:path";
import { it } from "node:test";
import { Coordinator } from "../../src/coordinator.js";
import { AppSettingsFile } from "../../src/app-settings.js";
import { ComfyUiEngineService } from "../../src/comfyui/engine.js";
import { OllamaEngineService } from "../../src/local-ai/ollama.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { devCipher } from "../../src/credentials/dev-cipher.js";
import { tempDir } from "../tmp.js";
import { LocalSetupService } from "../../src/setup/local-setup.js";
import { SETUP_CATALOGUE } from "../../src/setup/catalogue.js";
import type { SetupDeps } from "../../src/setup/local-setup.js";
import type { DomainEvent } from "@arke-studio/contracts";
import type { ChildSupervisor } from "../../src/supervisor.js";

const setupDeps: SetupDeps = {
  fetchStream: async () => { throw new Error("Optional model not downloaded in this test."); },
  run: async () => ({ code: 1, output: "" }), which: async () => null, probeUrl: async () => false,
  diskFreeMb: async () => 100000, externallyPresent: async id => id === "comfyui-runtime" || id === "ollama-runtime",
};

it("shutdown cancels setup activation before waiting for the setup drain, and refuses late completion", { timeout: 10000 }, async () => {
  const root = await tempDir("local-ai-setup-quit-");
  let finish!: () => void, admitted = false, refreshes = 0;
  const service = new OllamaEngineService({ appRoot: root, port: 28104, exists: () => true,
    registerBackstop: () => () => {}, supervise: () => ({ status: "starting", on() {},
      start: () => new Promise<void>(resolve => { admitted = true; finish = resolve; }),
      quiesce: () => finish(), stopAndConfirm: async () => {},
    }) as unknown as ChildSupervisor,
  });
  const refresh = service.refresh.bind(service);
  service.refresh = async () => { refreshes++; await refresh(); };
  const coordinator = new Coordinator({ appRoot: root, appVersion: "test", adapter: null,
    provider: new FsWorldProvider(root), changeLogPath: join(root, "logs", "changes.jsonl"), cipher: devCipher(),
    setup: setupDeps, ollama: { service },
  });
  const internal = coordinator as unknown as { setup: LocalSetupService; onSetupComponentReady(id: string): Promise<void> };
  // Model the completion callback held after the final install rename, exactly what dispose drains.
  const activation = internal.onSetupComponentReady("ollama-runtime");
  const dispose = internal.setup.dispose.bind(internal.setup);
  internal.setup.dispose = async () => { await activation; await dispose(); };
  try {
    while (!admitted) await new Promise(resolve => setTimeout(resolve, 5));
    await coordinator.stop();
    await activation;
    const before = refreshes;
    await internal.onSetupComponentReady("ollama-runtime");
    assert.equal(refreshes, before, "a late installation callback cannot try to start Ollama");
  } finally { if (admitted) finish(); await coordinator.stop(); }
});

it("never skips a mandatory runtime, while optional models remain skippable", async () => {
  const service = new LocalSetupService(setupDeps, () => {}, { appRoot: await tempDir("required-local-ai-"), catalogue: SETUP_CATALOGUE });
  try {
    for (const id of ["comfyui-runtime", "ollama-runtime"]) {
      service.skip(id);
      assert.equal(service.status().components.find(c => c.id === id)?.state, "queued");
    }
    const optional = SETUP_CATALOGUE.find(c => c.optional)!;
    service.skip(optional.id);
    assert.equal(service.status().components.find(c => c.id === optional.id)?.state, "skipped");
  } finally { await service.dispose(); }
});

it("seeds the gate before detection and publishes completion only after both selected services recover", { timeout: 60000 }, async () => {
  const root = await tempDir("local-ai-readiness-");
  const settings = new AppSettingsFile(join(root, "settings.json"));
  await settings.setComfyUi({ engineUrl: "http://127.0.0.1:28101" });
  await settings.setOllama({ engineUrl: "http://127.0.0.1:28102" });
  let comfyHealthy = false, ollamaHealthy = false;
  const comfy = new ComfyUiEngineService({ appRoot: root, recipes: [],
    fetch: async url => url.endsWith("/system_stats")
      ? Response.json({ system: { comfyui_version: "0.38.0" } }, { status: comfyHealthy ? 200 : 503 }) : Response.json({}),
    fileExists: async () => false, listDirectories: async () => [], hashFile: async () => null,
    writeTextFile: async () => {}, readNodeRef: async () => null,
    createSupervisor: () => { throw new Error("An explicit URL must never spawn."); },
    registerSupervisorExitBackstop: () => () => {}, createProcessEpoch: () => "test",
  });
  const ollama = new OllamaEngineService({ appRoot: root, port: 28103,
    fetch: async () => {
      if (!ollamaHealthy) throw new Error("Not answering.");
      return Response.json({ version: "existing" });
    },
  });
  const events: DomainEvent[] = [];
  const coordinator = new Coordinator({ appRoot: root, appVersion: "test", adapter: null,
    provider: new FsWorldProvider(root), changeLogPath: join(root, "logs", "changes.jsonl"), cipher: devCipher(),
    setup: setupDeps, comfyui: { service: comfy }, ollama: { service: ollama }, observeEvent: event => events.push(event),
  });
  assert.equal(coordinator.getState().app.setup?.localAi?.ready, false, "initial snapshot cannot bypass pending detection");
  try {
    await coordinator.start();
    const until = async (predicate: () => boolean) => {
      const deadline = Date.now() + 10000;
      while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      assert.ok(predicate());
    };
    await until(() => coordinator.getState().app.setup?.localAi?.engines.ollama.installed === true);
    assert.equal(coordinator.getState().app.setup?.localAi?.ready, false, "installed external runtimes are not healthy proof");
    comfyHealthy = true;
    await comfy.checkNow();
    assert.equal(coordinator.getState().app.setup?.localAi?.ready, false, "one healthy engine is insufficient");
    ollamaHealthy = true;
    await ollama.refresh();
    await until(() => coordinator.getState().app.setup?.localAi?.ready === true);
    assert.ok(events.some(e => e.type === "setup.status" && e.setup.localAi?.ready));
    ollamaHealthy = false;
    await ollama.refresh();
    assert.equal(coordinator.getState().app.setup?.localAi?.ready, false, "health loss revokes the gate");
  } finally { await coordinator.stop(); }
});
