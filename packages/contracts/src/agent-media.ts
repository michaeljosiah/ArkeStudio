import { z } from "zod";
import { FullSha256Schema } from "./audio.js";
import { SessionIdSchema, SlugSchema, TakeIdSchema } from "./ids.js";
import { ImageObservationSchema } from "./world-chat-images.js";

export const AGENT_MEDIA_SCHEMA_VERSION = 79;
export const AGENT_MEDIA_PROFILE = "arke-media-evidence-v1";
export const AGENT_MEDIA_LIMITS = Object.freeze({ frames: 8, intervalSeconds: 60, edge: 1024,
  streams: 16, channels: 8, sampleRate: 192000, pcmBytes: 64 * 1024 * 1024, calls: 16 });
export const AgentMediaSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("production-take"), productionId: SlugSchema, takeId: TakeIdSchema }).strict(),
  z.object({ kind: z.literal("bench-take"), sessionId: SessionIdSchema, takeId: TakeIdSchema }).strict(),
  z.object({ kind: z.literal("artifact"), id: z.string().min(1).max(200) }).strict(),
]);
export type AgentMediaSource = z.infer<typeof AgentMediaSourceSchema>;
const time = z.number().finite().min(0);
export const AgentMediaRangeSchema = z.object({ startSec: time, endSec: time }).strict().superRefine((range, context) => {
  if (range.endSec <= range.startSec || range.endSec - range.startSec > AGENT_MEDIA_LIMITS.intervalSeconds) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Inspection needs a positive interval of at most 60 seconds" });
  }
});
export const InspectMediaArgsSchema = z.object({ source: AgentMediaSourceSchema }).strict();
export const SampleVideoArgsSchema = z.object({ source: AgentMediaSourceSchema, range: AgentMediaRangeSchema,
  count: z.number().int().min(1).max(AGENT_MEDIA_LIMITS.frames).default(3),
  streamIndex: z.number().int().min(0).max(255).optional() }).strict();
export const AnalyzeAudioArgsSchema = z.object({ source: AgentMediaSourceSchema, range: AgentMediaRangeSchema,
  streamIndex: z.number().int().min(0).max(255).optional() }).strict();
export const AgentMediaStreamSchema = z.object({ index: z.number().int().min(0).max(255),
  kind: z.enum(["video", "audio", "other"]), codec: z.string().max(80),
  width: z.number().int().positive().optional(), height: z.number().int().positive().optional(),
  sampleRate: z.number().int().positive().optional(), channels: z.number().int().positive().optional(),
  timeBase: z.string().max(80).optional(), frameRate: z.string().max(80).optional(),
  durationSec: time.nullable(), startTimeSec: z.number().finite().nullable() }).strict();
export const AgentMediaInventorySchema = z.object({ durationSec: time.nullable(),
  streams: z.array(AgentMediaStreamSchema).max(AGENT_MEDIA_LIMITS.streams) }).strict().refine(value => new Set(value.streams.map(stream => stream.index)).size === value.streams.length, "Stream indices must be unique");
export type AgentMediaInventory = z.infer<typeof AgentMediaInventorySchema>;
const db = z.number().finite().nullable();
export const AudioSignalChannelSchema = z.object({ channel: z.number().int().min(0), samplePeakDbfs: db, rmsDbfs: db,
  samplesAtOrAboveFullScale: z.number().int().min(0), silentSamples: z.number().int().min(0),
  leadingSilenceSec: time, trailingSilenceSec: time, longestSilenceSec: time }).strict();
export const AudioSignalSchema = z.object({ streamIndex: z.number().int().min(0),
  sampleRate: z.number().int().positive().max(AGENT_MEDIA_LIMITS.sampleRate), channels: z.array(AudioSignalChannelSchema).min(1).max(AGENT_MEDIA_LIMITS.channels),
  sampleFrames: z.number().int().positive(), decodedDurationSec: time, pcmHash: FullSha256Schema,
  silenceThresholdDbfs: z.literal(-60), fullScaleThreshold: z.literal(1),
  truePeak: z.literal("not-measured"), integratedLufs: z.literal("not-measured"), loudnessRange: z.literal("not-measured") }).strict();
export type AudioSignal = z.infer<typeof AudioSignalSchema>;
export const AgentMediaFrameSchema = z.object({ requestedSourceTimeSec: time, sourceTimeSec: time,
  viewTimeSec: time, streamIndex: z.number().int().min(0), image: ImageObservationSchema }).strict();
export type AgentMediaObservation = { profile: typeof AGENT_MEDIA_PROFILE; source: AgentMediaSource; decoderVersion: string; probeVersion: string;
  sourceHash: string; byteLength: number; sourceStartSec: number; sourceEndSec: number | null; inventory: AgentMediaInventory;
  range?: { startSec: number; endSec: number }; frames?: Array<z.infer<typeof AgentMediaFrameSchema>>; audio?: AudioSignal;
  coverage: "metadata-only" | "sampled-frames-only" | "decoded-audio-samples"; limitations: string[] };
export const AgentMediaObservationSchema: z.ZodType<AgentMediaObservation> = z.object({ profile: z.literal(AGENT_MEDIA_PROFILE), source: AgentMediaSourceSchema,
  decoderVersion: z.string().min(1).max(200),
  probeVersion: z.string().min(1).max(200),
  sourceHash: FullSha256Schema, byteLength: z.number().int().positive(),
  sourceStartSec: time, sourceEndSec: time.nullable(), inventory: AgentMediaInventorySchema,
  range: AgentMediaRangeSchema.optional(), frames: z.array(AgentMediaFrameSchema).min(1).max(AGENT_MEDIA_LIMITS.frames).optional(),
  audio: AudioSignalSchema.optional(), coverage: z.enum(["metadata-only", "sampled-frames-only", "decoded-audio-samples"]),
  limitations: z.array(z.string().min(1).max(500)).min(1).max(8) }).strict().superRefine((value, context) => {
    if (value.sourceEndSec !== null && value.sourceEndSec < value.sourceStartSec) context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid source interval" });
    if (value.coverage === "sampled-frames-only" && (!value.range || !value.frames || value.audio) ||
      value.coverage === "decoded-audio-samples" && (!value.range || !value.audio || value.frames) ||
      value.coverage === "metadata-only" && (value.frames || value.audio || value.range)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Evidence must match its declared coverage" });
    }
    if (value.range && (value.sourceEndSec === null || value.sourceStartSec + value.range.endSec > value.sourceEndSec + .000001)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Evidence interval exceeds its source" });
    for (const frame of value.frames ?? []) {
      if (!value.range || frame.sourceTimeSec < value.sourceStartSec + value.range.startSec || frame.sourceTimeSec >= value.sourceStartSec + value.range.endSec ||
        frame.sourceTimeSec < frame.requestedSourceTimeSec - .000001 || Math.abs(frame.viewTimeSec - (frame.sourceTimeSec - value.sourceStartSec)) > .000001 ||
        frame.image.sourceHash !== value.sourceHash || !frame.image.posterOnly || !value.inventory.streams.some(stream => stream.index === frame.streamIndex && stream.kind === "video")) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Frame identity and timestamps must belong to the inspected source interval" });
      }
    }
    if (value.audio) {
      const stream = value.inventory.streams.find(stream => stream.kind === "audio" && stream.index === value.audio!.streamIndex);
      if (!stream || stream.sampleRate !== value.audio.sampleRate || stream.channels !== value.audio.channels.length ||
        Math.abs(value.audio.decodedDurationSec - value.audio.sampleFrames / value.audio.sampleRate) > .000001 ||
        !value.range || Math.abs(value.audio.decodedDurationSec - (value.range.endSec - value.range.startSec)) > .05 ||
        value.audio.channels.some((channel, index) => channel.channel !== index || channel.silentSamples > value.audio!.sampleFrames || channel.samplesAtOrAboveFullScale > value.audio!.sampleFrames)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Audio measurements must retain the selected stream's sample rate, channel layout and sample coverage" });
      }
    }
  });

/** Keep channel measurements on the original rate/layout; a mono STT derivative is separate. */
export function measureAudioSignal(bytes: Uint8Array, sampleRate: number, channels: number, streamIndex: number, pcmHash: string): AudioSignal {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0 || sampleRate > AGENT_MEDIA_LIMITS.sampleRate ||
    !Number.isInteger(channels) || channels < 1 || channels > AGENT_MEDIA_LIMITS.channels || !bytes.length ||
    bytes.length > AGENT_MEDIA_LIMITS.pcmBytes || bytes.length % (4 * channels)) throw new Error("Unsupported or oversized original-channel PCM");
  const frames = bytes.length / (4 * channels), data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const stats = Array.from({ length: channels }, () => ({ peak: 0, squares: 0, full: 0, silent: 0, run: 0, leading: 0, longest: 0, heard: false }));
  for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < channels; channel++) {
    const value = data.getFloat32((frame * channels + channel) * 4, true), current = stats[channel]!;
    if (!Number.isFinite(value)) throw new Error("Non-finite decoded PCM");
    const magnitude = Math.abs(value); current.peak = Math.max(current.peak, magnitude); current.squares += value * value;
    if (magnitude >= 1) current.full++;
    if (magnitude <= 0.001) { current.silent++; current.run++; }
    else { if (!current.heard) current.leading = current.run; current.longest = Math.max(current.longest, current.run); current.run = 0; current.heard = true; }
  }
  const decibels = (value: number) => value > 0 ? 20 * Math.log10(value) : null;
  return AudioSignalSchema.parse({ streamIndex, sampleRate, sampleFrames: frames, decodedDurationSec: frames / sampleRate, pcmHash,
    silenceThresholdDbfs: -60, fullScaleThreshold: 1, truePeak: "not-measured", integratedLufs: "not-measured", loudnessRange: "not-measured",
    channels: stats.map((current, channel) => ({ channel, samplePeakDbfs: decibels(current.peak), rmsDbfs: decibels(Math.sqrt(current.squares / frames)),
      samplesAtOrAboveFullScale: current.full, silentSamples: current.silent,
      leadingSilenceSec: (current.heard ? current.leading : frames) / sampleRate, trailingSilenceSec: current.run / sampleRate,
      longestSilenceSec: Math.max(current.longest, current.run) / sampleRate })) });
}
