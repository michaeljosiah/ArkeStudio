import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { COMFYUI_VERSION_FLOOR, compareComfyUiVersions } from "@arke-studio/contracts";
import { COMFYUI_RECIPES } from "@arke-studio/providers";
import { COMFYUI_VERSION, SETUP_CATALOGUE } from "../../src/setup/catalogue.js";

/**
 * Shipped data checked by assertion, not review (SPEC-021 R-18, R-21; issue 592). A recipe whose
 * floor outruns the pinned runtime is dead on arrival for every managed user with no update to
 * offer; a recipe whose exercised ceiling sits below its own floor or the provider's describes a
 * range no engine satisfies, labelling every usable engine untested.
 */
describe("catalogue invariants", () => {
  it("the pinned managed runtime is at or above every shipped recipe's floor (R-21)", () => {
    for (const recipe of COMFYUI_RECIPES) {
      assert.equal(
        compareComfyUiVersions(COMFYUI_VERSION, recipe.engine.minVersion)! >= 0,
        true,
        `${recipe.id} needs ${recipe.engine.minVersion}, above the pinned ${COMFYUI_VERSION}`,
      );
    }
  });

  it("every recipe's exercised-through version is at or above its own floor and the provider's (R-18)", () => {
    for (const recipe of COMFYUI_RECIPES) {
      const { minVersion, exercisedThroughVersion } = recipe.engine;
      assert.equal(compareComfyUiVersions(exercisedThroughVersion, minVersion)! >= 0, true, `${recipe.id}: exercised below its own floor`);
      assert.equal(compareComfyUiVersions(exercisedThroughVersion, COMFYUI_VERSION_FLOOR)! >= 0, true, `${recipe.id}: exercised below the provider floor`);
      assert.equal(compareComfyUiVersions(minVersion, COMFYUI_VERSION_FLOOR)! >= 0, true, `${recipe.id}: floor below the provider floor`);
    }
  });

  it("the managed runtime entry records where the tree states its own version", () => {
    const runtime = SETUP_CATALOGUE.find((entry) => entry.id === "comfyui-runtime")!;
    assert.equal(runtime.spec.kind, "tree");
    if (runtime.spec.kind === "tree") {
      assert.equal(runtime.spec.version, COMFYUI_VERSION);
      assert.equal(runtime.spec.versionFile, "ComfyUI/comfyui_version.py");
    }
  });
});
