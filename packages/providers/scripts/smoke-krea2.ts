import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { freemem, totalmem } from "node:os";
import { setTimeout } from "node:timers/promises";
import { ComfyUiClient } from "../src/clients/comfyui.js";
import { comfyUiRecipeById, comfyUiRecipeIdentity } from "../src/comfyui/recipes.js";

const [engineDir, destination, referencePath] = process.argv.slice(2);
if (!engineDir || !destination) {
  throw new Error("Usage: node --import tsx packages/providers/scripts/smoke-krea2.ts <ComfyUI directory> <output directory> [reference PNG]");
}
const recipe = comfyUiRecipeById("comfyui-krea2-image")!;
const base = "http://127.0.0.1:8188";
const queue = await (await fetch(`${base}/queue`)).json() as { queue_running: unknown[]; queue_pending: unknown[] };
if (queue.queue_running.length || queue.queue_pending.length) throw new Error("ComfyUI is busy; run this smoke check when its queue is empty.");
for (const checkpoint of recipe.requires.checkpoints) {
  console.log(`Verifying ${checkpoint.file}`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(join(engineDir, "models", checkpoint.file))) hash.update(chunk);
  if (hash.digest("hex") !== checkpoint.sha256) throw new Error(`Weight verification failed: ${checkpoint.file}`);
}
const node = recipe.requires.customNodes[0]!;
const identity = await readFile(join(engineDir, "custom_nodes", node.id, ".arke-content-id"), "utf8");
if (identity.trim() !== node.pinnedRef) throw new Error("Install and verify the vendored Krea node first.");
const currentQueue = await (await fetch(`${base}/queue`)).json() as typeof queue;
if (currentQueue.queue_running.length || currentQueue.queue_pending.length) throw new Error("ComfyUI became busy during verification; no smoke prompt was submitted.");
const client = new ComfyUiClient((url, init) => fetch(url, init), () => base, async () => ({ ok: true }));
const started = Date.now();
const memoryBefore = { totalMb: Math.round(totalmem() / 2 ** 20), freeMb: Math.round(freemem() / 2 ** 20) };
const request = await client.submit("", {
  model: recipe.id, capability: "image", recipe: comfyUiRecipeIdentity(recipe),
  params: {
    prompt: referencePath
      ? "Keep the same ceramic teapot, its round body, curved spout and cobalt blue glaze from the reference image. Photograph it on a pale oak table beside a rain-streaked window at dusk. Warm amber lamplight reflects in the glossy glaze, with fine droplets on the window and a softly blurred garden outside. Restrained editorial still-life photography, natural textures, carefully balanced composition."
      : "An editorial still-life photograph of a round cobalt blue ceramic teapot with a curved spout and small brass lid, resting on a pale oak table. A linen cloth lies loosely folded beside it. Soft morning light falls through a large window from the left, revealing tiny imperfections in the glossy handmade glaze and fine wood grain. The background is a quiet cream-colored kitchen with a single leafy plant softly out of focus. Natural color, subtle shadows, precise material detail, elegant balanced composition, no text.",
    seed: 28471, output: { aspect: "1:1", width: 2048, height: 2048, tier: "2K" },
    ...(referencePath ? { references: ["smoke-reference.png"] } : {}),
  },
  ...(referencePath ? { imageReferences: [{ name: "smoke-reference.png", contentType: "image/png" as const, data: await readFile(referencePath) }] } : {}),
});
console.log(JSON.stringify({ remoteId: request.remoteId, memoryBefore, reference: Boolean(referencePath) }));
let lastState = "";
try {
  for (;;) {
    const result = await client.poll("", request.remoteId);
    if (result.state !== lastState) {
      console.log(`${Math.round((Date.now() - started) / 1000)}s: ${result.state}`);
      lastState = result.state;
    }
    if (result.state === "failed" || result.state === "cancelled") throw new Error(JSON.stringify(result));
    if (result.state === "succeeded") break;
    if (Date.now() - started > 30 * 60 * 1000) {
      await client.cancel("", request.remoteId);
      throw new Error("Smoke check exceeded 30 minutes; its prompt was cancelled.");
    }
    await setTimeout(5000);
  }
  const artifacts = await client.fetchArtifacts("", request.remoteId, { model: recipe.id });
  await mkdir(resolve(destination), { recursive: true });
  for (const artifact of artifacts) await writeFile(join(resolve(destination), artifact.name), artifact.data);
  const report = { remoteId: request.remoteId, elapsedSec: (Date.now() - started) / 1000, memoryBefore, recipe: comfyUiRecipeIdentity(recipe), reference: Boolean(referencePath) };
  await writeFile(join(resolve(destination), "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  client.dispose();
}
