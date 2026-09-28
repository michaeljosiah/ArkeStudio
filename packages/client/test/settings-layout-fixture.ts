import { type ClientState, type ManifestModel } from "@arke-studio/contracts";
import { FIXTURE_STATE } from "./fixture-state.js";
import { developLayoutFixture } from "./develop-layout-fixture.js";
export function settingsLayoutFixture(): ClientState {
  const state = developLayoutFixture(), models = state.app.manifest!.models;
  const base = models[0]!;
  const model = (id: string, displayName: string, capability: ManifestModel["capability"]): ManifestModel => ({ ...base, id, displayName, capability, provider: "fal", pricing: capability === "video" ? { kind: "perSecond", microUsdPerSecond: 80000 } : capability === "music" ? { kind: "unmetered" } : { kind: "perImage", microUsdPerImage: 40000 } });
  state.app.manifest!.models = [model("nano-banana-pro", "Nano Banana Pro", "image"), model("seedance-fast", "Seedance 2.0 Fast", "video"), model("lyria-2", "Lyria 2", "music"), model("flux-1.1", "Flux 1.1", "image")];
  state.app.models.disabled = ["flux-1.1"];
  state.app.routing.defaults = { image: "nano-banana-pro", video: "seedance-fast", music: "lyria-2" };
  state.app.providers = ["fal", "openai", "elevenlabs"].map(id => ({ id: id as "fal" | "openai" | "elevenlabs", configured: true, validation: "valid", lastValidated: "2026-09-28T12:00:00Z", credentialFingerprint: "NEVER-RENDER", probes: [{ capability: "image", available: true }, { capability: "video", available: true }, { capability: "music", available: true }], fault: null }));
  state.app.account = { kind: "signed-in", session: "ok", person: { name: "Helen Marsh", email: "helen@marsh.studio", picture: null }, plan: { name: "Free", paid: false } };
  const job = FIXTURE_STATE.app.jobs[0]!;
  state.app.jobs = [{ ...job, model: "seedance-fast", updatedAt: new Date().toISOString() }, { ...job, id: job.id.slice(0, -1) + "6", model: "nano-banana-pro", capability: "image", status: "needs-reconciliation", error: "Saltlight · Nano Banana Pro · timed out", updatedAt: new Date().toISOString() }];
  state.app.version = "0.5.52";
  return state;
}

/** Populated machine rows exercise paths that the cloud-provider design frame leaves empty. */
export function settingsMachineLayoutFixture(): ClientState {
  const state = settingsLayoutFixture();
  const model: ManifestModel = {
    id: "gemma4-12b", provider: "ollama", capability: "llm", displayName: "Gemma 4 12B",
    accepts: { referenceImages: 0, startFrame: false, endFrame: false },
    limits: { maxContextTokens: 256000 }, pricing: { kind: "unmetered" }, requires: { vramMb: 9600 },
  };
  state.app.manifest!.models.push(model);
  state.app.runtime = {
    probes: { vramMb: 24576, memMb: 65536, diskFreeMb: 400000, accelerators: ["cuda"], platform: "win32" },
    detectedAt: "2026-09-28T12:00:00Z", recommended: { llm: model.id },
    models: [{ modelId: model.id, provider: model.provider, displayName: model.displayName, capability: model.capability, locality: "local", fit: "runs-well" }],
  };
  state.app.setup = { running: true, diskFreeMb: 400000, diskCheckedAt: null, components: [{
    id: "ollama-gemma4-12b", engine: "ollama", displayName: "Gemma 4 · 12B", purpose: "Reads images and holds a 256K context",
    sizeMb: 7600, installLocation: "C:\\Users\\Helen\\AppData\\Local\\ArkeStudio\\models\\gemma4-12b",
    state: "downloading", bytesDone: 3800 * 1024 * 1024, bytesTotal: 7600 * 1024 * 1024,
    bytesPerSecond: 12 * 1024 * 1024, pauseSupported: true, provides: [model.id], removable: true,
  }] };
  return state;
}
