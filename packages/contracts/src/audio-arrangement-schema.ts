import { z } from "zod";
import { isWorldAudioPath } from "./audiobook-timing.js";

/** SPEC-047 R-186–R-194: this clock never borrows the video editor's frame rate. */
export const AUDIO_STUDIO_RATE = 48_000;
export const AUDIO_STUDIO_HISTORY = 20;
// Classic RIFF, stereo 16-bit PCM, including its 36-byte RIFF payload header.
export const AUDIO_STUDIO_MAX_SAMPLES = Math.floor((0xffffffff - 36) / 4);
const Id = z.string().min(1).max(160);
const Sample = z.number().int().min(0).max(AUDIO_STUDIO_MAX_SAMPLES);
const Offset = z.number().int().min(-AUDIO_STUDIO_MAX_SAMPLES).max(AUDIO_STUDIO_MAX_SAMPLES);
const Gain = z.number().min(-96).max(24);

export const AudioPassageSchema = z.object({ id: Id, key: Id, textHash: z.string().min(1).max(128), confirmedHash: z.string().min(1).max(128).optional() }).strict();
export type AudioPassage = z.infer<typeof AudioPassageSchema>;
export const AudioSourceSchema = z.object({
  file: z.string().max(1000).refine(isWorldAudioPath, "audio must belong to the world"),
  hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  samples: Sample.refine(value => value > 0),
  rate: z.number().int().min(8000).max(384000),
  channels: z.number().int().min(1).max(2),
  label: z.string().min(1).max(200),
  artifactId: z.string().min(1).max(160).optional(),
}).strict();
export type AudioSource = z.infer<typeof AudioSourceSchema>;
export const AudioWaveformSchema = z.object({ hash: z.string().regex(/^sha256:[a-f0-9]{64}$/), samples: Sample,
  left: z.array(z.number().min(0).max(1)).max(2048), right: z.array(z.number().min(0).max(1)).max(2048) }).strict();
export type AudioWaveform = z.infer<typeof AudioWaveformSchema>;
export const AudioArrangementRoleSchema = z.enum(["speech", "music", "ambience", "sfx"]);
export const AudioArrangementTrackSchema = z.object({ id: Id, name: z.string().trim().min(1).max(120), gainDb: Gain, muted: z.boolean() }).strict();
export type AudioArrangementTrack = z.infer<typeof AudioArrangementTrackSchema>;
const Boundary = z.object({ passageId: Id, edge: z.enum(["start", "end"]), offset: Offset }).strict();
export const AudioPlacementSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("sequence"), offset: Offset }).strict(),
  z.object({ kind: z.literal("fixed"), at: Sample }).strict(),
  z.object({ kind: z.literal("passage"), anchor: Boundary }).strict(),
  z.object({ kind: z.literal("range"), from: Boundary, to: Boundary }).strict(),
]);
export type AudioPlacement = z.infer<typeof AudioPlacementSchema>;
export const AudioClipSchema = z.object({
  id: Id, trackId: Id, label: z.string().min(1).max(200), role: AudioArrangementRoleSchema,
  passageId: Id.optional(), source: AudioSourceSchema.nullable(),
  sourceIn: Sample, sourceOut: Sample, placement: AudioPlacementSchema,
  gainDb: Gain, pan: z.number().min(-1).max(1), fadeIn: Sample, fadeOut: Sample,
  loop: z.boolean(), loopFade: Sample, duckDb: z.number().min(0).max(30),
  loopOffset: Sample.optional(), loopDuration: Sample.nullable().optional(),
  protected: z.boolean(), repeated: z.boolean(),
}).strict();
export type AudioClip = z.infer<typeof AudioClipSchema>;
export const AudioOmissionSchema = z.object({ id: Id, passageId: Id, label: z.string().max(200), acknowledged: z.boolean() }).strict();
export const AudioArrangementStateSchema = z.object({
  manuscriptHash: z.string().min(1).max(128),
  passages: z.array(AudioPassageSchema).max(10000), tracks: z.array(AudioArrangementTrackSchema).max(128),
  clips: z.array(AudioClipSchema).max(10000), omissions: z.array(AudioOmissionSchema).max(10000),
  master: z.object({ targetLufs: z.number().min(-30).max(-10), ceilingDb: z.number().min(-6).max(-0.1) }).strict(),
}).strict();
export type AudioArrangementState = z.infer<typeof AudioArrangementStateSchema>;
const History = z.object({ label: z.string().min(1).max(200), state: AudioArrangementStateSchema }).strict();
export const AudioArrangementSchema = z.object({
  schemaVersion: z.literal(1), sampleRate: z.literal(AUDIO_STUDIO_RATE), channels: z.literal(2),
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), current: AudioArrangementStateSchema,
  undo: z.array(History).max(AUDIO_STUDIO_HISTORY), redo: z.array(History).max(AUDIO_STUDIO_HISTORY),
  /** The exact legacy JSON is recovery material, never a second editing target. */
  legacy: z.string().max(16 * 1024 * 1024),
}).strict();
export type AudioArrangement = z.infer<typeof AudioArrangementSchema>;

const ClipChange = AudioClipSchema.omit({ id: true, source: true, protected: true, repeated: true }).partial().strict();
export const AudioArrangementCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("add-track"), track: AudioArrangementTrackSchema }).strict(),
  z.object({ kind: z.literal("set-track"), id: Id, changes: AudioArrangementTrackSchema.omit({ id: true }).partial() }).strict(),
  z.object({ kind: z.literal("remove-track"), id: Id }).strict(),
  z.object({ kind: z.literal("add-clip"), clip: AudioClipSchema }).strict(),
  z.object({ kind: z.literal("set-clip"), id: Id, changes: ClipChange }).strict(),
  z.object({ kind: z.literal("protect-clip"), id: Id, protected: z.boolean() }).strict(),
  z.object({ kind: z.literal("remove-clip"), id: Id }).strict(),
  z.object({ kind: z.literal("split-clip"), id: Id, nextId: Id, at: Sample }).strict(),
  z.object({ kind: z.literal("duplicate-clip"), id: Id, nextId: Id, at: Sample }).strict(),
  z.object({ kind: z.literal("replace-source"), id: Id, source: AudioSourceSchema }).strict(),
  z.object({ kind: z.literal("bind-passage"), id: Id, key: Id, textHash: z.string().min(1).max(128), scriptHash: z.string().min(1).max(128) }).strict(),
  z.object({ kind: z.literal("add-passage"), passage: AudioPassageSchema }).strict(),
  z.object({ kind: z.literal("remove-passage"), id: Id }).strict(),
  z.object({ kind: z.literal("omit-passage"), id: Id, label: z.string().max(200), acknowledged: z.boolean() }).strict(),
  z.object({ kind: z.literal("acknowledge-omission"), id: Id, acknowledged: z.boolean() }).strict(),
  z.object({ kind: z.literal("clear-omission"), id: Id }).strict(),
  z.object({ kind: z.literal("set-master"), master: AudioArrangementStateSchema.shape.master }).strict(),
]);
export type AudioArrangementCommand = z.infer<typeof AudioArrangementCommandSchema>;
export const AudioArrangementEditSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("commands"), label: z.string().min(1).max(200), commands: z.array(AudioArrangementCommandSchema).min(1).max(100) }).strict(),
  z.object({ kind: z.literal("undo") }).strict(),
  z.object({ kind: z.literal("redo") }).strict(),
]);
export type AudioArrangementEdit = z.infer<typeof AudioArrangementEditSchema>;

/** Proposals never own an arrangement; they retain the exact batch offered for human review. */
export const AudioStudioProposalInputSchema = z.object({
  base: z.string().regex(/^[a-f0-9]{64}$/), summary: z.string().trim().min(1).max(200),
  commands: z.array(AudioArrangementCommandSchema).min(1).max(100),
  family: z.object({ id: Id, version: z.number().int().min(1) }).strict().optional(),
}).strict();
export type AudioStudioProposalInput = z.infer<typeof AudioStudioProposalInputSchema>;
export const AudioStudioProposalSchema = z.object({
  id: Id, status: z.enum(["pending", "kept", "applied"]),
  versions: z.array(z.object({
    actionId: Id, number: z.number().int().min(1), base: z.string().regex(/^[a-f0-9]{64}$/),
    summary: z.string().min(1).max(200), commands: z.array(AudioArrangementCommandSchema).min(1).max(100),
  }).strict()).min(1).max(20),
  resultRevision: z.number().int().min(0).optional(),
}).strict();
export type AudioStudioProposal = z.infer<typeof AudioStudioProposalSchema>;

/**
 * A note heard audio earned (design turn 230o, issue 1882): what was observed on one line, on the
 * interval actually heard, with the change that would answer it for Current and Suggested.
 */
export const AudioHeardNoteSchema = z.object({
  key: z.string().regex(/^[a-f0-9]{16,64}$/),
  check: z.literal("intelligibility"),
  /** The line, by its passage key: an episode's block id. */
  block: Id,
  quote: z.string().max(300),
  from: z.number().min(0), to: z.number().min(0),
  observed: z.string().min(1).max(300),
  fix: z.object({ label: z.string().min(1).max(200), commands: z.array(AudioArrangementCommandSchema).min(1).max(20) }).strict().optional(),
}).strict();
export type AudioHeardNote = z.infer<typeof AudioHeardNoteSchema>;
/**
 * What of an arrangement has been heard, and on which (issue 1882): spans in seconds of the mix
 * whose base they were heard on, its length then, and the notes they earned. A changed arrangement
 * lapses them all, since what was heard no longer exists.
 */
export const AudioHeardSchema = z.object({
  base: z.string().regex(/^[a-f0-9]{64}$/),
  seconds: z.number().min(0),
  spans: z.array(z.tuple([z.number().min(0), z.number().min(0)])).max(500),
  notes: z.array(AudioHeardNoteSchema).max(200),
}).strict();
export type AudioHeard = z.infer<typeof AudioHeardSchema>;

export const AudioStudioSnapshotSchema = z.object({
  /** What of this arrangement has been heard (issue 1882), when it is still the one heard. */
  heard: AudioHeardSchema.optional(),
  proposals: z.array(AudioStudioProposalSchema).max(100).optional(),
  unavailable: z.array(z.object({ file: z.string(), message: z.string() }).strict()).optional(),
  base: z.string().regex(/^[a-f0-9]{64}$/), revision: z.number().int().min(0),
  undo: z.string().nullable(), redo: z.string().nullable(), state: AudioArrangementStateSchema,
  script: z.object({ hash: z.string(), passages: z.array(z.object({ key: z.string(), textHash: z.string() }).strict()) }).strict(),
  passages: z.array(z.object({ key: z.string(), text: z.string() }).strict()),
  library: z.array(z.object({ file: z.string(), label: z.string(), artifactId: z.string(), block: z.string().optional(), textHash: z.string().optional() }).strict()),
}).strict();
export type AudioStudioSnapshot = z.infer<typeof AudioStudioSnapshotSchema>;
