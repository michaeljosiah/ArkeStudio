import type { ClientState, ManifestModel, ModelSampling } from "@arke-studio/contracts";
import { FIXTURE_STATE } from "./fixture-state.js";

/** H3 as the catalogue projects it (design turn 177), and a state that has it ready. */
export const SAMPLING: ModelSampling = {
  presets: [
    { id: "fast", values: { steps: 8, speedAdapter: 1, shift: 12, sampler: "euler", scheduler: "simple" } },
    { id: "balanced", values: { steps: 10, speedAdapter: 0.75, shift: 9, sampler: "euler", scheduler: "simple" } },
    { id: "quality", values: { steps: 12, speedAdapter: 0.5, shift: 6, sampler: "euler", scheduler: "simple" } },
  ],
  samplers: ["euler", "dpmpp_2m", "ddim"],
  schedulers: ["simple", "beta", "ddim_uniform"],
  clipSec: 10,
};

export const H3: ManifestModel = {
  id: "comfyui-h3-video",
  provider: "comfyui",
  capability: "video",
  displayName: "Local · H3 Video",
  accepts: { referenceImages: 1, startFrame: false, endFrame: false },
  limits: { maxPromptChars: 2000, alwaysSound: true, durations: { "5": "5", "10": "10" }, durationWire: "number", resolutions: ["480p"], aspects: ["16:9", "9:16"] },
  pricing: { kind: "unmetered", typicalRunSec: 636 },
  sampling: SAMPLING,
};

export function withSampling(localSampling?: ClientState["app"]["localSampling"], extra: Partial<ClientState["app"]> = {}): ClientState {
  return {
    ...FIXTURE_STATE,
    app: {
      ...FIXTURE_STATE.app,
      manifest: { ...FIXTURE_STATE.app.manifest!, models: [...FIXTURE_STATE.app.manifest!.models, H3] },
      comfyui: {
        engine: { source: "managed", state: "ready", locality: "local", location: "127.0.0.1:8188", version: "0.33.1", detail: null, detected: [], instanceId: "local-1" },
        recipes: [{ recipeId: H3.id, recipeVersion: 2, displayName: H3.displayName, capability: "video", state: "ready" }],
        checkedAt: "2026-09-30T12:00:00.000Z",
      },
      ...(localSampling !== undefined ? { localSampling } : {}),
      ...extra,
    },
  };
}

export const plain = (html: string) => html.replace(/<!-- -->/g, "");

