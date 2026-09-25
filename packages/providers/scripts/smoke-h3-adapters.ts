import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream, constants } from "node:fs";
import { mkdir, readFile, writeFile, link, copyFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { freemem, totalmem } from "node:os";
import { setTimeout } from "node:timers/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ComfyUiClient } from "../src/clients/comfyui.js";
import { comfyUiRecipeById, comfyUiRecipeIdentity } from "../src/comfyui/recipes.js";
import { adapterValidationCandidate } from "../src/comfyui/adapters.js";
import { HEARMEMAN_ADAPTERS } from "../src/comfyui/hearmeman.generated.js";

const [engineDir, modelsDir, intakeDir, outputDir, recipeId = "comfyui-h3-video", entry = "0"] = process.argv.slice(2);
if (!engineDir || !modelsDir || !intakeDir || !outputDir) throw new Error("Usage: smoke-h3-adapters.ts <engine directory> <models directory> <verified intake directory> <output directory> [recipe ID] [adapter index|all]");
const baseRecipe = comfyUiRecipeById(recipeId);
if (!baseRecipe?.adapterSlot) throw new Error("Choose a shipped H3 recipe with an adapter slot");
const releases = entry === "all" ? HEARMEMAN_ADAPTERS : [HEARMEMAN_ADAPTERS[Number(entry)]];
if (releases.some(row => !row)) throw new Error("Invalid adapter index");
const output = resolve(outputDir), endpoint = "http://127.0.0.1:8188";
await mkdir(output, { recursive: true });
const run = promisify(execFile);
const receiptPath = join(output, "verified-files.json");
const verified = new Map<string, string>(JSON.parse(await readFile(receiptPath, "utf8").catch(error => {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return "[]"; throw error;
})));
async function verify(file: string, expected: string): Promise<void> {
  const info = await stat(file), identity = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${expected}`;
  if (verified.get(file) === identity) return;
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  assert.equal(hash.digest("hex"), expected, `Pinned weight mismatch: ${file}`);
  verified.set(file, identity);
  await writeFile(receiptPath, JSON.stringify([...verified]));
}
async function gpu(): Promise<number> {
  const { stdout } = await run("nvidia-smi", ["--query-gpu=memory.free", "--format=csv,noheader,nounits"], { windowsHide: true, timeout: 10_000 });
  const free = Number(stdout.trim().split(/\r?\n/)[0]);
  if (!Number.isFinite(free)) throw new Error("GPU free-memory probe unavailable");
  return free;
}
async function idle(): Promise<void> {
  const queue = await (await fetch(`${endpoint}/queue`, { signal: AbortSignal.timeout(10_000) })).json() as { queue_running: unknown[]; queue_pending: unknown[] };
  if (queue.queue_running.length || queue.queue_pending.length) throw new Error("Engine is busy; no test submitted");
}
await idle();
console.log("Verifying the pinned H3 base dependency closure");
for (const checkpoint of baseRecipe.requires.checkpoints) {
  console.log(`Hashing ${checkpoint.file}`);
  await verify(join(modelsDir, checkpoint.file), checkpoint.sha256);
}
const system = await (await fetch(`${endpoint}/system_stats`)).json();
const { stdout: engineCommit } = await run("git", ["rev-parse", "HEAD"], { cwd: engineDir, windowsHide: true });
for (const release of releases) {
  const deadline = AbortSignal.timeout(45 * 60_000);
  const directory = join(output, release!.id);
  await mkdir(directory, { recursive: true });
  const selections = [{ releaseId: release!.id, sha256: release!.source.sha256, strength: 1 }];
  const candidate = adapterValidationCandidate(baseRecipe, selections);
  const source = join(intakeDir, "weights", `${release!.source.sha256}.safetensors`);
  await verify(source, release!.source.sha256);
  // The test runtime searches this checkout's models as well as the user's D: mapping.
  // A hard link avoids a second weight copy where volumes permit; otherwise copy exclusively.
  // Existing files are verified, never replaced.
  const target = join(engineDir, "models", "loras", "arke", `${release!.source.sha256}.safetensors`);
  await mkdir(join(engineDir, "models", "loras", "arke"), { recursive: true });
  let createdFile = false;
  try {
    try { await link(source, target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      await copyFile(source, target, constants.COPYFILE_EXCL);
    }
    createdFile = true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  await verify(target, release!.source.sha256);
  await writeFile(join(directory, "test-file.json"), JSON.stringify({ target, sha256: release!.source.sha256, createdFile }));
  const guard = async (model: string, selected: unknown) => {
    assert.equal(model, recipeId); assert.deepEqual(selected, selections);
    await verify(target, release!.source.sha256);
  };
  // The candidate injection is confined to this maintainer process. Neither the shipped
  // catalogue nor the user's acknowledgement/compliance journal is changed by a test.
  const client = new ComfyUiClient((url, init) => fetch(url, init), () => endpoint, async () => ({ ok: true }),
    undefined, gpu, async () => freemem() / 2 ** 20, () => "local", undefined, undefined, undefined, undefined,
    guard, adapterValidationCandidate);
  const started = Date.now();
  const before = { freeVramMb: await gpu(), freeRamMb: freemem() / 2 ** 20, totalRamMb: totalmem() / 2 ** 20 };
  const report: Record<string, unknown> = { at: new Date().toISOString(), kind: "unverified-candidate-smoke", recipe: comfyUiRecipeIdentity(candidate),
    strength: 1, seed: 9123, system, engineCommit: engineCommit.trim(), before, visualInspection: "pending" };
  let remoteId: string | undefined;
  try {
    await idle();
    if (before.freeVramMb < (baseRecipe.hardware.minFreeVramMb ?? 0)) throw new Error("Free VRAM is below the base recipe admission floor");
    const imageReferences = [];
    if (recipeId === "comfyui-h3-reference-video") {
      const image = join(directory, "reference.png");
      await run("ffmpeg", ["-nostdin", "-y", "-f", "lavfi", "-i", "color=c=red:s=256x256", "-frames:v", "1", image], { windowsHide: true });
      imageReferences.push({ name: "reference.png", contentType: "image/png" as const, data: await readFile(image) });
    }
    const prompt = "A playful abstract animation of a red cube and a blue sphere on a white tabletop. The shapes gently move apart, then come together. One continuous camera shot. Only geometric objects, no people, no titles.";
    report.prompt = prompt;
    const request = await client.submit("", { model: recipeId, capability: "video", recipe: comfyUiRecipeIdentity(candidate), signal: deadline,
      params: { prompt, seed: 9123, durationSec: 5, aspect: "16:9", adapters: selections, references: imageReferences.map(image => image.name) }, imageReferences });
    remoteId = request.remoteId; report.remoteId = remoteId;
    console.log(JSON.stringify({ release: release!.displayName, remoteId, before }));
    await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2));
    let lowestRamMb = before.freeRamMb, lowestVramMb = before.freeVramMb, nextLog = 0;
    for (;;) {
      deadline.throwIfAborted();
      const result = await client.poll("", remoteId);
      lowestRamMb = Math.min(lowestRamMb, freemem() / 2 ** 20);
      lowestVramMb = Math.min(lowestVramMb, await gpu());
      if (Date.now() >= nextLog) { console.log(`${release!.displayName}: ${Math.round((Date.now() - started) / 1000)}s ${result.state}`); nextLog = Date.now() + 30_000; }
      if (result.state === "failed" || result.state === "cancelled") throw new Error(JSON.stringify(result));
      if (result.state === "succeeded") break;
      await setTimeout(5000, undefined, { signal: deadline });
    }
    report.lowestRamMb = lowestRamMb; report.lowestVramMb = lowestVramMb;
    const artifacts = await client.fetchArtifacts("", remoteId, { model: recipeId });
    for (const artifact of artifacts) {
      const file = join(directory, artifact.name);
      await writeFile(file, artifact.data);
      const { stdout } = await run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file], { windowsHide: true });
      report.media = JSON.parse(stdout);
      await run("ffmpeg", ["-nostdin", "-y", "-i", file, "-vf", "fps=1", join(directory, "frame-%02d.png")], { windowsHide: true });
    }
    report.status = "generated-awaiting-inspection";
  } catch (error) {
    report.status = "failed"; report.reason = error instanceof Error ? error.message : String(error);
    if (remoteId) await client.cancel("", remoteId).catch(() => {});
    process.exitCode = 1;
  } finally {
    report.elapsedSec = (Date.now() - started) / 1000;
    await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2));
    if (remoteId) await idle().then(() => client.release(recipeId)).catch(() => {});
    client.dispose();
  }
  console.log(JSON.stringify({ release: release!.displayName, status: report.status, reason: report.reason, elapsedSec: report.elapsedSec }));
  if (report.status === "failed") break;
}
