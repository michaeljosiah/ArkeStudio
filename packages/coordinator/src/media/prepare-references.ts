import { ReferenceMediaBindingsSchema } from "@arke-studio/contracts";
import type { Job, ManifestModel } from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import { readContainedAudioReferences } from "../world/reference-files.js";
import type { DispatchVideoSource, DispatchVoiceReference } from "../queue/dispatcher.js";
import type { FfmpegRunner } from "../takes/export.js";
import type { MediaProbe } from "./probe.js";
import { prepareReferenceVideo, measureReferenceAudio, referenceHash } from "./reference-media.js";

export async function prepareReferences(store: WorldStore, job: Job, model: ManifestModel | undefined,
  videos: DispatchVideoSource[], tools: { ffmpeg?: FfmpegRunner; probe?: MediaProbe }, signal: AbortSignal) {
  const audio: Array<DispatchVoiceReference & { durationSec: number }> = [];
  if (model?.limits.referenceSyntax !== "minimax-h3") {
    if (job.params.referenceMedia !== undefined) throw new Error("This route cannot carry standalone audio references.");
    return { videos, audio };
  }
  const bindings = ReferenceMediaBindingsSchema.parse(job.params.referenceMedia ?? []);
  const videoBindings = bindings.filter(ref => ref.kind === "video"), audioBindings = bindings.filter(ref => ref.kind === "audio");
  const paths = Array.isArray(job.params.videoReferences) ? job.params.videoReferences : [];
  if (job.params.referenceMedia !== undefined && (videoBindings.length !== paths.length || videoBindings.some((ref, index) => ref.file !== paths[index]))) throw new Error("Video reference order changed.");
  if (videos.length > 3 || audioBindings.length > 3) throw new Error("Too many multimedia references.");
  const check = (data: Uint8Array, hash: string) => {
    if (referenceHash(data).replace(/^sha256:/, "") !== hash.replace(/^sha256:/, "")) throw new Error("Reference media changed since review.");
  };
  const preparedVideos: DispatchVideoSource[] = [];
  for (const [index, video] of videos.entries()) {
    const binding = videoBindings[index - (job.params.continuedFrom ? 1 : 0)];
    if (binding) check(video.data, binding.hash);
    const prepared = await prepareReferenceVideo(video, tools, signal);
    if (binding && Math.abs(prepared.durationSec! - binding.durationSec) > 0.15) throw new Error("Video duration changed since review.");
    preparedVideos.push({ ...prepared, contentType: "video/mp4" });
  }
  const clips = await readContainedAudioReferences(store.dir, audioBindings.map(ref => ref.file));
  for (const [index, clip] of clips.entries()) {
    check(clip.data, audioBindings[index]!.hash);
    const durationSec = await measureReferenceAudio(clip, tools.probe, signal);
    if (Math.abs(durationSec - audioBindings[index]!.durationSec) > 0.15) throw new Error("Audio duration changed since review.");
    audio.push({ ...clip, durationSec });
  }
  return { videos: preparedVideos, audio };
}
