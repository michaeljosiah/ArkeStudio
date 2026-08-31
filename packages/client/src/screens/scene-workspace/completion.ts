import {
  orderedShots,
  shotCardState,
  shotCoverage,
  type ArtifactSidecar,
  type ProductionBundle,
  type SceneRecord,
} from "@arke-studio/contracts";
import { acceptedTakeId, takesForShot } from "../../lib/selectors.js";
import { shotHasFrame } from "./boards.js";

/** SPEC-036 R-31: completion is only the shared shot-state derivation, never stored. */
export function sceneIsComplete(
  scene: SceneRecord,
  production: ProductionBundle,
  artifacts: readonly ArtifactSidecar[],
  digests: ReadonlyMap<string, string>,
): boolean {
  const shots = orderedShots(scene);
  return shots.length > 0 && shots.every((shot) => {
    const accepted = acceptedTakeId(production, shot.id);
    const take = accepted === null
      ? undefined
      : takesForShot(production, shot.id).find((candidate) => candidate.id === accepted);
    const state = shotCardState({
      blankScript: shot.description.trim() === "",
      clipAccepted: take?.kind === "clip",
      hasFrame: shotHasFrame(production, artifacts, shot.id),
      coverage: shotCoverage(shot, digests),
    });
    return state === "production-ready" || state === "rendered";
  });
}
