import { createHash } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManifestModel } from "@arke-studio/contracts";
import type { FfmpegRunner } from "../takes/export.js";
import type { MediaProbe } from "./probe.js";

export interface ReferenceMedia {
  contentType: string;
  data: Uint8Array;
  durationSec?: number;
  /** Set only by host preparation after checking the source and normalizing the stream. */
  referenceVideo24fps?: true;
}

/** Decode only a private copy of already-contained bytes. H3 consumes frame tensors at 24 fps,
 * not a video's timebase, so handing it 30 fps would change motion and desynchronise sound.
 * A silent track reserves the same audio ordinal for silent and sounding reference videos. */
export async function prepareReferenceVideo(input: ReferenceMedia, tools: { ffmpeg?: FfmpegRunner; probe?: MediaProbe }, signal: AbortSignal): Promise<ReferenceMedia> {
  if (!tools.ffmpeg || !tools.probe?.info) throw new Error("Video references need the local media tools.");
  const dir = await mkdtemp(join(tmpdir(), "arke-h3-reference-"));
  const source = join(dir, "source"), destination = join(dir, "reference.mp4");
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
  try {
    await writeFile(source, input.data);
    const info = await tools.probe.info(source, { signal: bounded });
    if (!info || info.durationSec < 2 || info.durationSec > 5.2) throw new Error("H3 reference videos must be 2–5 seconds. Trim and review the clip first.");
    await tools.ffmpeg.run(["-nostdin", "-y", "-protocol_whitelist", "file,pipe", "-i", source,
      ...(!info.hasAudio ? ["-f", "lavfi", "-i", "anullsrc=r=32000:cl=stereo"] : []),
      "-map", "0:v:0", "-map", info.hasAudio ? "0:a:0" : "1:a:0", "-vf", "fps=24,scale=864:480:force_original_aspect_ratio=decrease:force_divisible_by=32",
      "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "32000", "-ac", "2",
      "-t", String(info.durationSec), "-fs", "100000000", "-movflags", "+faststart", destination], () => {}, bounded);
    const result = await tools.probe.info(destination, { signal: bounded });
    if (!result?.hasAudio || Math.abs(result.durationSec - info.durationSec) > 0.15) throw new Error("Video reference preparation changed the clip duration.");
    const data = await readFile(destination);
    return { contentType: "video/mp4", data, durationSec: info.durationSec, referenceVideo24fps: true };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

export function referenceHash(data: Uint8Array): string { return `sha256:${createHash("sha256").update(data).digest("hex")}`; }

export async function measureReferenceAudio(input: ReferenceMedia, probe: MediaProbe | undefined, signal: AbortSignal, limits = { min: 0, max: 5.2 }): Promise<number> {
  if (!probe?.info) throw new Error("Audio references need the local media tools.");
  const dir = await mkdtemp(join(tmpdir(), "arke-h3-audio-"));
  try {
    const path = join(dir, "source");
    await writeFile(path, input.data);
    const info = await probe.info(path, { signal });
    if (!info?.hasAudio || info.durationSec <= 0 || info.durationSec < limits.min || info.durationSec > limits.max) throw new Error("Audio reference duration is outside this route's limits.");
    return info.durationSec;
  } finally { await rm(dir, { recursive: true, force: true }); }
}


// Probe the contained bytes before the paid request. Seedance accepts native frame rates,
// so unlike H3 this path validates without changing the authored clip.
export async function checkSeedanceVideo(input: ReferenceMedia, model: ManifestModel, probe: MediaProbe | undefined, signal: AbortSignal): Promise<ReferenceMedia> {
  if (!probe?.info) throw new Error("Video references need the local media tools.");
  if (!["video/mp4", "video/quicktime"].includes(input.contentType)) throw new Error("Seedance video references must be MP4 or MOV.");
  const limits = model.limits;
  if (limits.maxReferenceVideoFileBytes !== undefined && input.data.byteLength > limits.maxReferenceVideoFileBytes)
    throw new Error("Video reference exceeds the route's file size limit.");
  const dir = await mkdtemp(join(tmpdir(), "arke-seedance-reference-"));
  try {
    const path = join(dir, "source");
    await writeFile(path, input.data);
    const info = await probe.info(path, { signal });
    if (!info?.width || !info.height || info.hasVideo === false) throw new Error("Video reference dimensions could not be read.");
    const within = (value: number | undefined, range: { min: number; max: number } | undefined) =>
      !range || (value !== undefined && value >= range.min && value <= range.max);
    if (!within(info.width * info.height, limits.referenceVideoPixels) ||
        !within(info.width, limits.referenceVideoSides) || !within(info.height, limits.referenceVideoSides) ||
        !within(info.width / info.height, limits.referenceVideoAspect) || !within(info.frameRate, limits.referenceVideoFps))
      throw new Error("Video reference resolution or frame rate is outside this Seedance route's limits.");
    if (info.durationSec < (limits.minReferenceVideoFileSec ?? 0) || info.durationSec > (limits.maxReferenceVideoFileSec ?? limits.maxReferenceVideoSec ?? Infinity))
      throw new Error("Video reference duration is outside this Seedance route's limits.");
    return { ...input, durationSec: info.durationSec };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
