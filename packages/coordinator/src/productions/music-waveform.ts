import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { AUDIO_STUDIO_RATE, MusicWaveformSchema, type MusicWaveform } from "@arke-studio/contracts";
import { atomicWriteFile } from "../world/atomic.js";
import { containedWorldFilePath } from "../world/contained-file.js";
import { toExtendedLength } from "../world/paths.js";
import type { FfmpegRunner } from "../takes/export.js";
import { containedAudioPath, readAudioStudioSource } from "./audio-studio-source.js";

/**
 * A take's or a track's waveform (design turn 238i – 238k, SPEC-060 R-11): the file decoded through
 * the bounded runner as the audio studio reads one, reduced to a strip of peaks and cached beside
 * the album's renders. A sequence of twelve tracks then decodes each once, not each time it is
 * opened. Peaks describe the source, before any trim or fade, and are never authored data.
 */
export const MUSIC_WAVEFORM_PEAKS = 600;

/** One decode at a time: the sequence asks for every track's strip at once. */
let decoding: Promise<unknown> = Promise.resolve();
const asked = new Map<string, Promise<MusicWaveform>>();

export async function musicWaveform(dir: string, file: string, options: { ffmpeg?: FfmpegRunner; signal?: AbortSignal } = {}): Promise<MusicWaveform> {
  const key = JSON.stringify([dir, file]);
  const held = asked.get(key);
  if (held !== undefined) return held;
  const run = decoding.then(() => readWaveform(dir, file, options), () => readWaveform(dir, file, options)).finally(() => asked.delete(key));
  decoding = run.catch(() => {});
  asked.set(key, run);
  return run;
}

async function readWaveform(dir: string, file: string, options: { ffmpeg?: FfmpegRunner; signal?: AbortSignal }): Promise<MusicWaveform> {
  options.signal?.throwIfAborted();
  const info = await stat(toExtendedLength(await containedAudioPath(dir, file)));
  // A take's bytes and a kept file are not rewritten in place, so their size and time name them
  // without reading them; a file replaced under the same name reads as new.
  const key = createHash("sha256").update(JSON.stringify({ file, size: info.size, mtimeMs: info.mtimeMs, peaks: MUSIC_WAVEFORM_PEAKS })).digest("hex");
  const cached = await containedWorldFilePath(dir, `.cache/music/peaks-${key}.json`, true, "music cache", true);
  try {
    return MusicWaveformSchema.parse(JSON.parse(await readFile(toExtendedLength(cached), "utf8")));
  } catch {
    // A missing or damaged derived file is made again.
  }
  const { pcm } = await readAudioStudioSource(dir, file, options);
  const frames = pcm.left.length;
  const count = Math.min(MUSIC_WAVEFORM_PEAKS, frames);
  const peaks = Array.from({ length: count }, (_, bucket) => {
    const end = Math.floor(((bucket + 1) * frames) / count);
    let peak = 0;
    for (let index = Math.floor((bucket * frames) / count); index < end; index++) peak = Math.max(peak, Math.abs(pcm.left[index]!), Math.abs(pcm.right[index]!));
    return Math.round(Math.min(1, peak) * 1000) / 1000;
  });
  const waveform: MusicWaveform = { durationMs: Math.round((frames * 1000) / AUDIO_STUDIO_RATE), peaks };
  await atomicWriteFile(cached, JSON.stringify(waveform)).catch(() => {
    // A cache that cannot be written is made again next time; the answer stands.
  });
  return waveform;
}
