import path from "node:path";
import { randomInt } from "node:crypto";
import { exportArkePlayer } from "../packages/coordinator/src/productions/arke-player-export.js";
import { createNodeFfmpegRunner } from "../packages/coordinator/src/media/node-media-host.js";
import { WorldStore } from "../packages/coordinator/src/world/store.js";

// Export → Arke Player without the app (SPEC-058 R-1 – R-8, SPEC-059 R-15): the same exportArkePlayer
// the Studio's sheet runs, against a world on disk, for publishing a world to the Player's list.
// Run it on a COPY of the world: it writes exports/ and .staging/ inside the world it is given.
//   npx tsx scripts/export-arke-player.mts WORLD_DIR PRODUCTION_ID FFMPEG [--no-book] [--no-motion]
// FFMPEG is the installed app's own (…\Programs\Arke Studio\resources\ffmpeg\ffmpeg.exe): winget's
// build on PATH has crashed on other exports. The package lands in WORLD_DIR/exports/ with its
// record beside it; the last line printed is the export's result as JSON.
const [worldArg, productionId, ffmpegPath, ...flags] = process.argv.slice(2);
if (!worldArg || !productionId || !ffmpegPath) throw Error("Usage: npx tsx scripts/export-arke-player.mts WORLD_DIR PRODUCTION_ID FFMPEG [--no-book] [--no-motion]");
const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const exportId = `ap_${Array.from({ length: 26 }, (_, i) => crockford[i === 0 ? randomInt(8) : randomInt(32)]).join("")}`;

const store = await WorldStore.open(path.resolve(worldArg), { clock: () => new Date().toISOString() });
try {
  let last = "";
  const result = await exportArkePlayer(store, productionId, {
    clock: () => new Date().toISOString(),
    ffmpeg: createNodeFfmpegRunner(path.resolve(ffmpegPath), ""),
    exportId,
    include: { book: !flags.includes("--no-book"), motion: !flags.includes("--no-motion") },
    studioVersion: process.env["ARKE_STUDIO_VERSION"] ?? "script",
    onStep: (step, percent) => {
      const line = `${Math.round(percent)}% ${step}`;
      if (line !== last) console.error((last = line));
    },
  });
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
} finally {
  await store.close();
}
