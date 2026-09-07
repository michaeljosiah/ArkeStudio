import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { freemem, totalmem } from "node:os";
import { setTimeout } from "node:timers/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ComfyUiClient } from "../src/clients/comfyui.js";
import { comfyUiRecipeById, comfyUiRecipeIdentity } from "../src/comfyui/recipes.js";

const [engineDir, outputDir, mode = "mixed"] = process.argv.slice(2);
if (!engineDir || !outputDir || !["mixed", "images", "audio", "video"].includes(mode)) throw new Error("Usage: smoke-h3-reference.ts <ComfyUI directory> <output directory> [mixed|images|audio|video]");
const directory = resolve(outputDir);
await mkdir(directory, { recursive: true });
const run = promisify(execFile);
const ffmpeg = process.env.ARKE_TEST_FFMPEG ?? "ffmpeg";
const ffprobe = process.env.ARKE_TEST_FFPROBE ?? "ffprobe";
const execute = async (args: string[]) => { await run(ffmpeg, ["-nostdin", "-y", ...args], { windowsHide: true, timeout: 60_000 }); };
for (const [name, color] of [["red", "red"], ["blue", "blue"]]) await execute(["-f", "lavfi", "-i", `color=c=${color}:s=256x256`, "-frames:v", "1", join(directory, `${name}.png`)]);
await execute(["-f", "lavfi", "-i", "testsrc2=s=256x256:r=24:d=2", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=32000:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "2", "-shortest", join(directory, "motion.mp4")]);
await execute(["-f", "lavfi", "-i", "sine=frequency=660:sample_rate=32000:duration=2", "-ac", "1", join(directory, "tone.wav")]);
const recipe = comfyUiRecipeById("comfyui-h3-reference-video")!;
const base = "http://127.0.0.1:8188";
const idle = async () => {
  const queue = await (await fetch(`${base}/queue`)).json() as { queue_running: unknown[]; queue_pending: unknown[] };
  if (queue.queue_running.length || queue.queue_pending.length) throw new Error("ComfyUI is busy; no smoke prompt submitted.");
};
await idle();
for (const checkpoint of recipe.requires.checkpoints) {
  console.log(`Verifying ${checkpoint.file}`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(join(engineDir, "models", checkpoint.file))) hash.update(chunk);
  if (hash.digest("hex") !== checkpoint.sha256) throw new Error(`Weight mismatch: ${checkpoint.file}`);
}
await idle();
const images = mode === "mixed" || mode === "images" ? await Promise.all(["red", "blue"].map(async name => ({ name: `${name}.png`, contentType: "image/png" as const, data: await readFile(join(directory, `${name}.png`)) }))) : [];
const videos = mode === "mixed" || mode === "video" ? [{ contentType: "video/mp4" as const, data: await readFile(join(directory, "motion.mp4")), durationSec: 2, referenceVideo24fps: true as const }] : [];
const audio = mode === "mixed" || mode === "audio" ? [{ name: "tone.wav", contentType: "audio/wav" as const, data: await readFile(join(directory, "tone.wav")), durationSec: 2 }] : [];
const client = new ComfyUiClient((url, init) => fetch(url, init), () => base, async () => ({ ok: true }));
const started = Date.now();
const memory = { totalMb: totalmem() / 2 ** 20, freeMb: freemem() / 2 ** 20 };
const request = await client.submit("", { model: recipe.id, capability: "video", recipe: comfyUiRecipeIdentity(recipe),
  params: { prompt: `A playful abstract animation of a red cube and a blue sphere on a white tabletop. ${images.length ? "Use <Picture 1> for the red cube's color and <Picture 2> for the blue sphere's color." : ""} ${videos.length ? "Use <Video 1> as motion guidance, with its <Audio 1> soundtrack as sound guidance." : ""} ${audio.length ? `Use <Audio ${videos.length + 1}> as a tonal sound reference.` : ""} The shapes gently move apart, then come together. One continuous camera shot, no titles.`,
    seed: 9123, durationSec: 5, aspect: "16:9", references: images.map(image => image.name), videoReferences: videos.map(() => "motion.mp4"),
    referenceMedia: audio.map(clip => ({ kind: "audio", file: clip.name, hash: `sha256:${createHash("sha256").update(clip.data).digest("hex")}`, durationSec: clip.durationSec })) },
  imageReferences: images, videoReferences: videos, mediaAudioReferences: audio });
console.log(JSON.stringify({ remoteId: request.remoteId, mode, memory }));
await writeFile(join(directory, "request.json"), JSON.stringify({ remoteId: request.remoteId, mode, memory }));
try {
  let nextLog = 0, lowestFreeMb = memory.freeMb;
  for (;;) {
    const result = await client.poll("", request.remoteId);
    lowestFreeMb = Math.min(lowestFreeMb, freemem() / 2 ** 20);
    if (Date.now() >= nextLog) { console.log(`${Math.round((Date.now() - started) / 1000)}s: ${result.state}; free RAM ${Math.round(freemem() / 2 ** 20)} MB`); nextLog = Date.now() + 30_000; }
    if (result.state === "failed" || result.state === "cancelled") throw new Error(JSON.stringify(result));
    if (result.state === "succeeded") break;
    if (Date.now() - started > 45 * 60_000) { await client.cancel("", request.remoteId); throw new Error("Smoke timed out; its prompt cancelled."); }
    await setTimeout(5000);
  }
  const artifacts = await client.fetchArtifacts("", request.remoteId, { model: recipe.id });
  for (const artifact of artifacts) await writeFile(join(directory, artifact.name), artifact.data);
  const file = join(directory, artifacts[0]!.name);
  const { stdout } = await run(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", file], { windowsHide: true });
  const report = { mode, elapsedSec: (Date.now() - started) / 1000, memory, lowestFreeMb, recipe: comfyUiRecipeIdentity(recipe), media: JSON.parse(stdout) };
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { client.dispose(); }
