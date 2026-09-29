import assert from "node:assert/strict";
import { it } from "node:test";
import { COMFYUI_RECIPES } from "@arke-studio/providers";
import { comfyUiWeightsComponentId } from "@arke-studio/contracts";
import { comfyUiWeightCatalogue } from "../src/comfyui-setup.js";

it("keeps download paths, digests, sizes and runtime prerequisites aligned with recipe verification", () => {
  for (const entry of comfyUiWeightCatalogue(COMFYUI_RECIPES)) {
    const recipe = COMFYUI_RECIPES.find(recipe => comfyUiWeightsComponentId(recipe.id) === entry.id)!;
    assert.deepEqual(entry.requires, ["comfyui-runtime"]);
    assert.equal(entry.optional, true);
    assert.equal(entry.spec.kind, "files");
    if (entry.spec.kind !== "files") throw new Error("expected file setup");
    assert.equal(entry.spec.externalRoot, "comfyui-models");
    assert.deepEqual(entry.spec.files, recipe.requires.checkpoints.map(file => ({ url: file.url, file: file.file, sizeMb: file.sizeMb, sha256: file.sha256 })));
    assert.equal(entry.sizeMb, recipe.requires.checkpoints.reduce((sum, file) => sum + file.sizeMb, 0));
  }
});

it("excludes an empty or explicitly unsupported manifest from the setup catalogue", () => {
  const recipe = structuredClone(COMFYUI_RECIPES[0]!);
  recipe.requires.checkpoints = [];
  assert.deepEqual(comfyUiWeightCatalogue([recipe]), []);
  const unsupported = structuredClone(COMFYUI_RECIPES[0]!);
  unsupported.requires.unavailableReason = "unsupported_in_build: missing immutable dependencies";
  assert.deepEqual(comfyUiWeightCatalogue([unsupported]), []);
});

it("has no retired speech component in the setup catalogue", () => {
  assert.ok(!comfyUiWeightCatalogue(COMFYUI_RECIPES).some(entry => entry.id === comfyUiWeightsComponentId("comfyui-cloned-voice")));
});
