import { z } from "zod";
import { EffectAudioInputSchema } from "./editor-effects.js";

/** SPEC-053 R-14/R-20: fixed analysis math and finite cache/worker material. */
export const EFFECT_ANALYSIS_PROFILE = Object.freeze({
  id: "audible-pcm-v1" as const, sampleRate: 48000, channels: 2,
  maxSeconds: 1800, maxFrames: 54000, maxSources: 128,
  maxManifestBytes: 2 * 1024 * 1024, maxFrozenManifestBytes: 32 * 1024 * 1024,
  maxPreparedFrames: 1_000_000, maxCacheBytes: 256 * 1024 * 1024,
  featureQuantum: 0.0001, responseQuantum: 0.00000001, energyReferenceRms: 0.5, bassReferenceRms: 0.25,
  bassLowHz: 30, bassHighHz: 200, beatMeanMs: 500, beatThreshold: 0.02,
  beatRatio: 1.3, beatRefractoryMs: 180, beatPulseMs: 120,
});
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const frame = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const unit = z.number().finite().min(0).max(1);
const second = z.number().finite().nonnegative();
const path = z.string().min(1).max(4096).refine(value => !value.startsWith("/") && !value.includes("\\") && !/^[a-z]:/i.test(value) && !value.split("/").some(part => part === ".." || part === "."), "source paths must be portable world-relative paths");
export const EffectAudioWindowSchema = z.object({ startSec: second, endSec: second }).strict().refine(window => window.endSec > window.startSec, "audio windows must have positive duration");
export type EffectAudioWindow = z.infer<typeof EffectAudioWindowSchema>;
export const EffectAudioNativeDescriptorSchema = z.object({
  profileId: z.literal("audible-pcm-v1"),
  decoder: z.object({ versionConfigHash: hash, executableHash: hash }).strict(),
  canonical: z.object({ sampleRate: z.number().int().min(8000).max(192000), channels: z.union([z.literal(1), z.literal(2)]),
    channelLayout: z.enum(["mono", "stereo"]), sampleFormat: z.literal("dbl"), limiterDelaySamples: frame,
    limiter: z.object({ attackMs: z.literal(5), releaseMs: z.literal(50), level: z.literal(false), asc: z.literal(false), latency: z.literal(false),
      levelIn: z.literal(1), levelOut: z.literal(1), ceiling: z.number().finite().min(0.0625).max(1) }).strict(),
  }).strict().superRefine((value, ctx) => {
    if ((value.channels === 1) !== (value.channelLayout === "mono")) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "canonical channel layout does not match its channel count" });
    if (value.limiterDelaySamples !== Math.floor(value.sampleRate * 0.005) - 1) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "canonical limiter delay does not match its observed sample rate" });
  }),
  analysis: z.object({ sampleRate: z.literal(48000), channels: z.literal(2), sampleFormat: z.literal("f32le"),
    monoPolicy: z.literal("duplicate-unity"), resamplerProfile: z.literal("swr-v1") }).strict(),
}).strict();
export type EffectAudioNativeDescriptor = z.infer<typeof EffectAudioNativeDescriptorSchema>;
export const EffectAudioContributionSchema = z.object({ path, clipId: z.string().min(1).optional(), trackId: z.string().min(1).optional(),
  startSec: second, endSec: second, sourceInSec: second, gainDb: z.number().finite().min(-60).max(12),
  role: z.enum(["dialogue", "ambience", "music", "picture", "unspecified"]),
}).strict().refine(value => value.endSec > value.startSec, "audio contributions must have positive duration");
export const EffectAudioSourceDescriptorSchema = z.object({
  profileId: z.literal("audible-pcm-v1"), binding: EffectAudioInputSchema,
  frameRate: z.union([z.literal(24), z.literal(25), z.literal(30)]), startFrame: frame, endFrame: frame,
  selectedClipIds: z.array(z.string().min(1)).max(4000),
  placedWindows: z.array(EffectAudioWindowSchema).max(4000), audibleWindows: z.array(EffectAudioWindowSchema).max(4000),
  contributions: z.array(EffectAudioContributionSchema).max(EFFECT_ANALYSIS_PROFILE.maxSources),
  sources: z.array(z.object({ path, sha256: hash }).strict()).max(EFFECT_ANALYSIS_PROFILE.maxSources),
  mix: z.object({ speechFirst: z.boolean(), duckingDb: z.number().min(-24).max(0), lookAheadMs: z.number().int().min(0).max(2000),
    releaseMs: z.number().int().min(0).max(5000), limiterCeilingDb: z.number().min(-12).max(0) }).strict(),
  speech: z.array(EffectAudioWindowSchema).max(4000), native: EffectAudioNativeDescriptorSchema,
}).strict().superRefine((value, ctx) => {
  if (value.endFrame < value.startFrame || value.endFrame - value.startFrame > value.frameRate * EFFECT_ANALYSIS_PROFILE.maxSeconds) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "analysis delivery must fit the 30-minute profile" });
  if (new Set(value.sources.map(source => source.path)).size !== value.sources.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "analysis source paths must be unique" });
  if (new Set(value.selectedClipIds).size !== value.selectedClipIds.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "selected clip IDs must be unique" });
  for (const contribution of value.contributions) if (!value.sources.some(source => source.path === contribution.path)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "every audible contribution needs a source content hash" });
});
export type EffectAudioSourceDescriptor = z.infer<typeof EffectAudioSourceDescriptorSchema>;
export const EffectFeaturesSchema = z.object({ startFrame: frame, endFrame: frame,
  beat: z.array(unit).max(EFFECT_ANALYSIS_PROFILE.maxFrames), bass: z.array(unit).max(EFFECT_ANALYSIS_PROFILE.maxFrames), energy: z.array(unit).max(EFFECT_ANALYSIS_PROFILE.maxFrames),
}).strict().superRefine((value, ctx) => {
  const length = value.endFrame - value.startFrame;
  if (length < 0 || value.beat.length !== length || value.bass.length !== length || value.energy.length !== length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "features must cover exactly one shared frame window" });
});
export type EffectFeatures = z.infer<typeof EffectFeaturesSchema>;
export const EffectLikelyBeatSchema = z.object({ frame, strength: unit, confidence: unit }).strict();
export const EffectFeatureDataSchema = z.object({ features: EffectFeaturesSchema,
  likelyBeats: z.array(EffectLikelyBeatSchema).max(12000), silent: z.boolean() }).strict();
export type EffectFeatureData = z.infer<typeof EffectFeatureDataSchema>;
const EffectFeatureManifestObjectSchema = EffectFeatureDataSchema.extend({ schemaVersion: z.literal(1), profileId: z.literal("audible-pcm-v1"),
  manifestKey: hash, sourceFingerprint: hash, descriptor: EffectAudioSourceDescriptorSchema, pcmHash: hash,
}).strict();
export type EffectFeatureManifest = z.infer<typeof EffectFeatureManifestObjectSchema>;
export const EffectFeatureManifestSchema = EffectFeatureManifestObjectSchema.superRefine((value, ctx) => {
  if (value.features.startFrame !== value.descriptor.startFrame || value.features.endFrame !== value.descriptor.endFrame) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "manifest features do not match the frozen source clock" });
  if (value.silent !== value.features.energy.every(level => level === 0)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "manifest silence must describe the analyzed signal" });
  let previous = -1;
  for (const beat of value.likelyBeats) {
    if (beat.frame < value.features.startFrame || beat.frame >= value.features.endFrame || beat.frame <= previous) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "likely beats must be ordered unique frames inside the analysis window" });
    previous = beat.frame;
  }
  if (new TextEncoder().encode(JSON.stringify(value)).length > EFFECT_ANALYSIS_PROFILE.maxManifestBytes) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "analysis manifest exceeds its byte budget" });
});
export const EffectCueConflictSchema = z.object({ cueId: z.string().min(1), frame, kind: z.literal("outside-source-window"), reason: z.string().min(1).max(500) }).strict();
export type EffectCueConflict = z.infer<typeof EffectCueConflictSchema>;
const identity = { requestFingerprint: z.string().min(1).max(128).optional(), sourceFingerprint: hash.optional() };
export const EffectAnalysisStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("off"), ...identity }).strict(),
  z.object({ status: z.literal("no-source"), ...identity, reason: z.string().min(1) }).strict(),
  z.object({ status: z.literal("analysing"), ...identity, progress: unit.optional() }).strict(),
  z.object({ status: z.literal("ready"), requestFingerprint: identity.requestFingerprint.unwrap(), sourceFingerprint: hash, manifestKey: hash,
    silent: z.boolean(), cueConflicts: z.array(EffectCueConflictSchema).max(2000) }).strict(),
  z.object({ status: z.literal("source-changed"), ...identity, previousManifestKey: hash.optional(), reason: z.string().min(1) }).strict(),
  z.object({ status: z.literal("missing-source"), ...identity, reason: z.string().min(1) }).strict(),
  z.object({ status: z.literal("failed"), ...identity, reason: z.string().min(1) }).strict(),
]);
export type EffectAnalysisState = z.infer<typeof EffectAnalysisStateSchema>;
export const EffectAnalysisProjectionSchema = z.object({ worldId: z.string().min(1).max(128), productionId: z.string().min(1).max(128),
  canPrepare: z.boolean().default(false),
  byEffectId: z.record(z.string().regex(/^cl_[A-Za-z0-9][A-Za-z0-9_-]*$/), EffectAnalysisStateSchema)
    .refine(value => Object.keys(value).length <= 1000, "analysis metadata exceeds the authored effect limit"),
}).strict();
export type EffectAnalysisProjection = z.infer<typeof EffectAnalysisProjectionSchema>;

/** Stable material is shared with browser WebCrypto; only the host owns filesystem hashing. */
export function effectAnalysisCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(effectAnalysisCanonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).filter(([, child]) => child !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${effectAnalysisCanonicalJson(child)}`).join(",")}}`;
  const result = JSON.stringify(value);
  if (result === undefined) throw new TypeError("Analysis identity contains an unsupported value");
  return result;
}
export function effectAudioSourceFingerprintMaterial(descriptor: EffectAudioSourceDescriptor): string { return effectAnalysisCanonicalJson(descriptor); }
export function effectManifestFingerprintMaterial(manifest: Omit<EffectFeatureManifest, "manifestKey"> | EffectFeatureManifest): string {
  const { manifestKey: _ignored, ...content } = manifest as EffectFeatureManifest;
  return effectAnalysisCanonicalJson(content);
}
