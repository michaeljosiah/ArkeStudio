import { comfyUiWeightsComponentId } from "@arke-studio/contracts";
import type { CatalogueEntry } from "@arke-studio/coordinator";
import type { ComfyUiRecipe } from "@arke-studio/providers";

/** Setup and verification use the same paths/digests. Unsupported builds offer no partial install. */
export function comfyUiWeightCatalogue(recipes: readonly ComfyUiRecipe[]): CatalogueEntry[] {
  return recipes.filter(recipe => recipe.requires.checkpoints.length > 0 && recipe.requires.unavailableReason === undefined)
    .map(recipe => ({
      id: comfyUiWeightsComponentId(recipe.id),
      displayName: `${recipe.displayName} · weights`,
      purpose: `Model files for ${recipe.displayName} — landed in the selected engine's mapped models folder`,
      sizeMb: recipe.requires.checkpoints.reduce((sum, file) => sum + file.sizeMb, 0),
      optional: true,
      requires: ["comfyui-runtime"],
      engine: "comfyui",
      spec: {
        kind: "files", dir: "", externalRoot: "comfyui-models",
        files: recipe.requires.checkpoints.map(file => ({ url: file.url, file: file.file, sizeMb: file.sizeMb, sha256: file.sha256 })),
      },
    }));
}
