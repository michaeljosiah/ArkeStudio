import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { freemem, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ChildLedger, ChildSupervisor, ProfiledComfyUiEngineService, readCustomNodeRef, registerExitBackstop } from "@arke-studio/coordinator";
import { COMFYUI_RECIPES, ComfyUiClient, recipeNodeClasses } from "@arke-studio/providers";
import { comfyUiRecipeIdentity } from "../../../packages/providers/src/comfyui/recipes.js";
import { ComfyUiDigestCache } from "../src/comfyui-digest-cache.js";
import { detectQwenCudaDevice, qwenEngineProfile } from "../src/comfyui-profiles.js";

const [root, models, output, reference] = process.argv.slice(2);
if (!root || !models || !output) throw new Error("Usage: node --import tsx apps/desktop/scripts/smoke-qwen-profile.ts <app root with comfyui-runtime> <models folder> <new output folder> [reference PNG]");
const appRoot = resolve(root);
const destination = resolve(output);
await mkdir(destination, { recursive: false });
const cudaDevice = await detectQwenCudaDevice();
const profile = qwenEngineProfile(fileURLToPath(new URL("../../../vendor/comfyui", import.meta.url)), cudaDevice);
const cache = new ComfyUiDigestCache(appRoot);
const ledger = new ChildLedger(join(appRoot, "run", "children.json"));
const memory = async (field: "free" | "total") => {
  const { stdout } = await promisify(execFile)("nvidia-smi", [`--query-gpu=memory.${field}`, "--format=csv,noheader,nounits", ...(cudaDevice ? ["--id", cudaDevice] : [])], { timeout: 5000, windowsHide: true });
  return Number.parseInt(stdout.trim().split(/\r?\n/)[0]!, 10);
};
const freeVramMb = () => memory("free");
const freeMemMb = async () => freemem() / 2 ** 20;
const service = new ProfiledComfyUiEngineService({
  appRoot, freeVramMb, freeMemMb,
  recipes: COMFYUI_RECIPES.map(recipe => ({
    id: recipe.id, displayName: recipe.displayName, capability: recipe.capability, version: recipe.recipeVersion,
    ...recipe.hardware, checkpoints: recipe.requires.checkpoints, customNodes: recipe.requires.customNodes,
    ...(recipe.requires.unavailableReason ? { unavailableReason: recipe.requires.unavailableReason } : {}),
    minEngineVersion: recipe.engine.minVersion, exercisedThroughVersion: recipe.engine.exercisedThroughVersion,
    nodeClasses: recipeNodeClasses(recipe), identity: comfyUiRecipeIdentity(recipe),
  })),
  fetch: (url, init) => fetch(url, init),
  fileExists: async path => { try { await stat(path); return true; } catch { return false; } },
  listDirectories: async path => { try { return (await readdir(path, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name); } catch { return []; } },
  hashFile: (path, signal, force) => cache.hashFile(path, signal, force),
  readNodeRef: readCustomNodeRef,
  writeTextFile: (path, text) => writeFile(path, text, "utf8"),
  createSupervisor: spec => new ChildSupervisor({ ...spec, logFile: join(appRoot, "logs", `${spec.id}.log`) }, { ledger }),
  registerSupervisorExitBackstop: supervisor => registerExitBackstop(supervisor),
  createProcessEpoch: randomUUID,
}, profile.model, profile.launch);
const client = new ComfyUiClient(async (url, init) => {
  if (url.endsWith("/prompt")) await writeFile(join(destination, "request.json"), String(init?.body));
  return fetch(url, init);
}, model => service.baseUrl(model), model => service.preflight(model), undefined, freeVramMb, freeMemMb,
undefined, undefined, undefined, () => service.baseUrls());
try {
  await service.applySettings({ enginePath: null, engineUrl: null, modelsDir: resolve(models) });
  if (!(await service.waitUntilReady())) throw new Error("The managed engine did not start");
  const deadline = Date.now() + 120_000;
  while (service.baseUrl(profile.model) === null && Date.now() < deadline) await setTimeout(500);
  if (service.baseUrl(profile.model) === null) throw new Error("The Qwen worker did not start");
  await service.reverify([profile.model]);
  const status = await service.status({ vramMb: await memory("total"), memMb: Math.round(totalmem() / 2 ** 20), diskFreeMb: null, accelerators: ["cuda"] });
  await writeFile(join(destination, "readiness.json"), JSON.stringify(status, null, 2));
  const ready = status.recipes.find(recipe => recipe.recipeId === profile.model)!;
  console.log(JSON.stringify({ readiness: ready, primary: service.baseUrl(), worker: service.baseUrl(profile.model) }));
  if (ready.state !== "ready") throw new Error(ready.reason ?? "Qwen is not ready");
  const started = Date.now();
  const submitted = await client.submit("", {
    model: profile.model, capability: "image", recipe: service.identityFor(profile.model)!.recipe,
    params: { prompt: reference
      ? "Keep the same ceramic teapot from <image1>. Place it beside a rainy window at dusk with warm amber lamplight. Preserve its shape, handle, spout and blue glaze."
      : "An editorial photograph of a cobalt blue ceramic teapot with a curved spout and brass lid, resting on a pale oak table beside folded linen. Soft morning window light, glossy handmade glaze, a softly blurred leafy plant, no text.",
    seed: 28471, output: { aspect: "1:1", tier: "1K" }, ...(reference ? { references: ["reference.png"] } : {}) },
    ...(reference ? { imageReferences: [{ name: "reference.png", contentType: "image/png" as const, data: await readFile(reference) }] } : {}),
  });
  for (;;) {
    const state = await client.poll("", submitted.remoteId, { model: profile.model });
    console.log(`${Math.round((Date.now() - started) / 1000)}s: ${state.state}`);
    if (state.state === "succeeded") break;
    if (state.state === "failed" || state.state === "cancelled") throw new Error(JSON.stringify(state));
    if (Date.now() - started > 20 * 60 * 1000) throw new Error("Managed-profile smoke check exceeded twenty minutes");
    await setTimeout(10000);
  }
  for (const artifact of await client.fetchArtifacts("", submitted.remoteId, { model: profile.model })) {
    await writeFile(join(destination, artifact.name), artifact.data);
  }
  await writeFile(join(destination, "report.json"), JSON.stringify({ elapsedSec: (Date.now() - started) / 1000, identity: service.identityFor(profile.model), reference: Boolean(reference) }, null, 2));
} finally {
  client.dispose();
  await service.dispose();
}
