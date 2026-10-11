import { createHash } from "node:crypto";
import { effectAudioSourceFingerprintMaterial, effectManifestFingerprintMaterial,
  type EffectFeatureManifest, type EffectAudioInput } from "@arke-studio/contracts";

/** Authenticated manifest-shaped test material; native decoding is covered by real PCM fixtures. */
export function analysisFixture(options: { endFrame?: number; frameRate?: 24 | 25 | 30; energy?: number;
  sources?: Array<{ path: string; sha256: string }>; binding?: EffectAudioInput } = {}): EffectFeatureManifest {
  const endFrame = options.endFrame ?? 240, frameRate = options.frameRate ?? 24, energy = options.energy ?? .7;
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const descriptor: EffectFeatureManifest["descriptor"] = {
    profileId: "audible-pcm-v1", binding: options.binding ?? { kind: "composition-mix" }, frameRate, startFrame: 0, endFrame,
    selectedClipIds: [], placedWindows: [{ startSec: 0, endSec: endFrame / frameRate }], audibleWindows: [{ startSec: 0, endSec: endFrame / frameRate }],
    contributions: [], sources: options.sources ?? [], speech: [],
    mix: { speechFirst: false, duckingDb: -12, lookAheadMs: 100, releaseMs: 300, limiterCeilingDb: -1 },
    native: { profileId: "audible-pcm-v1", decoder: { versionConfigHash: "a".repeat(64), executableHash: "b".repeat(64) },
      canonical: { sampleRate: 48000, channels: 2, channelLayout: "stereo", sampleFormat: "dbl", limiterDelaySamples: 239,
        limiter: { attackMs: 5, releaseMs: 50, level: false, asc: false, latency: false, levelIn: 1, levelOut: 1, ceiling: .891251 } },
      analysis: { sampleRate: 48000, channels: 2, sampleFormat: "f32le", monoPolicy: "duplicate-unity", resamplerProfile: "swr-v1" } },
  };
  const manifest = { schemaVersion: 1 as const, profileId: "audible-pcm-v1" as const, descriptor, sourceFingerprint: digest(effectAudioSourceFingerprintMaterial(descriptor)),
    pcmHash: "c".repeat(64), silent: energy === 0, likelyBeats: [], features: { startFrame: 0, endFrame,
      energy: Array<number>(endFrame).fill(energy), bass: Array<number>(endFrame).fill(energy / 2), beat: Array.from({ length: endFrame }, (_, i) => energy && i % 12 === 0 ? 1 : 0) } };
  return { ...manifest, manifestKey: digest(effectManifestFingerprintMaterial(manifest)) };
}
