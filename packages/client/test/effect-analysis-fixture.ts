import { createHash } from "node:crypto";
import { EffectFeatureManifestSchema, effectAudioSourceFingerprintMaterial, effectManifestFingerprintMaterial,
  type EffectFeatureManifest, type EffectAudioInput } from "@arke-studio/contracts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
export function analysisManifest(level = 1, binding: EffectAudioInput = { kind: "composition-mix" }): EffectFeatureManifest {
  const descriptor: EffectFeatureManifest["descriptor"] = {
    profileId: "audible-pcm-v1", binding, frameRate: 24, startFrame: 0, endFrame: 240,
    selectedClipIds: [], placedWindows: [{ startSec: 0, endSec: 10 }], audibleWindows: [{ startSec: 0, endSec: 10 }],
    contributions: [], sources: [], mix: { speechFirst: true, duckingDb: -12, lookAheadMs: 100, releaseMs: 300, limiterCeilingDb: -1 }, speech: [],
    native: { profileId: "audible-pcm-v1", decoder: { versionConfigHash: sha("version"), executableHash: sha("decoder") },
      canonical: { sampleRate: 48000, channels: 2, channelLayout: "stereo", sampleFormat: "dbl", limiterDelaySamples: 239,
        limiter: { attackMs: 5, releaseMs: 50, level: false, asc: false, latency: false, levelIn: 1, levelOut: 1, ceiling: 0.9 } },
      analysis: { sampleRate: 48000, channels: 2, sampleFormat: "f32le", monoPolicy: "duplicate-unity", resamplerProfile: "swr-v1" } },
  };
  const payload: Omit<EffectFeatureManifest, "manifestKey"> = { schemaVersion: 1, profileId: "audible-pcm-v1", descriptor,
    sourceFingerprint: sha(effectAudioSourceFingerprintMaterial(descriptor)), pcmHash: sha(String(level)),
    features: { startFrame: 0, endFrame: 240, beat: Array<number>(240).fill(level), bass: Array<number>(240).fill(level), energy: Array<number>(240).fill(level) },
    likelyBeats: [], silent: level === 0 };
  return EffectFeatureManifestSchema.parse({ ...payload, manifestKey: sha(effectManifestFingerprintMaterial(payload)) });
}
