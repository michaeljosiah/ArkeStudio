import { z } from "zod";
import { FullSha256Schema } from "./audio.js";
import { AgentMediaRangeSchema, AgentMediaSourceSchema, AgentMediaStreamIndexSchema, agentMediaTime } from "./agent-media-source.js";

/*
 * Local measurements Arke can take of a cut (epic #3070). Each is signal measurement on the same
 * bounded decoder as `analyze_audio_signal`: no provider, no cost, and no claim beyond what it
 * measures. Each kind of measurement is its own world boundary, so a build that cannot read one
 * refuses the world by name rather than dropping the receipt.
 */

const fraction = z.number().finite().min(0).max(1);
const correlation = z.number().finite().min(-1).max(1);

/** A box inside the picture, as fractions of its width and height (a mouth, a face). */
export const AgentMediaRegionSchema = z.object({ x: fraction, y: fraction, width: fraction, height: fraction }).strict()
  .superRefine((region, context) => {
    if (region.width < .02 || region.height < .02 || region.x + region.width > 1.000001 || region.y + region.height > 1.000001) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "A region is at least 2% of the picture each way and lies inside it" });
    }
  });
export type AgentMediaRegion = z.infer<typeof AgentMediaRegionSchema>;

/**
 * Lip sync against a reference (#3205). Measured on the "Why You Do Me Like That" music video: the
 * video models give back the audio they were sent as the clip's own soundtrack, so that soundtrack
 * against the slice that was sent finds both drift (Seedance 2.0 sat 100–450 ms off) and a take
 * that sang words of its own (low correlation). Where a take's own sound is not the reference, the
 * motion inside a box round the mouth is measured against how the reference's loudness changes.
 */
export const AGENT_SYNC_SCHEMA_VERSION = 140;
export const AGENT_SYNC_LIMITS = Object.freeze({
  /** Wider than any drift seen (450 ms), narrow enough that a repeated phrase is not mistaken for the line. */
  defaultMaxLagSec: .6, maxLagSec: 2,
  /** 10 ms envelope steps for sound; 25 frames a second for a mouth. */
  hopSec: .01, mouthFps: 25, mouthEdge: 96,
  /** Correlation over less than this much overlap is noise. */
  minOverlapSec: .6,
  /** Below this a take is reported as not following its reference (every take that sang its own words scored under it). */
  follows: .5,
  /** A step quieter than this (dBFS) counts as silence when deciding whether either side holds a signal at all. */
  activeDbfs: -45,
});
export const MeasureSyncArgsSchema = z.object({
  source: AgentMediaSourceSchema, range: AgentMediaRangeSchema,
  /** The take's audio stream (soundtrack) or video stream (mouth); required when ambiguous. */
  streamIndex: AgentMediaStreamIndexSchema.optional(),
  /** The sound the take should follow: its interval starts here and runs as long as the take's range. */
  reference: z.object({ source: AgentMediaSourceSchema, startSec: agentMediaTime, streamIndex: AgentMediaStreamIndexSchema.optional() }).strict(),
  method: z.enum(["soundtrack", "mouth"]).default("soundtrack"),
  /** Mouth method only: the box round the mouth. */
  region: AgentMediaRegionSchema.optional(),
  maxLagSec: z.number().finite().min(.04).max(AGENT_SYNC_LIMITS.maxLagSec).default(AGENT_SYNC_LIMITS.defaultMaxLagSec),
}).strict().superRefine((args, context) => {
  if ((args.method === "mouth") !== (args.region !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "The mouth method needs a region round the mouth; the soundtrack method takes none" });
  }
});
export type MeasureSyncArgs = z.infer<typeof MeasureSyncArgsSchema>;

export const AgentSyncMeasurementSchema = z.object({
  method: z.enum(["soundtrack", "mouth"]),
  /** The take's measured stream: audio for the soundtrack method, video for the mouth. */
  streamIndex: AgentMediaStreamIndexSchema,
  region: AgentMediaRegionSchema.optional(),
  reference: z.object({ source: AgentMediaSourceSchema, sourceHash: FullSha256Schema, streamIndex: AgentMediaStreamIndexSchema,
    startSec: agentMediaTime, endSec: agentMediaTime }).strict(),
  stepSec: z.number().finite().positive().max(.1),
  maxLagSec: z.number().finite().positive().max(AGENT_SYNC_LIMITS.maxLagSec),
  /** Positive: the take is late, its events come this long after the reference's. */
  lagSec: z.number().finite().nullable(),
  correlation: correlation.nullable(),
  zeroLagCorrelation: correlation.nullable(),
  threshold: z.literal(AGENT_SYNC_LIMITS.follows),
  follows: z.boolean(),
  /** Where the take follows: start it this much later in its source (negative: earlier) to land on the reference. */
  sourceShiftSec: z.number().finite().nullable(),
  /** Share of steps above the silence floor; null for a mouth, where motion has no such floor. */
  takeActiveFraction: fraction.nullable(),
  referenceActiveFraction: fraction,
}).strict().superRefine((sync, context) => {
  const issue = (message: string) => context.addIssue({ code: z.ZodIssueCode.custom, message });
  if (sync.reference.endSec <= sync.reference.startSec) issue("A sync reference needs a positive interval");
  if ((sync.method === "mouth") !== (sync.region !== undefined) || (sync.method === "mouth") !== (sync.takeActiveFraction === null)) issue("Only a mouth measurement names a region, and only it has no silence floor");
  if (sync.lagSec !== null && Math.abs(sync.lagSec) > sync.maxLagSec + .000001) issue("A lag lies inside the searched window");
  if ((sync.lagSec === null) !== (sync.correlation === null)) issue("A lag and its correlation are found together");
  if (sync.follows && (sync.correlation === null || sync.correlation < sync.threshold || sync.sourceShiftSec !== sync.lagSec) ||
    !sync.follows && sync.sourceShiftSec !== null) issue("Only a take that follows its reference gets a source shift, and it is the lag");
});
export type AgentSyncMeasurement = z.infer<typeof AgentSyncMeasurementSchema>;

/**
 * A song's beats, sections and voice (#3075, #3099). Measured on the music video: the beats were
 * worked out by hand and the sections timed in another program, because nothing here could hear
 * the song. Beats are tracked, not a grid, sections are the Studio's own finder (`findSongSections`)
 * and the voice comes from a vocal stem when one is named.
 */
export const AGENT_SONG_SCHEMA_VERSION = 141;
export const AGENT_SONG_LIMITS = Object.freeze({ maxSeconds: 900, maxBeats: 3000, maxSections: 24, maxVoiceIntervals: 600 });
const songTime = agentMediaTime;
export const AgentSongWindowSchema = z.object({ startSec: songTime, endSec: songTime }).strict().superRefine((window, context) => {
  if (window.endSec <= window.startSec || window.endSec - window.startSec > AGENT_SONG_LIMITS.maxSeconds) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "A song map covers a positive window of at most 15 minutes" });
  }
});
export const SongMapArgsSchema = z.object({
  source: AgentMediaSourceSchema,
  /** Defaults to the whole source when it is at most 15 minutes. */
  window: AgentSongWindowSchema.optional(),
  streamIndex: AgentMediaStreamIndexSchema.optional(),
  /** A stem holding the voice alone, aligned with the source, to map where it sings. */
  vocal: z.object({ source: AgentMediaSourceSchema, streamIndex: AgentMediaStreamIndexSchema.optional() }).strict().optional(),
}).strict();
export type SongMapArgs = z.infer<typeof SongMapArgsSchema>;
const songSpan = z.object({ startSec: songTime, endSec: songTime }).strict();
export const AgentSongMapSchema = z.object({
  streamIndex: AgentMediaStreamIndexSchema,
  /** The window measured, in seconds from the source's start; every time below is on the same clock. */
  startSec: songTime, endSec: songTime,
  tempoBpm: z.number().finite().positive().nullable(),
  beats: z.array(songTime).max(AGENT_SONG_LIMITS.maxBeats),
  sections: z.array(songSpan.extend({ loudnessDbfs: z.number().finite().nullable(), vocalFraction: fraction.nullable() }).strict())
    .min(1).max(AGENT_SONG_LIMITS.maxSections),
  vocal: z.object({ source: AgentMediaSourceSchema, sourceHash: FullSha256Schema, streamIndex: AgentMediaStreamIndexSchema,
    thresholdDbfs: z.number().finite(), intervals: z.array(songSpan).max(AGENT_SONG_LIMITS.maxVoiceIntervals) }).strict().nullable(),
}).strict().superRefine((song, context) => {
  const issue = (message: string) => context.addIssue({ code: z.ZodIssueCode.custom, message });
  const inside = (at: number) => at >= song.startSec - .000001 && at <= song.endSec + .000001;
  if (song.endSec <= song.startSec || song.endSec - song.startSec > AGENT_SONG_LIMITS.maxSeconds + .000001) issue("A song map covers a positive window of at most 15 minutes");
  if (song.beats.some((beat, i) => !inside(beat) || i > 0 && beat <= song.beats[i - 1]!)) issue("Beats are ascending and inside the window");
  if ((song.tempoBpm === null) !== (song.beats.length === 0)) issue("A tempo is reported with the beats that keep it");
  // Sections tile the window: the first starts it, each starts where the last ended, the last ends it.
  if (Math.abs(song.sections[0]!.startSec - song.startSec) > .001 || Math.abs(song.sections[song.sections.length - 1]!.endSec - song.endSec) > .001 ||
    song.sections.some((section, i) => section.endSec <= section.startSec || i > 0 && Math.abs(section.startSec - song.sections[i - 1]!.endSec) > .001)) issue("Sections tile the measured window");
  if (song.sections.some(section => (section.vocalFraction === null) !== (song.vocal === null))) issue("Only a map with a vocal stem says how much of each section is sung");
  if (song.vocal?.intervals.some((span, i, all) => span.endSec <= span.startSec || !inside(span.startSec) || !inside(span.endSec) || i > 0 && span.startSec < all[i - 1]!.endSec)) issue("Voice intervals are ordered, apart and inside the window");
});
export type AgentSongMap = z.infer<typeof AgentSongMapSchema>;

/**
 * The quality of a generated clip (#3076). Measured on the music video: viewers called shots
 * "choppy" because 30 fps takes were played in a 24 fps cut that dropped a frame in five, and an
 * upscale was judged by its fine detail and whether that detail shimmered. Cadence reads every
 * decoded frame of the interval, small; detail reads a box at full resolution over at most two
 * seconds from the interval's middle.
 */
export const AGENT_QUALITY_SCHEMA_VERSION = 142;
export const AGENT_QUALITY_LIMITS = Object.freeze({
  cadenceEdge: 128, detailSeconds: 2, detailEdge: 960,
  /** A step under this share of the median step is a repeated (or blended) frame. */
  repeatShare: .15,
  /** Under this median step (grey levels of 255) the picture is still and cadence cannot be read. */
  stillStep: .3,
});
export const ClipQualityArgsSchema = z.object({
  source: AgentMediaSourceSchema, range: AgentMediaRangeSchema, streamIndex: AgentMediaStreamIndexSchema.optional(),
  /** Where detail is measured (a face, a texture); the whole picture when absent. */
  region: AgentMediaRegionSchema.optional(),
  /** A second clip (another take, or an upscale of this one) measured the same way, at the same size. */
  compare: z.object({ source: AgentMediaSourceSchema, range: AgentMediaRangeSchema.optional(), streamIndex: AgentMediaStreamIndexSchema.optional() }).strict().optional(),
}).strict().superRefine((args, context) => {
  if (args.compare?.range && Math.abs((args.compare.range.endSec - args.compare.range.startSec) - (args.range.endSec - args.range.startSec)) > .001) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "A compared range runs as long as the clip's" });
  }
});
export type ClipQualityArgs = z.infer<typeof ClipQualityArgsSchema>;
const level = z.number().finite().min(0).max(255);
export const AgentClipCadenceSchema = z.object({
  frameRate: z.number().finite().positive().nullable(), framesDecoded: z.number().int().min(0),
  medianStep: level,
  /** Standard deviation of the frame-to-frame steps over their mean: even motion is low. */
  unevenness: z.number().finite().min(0).nullable(),
  still: z.boolean(),
  repeatedFrames: z.number().int().min(0).nullable(),
  /** The mean spacing of repeats when it is regular, within a frame (5: 24 fps motion in a 30 fps file). */
  repeatPeriod: z.number().int().min(2).nullable(),
  /** The frame rate the motion really moves at: the container's less its repeats. */
  motionFps: z.number().finite().positive().nullable(),
}).strict().superRefine((cadence, context) => {
  if (cadence.still && (cadence.repeatedFrames !== null || cadence.repeatPeriod !== null || cadence.motionFps !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "A still picture has no cadence to read" });
  }
});
export const AgentClipDetailSchema = z.object({
  width: z.number().int().positive(), height: z.number().int().positive(), frames: z.number().int().min(2),
  /** Mean absolute Laplacian, grey levels: fine detail. */
  sharpness: z.number().finite().min(0), sharpnessLow: z.number().finite().min(0), sharpnessHigh: z.number().finite().min(0),
  /** How much that detail changes from frame to frame, over the detail itself. */
  shimmer: z.number().finite().min(0),
  /** Frame-to-frame change of the blurred picture: movement, not detail. */
  motion: z.number().finite().min(0),
}).strict();
const quality = z.object({ streamIndex: AgentMediaStreamIndexSchema, cadence: AgentClipCadenceSchema, detail: AgentClipDetailSchema }).strict();
export const AgentClipQualitySchema = quality.extend({
  region: AgentMediaRegionSchema.optional(),
  compare: quality.extend({ source: AgentMediaSourceSchema, sourceHash: FullSha256Schema, range: AgentMediaRangeSchema,
    /** Percent changes of the compared clip against this one, measured at one size. */
    sharpnessChangePct: z.number().finite(), shimmerChangePct: z.number().finite() }).strict().nullable(),
}).strict().superRefine((value, context) => {
  if (value.compare && (value.compare.detail.width !== value.detail.width || value.compare.detail.height !== value.detail.height)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Two clips' detail is compared at one size" });
  }
});
export type AgentClipQuality = z.infer<typeof AgentClipQualitySchema>;
