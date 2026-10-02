import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { HEARMEMAN_ADAPTERS } from "@arke-studio/providers";
import type { ComfyUiEngineService } from "../../src/comfyui/engine.js";
import { AdapterLibrary } from "../../src/local-ai/adapter-library.js";
import { Coordinator } from "../../src/coordinator.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { makeTempRoot } from "../world/helpers.js";
import { until } from "../wait.js";

/**
 * start() reads the adapter library before ComfyUI has been detected, when no engine is local and
 * no file can count as installed. Reproduced on v0.5.55-adult.1: twelve adapters on disk read
 * "Not installed" in Settings and the Generate picker until Refresh status was pressed.
 */
it("re-reads adapter installs when the engine becomes local or its model folder moves", async () => {
  const { root } = await makeTempRoot();
  const provider = new FsWorldProvider(root, { clock: () => "2026-09-30T12:00:00.000Z" });
  const models = join(root, "models"), elsewhere = join(root, "elsewhere");
  // The smallest pinned release; the file is sized, not filled, since presence is only lstat.
  const release = [...HEARMEMAN_ADAPTERS].sort((a, b) => a.source.bytes - b.source.bytes)[0]!;
  await mkdir(join(models, "loras", "arke"), { recursive: true });
  const file = await open(join(models, "loras", "arke", `${release.source.sha256}.safetensors`), "w");
  await file.truncate(release.source.bytes);
  await file.close();

  // Adult content was switched on in an earlier session; every pinned adapter is adult.
  const earlier = new AdapterLibrary({ appRoot: root, releases: HEARMEMAN_ADAPTERS, modelsDir: () => null, local: () => false,
    install: async () => {}, active: () => false, revoke: async () => {}, changed: () => {} });
  await earlier.handle({ action: "enable", acknowledgement: { adultAge: true, explicitChoice: true, rightsAndConsent: true } });
  await earlier.dispose();

  const engine = { detected: false, dir: models as string | null, listeners: [] as Array<() => void> };
  const engineStatus = () => ({
    source: engine.detected ? "managed" : "absent", state: engine.detected ? "ready" : "absent", locality: "local",
    location: engine.detected ? "127.0.0.1:8188" : null, version: engine.detected ? "0.3.45" : null,
    instanceId: engine.detected ? "engine-1" : null, detail: engine.detected ? null : "Not found.", detected: [],
  });
  const service = {
    engineStatus,
    engineIdentity: () => (engine.detected ? { source: "managed", locality: "local", instanceId: "engine-1" } : null),
    modelsDir: () => (engine.detected ? engine.dir : null),
    baseUrls: () => (engine.detected ? ["http://127.0.0.1:8188"] : []),
    status: async () => ({ engine: engineStatus(), recipes: [], checkedAt: "2026-09-30T12:00:00.000Z" }),
    checkNow: async () => {},
    applySettings: async () => {},
    reverify: async () => {},
    subscribe: (listener: () => void) => { engine.listeners.push(listener); return () => {}; },
    dispose: async () => {},
  } as unknown as ComfyUiEngineService;
  const coordinator = new Coordinator({ provider, adapter: null, changeLogPath: join(root, "logs", "changes.jsonl"),
    appVersion: "test", appRoot: root, comfyui: { service } });
  const installed = () => coordinator.getState().app.adapters?.entries.find(row => row.release.id === release.id)?.installed;
  try {
    await coordinator.start(0);
    await until(() => coordinator.getState().app.comfyui != null, "startup engine publish");
    assert.equal(installed(), false, "no engine yet: nothing can count as installed");

    // Detection lands in the background and publishes through the service, as it does at launch.
    engine.detected = true;
    for (const listener of engine.listeners) listener();
    await until(() => installed() === true, "adapters re-read once the engine is local");

    // Pointing the engine at another model folder is the same question asked again.
    engine.dir = elsewhere;
    for (const listener of engine.listeners) listener();
    await until(() => installed() === false, "adapters re-read after the model folder moved");
  } finally {
    await coordinator.stop();
    await provider.close();
  }
});
