import { AdapterSelectionsSchema, adapterCompatibilityProblem, compareComfyUiVersions, type AdapterRelease } from "@arke-studio/contracts";
import type { ComfyUiRecipe } from "./recipes.js";
import { HEARMEMAN_ADAPTERS } from "./hearmeman.generated.js";

/** Only a catalogue release can extend the authored graph; callers supply no paths or nodes. */
export function recipeWithAdapters(base: ComfyUiRecipe, input: unknown, catalogue: readonly AdapterRelease[] = HEARMEMAN_ADAPTERS): ComfyUiRecipe {
  const selected = AdapterSelectionsSchema.parse(input ?? []);
  if (!selected.length) return base;
  for (const selection of selected) {
    const release = catalogue.find(row => row.id === selection.releaseId && row.source.sha256 === selection.sha256);
    if (!release) throw new Error("Unknown or changed adapter release.");
    const problem = adapterCompatibilityProblem(release, base.id, selection.strength);
    if (problem) throw new Error(problem);
  }
  const recipe = adapterValidationCandidate(base, selected, catalogue);
  for (const selection of selected) {
    const pairing = catalogue.find(row => row.id === selection.releaseId)!.compatibility.find(row => row.recipeId === base.id)!;
    if (!pairing.hardware || !pairing.minEngineVersion || !pairing.exercisedThroughVersion) throw new Error("Adapter validation evidence is incomplete.");
    for (const key of ["minVramMb", "minFreeVramMb", "minMemMb", "minFreeMemMb"] as const) {
      recipe.hardware[key] = Math.max(recipe.hardware[key] ?? 0, pairing.hardware[key]);
    }
    if (compareComfyUiVersions(pairing.minEngineVersion, recipe.engine.minVersion) === 1) recipe.engine.minVersion = pairing.minEngineVersion;
    if (compareComfyUiVersions(pairing.exercisedThroughVersion, recipe.engine.exercisedThroughVersion) === -1) recipe.engine.exercisedThroughVersion = pairing.exercisedThroughVersion;
  }
  return recipe;
}

/** Maintainer GPU harness only: compose the exact candidate graph without inventing verification evidence.
 * Production hosts use recipeWithAdapters; this is never selected by renderer parameters.
 */
export function adapterValidationCandidate(base: ComfyUiRecipe, input: unknown, catalogue: readonly AdapterRelease[] = HEARMEMAN_ADAPTERS): ComfyUiRecipe {
  const selected = AdapterSelectionsSchema.parse(input ?? []);
  if (!selected.length) return base;
  if (!base.adapterSlot) throw new Error("This recipe does not accept adapters.");
  if (selected.length > 1) throw new Error("Adapter combinations have not completed validation.");
  const recipe = structuredClone(base), slot = recipe.adapterSlot!;
  recipe.adapters = selected;
  let previous = recipe.graph[slot[0]]?.inputs[slot[1]];
  if (!Array.isArray(previous)) throw new Error("The recipe adapter slot is invalid.");
  for (const [index, selection] of selected.entries()) {
    const release = catalogue.find(row => row.id === selection.releaseId);
    if (!release || release.source.sha256 !== selection.sha256) throw new Error("Unknown or changed adapter release.");
    if (!release.compatibility.some(pair => pair.recipeId === base.id)) throw new Error("No catalogue pairing for this recipe.");
    const id = `arke_adapter_${index}`;
    if (recipe.graph[id]) throw new Error("Adapter node collides with the authored recipe.");
    recipe.graph[id] = { class_type: "LoraLoaderModelOnly", inputs: {
      model: previous, lora_name: `arke/${release.source.sha256}.safetensors`, strength_model: selection.strength,
    } };
    previous = [id, 0];
    recipe.requires.checkpoints = [...recipe.requires.checkpoints, {
      file: `loras/arke/${release.source.sha256}.safetensors`, sha256: release.source.sha256,
      sizeMb: Math.ceil(release.source.bytes / 1_000_000),
      url: `https://huggingface.co/${release.source.repository}/resolve/${release.source.revision}/${release.source.file}`,
    }];
  }
  recipe.graph[slot[0]]!.inputs[slot[1]] = previous;
  return recipe;
}
