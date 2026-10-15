import { createHash } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AUDIO_STUDIO_RATE, AudioArrangementRefusal, isWorldAudioPath, ulid, type AudioSource } from "@arke-studio/contracts";
import { readStereoWav, resampleStereo, type StereoPcm } from "../audio/stereo-wav.js";
import { atomicWriteFile } from "../world/atomic.js";
import { containedWorldFilePath } from "../world/contained-file.js";
import { readContainedMediaBytes } from "../world/reference-files.js";
import type { FfmpegRunner } from "../takes/export.js";

/** Bound each decode independently; long chapters are streamed from bounded individual sources. */
export const AUDIO_STUDIO_SOURCE_BYTES = 256 * 1024 * 1024;
export async function containedAudioPath(dir: string, file: string): Promise<string> {
  if (!isWorldAudioPath(file)) throw new AudioArrangementRefusal("Choose an audio file in this world");
  return containedWorldFilePath(dir, file, false, "audio source");
}
export async function audioStudioCache(dir: string, part: "decode" | "mix"): Promise<string> {
  return dirname(await containedWorldFilePath(dir, `.cache/audio-studio/${part}/placeholder`, true, "audio cache", true));
}

/** Hash the bytes actually decoded. FFmpeg receives a private snapshot, never a live source path. */
export async function readAudioStudioSource(dir: string, file: string, options: { ffmpeg?: FfmpegRunner; expectedHash?: string; signal?: AbortSignal } = {}): Promise<{ source: AudioSource; pcm: StereoPcm }> {
  const signal = options.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  let bytes: Uint8Array;
  try {
    if (!isWorldAudioPath(file)) throw new AudioArrangementRefusal("Choose an audio file in this world");
    bytes = await readContainedMediaBytes(dir, file, signal, AUDIO_STUDIO_SOURCE_BYTES);
  } catch (error) {
    if (error instanceof AudioArrangementRefusal || signal.aborted) throw error;
    throw new AudioArrangementRefusal(`${file.split("/").pop()} is not available on this machine`);
  }
  const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (options.expectedHash !== undefined && hash !== options.expectedHash) throw new AudioArrangementRefusal(`${file.split("/").pop()} changed; review its replacement before playing it`);
  let pcm: StereoPcm | undefined;
  try { pcm = readStereoWav(bytes); } catch { /* Other containers and encodings use the host decoder. */ }
  let rate = pcm?.rate, channels = pcm?.channels;
  if (!pcm || pcm.rate > AUDIO_STUDIO_RATE) {
    if (!options.ffmpeg) throw new AudioArrangementRefusal("This audio format needs FFmpeg on this machine");
    const folder = await audioStudioCache(dir, "decode"), id = ulid(), input = join(folder, `${id}.input.${file.split(".").pop()}`), output = join(folder, `${id}.decoded.wav`);
    try {
      await atomicWriteFile(input, bytes);
      const decode = async (canonical: boolean) => {
        await options.ffmpeg!.run(["-y", "-v", "error", "-protocol_whitelist", "file,pipe", "-format_whitelist", "wav,mp3,flac,ogg,mov,aac,aiff,matroska,webm", "-i", input, "-vn", ...(canonical ? ["-ac", "2", "-ar", String(AUDIO_STUDIO_RATE)] : []), "-c:a", "pcm_f32le", "-fs", String(AUDIO_STUDIO_SOURCE_BYTES), output], () => {}, signal);
        const info = await stat(output);
        if (info.size >= AUDIO_STUDIO_SOURCE_BYTES - 1024) throw new AudioArrangementRefusal("The decoded audio exceeds 256 MiB; import shorter sections");
        return readStereoWav(await readFile(output, { signal }));
      };
      // Preserve source properties before canonical conversion; mono MP3 is not stereo input.
      if (!pcm) { pcm = await decode(false); rate = pcm.rate; channels = pcm.channels; }
      // The host resampler supplies the anti-alias filter for high-rate WAV and encoded input.
      if (pcm.rate > AUDIO_STUDIO_RATE) pcm = await decode(true);
    } finally { await Promise.all([input, output].map(path => rm(path, { force: true }).catch(() => {}))); }
  }
  if (pcm.left.length * AUDIO_STUDIO_RATE / pcm.rate * 8 > AUDIO_STUDIO_SOURCE_BYTES) throw new AudioArrangementRefusal("The decoded audio exceeds 256 MiB; import shorter sections");
  pcm = resampleStereo(pcm, AUDIO_STUDIO_RATE);
  if (pcm.left.length === 0) throw new AudioArrangementRefusal("The audio source has no samples");
  signal.throwIfAborted();
  return { pcm, source: { file, hash, samples: pcm.left.length, rate: rate!, channels: channels!, label: file.split("/").pop()!.slice(0, 200) } };
}
