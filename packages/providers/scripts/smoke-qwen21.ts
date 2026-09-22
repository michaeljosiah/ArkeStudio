import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { freemem, totalmem } from "node:os";
import { setTimeout } from "node:timers/promises";
import { ComfyUiClient } from "../src/clients/comfyui.js";
import { comfyUiRecipeById, comfyUiRecipeIdentity, recipeNodeClasses } from "../src/comfyui/recipes.js";

const [engineDir, modelsDir, base, destination, ...references] = process.argv.slice(2);
if (!engineDir || !modelsDir || !base || !destination || references.length > 2) {
  throw new Error("Usage: node --import tsx packages/providers/scripts/smoke-qwen21.ts <engine> <models> <URL> <output directory> [reference PNG] [reference PNG]");
}
const recipe = comfyUiRecipeById("comfyui-qwen21-image")!;
const target = resolve(destination);
await mkdir(target, { recursive: false });
const get = async (path: string) => {
  const response = await fetch(`${base.replace(/\/+$/, "")}${path}`, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Engine returned ${response.status} for ${path}`);
  return response.json();
};
const preflight = async () => {
  const queue = await get("/queue");
  if (queue.queue_running.length || queue.queue_pending.length) return { ok: false as const, reason: "Engine is busy" };
  const nodes = await get("/object_info");
  const missing = recipeNodeClasses(recipe).filter((name) => !nodes[name]);
  if (missing.length) return { ok: false as const, reason: `Missing recipe runtime: ${missing.join(", ")}` };
  return { ok: true as const };
};
for (const checkpoint of recipe.requires.checkpoints) {
  console.log(`Verifying ${checkpoint.file}`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(join(modelsDir, checkpoint.file))) hash.update(chunk);
  if (hash.digest("hex") !== checkpoint.sha256) throw new Error(`Weight verification failed: ${checkpoint.file}`);
}
const dependency = recipe.requires.customNodes[0]!;
const code = await readFile(join(engineDir, "custom_nodes", dependency.id, "__init__.py"));
if (createHash("sha256").update(code).digest("hex") !== dependency.pinnedRef) throw new Error("Runtime source verification failed");
const stats = await get("/system_stats");
const client = new ComfyUiClient(async (url, init) => {
  if (url.endsWith("/prompt")) await writeFile(join(target, "request.json"), init!.body as string);
  return fetch(url, init);
}, () => base, preflight, undefined, undefined, async () => freemem() / 2 ** 20);
const started = Date.now();
const before = { totalMb: totalmem() / 2 ** 20, freeMb: freemem() / 2 ** 20 };
try {
  const submitted = await client.submit("", {
    model: recipe.id, capability: "image", recipe: { ...comfyUiRecipeIdentity(recipe), engineVersion: stats.system.comfyui_version },
    params: {
      prompt: process.env.ARKE_SMOKE_PROMPT ?? (references.length
        ? "Keep the same ceramic teapot from image 1. Photograph it on a pale oak table beside a rain-streaked window at dusk. Warm amber lamplight reflects in the cobalt blue glaze. Preserve its round body, curved spout, handle and brass lid details."
        : "An editorial still-life photograph of a round cobalt blue ceramic teapot with a curved spout and small brass lid, resting on a pale oak table beside loosely folded linen. Soft morning window light from the left, glossy handmade glaze, fine wood grain, a cream kitchen and softly blurred leafy plant. Natural color, precise material detail, no text."),
      seed: Number(process.env.ARKE_SMOKE_SEED ?? 28471), output: { aspect: "1:1", tier: "1K" }, references,
    },
    imageReferences: await Promise.all(references.map(async (path) => ({ name: "reference.png", contentType: "image/png" as const, data: await readFile(path) }))),
  });
  await writeFile(join(target, "submission.json"), JSON.stringify(submitted, null, 2));
  console.log(`Submitted ${submitted.remoteId}`);
  for (;;) {
    const result = await client.poll("", submitted.remoteId);
    console.log(`${Math.round((Date.now() - started) / 1000)}s: ${result.state}`);
    if (result.state === "failed" || result.state === "cancelled") throw new Error(JSON.stringify(result));
    if (result.state === "succeeded") break;
    if (Date.now() - started > 20 * 60 * 1000) {
      await client.cancel("", submitted.remoteId);
      throw new Error("Smoke check exceeded 20 minutes; cancellation requested");
    }
    await setTimeout(10000);
  }
  const artifacts = await client.fetchArtifacts("", submitted.remoteId, { model: recipe.id });
  for (const artifact of artifacts) await writeFile(join(target, artifact.name), artifact.data);
  const report = { elapsedSec: (Date.now() - started) / 1000, before, engine: stats.system,
    recipe: comfyUiRecipeIdentity(recipe), references: references.length, outputs: artifacts.map((a) => a.name) };
  await writeFile(join(target, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ elapsedSec: report.elapsedSec, outputs: report.outputs }));
} finally { client.dispose(); }
