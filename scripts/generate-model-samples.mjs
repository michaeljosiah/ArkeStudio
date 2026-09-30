#!/usr/bin/env node
/**
 * The posters on the AI models pane's image and video tiles (SPEC-042 R-17), each made by the
 * model the tile names.
 *
 * A tile's picture is the one place the pane shows what a model makes, so a poster painted by a
 * different model would be a small lie about the one it sits on. Every row here is therefore the
 * tile's own model, reached through fal: the fal rows by their own route, and the other rows by
 * the fal route serving the same weights — GPT Image 2 for the OpenAI row, SDXL base for the
 * local draft image, Wan 2.2 TI2V 5B for the local draft video, Krea 2 Turbo for the local Krea
 * tile, MiniMax H3 for the three local H3 tiles. A model fal does not serve has no row here.
 * Higgsfield Soul 2.0's poster came from Higgsfield's own CLI, the route the app dispatches it by:
 *
 *   higgsfield generate create text2image_soul_v2 --prompt "..." --aspect_ratio 16:9 --quality 1.5k --wait --json
 *
 * then the same ffmpeg step as below on its result_url. Qwen Image 2.1 has no hosted route at all
 * (fal serves 2 and 3, not 2.1) and keeps its plain plate.
 *
 * A video tile's poster is the first frame of a clip the model made, as R-17 has it, so a clip
 * can be added later without the poster changing. Clips are made at the shortest length and the
 * cheapest resolution each route offers, with sound off; this is a still, not a showreel.
 *
 * Genres are drawn at random from a pool on every run, so a re-run is a new set rather than the
 * same prompts twice. The pool stays clear of the fixture's lighthouse story on purpose: the
 * pane is the first look at what the studio can make, and it should not read as one story.
 *
 * Usage, from the repository root (costs roughly US$8 at September 2026 prices):
 *
 *   PowerShell:  $env:FAL_KEY="..."; node scripts/generate-model-samples.mjs
 *   bash:        FAL_KEY=... node scripts/generate-model-samples.mjs
 *
 * Options:
 *   --only <a,b>   Model ids to (re)make; default every row.
 *   --raw <dir>    Where the full-size downloads and prompts.json go (default: a temp dir).
 *
 * Writes packages/client/public/samples/<model id>.webp at 640x360. Needs ffmpeg with libwebp on
 * PATH. A new poster only shows once its model id is in MODEL_SAMPLES in manifest-data.ts.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "packages", "client", "public", "samples");

const GENRES = [
  "Cyberpunk: a night-market noodle stall under stacked neon signs in pouring rain, steam rising, a courier in a glowing visor waiting for her order",
  "Western: a dusty frontier main street at high noon, two gunslingers facing off in the heat haze, townsfolk peering from the saloon doors",
  "High fantasy: a copper dragon coiled around a ruined mountain temple at dawn, a lone armoured knight climbing the stair towards it",
  "Film noir, black and white: a 1940s detective's office at night, venetian-blind shadows across the desk, cigarette smoke curling, rain on the window",
  "Space opera: a vast battle-scarred starship sliding out of a violet nebula above a ringed gas giant, a squadron of fighters peeling away",
  "Samurai drama: a lone ronin in a bamboo forest as snow begins to fall, hand resting on his sword, breath misting",
  "Cosy mystery: a cluttered village bookshop in autumn light, a ginger cat asleep on a stack of books beside a cooling cup of tea and a torn letter",
  "Post-apocalyptic: a motorway interchange reclaimed by forest decades later, deer grazing between rusted cars under a pale sky",
  "Steampunk: a brass-ribbed airship easing into dock at a clockwork tower above soot-dark Victorian rooftops",
  "Folk horror: an abandoned travelling carnival at dusk in fog, a single carousel still lit and turning slowly with no riders",
  "Heist thriller: a crew in black tie lowering on cables into a marble vault criss-crossed by red security lasers",
  "Romance: a couple sharing one umbrella on a Paris bridge at blue hour, street lamps just coming on, the river shining behind them",
  "Kaiju: a moss-covered giant wading through a river city at sunset, crowds on a suspension bridge turning to look",
  "Sports drama: a boxer alone in a run-down gym before dawn, single hanging bulb, sweat and chalk dust in the air",
  "Golden-age musical: tap dancers in sequined tails mid-routine on a gleaming art-deco soundstage staircase",
  "Norse saga: a longship rowing through a narrow fjord under a green aurora, shields along its side, torches on the prow",
  "Nature documentary: a snow leopard stalking along a Himalayan ridge in blowing snow, long lens, morning light",
  "Anime, cel-shaded: a schoolgirl on a rooftop at golden hour, school bag at her feet, a city skyline and summer clouds behind her",
  "War drama: a First World War trench at first light, soldiers waiting at the ladders in low mist, an officer checking his watch",
  "Surrealism: a staircase melting into desert sand, leading up to three free-standing doors that open onto different skies",
  "Fairy tale: a gingerbread cottage deep in a forest of giant glowing mushrooms, fireflies drifting over the path",
  "Road movie: a vintage turquoise convertible on an empty desert highway through red mesas at golden hour, dust trailing",
  "Retro sci-fi: an art-deco dome city on the ocean floor, a bulbous yellow submarine gliding past lit windows and schools of fish",
  "Slapstick comedy: a towering wedding cake mid-collapse at a banquet, a waiter diving to catch it, guests frozen in horror",
  "Historical epic: a chariot race in the Circus Maximus, four horses abreast kicking up sand before a roaring crowd",
  "Solarpunk: terraced rooftop farms and wind sails over a bright green city, cyclists crossing a garden bridge below",
];

const CINEMA = "Cinematic film still, 16:9 widescreen composition, rich lighting, no text, no captions, no watermark.";
const MOTION = "Cinematic shot, 16:9, gentle camera movement, no text, no captions, no watermark.";

/** One row per tile: the tile's model id, the fal route serving that model, and its input. */
const TARGETS = [
  // ---- fal image rows ----
  { id: "flux-2-pro", endpoint: "fal-ai/flux-2-pro", kind: "image", input: { image_size: "landscape_16_9", output_format: "png" } },
  { id: "nano-banana-2", endpoint: "fal-ai/nano-banana-2", kind: "image", input: { aspect_ratio: "16:9", resolution: "1K", output_format: "png" } },
  { id: "nano-banana-pro", endpoint: "fal-ai/nano-banana-pro", kind: "image", input: { aspect_ratio: "16:9", resolution: "1K", output_format: "png" } },
  { id: "gpt-image-2-fal", endpoint: "openai/gpt-image-2", kind: "image", input: { image_size: "landscape_16_9", quality: "medium", output_format: "png" } },
  // ---- the same weights, for rows dispatched elsewhere ----
  { id: "gpt-image-2", endpoint: "openai/gpt-image-2", kind: "image", input: { image_size: "landscape_16_9", quality: "medium", output_format: "png" } },
  { id: "comfyui-krea2-image", endpoint: "fal-ai/krea-2/turbo", kind: "image", input: { image_size: "landscape_16_9", output_format: "png" } },
  { id: "comfyui-draft-image", endpoint: "fal-ai/fast-sdxl", kind: "image", input: { image_size: "landscape_16_9", format: "png" } },
  // ---- fal video rows ----
  { id: "seedance-2.0", endpoint: "bytedance/seedance-2.0/text-to-video", kind: "video", input: { duration: "4", resolution: "720p", aspect_ratio: "16:9", generate_audio: false } },
  { id: "seedance-2.0-fast", endpoint: "bytedance/seedance-2.0/fast/text-to-video", kind: "video", input: { duration: "4", resolution: "720p", aspect_ratio: "16:9", generate_audio: false } },
  { id: "seedance-2.5", endpoint: "bytedance/seedance-2.5/text-to-video", kind: "video", input: { duration: "4", resolution: "480p", aspect_ratio: "16:9", generate_audio: false } },
  { id: "veo-3.1", endpoint: "fal-ai/veo3.1", kind: "video", input: { duration: "4s", resolution: "720p", aspect_ratio: "16:9", generate_audio: false } },
  { id: "veo-3.1-fast", endpoint: "fal-ai/veo3.1/fast", kind: "video", input: { duration: "4s", resolution: "720p", aspect_ratio: "16:9", generate_audio: false } },
  { id: "minimax-h3", endpoint: "minimax/h3/text-to-video", kind: "video", input: { duration: 5, resolution: "480P", aspect_ratio: "16:9" } },
  { id: "wan-2.7", endpoint: "fal-ai/wan/v2.7/text-to-video", kind: "video", input: { duration: 2, resolution: "720p", aspect_ratio: "16:9" } },
  { id: "kling-3-pro", endpoint: "fal-ai/kling-video/v3/pro/text-to-video", kind: "video", input: { duration: "3", aspect_ratio: "16:9", generate_audio: false } },
  { id: "kling-3-standard", endpoint: "fal-ai/kling-video/v3/standard/text-to-video", kind: "video", input: { duration: "3", aspect_ratio: "16:9", generate_audio: false } },
  // ---- local video tiles, by the weights their recipes load ----
  { id: "comfyui-draft-video", endpoint: "fal-ai/wan/v2.2-5b/text-to-video", kind: "video", input: { resolution: "580p", aspect_ratio: "16:9" } },
  { id: "comfyui-h3-video", endpoint: "minimax/h3/text-to-video", kind: "video", input: { duration: 5, resolution: "480P", aspect_ratio: "16:9" } },
  { id: "comfyui-h3-video-768", endpoint: "minimax/h3/text-to-video", kind: "video", input: { duration: 5, resolution: "768P", aspect_ratio: "16:9" } },
  { id: "comfyui-h3-reference-video", endpoint: "minimax/h3/text-to-video", kind: "video", input: { duration: 5, resolution: "480P", aspect_ratio: "16:9" } },
];

function arg(name) {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

function shuffle(list) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function falJson(key, url, init = {}) {
  const res = await fetch(url, { ...init, headers: { Authorization: `Key ${key}`, "Content-Type": "application/json", ...init.headers } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${url}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

/** Submit to fal's queue and wait for the result; the queue polls, so no socket sits open for minutes. */
async function run(key, endpoint, input) {
  const queued = await falJson(key, `https://queue.fal.run/${endpoint}`, { method: "POST", body: JSON.stringify(input) });
  for (;;) {
    await sleep(4000);
    const status = await falJson(key, queued.status_url);
    if (status.status === "COMPLETED") return falJson(key, queued.response_url);
    if (status.status !== "IN_QUEUE" && status.status !== "IN_PROGRESS") throw new Error(`${endpoint}: ${JSON.stringify(status).slice(0, 400)}`);
  }
}

function mediaUrl(kind, result) {
  const url = kind === "image" ? result.images?.[0]?.url : result.video?.url;
  if (typeof url !== "string") throw new Error(`no ${kind} in result: ${JSON.stringify(result).slice(0, 400)}`);
  return url;
}

function ffmpeg(args) {
  const done = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { encoding: "utf8" });
  if (done.status !== 0) throw new Error(`ffmpeg: ${done.stderr || done.error}`);
}

async function main() {
  const key = process.env.FAL_KEY;
  if (!key) throw new Error("Set FAL_KEY first.");
  const only = arg("--only")?.split(",");
  const raw = arg("--raw") ?? mkdtempSync(join(tmpdir(), "arke-samples-"));
  mkdirSync(raw, { recursive: true });
  mkdirSync(OUT, { recursive: true });

  const targets = TARGETS.filter((t) => only === undefined || only.includes(t.id));
  const genres = shuffle(GENRES);
  const plan = targets.map((t, i) => ({ ...t, prompt: `${genres[i % genres.length]}. ${t.kind === "image" ? CINEMA : MOTION}` }));

  const outcomes = await Promise.allSettled(plan.map(async (t) => {
    const result = await run(key, t.endpoint, { prompt: t.prompt, ...t.input });
    const url = mediaUrl(t.kind, result);
    const file = join(raw, `${t.id}.${t.kind === "image" ? "png" : "mp4"}`);
    writeFileSync(file, Buffer.from(await (await fetch(url)).arrayBuffer()));
    // Fill 16:9 and crop the overflow, so a route that returns 1024x576 or 1280x720 or 848x480
    // lands on the same plate. A video's poster is its first frame (R-17).
    ffmpeg(["-i", file, "-frames:v", "1", "-vf", "scale=640:360:force_original_aspect_ratio=increase,crop=640:360", "-c:v", "libwebp", "-quality", "82", join(OUT, `${t.id}.webp`)]);
    console.log(`ok   ${t.id}  <-  ${t.endpoint}`);
    return { id: t.id, endpoint: t.endpoint, prompt: t.prompt, source: url };
  }));

  const made = [];
  outcomes.forEach((o, i) => {
    if (o.status === "fulfilled") made.push(o.value);
    else console.error(`FAIL ${plan[i].id}: ${o.reason?.message ?? o.reason}`);
  });
  writeFileSync(join(raw, "prompts.json"), JSON.stringify(made, null, 2));
  console.log(`\n${made.length} of ${plan.length} posters written to ${OUT}\nFull-size sources and prompts: ${raw}`);
  if (made.length !== plan.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exitCode = 1;
});
