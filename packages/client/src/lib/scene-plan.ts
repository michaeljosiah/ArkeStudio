import { planScene, type ManifestModel, type Scene, type SizeTier } from "@arke-studio/contracts";
import type { ProductionBundle, WorldBundle } from "@arke-studio/contracts";

/**
 * One scene's dispatch plan, computed the way the coordinator computes it (issue 244, round 3).
 *
 * The dispatch dialog assembled these inputs inline, and turn 102's drawer needs the same number
 * under a much smaller button. Two copies of this assembly would be two answers to *what will
 * this cost*, and the screen's whole claim is that it runs the same function on the same inputs
 * — so it is assembled once, here, and both callers read it.
 */
export interface ScenePlanInput {
  world: WorldBundle;
  production: ProductionBundle;
  scene: Scene;
  model: ManifestModel;
  /** The provider's own word for size, where a caller has chosen one. */
  resolution?: string;
  tier?: SizeTier;
}

type ScenePlans = { perShot: ReturnType<typeof planScene>; wholeScene: ReturnType<typeof planScene> };

export function planForScene(input: ScenePlanInput): ScenePlans;
export function planForScene(input: ScenePlanInput, mode: "whole-scene"): Pick<ScenePlans, "wholeScene">;
export function planForScene(input: ScenePlanInput, mode: "per-shot"): Pick<ScenePlans, "perShot">;
/**
 * `mode` narrows the work (review 2026-08-22): planning a mode assembles every shot's prompt,
 * and the Generate drawer reads only the whole-scene number — so computing both there priced
 * a dispatch nobody was looking at on every keystroke that re-rendered the drawer.
 */
export function planForScene(input: ScenePlanInput, mode?: "per-shot" | "whole-scene"): Partial<ScenePlans> {
  const { world, production, scene, model, resolution, tier } = input;
  const planInput = {
    world: world.meta,
    artDirection: world.artDirection,
    productionId: production.meta.id,
    // The production's standing constraints, so a preview plans what the coordinator executes:
    // without them the preview showed a prompt missing the production's own negatives while the
    // server sent them.
    production: {
      ...(production.meta.styleOverride !== undefined
        ? { styleOverride: production.meta.styleOverride }
        : {}),
      ...(production.meta.musicPolicy !== undefined ? { musicPolicy: production.meta.musicPolicy } : {}),
      failureModes: production.meta.failureModes,
    },
    sheets: world.sheets,
    kits: world.referenceKits,
    scene,
    selections: production.selections,
    model,
    // The world's shelf, so a durable boundary frame resolves here exactly as it will at the
    // coordinator (issue 154).
    artifacts: world.artifacts,
    // The production's takes, on the same grounds one input up: a continuation resolves against
    // a specific predecessor take (SPEC-019 R-50), and without them the dialog would price a
    // plain generation for a shot the coordinator is about to dispatch as an extension.
    takes: production.takes,
    // The production's delivery aspect (issue 389), on the same same-function claim.
    ...(production.meta.aspect !== undefined ? { aspect: production.meta.aspect } : {}),
    ...(resolution !== undefined ? { resolution } : {}),
    ...(tier !== undefined ? { tier } : {}),
  };
  return {
    ...(mode !== "whole-scene" ? { perShot: planScene(planInput, "per-shot") } : {}),
    ...(mode !== "per-shot" ? { wholeScene: planScene(planInput, "whole-scene") } : {}),
  };
}
