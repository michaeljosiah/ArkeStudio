import path from "node:path";
import { randomInt } from "node:crypto";
import { DesignedVoiceModelSchema, productionShape } from "@arke-studio/contracts";
import { SHIPPED_MANIFEST } from "@arke-studio/providers";
import { designedTableReadNarrator, planTableRead } from "../packages/coordinator/src/audio/table-read.js";
import { exportArkePlayer } from "../packages/coordinator/src/productions/arke-player-export.js";
import { exportGuideAlone } from "../packages/coordinator/src/productions/arke-player-guide-export.js";
import type { BeatVoices } from "../packages/coordinator/src/productions/interactive.js";
import { createNodeFfmpegRunner } from "../packages/coordinator/src/media/node-media-host.js";
import { WorldStore } from "../packages/coordinator/src/world/store.js";

// Export → Arke Player without the app (SPEC-058 R-1 – R-8, SPEC-059 R-15): the same exportArkePlayer
// the Studio's sheet runs, against a world on disk, for publishing a world to the Player's list.
// Run it on a COPY of the world: it writes exports/ and .staging/ inside the world it is given.
//   npx tsx scripts/export-arke-player.mts WORLD_DIR PRODUCTION_ID FFMPEG [--no-book] [--no-motion] [--cover FILE] [--part IDS [--day DAY] [--next DATE]]
//   npx tsx scripts/export-arke-player.mts WORLD_DIR --guide-alone FFMPEG
// --guide-alone makes the world's guide alone (SPEC-059 R-10), the package the Player's list pins as
// a world's `guide`: exports/<slug>-guide-<date>.zip, with no record, as Publications never lists it.
// --cover names the production's picture as Publish's cover does (R-2), a world-relative file. The
// script cannot read the app's Publish settings, so without it the key art stands in.
// --part CHAPTER,CHAPTER makes a part of those chapters instead (turn 236, SPEC-058 R-43 – R-47):
// exports/<slug>-part-<date>.zip, following the newest edition in WORLD_DIR/exports/, so copy the
// published edition's ZIP and its .zip.json record (and any parts after it) into the copy first.
// --day friday|daily and --next 2026-11-06 are the author's schedule, carried in the part.
// A music production (SPEC-060 R-15 – R-17) makes its production package instead, the same call:
// exports/<slug>-<production-id>-<date>.zip, every track rendered as Play all plays it, its cover
// at 1:1. --no-book, --no-motion, --cover and --part do not apply; the cover is the album's own.
// An interactive movie or a visual novel (SPEC-058 R-79, R-89; turn 245) makes its story package:
//   npx tsx scripts/export-arke-player.mts WORLD_DIR --story PRODUCTION_ID FFMPEG [--size full|1280|960] [--cover FILE] [--tall FILE] [--narrator VOICE [--narrator-model MODEL]]
// exports/<production-id>-story-<date>-<export id>.zip, schema 6 and alone, every reachable clip or beat's
// picture, the routing compiled by contracts, read back with every route replayed. --size is a
// novel's beats' long side (235d); --cover the wide cover (else the key art) and --tall its Tall
// cover, world-relative files. Blocked as the sheet is: every choice walked in the Studio's preview,
// a clip for each reachable scene. A novel's lines carry the voices already prepared for its table
// read, nothing made: its characters' always, its narration only with --narrator, naming the voice
// the app's narrator read it in — one of the world's designed voices, designed:dv_…:N, as Settings
// keeps it. The script cannot read Settings and a catalogue voice is the app's to resolve, so any
// other voice is refused; without --narrator the narration goes as text, as before. A designed
// voice reads in either Gemini model and its reads are cached by the one the narrator chose:
// --narrator-model gemini-3.8-flash-tts|gemini-3.8-flash-lite-tts names it, else the model the
// voice was made in. The line printed before the result says how many narration lines went voiced.
// FFMPEG is the installed app's own (…\Programs\Arke Studio\resources\ffmpeg\ffmpeg.exe): winget's
// build on PATH has crashed on other exports. The package lands in WORLD_DIR/exports/ with its
// record beside it; the last line printed is the export's result as JSON.
const args = process.argv.slice(2);
// `--story PRODUCTION_ID` stands where the production id does, as R-89 writes the form.
const story = args[1] === "--story";
const [worldArg, productionId, ffmpegPath, ...flags] = story ? [args[0], args[2], args[3], ...args.slice(4)] : args;
if (!worldArg || !productionId || !ffmpegPath) throw Error("Usage: npx tsx scripts/export-arke-player.mts WORLD_DIR (PRODUCTION_ID | --guide-alone | --story PRODUCTION_ID) FFMPEG [--no-book] [--no-motion] [--cover FILE] [--tall FILE] [--size SIZE] [--narrator VOICE [--narrator-model MODEL]] [--part IDS [--day DAY] [--next DATE]]");
const valueOf = (flag: string, what: string) => {
  const at = flags.indexOf(flag);
  const value = at === -1 ? undefined : flags[at + 1];
  if (at !== -1 && (value === undefined || value.startsWith("--"))) throw Error(`${flag} needs ${what}`);
  return value;
};
const cover = valueOf("--cover", "a world-relative file");
const tall = valueOf("--tall", "a world-relative file");
const size = valueOf("--size", "full, 1280 or 960");
if (size !== undefined && !["full", "1280", "960"].includes(size)) throw Error("--size is full, 1280 or 960");
const narratorVoice = valueOf("--narrator", "a designed voice, designed:dv_…:N");
const models = DesignedVoiceModelSchema.options;
const narratorModelArg = valueOf("--narrator-model", models.join(" or "));
const narratorModel = models.find((model) => model === narratorModelArg);
if (narratorModelArg !== undefined && narratorModel === undefined) throw Error(`--narrator-model is ${models.join(" or ")}`);
if (narratorModel !== undefined && narratorVoice === undefined) throw Error("--narrator-model goes with --narrator");
const partChapters = valueOf("--part", "chapter ids, comma separated")?.split(",").map((id) => id.trim()).filter((id) => id !== "");
const day = valueOf("--day", "a weekday or daily") as "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday" | "daily" | undefined;
const next = valueOf("--next", "a date, 2026-11-06");
const part = partChapters === undefined ? undefined : { chapters: partChapters, ...(day !== undefined || next !== undefined ? { schedule: { ...(day !== undefined ? { day } : {}), ...(next !== undefined ? { next } : {}) } } : {}) };
const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const exportId = `ap_${Array.from({ length: 26 }, (_, i) => crockford[i === 0 ? randomInt(8) : randomInt(32)]).join("")}`;

const store = await WorldStore.open(path.resolve(worldArg), { clock: () => new Date().toISOString() });
try {
  let last = "";
  const shared = {
    clock: () => new Date().toISOString(),
    ffmpeg: createNodeFfmpegRunner(path.resolve(ffmpegPath), ""),
    exportId,
    studioVersion: process.env["ARKE_STUDIO_VERSION"] ?? "script",
    onStep: (step: string, percent: number) => {
      const line = `${Math.round(percent)}% ${step}`;
      if (line !== last) console.error((last = line));
    },
  };
  const meta = store.getBundle().productions.find((production) => production.meta.id === productionId)?.meta;
  if (story && (meta === undefined || !productionShape(meta).isBranching)) throw Error(`${productionId} is not an interactive movie or a visual novel in this world`);
  const novel = story && productionShape(meta!).playsAsBeats;
  if (narratorVoice !== undefined && !novel) throw Error("--narrator is for a visual novel's story package, with --story");
  // The narrator as it stands in the world, read again each time the export asks: it compares the
  // answer before the plans and under its gate, so a voice removed meanwhile refuses the package.
  const narratorNow = () => (narratorVoice === undefined ? null : designedTableReadNarrator(store.getBundle().designedVoices ?? [], narratorVoice, narratorModel));
  const narrator = narratorNow();
  if (narratorVoice !== undefined && narrator === null) {
    throw Error(narratorVoice.startsWith("designed:")
      ? `--narrator ${narratorVoice} is not a designed voice in this world`
      : `--narrator takes one of this world's designed voices, designed:dv_…:N; ${narratorVoice} is not one, and a catalogue voice is the app's to resolve — export from the Branch Map`);
  }
  // Each narration line once, voiced or not, for the line printed at the end: a narrator whose
  // reads were never prepared still ships its narration as text, and that should not pass unseen.
  const narration = new Map<string, boolean>();
  // The voices the table read prepared, read as the app reads them, with nothing made.
  const voices: BeatVoices | undefined = novel
    ? {
        plan: async (sceneId) => {
          const { plan } = await planTableRead(store, productionId, sceneId, SHIPPED_MANIFEST, [], [], undefined, narrator);
          for (const item of plan.items) if (item.narration) narration.set(item.lineId, item.file !== undefined);
          return { sceneVersion: plan.sceneVersion, confirmationToken: plan.confirmationToken, files: new Map(plan.items.flatMap((item) => (item.file === undefined ? [] : [[item.lineId, item.file] as const]))) };
        },
        narrator: async () => narratorNow(),
      }
    : undefined;
  const result = productionId === "--guide-alone"
    ? await exportGuideAlone(store, shared)
    : story
      ? await exportArkePlayer(store, productionId, { ...shared, include: { book: false, motion: false }, ...(size !== undefined ? { pictureSize: size as "full" | "1280" | "960" } : {}), ...(cover !== undefined || tall !== undefined ? { publish: { ...(cover !== undefined ? { cover } : {}), ...(tall !== undefined ? { tall } : {}) } } : {}), ...(voices !== undefined ? { voices } : {}) })
      : await exportArkePlayer(store, productionId, { ...shared, include: { book: !flags.includes("--no-book"), motion: !flags.includes("--no-motion") }, ...(cover !== undefined ? { publish: { cover } } : {}), ...(part !== undefined ? { part } : {}) });
  if (narrator !== null) console.error(`Narration · ${[...narration.values()].filter(Boolean).length} of ${narration.size} lines voiced by ${narrator.label ?? narrator.voiceId} in ${narrator.model}`);
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
} finally {
  await store.close();
}
