import assert from "node:assert/strict";
import { test } from "node:test";
import { AdapterReleaseSchema } from "@arke-studio/contracts";
import { HEARMEMAN_ADAPTERS } from "../src/comfyui/hearmeman.generated.js";
import { recipeWithAdapters, adapterValidationCandidate } from "../src/comfyui/adapters.js";
import { ComfyUiClient } from "../src/clients/comfyui.js";
import { comfyUiRecipeById, comfyUiRecipeIdentity } from "../src/comfyui/recipes.js";

test("pinned inventory accounts for all 14 artifacts without claiming GPU verification", () => {
  assert.equal(HEARMEMAN_ADAPTERS.length, 14);
  assert.equal(HEARMEMAN_ADAPTERS.reduce((sum, row) => sum + row.source.bytes, 0), 4061177176);
  for (const row of HEARMEMAN_ADAPTERS) {
    assert.ok(row.id.endsWith(row.source.sha256));
    assert.equal(row.source.revision, "de4c3bc6122e68b88407c03dfecf521c803f098d");
    assert.ok(row.compatibility.every(pair => pair.state !== "verified"));
    for (const id of row.supersedes) assert.ok(HEARMEMAN_ADAPTERS.some(prior => prior.id === id && prior.adapterId === row.adapterId));
  }
});

test("selection changes only the declared model slot, freezes exact provenance and raises measured floors", () => {
  const base = comfyUiRecipeById("comfyui-h3-video")!;
  const before = structuredClone(base);
  const release = AdapterReleaseSchema.parse({ ...HEARMEMAN_ADAPTERS[0], compatibility: [{ recipeId: base.id, state: "verified", reason: "Fixture only",
    evidence: "Synthetic graph test, not GPU evidence", minStrength: 0.25, maxStrength: 1,
    minEngineVersion: "0.37.0", exercisedThroughVersion: "0.37.0",
    hardware: { minVramMb: 12000, minFreeVramMb: 6000, minMemMb: 32000, minFreeMemMb: 20000 } }] });
  const selection = [{ releaseId: release.id, sha256: release.source.sha256, strength: 0.5 }];
  assert.equal(recipeWithAdapters(base, []), base);
  const composed = recipeWithAdapters(base, selection, [release]);
  assert.deepEqual(base, before);
  assert.deepEqual(composed.graph["3"]!.inputs.model, ["arke_adapter_0", 0]);
  assert.deepEqual(composed.graph.arke_adapter_0!.inputs.model, base.graph["3"]!.inputs.model);
  assert.equal(composed.graph.arke_adapter_0!.inputs.lora_name, `arke/${release.source.sha256}.safetensors`);
  assert.ok(composed.hardware.minVramMb >= 12000);
  assert.deepEqual(comfyUiRecipeIdentity(composed).adapters, selection);
  assert.notEqual(comfyUiRecipeIdentity(composed).templateDigest, comfyUiRecipeIdentity(base).templateDigest);
  assert.notEqual(comfyUiRecipeIdentity(composed).dependencyDigest, comfyUiRecipeIdentity(base).dependencyDigest);
  assert.throws(() => recipeWithAdapters(base, [{ ...selection[0], strength: 1.5 }], [release]), /strength/);
  assert.throws(() => recipeWithAdapters(base, selection), /validation/);
  assert.throws(() => recipeWithAdapters(base, [{ ...selection[0], sha256: "f".repeat(64) }], [release]), /changed/);
});

test("the maintainer candidate does not grant production verification or bypass the host guard", async () => {
  const base = comfyUiRecipeById("comfyui-h3-video")!;
  const release = HEARMEMAN_ADAPTERS[0]!;
  const selections = [{ releaseId: release.id, sha256: release.source.sha256, strength: 1 }];
  const before = structuredClone(release);
  const candidate = adapterValidationCandidate(base, selections);
  assert.deepEqual(release, before);
  assert.deepEqual(candidate.adapters, selections);
  assert.throws(() => recipeWithAdapters(base, selections), /validation/);
  const client = new ComfyUiClient(async () => { throw new Error("Must refuse before HTTP"); }, () => "http://127.0.0.1:8188",
    async () => ({ ok: true }), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    adapterValidationCandidate);
  try {
    await assert.rejects(client.submit("", { model: base.id, capability: "video", recipe: comfyUiRecipeIdentity(candidate),
      params: { adapters: selections } }), /authorization is unavailable/);
  } finally { client.dispose(); }
});
