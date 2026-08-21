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

export function planForScene(input: ScenePlanInput) {
  const { world, production, scene, model, resolution, tier } = input;
  const planInput = {
    world: world.meta,
    artDirection: world.artDirection,
    productionId: production.meta.id,
    // The production's standing constraints, so a preview plans what the coordinator executes:
    // without them the preview showed a prompt missing the production's own negatives while the
    // server sent them.
    production: {
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
    // The production's delivery aspect (issue 389), on the same same-function claim.
    ...(production.meta.aspect !== undefined ? { aspect: production.meta.aspect } : {}),
    ...(resolution !== undefined ? { resolution } : {}),
    ...(tier !== undefined ? { tier } : {}),
  };
  return { perShot: planScene(planInput, "per-shot"), wholeScene: planScene(planInput, "whole-scene") };
}
