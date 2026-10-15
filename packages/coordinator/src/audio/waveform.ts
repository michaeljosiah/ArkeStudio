import type { AudioWaveform } from "@arke-studio/contracts";
import type { StereoPcm } from "./stereo-wav.js";

/** Peaks describe the decoded source, before clip/track processing, and are never authored data. */
export function audioWaveform(hash: string, pcm: StereoPcm): AudioWaveform {
  const count = Math.min(2048, pcm.left.length);
  const peaks = (channel: Float32Array) => Array.from({ length: count }, (_, bucket) => {
    const end = Math.floor((bucket + 1) * channel.length / count);
    let peak = 0;
    for (let index = Math.floor(bucket * channel.length / count); index < end; index++) peak = Math.max(peak, Math.abs(channel[index]!));
    return Math.round(Math.min(1, peak) * 1000) / 1000;
  });
  return { hash, samples: pcm.left.length, left: peaks(pcm.left), right: peaks(pcm.right) };
}
