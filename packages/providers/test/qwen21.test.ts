import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { it } from "node:test";
import { ComfyUiClient } from "../src/clients/comfyui.js";
import { COMFYUI_MANIFEST_MODELS, comfyUiRecipeById, comfyUiRecipeIdentity, recipeTemplateDigest } from "../src/comfyui/recipes.js";
import { fitFor, ManifestModelSchema, referencePrompt } from "@arke-studio/contracts";

const recipe = comfyUiRecipeById("comfyui-qwen21-image")!;
const base = () => "http://127.0.0.1:8189";
const image = (n: number) => ({ name: "private-name.png", contentType: "image/png" as const, data: Uint8Array.of(137, 80, 78, 71, n) });

it("Qwen declares a separate 1K research recipe with a verified runtime dependency", async () => {
  const row = COMFYUI_MANIFEST_MODELS.find((m) => m.id === recipe.id)!;
  assert.ok(ManifestModelSchema.safeParse(row).success);
  assert.deepEqual(row.limits.aspects, ["1:1"]);
  assert.deepEqual(row.limits.tiers, { "1K": "1024" });
  assert.equal(row.accepts.referenceImages, 1);
  assert.equal(COMFYUI_MANIFEST_MODELS.find((m) => m.capability === "image")!.id, "comfyui-krea2-image");
  assert.match(row.displayName, /Research/);
  assert.equal(referencePrompt("Keep @Image 1 beside @image2; @Video 1 remains unsupported.", row), "Keep <image1> beside <image2>; @Video 1 remains unsupported.");
  assert.equal(referencePrompt("Image 1 and Image 2", row, 0, 0, true), "<image1> and <image2>");
  assert.equal(referencePrompt("An image 1 note without a citation", row), "An image 1 note without a citation");
  assert.equal(recipe.engine.minVersion, "0.37.0");
  assert.equal(recipe.graph["9"].inputs.device, "off");
  assert.equal(recipe.graph["7"].class_type, "VAEDecodeTiled");
  const bytes = await readFile(new URL("../../../vendor/comfyui/ArkeQwen21Runtime/__init__.py", import.meta.url));
  const pin = recipe.requires.customNodes[0];
  assert.equal(createHash("sha256").update(bytes).digest("hex"), pin.pinnedRef);
  assert.equal(recipe.requires.checkpoints.length, 3);
  for (const checkpoint of recipe.requires.checkpoints) {
    assert.match(checkpoint.sha256, /^[a-f0-9]{64}$/);
    assert.match(checkpoint.url, /\/resolve\/ace0edeb3791a594ddfa36ed5f41a178a394e921\//);
  }
  const changed = structuredClone(recipe);
  changed.referenceConditioning!.textOnly = ["4", 2];
  assert.notEqual(recipeTemplateDigest(changed), recipeTemplateDigest(recipe));
});

it("Qwen measures the CUDA adapter rather than borrowing another card's VRAM", () => {
  const row = COMFYUI_MANIFEST_MODELS.find((m) => m.id === recipe.id)!;
  const machine = { vramMb: 24576, memMb: 65536, diskFreeMb: 100000, platform: "win32" };
  assert.equal(fitFor(row, { ...machine, accelerators: ["rocm"] }).fit, "unsupported");
  assert.equal(fitFor(row, { ...machine, accelerators: ["cuda", "rocm"], vramMbByAccelerator: { cuda: 8192, rocm: 24576 } }).fit, "insufficient");
  assert.equal(fitFor(row, { ...machine, accelerators: ["cuda"], vramMbByAccelerator: { cuda: 24576 } }).fit, "runs-well");
});

for (const count of [0, 1]) it(`Qwen dispatch with ${count} references preserves alpha, order and the authored canvas`, async () => {
  const uploads: string[] = [];
  let graph: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {};
  const client = new ComfyUiClient(async (url, init) => {
    if (url.endsWith("/upload/image")) {
      const file = (init!.body as FormData).get("image") as File;
      uploads.push(file.name);
      return Response.json({ name: `accepted-${uploads.length}.png` });
    }
    assert.ok(url.endsWith("/prompt"));
    graph = JSON.parse(init!.body as string).prompt;
    return Response.json({ prompt_id: "qwen" });
  }, base, async () => ({ ok: true }));
  try {
    await client.submit("", { model: recipe.id, capability: "image", recipe: comfyUiRecipeIdentity(recipe),
      params: { prompt: "Keep the dragon from image 1.", seed: 42, output: { aspect: "1:1" }, references: Array.from({ length: count }, (_, n) => `${n}.png`) },
      imageReferences: Array.from({ length: count }, (_, n) => image(n)),
    });
    assert.equal(uploads.length, count);
    assert.equal(new Set(uploads).size, count);
    assert.ok(uploads.every((name) => /^[a-f0-9]{64}\.png$/.test(name)));
    assert.deepEqual(graph["6"].inputs.latent_image, count ? ["4", 2] : ["5", 0]);
    assert.deepEqual(graph["6"].inputs.model, ["10", 0]);
    assert.deepEqual(graph["6"].inputs.positive, ["4", 0]);
    assert.equal(graph["5"].inputs.width, 1024);
    assert.equal(graph["6"].inputs.steps, 40);
    for (let n = 1; n <= 2; n++) {
      if (n <= count) {
        assert.equal(graph[String(10 + n)].inputs.image, `accepted-${n}.png`);
        assert.deepEqual(graph[String(20 + n)].inputs.alpha, [String(10 + n), 1]);
        assert.deepEqual(graph["4"].inputs[`images.image_${n}`], [String(30 + n), 0]);
        assert.equal(graph[String(30 + n)].inputs.crop, "center");
        assert.equal(graph[String(30 + n)].inputs.width, 1024);
      } else {
        for (const offset of [10, 20, 30]) assert.equal(graph[String(offset + n)], undefined);
        assert.equal(graph["4"].inputs[`images.image_${n}`], undefined);
      }
    }
    assert.equal(recipe.graph["11"].inputs.image, "");
  } finally { client.dispose(); }
});

it("Qwen rejects missing, excessive and unverified references before uploading", async () => {
  let calls = 0;
  const client = new ComfyUiClient(async () => { calls++; throw new Error("unexpected network"); }, base,
    async () => ({ ok: false, reason: "Qwen runtime is not configured" }));
  try {
    for (const request of [
      { params: { prompt: "x", references: ["missing.png"] } },
      { params: { prompt: "x" }, imageReferences: [image(1), image(2)] },
      { params: { prompt: "x" }, imageReferences: [image(1)] },
    ]) await assert.rejects(client.submit("", { model: recipe.id, capability: "image", ...request }));
    assert.equal(calls, 0);
  } finally { client.dispose(); }
});
