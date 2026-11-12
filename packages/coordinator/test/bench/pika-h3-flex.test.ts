import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { newId, comfyUiWeightsComponentId } from "@arke-studio/contracts";
import { COMFYUI_RECIPES, SHIPPED_MANIFEST, comfyUiRecipeById } from "@arke-studio/providers";
import { addBenchReference, openBenchSession, planBenchDispatch } from "../../src/bench/service.js";
import { comfyUiWeightCatalogue } from "../../src/comfyui/setup.js";
import { localTakeFreeze } from "../../src/queue/local-sampling.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

const clock = () => "2026-10-30T12:00:00.000Z";
const recipes = COMFYUI_RECIPES.filter(recipe => recipe.id.startsWith("comfyui-pika-h3-flex"));

test("Pika setup entries install the same pinned files that readiness and dispatch require", () => {
  const entries = comfyUiWeightCatalogue(recipes);
  assert.equal(entries.length, 4);
  for (const recipe of recipes) {
    const entry = entries.find(row => row.id === comfyUiWeightsComponentId(recipe.id))!;
    assert.equal(entry.spec.kind, "files");
    if (entry.spec.kind !== "files") throw new Error("Expected model files");
    assert.equal(entry.spec.externalRoot, "comfyui-models");
    assert.deepEqual(entry.spec.files.map(file => [file.file, file.sha256]), recipe.requires.checkpoints.map(file => [file.file, file.sha256]));
    assert.equal(entry.sizeMb, SHIPPED_MANIFEST.models.find(model => model.id === recipe.id)!.requires!.diskMb);
  }
});

for (const recipe of recipes) test(`${recipe.id}: Bench preserves the model, reference meaning, seed and version`, async () => {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir, { clock });
  closeOnCleanup(() => store.close());
  const bytes = Buffer.from("Pika reference fixture");
  const artifactId = newId("ar");
  await store.ownedWrite(async () => {
    await mkdir(join(dir, "artifacts"), { recursive: true });
    await writeFile(join(dir, "artifacts", "pika.png"), bytes);
    await writeFile(join(dir, "artifacts", "pika.png.json"), JSON.stringify({ id: artifactId, kind: "image", file: "pika.png",
      hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, origin: { by: "user" }, links: [], created: clock() }));
  });
  const model = SHIPPED_MANIFEST.models.find(row => row.id === recipe.id)!;
  const opened = await openBenchSession(dir, clock, { fresh: true, defaultModel: { provider: "comfyui", model: model.id } });
  assert.ok(opened);
  const seconds = model.id.endsWith("768") ? 5 : 15;
  await opened.store.append({ type: "composer-set", mode: "video", provider: model.provider, model: model.id,
    params: { kind: "video", durationSec: seconds, aspect: "9:16", resolution: model.limits.resolutions![0]! },
    brief: recipe.referenceFrame ? "The robot waves." : "@Image 1 waves." }, { at: clock() });
  if (recipe.referenceFrame) {
    const wrongLane = await addBenchReference({ store: opened.store, session: (await opened.store.fold())! }, store.getBundle(), model,
      { source: { source: "artifact", artifactId }, requestId: "wrong-pika-lane", at: clock() });
    assert.equal(wrongLane.outcome, "refused", "a first-frame preset must not change the meaning of an appearance reference");
  }
  const attached = await addBenchReference({ store: opened.store, session: (await opened.store.fold())! }, store.getBundle(), model,
    { source: { source: "artifact", artifactId }, requestId: "attach-pika", at: clock(), ...(recipe.referenceFrame ? { lane: "keyframe" as const } : {}) });
  assert.notEqual(attached.outcome, "refused", JSON.stringify(attached));
  const plan = planBenchDispatch((await opened.store.fold())!, store.getBundle(), SHIPPED_MANIFEST, {
    worldId: store.worldId, requestId: "pika-dispatch", at: clock(),
    recipeVersionOf: id => comfyUiRecipeById(id)?.recipeVersion,
    localFreeze: (id, rerun) => localTakeFreeze(id, rerun, () => undefined, () => 9123),
  });
  assert.ok(plan.ok, plan.ok ? undefined : plan.reason);
  if (!plan.ok) return;
  assert.equal(plan.inputs[0]!.model, recipe.id);
  assert.equal(plan.inputs[0]!.params.seed, 9123);
  assert.equal(plan.inputs[0]!.params.sampling, undefined);
  assert.deepEqual(plan.inputs[0]!.params.references, ["artifacts/pika.png"]);
  assert.equal(plan.reserved[0]!.request.recipeVersion, 1);
  assert.equal(plan.reserved[0]!.request.requestedSeed, 9123);
  if (recipe.referenceFrame) assert.equal(plan.inputs[0]!.params.taskMode, "first-frame");
  else assert.match(String(plan.inputs[0]!.params.prompt), /<Picture 1>/);
});
