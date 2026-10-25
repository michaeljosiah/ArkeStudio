import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { addMusicTrack } from "../../src/productions/music.js";
import { createProductionFromPlan, planProductionCreation } from "../../src/productions/ops.js";
import type { FfmpegRunner } from "../../src/takes/export.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";

/** Seconds of a quiet stereo tone, 48 kHz, as a music render's decode step writes it. */
export function toneWav(seconds: number): Buffer {
  const frames = 48_000 * seconds;
  const out = Buffer.alloc(44 + frames * 4);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(out.length - 8, 4);
  out.write("WAVEfmt ", 8, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(2, 22);
  out.writeUInt32LE(48_000, 24);
  out.writeUInt32LE(192_000, 28);
  out.writeUInt16LE(4, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(frames * 4, 40);
  for (let frame = 0; frame < frames; frame++) {
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * frame) / 48_000) * 3000);
    out.writeInt16LE(sample, 44 + frame * 4);
    out.writeInt16LE(sample, 44 + frame * 4 + 2);
  }
  return out;
}

/** An encoder that writes a real WAV for a decode, three seconds long, and a few bytes for anything else. */
export function musicFfmpeg(calls: string[][] = []): FfmpegRunner {
  return {
    slateFont: "",
    run: async (args: string[]) => {
      calls.push(args);
      const output = args[args.length - 1]!;
      await writeFile(output, output.endsWith(".wav") ? toneWav(3) : `made by ${output.split(/[\\/]/).pop()}`);
    },
  } as unknown as FfmpegRunner;
}

const VERSE = "ar_01J9M00000000000000000S001";

/**
 * A copy of the fixture world with an album of one three-second track, The drowned verse, and no
 * cover: the music a Guide's theme and song teaser name (SPEC-059 R-35, R-36).
 */
export async function withAlbum(clock: () => string, run: (store: WorldStore, dir: string, album: string, track: string) => Promise<void>): Promise<void> {
  const dir = await makeTempWorld();
  await writeFile(join(dir, "artifacts", "the-drowned-verse.wav"), toneWav(3));
  await writeFile(join(dir, "artifacts", "the-drowned-verse.wav.json"), JSON.stringify({ id: VERSE, kind: "audio", file: "the-drowned-verse.wav", hash: "sha256:3333333333333333", origin: { by: "user" }, links: [], created: "2026-10-23T10:00:00Z", mediaInfo: { durationSec: 3, hasAudio: true } }));
  const store = await WorldStore.open(dir, { clock });
  try {
    const plan = planProductionCreation(store.getBundle(), { title: "Songs of the Drowned Quarter", medium: "music", productionKind: "album" }, clock());
    await createProductionFromPlan(store, plan, { source: "test", requestId: "01J9M000000000000000000001", precondition: () => null });
    const track = await addMusicTrack(store, plan.production.id, VERSE);
    await run(store, dir, plan.production.id, track);
  } finally {
    await store.close();
  }
}
