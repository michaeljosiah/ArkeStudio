import type { ArtifactSidecar } from "./artifact.js";
import { resolveProductionArtifact } from "./artifact-access.js";
import { FullSha256Schema } from "./audio.js";
import { PerformanceIdSchema } from "./performance.js";
import { DialogueTimingIntentSchema } from "./cut.js";
import { resolvedAuthoredDuration } from "./scene.js";
import { z } from "zod";
import type { ProductionBundle } from "./client-state.js";
import { deriveCut, type CutEntry, type DerivedCut } from "./cut.js";
import { ArtifactIdSchema, ShotIdSchema, SlugSchema, TakeIdSchema } from "./ids.js";
import { orderedShots } from "./scene-flow.js";
import { ShotSelectionSchema, sortScenes } from "./scene.js";
import { orderedAnchors, type ProductionSpine } from "./spine.js";
import { FrameRateSchema, productionFrameRate, type FrameRate } from "./world.js";
import {
  DEFAULT_SUBTITLE_STYLE,
  LanguageTagSchema,
  SubtitleCueIdSchema,
  SubtitleCueSchema,
  SubtitleProvenanceSchema,
  SubtitleStyleSchema,
  cueOverlaps,
  orderedCues,
  type SubtitleCue,
  type SubtitleCueId,
} from "./subtitles.js";

/** The saved track vocabulary includes legacy audio kinds so existing mixes retain their roles. */
export const TimelineTrackKindSchema = z.enum(["picture", "audio", "dialogue", "ambience", "music", "subtitle"]);
export type TimelineTrackKind = z.infer<typeof TimelineTrackKindSchema>;
export const AudioRoleSchema = z.enum(["unspecified", "dialogue", "ambience", "music"]);
export type AudioRole = z.infer<typeof AudioRoleSchema>;

export type TimelineTrackId = `tr_${string}`;
export type TimelineClipId = `cl_${string}`;
export const TimelineSourceFingerprintSchema = z.string().regex(/^(story|spine)-picture-v1:[0-9a-f]{16}$/);

export const TimelineTrackIdSchema = z
  .string()
  .regex(/^tr_[A-Za-z0-9][A-Za-z0-9_-]*$/, "expected a tr_<stable-id> id") as z.ZodType<TimelineTrackId>;
export const TimelineClipIdSchema = z
  .string()
  .regex(/^cl_[A-Za-z0-9][A-Za-z0-9_-]*$/, "expected a cl_<stable-id> id") as z.ZodType<TimelineClipId>;

const WholeFrameSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const DurationFramesSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

/**
 * Enough clips to cut a feature and few enough that a history entry naming every one of them is
 * still a record a person can open. The same bound sizes an entry: a reorder can touch every
 * clip on its track, so the entry's own limit is the track's, not a smaller number of its own.
 */
export const MAX_TRACK_CLIPS = 4000;

/**
 * What a clip plays. A shot resolves through its current accepted take at read time (SPEC-037
 * R-12, D4), so a take switch never rewrites the timeline; a take or an artifact is named
 * directly because nothing else decides what they are.
 */
export const TimelineClipSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("performance"), performanceId: PerformanceIdSchema, shotId: ShotIdSchema,
    label: z.string().min(1), sourceHash: FullSha256Schema,
    leadInSec: z.number().finite().nonnegative(), timing: DialogueTimingIntentSchema }).strict(),
  z
    .object({
      kind: z.literal("shot"),
      shotId: ShotIdSchema,
      /** Kept only so a later story deletion remains a labelled gap instead of blocking the edited cut. */
      sceneNumber: z.number().int().min(1),
      shotNumber: z.number().int().min(1),
      label: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("take"),
      takeId: TakeIdSchema,
      label: z.string().min(1),
      /** A frozen selection's exact trim, before independent frame edits (SPEC-043 R-7). */
      offsetSec: z.number().finite().nonnegative().optional(),
      /** Dialogue keeps the speaking sheet and the version its voice was assigned at (SPEC-013 R-18, SPEC-038 R-20). */
      sheetId: SlugSchema.optional(),
      voiceAssignedAtVersion: z.number().int().min(1).optional(),
    })
    .strict(),
  z.object({ kind: z.literal("artifact"), artifactId: ArtifactIdSchema, label: z.string().min(1) }).strict(),
]);
export type TimelineClipSource = z.infer<typeof TimelineClipSourceSchema>;

export const TimelineClipSchema = z
  .object({
    id: TimelineClipIdSchema,
    startFrame: WholeFrameSchema,
    durationFrames: DurationFramesSchema,
    /**
     * Where the clip starts inside its source, in frames. A head trim advances it and a split's
     * right-hand clip inherits the left's plus the split offset, so the combined source range of
     * a split is exactly the range before it (R-21). Defaulted so a record written before trims
     * existed still parses; nothing here is invented on read.
     */
    sourceInFrames: WholeFrameSchema.default(0),
    source: TimelineClipSourceSchema,
    performanceSourceClipId: TimelineClipIdSchema.optional(),
    /** Audio clips: gain in dB, 0 when absent (SPEC-038 R-13). */
    gainDb: z.number().min(-60).max(12).optional(),
    role: AudioRoleSchema.optional(),
    /**
     * A placed video's own sound while it sits on a Picture track: kept or muted (SPEC-038 R-12).
     * `only` never lands here; a split's sound half is a typed audio clip linked back to it.
     */
    audio: z.enum(["keep", "mute"]).optional(),
    /** The other half of a split: the sound this picture lost, or the picture this sound left. */
    linkedClipId: TimelineClipIdSchema.optional(),
  })
  .strict();
export type TimelineClip = z.infer<typeof TimelineClipSchema>;

export const TimelineTrackSchema = z
  .object({
    id: TimelineTrackIdSchema,
    kind: TimelineTrackKindSchema,
    name: z.string().min(1),
    order: WholeFrameSchema,
    muted: z.boolean(),
    /** Audio tracks only (SPEC-038 R-6, R-13). Never written for Picture or Subtitle tracks. */
    solo: z.boolean().optional(),
    defaultRole: AudioRoleSchema.optional(),
    /**
     * Where the track's used range ends when that is past its last clip. Deleting the final clip
     * leaves a hole (R-21), and a hole with nothing after it has no clip to mark its far side, so
     * the track remembers it here. Absent means the last clip's end.
     */
    endFrame: WholeFrameSchema.optional(),
    clips: z.array(TimelineClipSchema).max(MAX_TRACK_CLIPS),
    /** Subtitle tracks only (SPEC-038 R-21): the language, the shared style and the cues. */
    language: LanguageTagSchema.optional(),
    style: SubtitleStyleSchema.optional(),
    cues: z.array(SubtitleCueSchema).max(MAX_TRACK_CLIPS).optional(),
  })
  .strict();
export type TimelineTrack = z.infer<typeof TimelineTrackSchema>;

/** How far a track reaches: its remembered end, or its last clip's. */
export function trackEndFrame(track: Pick<TimelineTrack, "clips" | "endFrame">): number {
  return Math.max(track.endFrame ?? 0, ...track.clips.map((clip) => clip.startFrame + clip.durationFrames), 0);
}

/** The properties a track command may change; clips move by their own commands. */
export const TimelineTrackPropsSchema = z
  .object({
    name: z.string().min(1),
    order: WholeFrameSchema,
    muted: z.boolean(),
    solo: z.boolean().optional(),
    defaultRole: AudioRoleSchema.optional(),
    endFrame: WholeFrameSchema.optional(),
    language: LanguageTagSchema.optional(),
    style: SubtitleStyleSchema.optional(),
  })
  .strict();
export type TimelineTrackProps = z.infer<typeof TimelineTrackPropsSchema>;

export function trackProps(track: TimelineTrack): TimelineTrackProps {
  return {
    name: track.name,
    order: track.order,
    muted: track.muted,
    ...(track.solo !== undefined ? { solo: track.solo } : {}),
    ...(track.defaultRole !== undefined ? { defaultRole: track.defaultRole } : {}),
    ...(track.endFrame !== undefined ? { endFrame: track.endFrame } : {}),
    ...(track.language !== undefined ? { language: track.language } : {}),
    ...(track.style !== undefined ? { style: track.style } : {}),
  };
}

/**
 * One production-level mix policy (SPEC-038 §2.2, R-14, R-15, R-17). A clip stores only what
 * differs per clip; five clips do not carry five copies of the same rule.
 */
export const MixSettingsSchema = z
  .object({
    speechFirst: z.boolean(),
    /** How far Music and Ambience drop under speech, in dB: 0 through -24. */
    duckingDb: z.number().min(-24).max(0),
    lookAheadMs: z.number().int().min(0).max(2000),
    releaseMs: z.number().int().min(0).max(5000),
    limiterCeilingDb: z.number().min(-12).max(0),
  })
  .strict();
export type MixSettings = z.infer<typeof MixSettingsSchema>;

export const DEFAULT_MIX: MixSettings = { speechFirst: true, duckingDb: -9, lookAheadMs: 80, releaseMs: 400, limiterCeilingDb: -1 };

export const AUDIO_TRACK_KINDS: ReadonlySet<TimelineTrackKind> = new Set(["audio", "dialogue", "ambience", "music"]);

/** Legacy track names retain their mix; a new default only affects future placements. */
export function effectiveAudioRole(track: Pick<TimelineTrack, "kind">, clip: Pick<TimelineClip, "role" | "source">): AudioRole {
  if (clip.source.kind === "performance") return "dialogue";
  return clip.role ?? (track.kind === "dialogue" || track.kind === "music" || track.kind === "ambience" ? track.kind : "unspecified");
}

export function placementAudioRole(track: Pick<TimelineTrack, "kind" | "defaultRole">): AudioRole {
  return track.defaultRole ?? "unspecified";
}

export const TimelineMoveDirectionSchema = z.enum(["earlier", "later"]);
export type TimelineMoveDirection = z.infer<typeof TimelineMoveDirectionSchema>;

/** The first slice's history shape. Still parsed and replayed so a timeline it wrote keeps its Undo. */
export const TimelineMoveHistoryEntrySchema = z
  .object({
    kind: z.literal("move"),
    trackId: TimelineTrackIdSchema,
    clipId: TimelineClipIdSchema,
    swappedWithClipId: TimelineClipIdSchema,
    direction: TimelineMoveDirectionSchema,
  })
  .strict();
export type TimelineMoveHistoryEntry = z.infer<typeof TimelineMoveHistoryEntrySchema>;

/** One clip as it read before and after a command; null on one side is a creation or a deletion. */
export const TimelineClipChangeSchema = z
  .object({
    trackId: TimelineTrackIdSchema,
    before: TimelineClipSchema.nullable(),
    after: TimelineClipSchema.nullable(),
  })
  .strict()
  .refine((change) => change.before !== null || change.after !== null, "a clip change must name a clip on at least one side");
export type TimelineClipChange = z.infer<typeof TimelineClipChangeSchema>;

/**
 * A shot selection as it read before and after a take switch (R-16, R-17). Only the mutable
 * selection is recorded: the review decision that accompanied the switch is append-only and is
 * never named here, so Undo cannot reach it.
 */
export const TimelineSelectionChangeSchema = z
  .object({
    shotId: ShotIdSchema,
    before: ShotSelectionSchema.nullable(),
    after: ShotSelectionSchema.nullable(),
  })
  .strict();
export type TimelineSelectionChange = z.infer<typeof TimelineSelectionChangeSchema>;

/** A track's properties, or its existence, before and after a command. */
export const TimelineTrackChangeSchema = z
  .object({
    trackId: TimelineTrackIdSchema,
    kind: TimelineTrackKindSchema,
    before: TimelineTrackPropsSchema.nullable(),
    after: TimelineTrackPropsSchema.nullable(),
  })
  .strict()
  .refine((change) => change.before !== null || change.after !== null, "a track change must name a track on at least one side");
export type TimelineTrackChange = z.infer<typeof TimelineTrackChangeSchema>;

/** One cue as it read before and after a command. */
export const TimelineCueChangeSchema = z
  .object({
    trackId: TimelineTrackIdSchema,
    before: SubtitleCueSchema.nullable(),
    after: SubtitleCueSchema.nullable(),
  })
  .strict()
  .refine((change) => change.before !== null || change.after !== null, "a cue change must name a cue on at least one side");
export type TimelineCueChange = z.infer<typeof TimelineCueChangeSchema>;

/**
 * One completed action, whatever it did (R-24, D5). Recording the exact before and after of every
 * clip it touched is what lets Undo apply the exact inverse (R-25) without a second implementation
 * of every command, and what lets an accepted Arke request of several commands be one entry.
 */
/**
 * What the Library holds (SPEC-039 R-8): the shots and artifacts a person or Arke added to cut
 * with. A curated set, not everything filed — the editor opens empty and fills as scenes are
 * assembled or items are added, the way the target works.
 */
export const TimelineLibraryItemSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("shot"), shotId: ShotIdSchema }).strict(),
  z.object({ kind: z.literal("artifact"), artifactId: ArtifactIdSchema }).strict(),
]);
export type TimelineLibraryItem = z.infer<typeof TimelineLibraryItemSchema>;
export const MAX_LIBRARY_ITEMS = 4000;

export const libraryItemKey = (item: TimelineLibraryItem): string => (item.kind === "shot" ? `shot:${item.shotId}` : `artifact:${item.artifactId}`);

export const TimelineChangeHistoryEntrySchema = z
  .object({
    kind: z.literal("change"),
    label: z.string().min(1).max(160),
    clips: z.array(TimelineClipChangeSchema).max(MAX_TRACK_CLIPS * 8),
    selections: z.array(TimelineSelectionChangeSchema).max(MAX_TRACK_CLIPS).default([]),
    tracks: z.array(TimelineTrackChangeSchema).max(200).default([]),
    cues: z.array(TimelineCueChangeSchema).max(MAX_TRACK_CLIPS * 8).default([]),
    mix: z.object({ before: MixSettingsSchema, after: MixSettingsSchema }).strict().optional(),
    /** The Library before and after, when the action changed it. */
    library: z
      .object({ before: z.array(TimelineLibraryItemSchema).max(MAX_LIBRARY_ITEMS), after: z.array(TimelineLibraryItemSchema).max(MAX_LIBRARY_ITEMS) })
      .strict()
      .optional(),
    /** Present when the entry landed an Arke editor request (SPEC-039 R-30, R-36). */
    requestId: z.string().min(1).max(80).optional(),
    /** What the action did, in plain lines — Arke's assembly says what it placed, left and laid. */
    notes: z.array(z.string().min(1).max(200)).max(8).optional(),
  })
  .strict()
  .refine(
    (entry) =>
      entry.clips.length > 0 ||
      entry.selections.length > 0 ||
      entry.tracks.length > 0 ||
      entry.cues.length > 0 ||
      entry.mix !== undefined ||
      entry.library !== undefined,
    "a history entry must change something",
  );
export type TimelineChangeHistoryEntry = z.infer<typeof TimelineChangeHistoryEntrySchema>;

export const TimelineHistoryEntrySchema = z.union([TimelineMoveHistoryEntrySchema, TimelineChangeHistoryEntrySchema]);
export type TimelineHistoryEntry = z.infer<typeof TimelineHistoryEntrySchema>;

export const TIMELINE_HISTORY_LIMIT = 100;

export const TimelineHistorySchema = z
  .object({
    undo: z.array(TimelineHistoryEntrySchema).max(TIMELINE_HISTORY_LIMIT),
    redo: z.array(TimelineHistoryEntrySchema).max(TIMELINE_HISTORY_LIMIT),
  })
  .strict();
export type TimelineHistory = z.infer<typeof TimelineHistorySchema>;

export const ProductionTimelineSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: WholeFrameSchema,
    /** Frozen when the record is first materialised; changing it requires an explicit conform. */
    frameRate: FrameRateSchema,
    tracks: z.array(TimelineTrackSchema),
    history: TimelineHistorySchema,
    /** Defaulted so a record written before the mix existed reads with the documented policy. */
    mix: MixSettingsSchema.default(DEFAULT_MIX),
    /** The Library (SPEC-039 R-8). Defaulted, so a record from before it existed opens empty. */
    library: z.array(TimelineLibraryItemSchema).max(MAX_LIBRARY_ITEMS).default([]),
    /**
     * Set once `cut.json`'s placements and audio tracks have been folded into typed tracks (R-30).
     * Until then the render plan still reads `cut.json`; after it there is one writable copy.
     */
    migratedCut: z.literal(true).optional(),
  })
  .strict()
  .superRefine((timeline, ctx) => {
    const trackIds = new Set<TimelineTrackId>();
    const trackOrders = new Set<number>();
    const clipIds = new Set<TimelineClipId>();

    for (const [trackIndex, track] of timeline.tracks.entries()) {
      if (track.defaultRole !== undefined && !AUDIO_TRACK_KINDS.has(track.kind)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tracks", trackIndex, "defaultRole"], message: "Only audio tracks have a default role" });
      }
      if (trackIds.has(track.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tracks", trackIndex, "id"], message: "track ids must be unique" });
      }
      if (trackOrders.has(track.order)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tracks", trackIndex, "order"], message: "track order must be unique" });
      }
      trackIds.add(track.id);
      trackOrders.add(track.order);

      if (track.solo !== undefined && !AUDIO_TRACK_KINDS.has(track.kind)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tracks", trackIndex, "solo"], message: "only audio tracks solo" });
      }
      if (track.kind === "subtitle") {
        if (track.language === undefined) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tracks", trackIndex, "language"], message: "a Subtitle track names its language" });
        }
        const cueIds = new Set<string>();
        for (const [cueIndex, cue] of (track.cues ?? []).entries()) {
          if (cueIds.has(cue.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tracks", trackIndex, "cues", cueIndex, "id"], message: "cue ids must be unique" });
          cueIds.add(cue.id);
        }
        for (const overlap of cueOverlaps(track.cues ?? [])) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tracks", trackIndex, "cues"], message: overlap });
        }
      } else if (track.language !== undefined || track.style !== undefined || track.cues !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tracks", trackIndex], message: "language, style and cues belong to Subtitle tracks" });
      }
      for (const [clipIndex, clip] of track.clips.entries()) {
        const problem = sourceProblem(track.kind, clip);
        if (problem !== null) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tracks", trackIndex, "clips", clipIndex, "source"], message: problem });
        }
      }

      const ordered = orderedTrackClips(track);
      for (const [clipIndex, clip] of track.clips.entries()) {
        if (clipIds.has(clip.id)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tracks", trackIndex, "clips", clipIndex, "id"], message: "clip ids must be unique" });
        }
        clipIds.add(clip.id);
        if (!Number.isSafeInteger(clip.startFrame + clip.durationFrames)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["tracks", trackIndex, "clips", clipIndex, "durationFrames"],
            message: "clip end must be a non-negative safe integer",
          });
        }
      }
      for (const overlap of trackOverlaps(ordered)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tracks", trackIndex, "clips"], message: overlap });
      }
    }

    if (timeline.revision < timeline.history.undo.length + timeline.history.redo.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["revision"],
        message: "timeline revision cannot predate its retained history",
      });
    }

    for (const stack of ["undo", "redo"] as const) {
      const problem = replayProblem(timeline, stack);
      if (problem !== null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["history", stack, problem.index], message: problem.message });
      }
    }
  });
export type ProductionTimeline = z.infer<typeof ProductionTimelineSchema>;

/** Scanner-facing state. Absence is not encoded as a nullable or empty timeline document. */
export const TimelineStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("absent") }).strict(),
  z.object({ status: z.literal("ready"), timeline: ProductionTimelineSchema, hash: z.string().optional() }).strict(),
  z.object({ status: z.literal("invalid"), message: z.string().min(1).max(500) }).strict(),
]);
export type TimelineState = z.infer<typeof TimelineStateSchema>;

// ---------------------------------------------------------------------------
// Commands (R-18..R-23): the only way a timeline changes
// ---------------------------------------------------------------------------

const TrimEdgeSchema = z.enum(["start", "end"]);
const SignedFramesSchema = z
  .number()
  .int()
  .min(-Number.MAX_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER)
  .refine((value) => value !== 0, "a trim must move the edge");

/**
 * The semantic vocabulary (R-19, D5). Every pointer gesture, menu item, keyboard shortcut and
 * Arke request reduces to one of these, which is what lets the coordinator fence, validate and
 * undo all of them the same way. New ids for a split or a duplicate travel *in* the command so
 * applying it is deterministic: a ghost derived on the client and the record the coordinator
 * writes name the same clip.
 */
export const TimelineCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("set-performance-source"), clipId: TimelineClipIdSchema, sourceClipId: TimelineClipIdSchema.nullable() }).strict(),
  z.object({ kind: z.literal("move-adjacent"), clipId: TimelineClipIdSchema, direction: TimelineMoveDirectionSchema }).strict(),
  z.object({ kind: z.literal("move-to-order"), clipId: TimelineClipIdSchema, index: WholeFrameSchema }).strict(),
  z.object({ kind: z.literal("move-to-frame"), clipId: TimelineClipIdSchema, startFrame: WholeFrameSchema }).strict(),
  z.object({ kind: z.literal("trim"), clipId: TimelineClipIdSchema, edge: TrimEdgeSchema, deltaFrames: SignedFramesSchema }).strict(),
  z.object({ kind: z.literal("split"), clipId: TimelineClipIdSchema, atFrame: WholeFrameSchema, newClipId: TimelineClipIdSchema }).strict(),
  z.object({ kind: z.literal("duplicate"), clipId: TimelineClipIdSchema, newClipId: TimelineClipIdSchema }).strict(),
  z.object({ kind: z.literal("delete"), clipId: TimelineClipIdSchema }).strict(),
  z.object({ kind: z.literal("ripple-delete"), clipId: TimelineClipIdSchema }).strict(),
  /** Applied by the coordinator through the append-only review path (R-16); never pure. */
  z.object({ kind: z.literal("switch-take"), shotId: ShotIdSchema, takeId: TakeIdSchema }).strict(),
  /** Place a clip on a track (SPEC-039 R-10). The clip arrives whole so a ghost and the record agree. */
  z.object({ kind: z.literal("place"), trackId: TimelineTrackIdSchema, clip: TimelineClipSchema }).strict(),
  z.object({ kind: z.literal("set-clip-gain"), clipId: TimelineClipIdSchema, gainDb: z.number().min(-60).max(12) }).strict(),
  z.object({ kind: z.literal("detach-audio"), clipId: TimelineClipIdSchema, newClipId: TimelineClipIdSchema }).strict(),
  z.object({ kind: z.literal("set-clip-audio"), clipId: TimelineClipIdSchema, audio: z.enum(["keep", "mute"]) }).strict(),
  z.object({ kind: z.literal("set-clip-role"), clipId: TimelineClipIdSchema, role: AudioRoleSchema }).strict(),
  z
    .object({
      kind: z.literal("set-track"),
      trackId: TimelineTrackIdSchema,
      name: z.string().min(1).optional(),
      defaultRole: AudioRoleSchema.optional(),
      muted: z.boolean().optional(),
      solo: z.boolean().optional(),
      order: WholeFrameSchema.optional(),
      /** Subtitle tracks only. */
      language: LanguageTagSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("add-track"),
      trackId: TimelineTrackIdSchema,
      trackKind: TimelineTrackKindSchema,
      name: z.string().min(1),
      defaultRole: AudioRoleSchema.optional(),
      order: WholeFrameSchema.optional(),
    })
    .strict(),
  /** Only an empty track goes; its clips are removed by their own commands first. */
  z.object({ kind: z.literal("remove-track"), trackId: TimelineTrackIdSchema }).strict(),
  z.object({ kind: z.literal("add-to-library"), items: z.array(TimelineLibraryItemSchema).min(1).max(200) }).strict(),
  z.object({ kind: z.literal("remove-from-library"), items: z.array(TimelineLibraryItemSchema).min(1).max(200) }).strict(),
  z.object({ kind: z.literal("set-mix"), mix: MixSettingsSchema.partial().strict() }).strict(),
  /** Subtitles (SPEC-038 R-21..R-26): a language track, and the cues on it. */
  z
    .object({
      kind: z.literal("add-subtitle-track"),
      trackId: TimelineTrackIdSchema,
      name: z.string().min(1),
      language: LanguageTagSchema,
      style: SubtitleStyleSchema.optional(),
    })
    .strict(),
  z.object({ kind: z.literal("add-cue"), trackId: TimelineTrackIdSchema, cue: SubtitleCueSchema }).strict(),
  z
    .object({
      kind: z.literal("edit-cue"),
      cueId: SubtitleCueIdSchema,
      text: z.string().min(1).max(500).optional(),
      startFrame: WholeFrameSchema.optional(),
      endFrame: WholeFrameSchema.optional(),
      /** Null clears the speaker. */
      speaker: SlugSchema.nullable().optional(),
    })
    .strict(),
  z.object({ kind: z.literal("delete-cue"), cueId: SubtitleCueIdSchema }).strict(),
  /**
   * Cues that already parsed on the frame grid (R-24): the importer reports what it could not
   * read before this is sent, so the command carries only rows that are cues. `replace` clears
   * the track first; otherwise the rows join what is there and overlap refuses the whole batch.
   */
  z
    .object({
      kind: z.literal("import-cues"),
      trackId: TimelineTrackIdSchema,
      cues: z.array(SubtitleCueSchema).min(1).max(MAX_TRACK_CLIPS),
      replace: z.boolean(),
      provenance: SubtitleProvenanceSchema.optional(),
    })
    .strict(),
  z.object({ kind: z.literal("set-subtitle-style"), trackId: TimelineTrackIdSchema, style: SubtitleStyleSchema.partial().strict() }).strict(),
]);
export type TimelineCommand = z.infer<typeof TimelineCommandSchema>;
export type TimelineClipCommand = Exclude<TimelineCommand, { kind: "switch-take" }>;

/** Why a clip cannot sit on a track of this kind, or null when it can (R-22). */
export function sourceProblem(kind: TimelineTrackKind, clip: Pick<TimelineClip, "source" | "audio" | "performanceSourceClipId" | "role">): string | null {
  if (clip.role !== undefined && !AUDIO_TRACK_KINDS.has(kind)) return "Only audio clips have an audio role";
  if (clip.performanceSourceClipId && (kind !== "picture" || clip.source.kind !== "shot")) return "master playback belongs to a shot on a Picture track";
  if (kind === "subtitle") return "a Subtitle track holds cues, not clips";
  if (clip.source.kind === "performance" && !AUDIO_TRACK_KINDS.has(kind)) return "an exact performance belongs on an audio track";
  if (kind === "picture") return null;
  if (clip.source.kind === "shot") return `a shot belongs on a Picture track, not ${kind}`;
  if (clip.audio !== undefined) return "keep and mute describe a picture's own sound; an audio clip has gain";
  return null;
}

/** A plain, present-tense line for a history entry or a request card (SPEC-039 R-34). */
export function describeTimelineCommand(command: TimelineCommand): string {
  switch (command.kind) {
    case "move-adjacent":
      return `Move ${command.clipId} ${command.direction}`;
    case "move-to-order":
      return `Move ${command.clipId} to position ${command.index + 1}`;
    case "move-to-frame":
      return `Move ${command.clipId} to frame ${command.startFrame}`;
    case "trim":
      return `Trim the ${command.edge} of ${command.clipId} by ${command.deltaFrames} frames`;
    case "split":
      return `Split ${command.clipId} at frame ${command.atFrame}`;
    case "duplicate":
      return `Duplicate ${command.clipId}`;
    case "delete":
      return `Delete ${command.clipId}`;
    case "ripple-delete":
      return `Ripple delete ${command.clipId}`;
    case "switch-take":
      return `Use ${command.takeId} for ${command.shotId}`;
    case "place":
      return `Place ${command.clip.source.label} on ${command.trackId}`;
    case "set-performance-source":
      return `Change performance playback for ${command.clipId}`;
    case "set-clip-gain":
      return `Set ${command.clipId} to ${command.gainDb} dB`;
    case "detach-audio":
      return "Detach audio";
    case "set-clip-audio":
      return `${command.audio === "mute" ? "Mute" : "Keep"} picture sound`;
    case "set-clip-role":
      return `Set audio role to ${command.role}`;
    case "set-track":
      return `Change track ${command.trackId}`;
    case "add-track":
      return `Add ${command.trackKind} track ${command.name}`;
    case "remove-track":
      return `Remove track ${command.trackId}`;
    case "add-to-library":
      return `Add ${command.items.length} item${command.items.length === 1 ? "" : "s"} to the library`;
    case "remove-from-library":
      return `Remove ${command.items.length} item${command.items.length === 1 ? "" : "s"} from the library`;
    case "set-mix":
      return "Change the mix";
    case "add-subtitle-track":
      return `Add ${command.language} subtitles`;
    case "add-cue":
      return `Add a subtitle at frame ${command.cue.startFrame}`;
    case "edit-cue":
      return `Edit subtitle ${command.cueId}`;
    case "delete-cue":
      return `Delete subtitle ${command.cueId}`;
    case "import-cues":
      return `Import ${command.cues.length} subtitle${command.cues.length === 1 ? "" : "s"}`;
    case "set-subtitle-style":
      return `Change subtitle style on ${command.trackId}`;
  }
}

/** A refused pure operation. Callers either persist the returned record whole or persist nothing. */
export class TimelineOperationRefused extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "TimelineOperationRefused";
  }
}

export function secondsToFrames(seconds: number, frameRate: FrameRate): number {
  if (!Number.isFinite(seconds) || seconds < 0) throw new RangeError("seconds must be a non-negative finite number");
  FrameRateSchema.parse(frameRate);
  // A product that lands a hair under a half frame in binary (4.02 × 25 = 100.49999…) meant the
  // half frame; the nudge is far smaller than any frame and rounds it the way the figure reads.
  const frames = Math.round(seconds * frameRate + 1e-6);
  if (!Number.isSafeInteger(frames)) throw new RangeError("seconds exceed the safe whole-frame range");
  return frames;
}

export function framesToSeconds(frames: number, frameRate: FrameRate): number {
  if (!Number.isSafeInteger(frames) || frames < 0) throw new RangeError("frames must be a non-negative safe integer");
  FrameRateSchema.parse(frameRate);
  return frames / frameRate;
}

/** `HH:MM:SS:FF` at the production clock (R-9). */
export function formatFrames(frames: number, frameRate: FrameRate): string {
  const whole = Math.max(0, Math.floor(frames));
  const ff = whole % frameRate;
  const totalSeconds = Math.floor(whole / frameRate);
  const ss = totalSeconds % 60;
  const mm = Math.floor(totalSeconds / 60) % 60;
  const hh = Math.floor(totalSeconds / 3600);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`;
}


export const PICTURE_TRACK_ID: TimelineTrackId = "tr_picture";

function orderedStoryShots(production: ProductionBundle) {
  return sortScenes(production.scenes).flatMap((scene) =>
    orderedShots(scene).map((shot) => ({ sceneNumber: scene.number, shot })),
  );
}

function shotDurationFrames(durationSec: number | undefined, frameRate: FrameRate): number {
  return Math.max(1, secondsToFrames(resolvedAuthoredDuration({ durationSec }), frameRate));
}

function sourceFingerprint(value: string, clock: "story" | "spine" = "story"): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `${clock}-picture-v1:${hash.toString(16).padStart(16, "0")}`;
}

/** Exactly the source fields that determine the first Picture assembly, in their effective order. */
export function storyTimelineFingerprint(production: ProductionBundle): string {
  const frameRate = productionFrameRate(production.meta);
  return sourceFingerprint(
    JSON.stringify([
      frameRate,
      orderedStoryShots(production).map(({ shot }) => [shot.id, shotDurationFrames(shot.durationSec, frameRate)]),
    ]),
  );
}

/**
 * Exactly the source fields that determine the first music-timed assembly (SPEC-037 R-13, R-32):
 * the clock, the master and its measured length, and every anchor in play order with its sound
 * policy. Measured, not authored: a spine whose track is unmeasured has no first assembly yet.
 */
export function spineTimelineFingerprint(production: ProductionBundle, spine: ProductionSpine, trackDurationSec: number): string {
  const frameRate = productionFrameRate(production.meta);
  return sourceFingerprint(
    JSON.stringify([
      frameRate,
      spine.trackArtifactId,
      trackDurationSec,
      orderedAnchors(spine).map(({ shotId, anchor }) => [
        shotId,
        anchor.startSec,
        anchor.endSec,
        anchor.clipAudio.mode,
        anchor.clipAudio.mode === "keep-diegetic" ? anchor.clipAudio.gainDb : null,
      ]),
    ]),
    "spine",
  );
}

/**
 * The fence for the first materialising command, on whichever clock the production runs. A
 * music-timed production needs its master measured before it has a first assembly at all.
 */
export function timelineSourceFingerprint(production: ProductionBundle, trackDurationSec: number | null): string | null {
  if (production.spine === null) return storyTimelineFingerprint(production);
  if (trackDurationSec === null) return null;
  return spineTimelineFingerprint(production, production.spine, trackDurationSec);
}

/**
 * The first music-timed assembly (R-13): the spine's anchors as Picture clips, on the frame grid,
 * and the master as a Music clip across the whole song. Overlapping anchors resolve exactly as
 * the spine cut resolves them — the earlier one keeps the seconds, the later one starts where it
 * ends — and an anchor for a shot that no longer exists is not a clip, because there is nothing
 * for it to play. The track remembers the song's end, so a song that outruns its picture stays
 * the length of the song.
 */
export function seedSpinePictureTimeline(production: ProductionBundle, spine: ProductionSpine, trackDurationSec: number): ProductionTimeline {
  const frameRate = productionFrameRate(production.meta);
  const shots = new Map<string, { sceneNumber: number; shot: { id: string; number: number; title: string } }>();
  for (const scene of sortScenes(production.scenes)) {
    for (const shot of orderedShots(scene)) shots.set(shot.id, { sceneNumber: scene.number, shot });
  }
  const songFrames = Math.max(1, secondsToFrames(trackDurationSec, frameRate));
  const clips: TimelineClip[] = [];
  let cursor = 0;
  for (const { shotId, anchor } of orderedAnchors(spine)) {
    const known = shots.get(shotId);
    if (known === undefined) continue;
    const startFrame = Math.max(cursor, secondsToFrames(anchor.startSec, frameRate));
    const endFrame = Math.min(songFrames, secondsToFrames(anchor.endSec, frameRate));
    if (endFrame <= startFrame) continue;
    clips.push({
      id: `cl_${shotId.replace("_", "-")}`,
      startFrame,
      durationFrames: endFrame - startFrame,
      sourceInFrames: 0,
      source: { kind: "shot", shotId, sceneNumber: known.sceneNumber, shotNumber: known.shot.number, label: known.shot.title },
      audio: anchor.clipAudio.mode === "keep-diegetic" ? "keep" : "mute",
      ...(anchor.clipAudio.mode === "keep-diegetic" ? { gainDb: anchor.clipAudio.gainDb } : {}),
    });
    cursor = endFrame;
  }
  return {
    schemaVersion: 1,
    revision: 0,
    frameRate,
    tracks: [
      { id: PICTURE_TRACK_ID, kind: "picture", name: "Picture", order: 0, muted: false, endFrame: songFrames, clips },
      {
        id: "tr_master",
        kind: "audio",
        name: "Master track",
        order: 1,
        muted: false,
        solo: false,
        clips: [
          {
            id: "cl_master",
            startFrame: 0,
            durationFrames: songFrames,
            sourceInFrames: 0,
            source: { kind: "artifact", artifactId: spine.trackArtifactId, label: "Master track" },
            gainDb: 0, role: "music",
          },
        ],
      },
    ],
    history: { undo: [], redo: [] },
    mix: DEFAULT_MIX,
    library: [],
  };
}

export type EpisodeRange = { ok: true; startFrame: number; endFrame: number } | { ok: false; reason: string };

/**
 * One episode's delivery range on the timeline (SPEC-037 R-33): from the first through the last
 * base Picture clip sourced by one of its scenes. A clip from another episode inside that range
 * is a refusal that names the conflict, never a silent inclusion or omission.
 */
export function episodeTimelineRange(production: ProductionBundle, timeline: ProductionTimeline, episodeId: string): EpisodeRange {
  const episode = production.episodes.find((candidate) => candidate.id === episodeId);
  if (episode === undefined) return { ok: false, reason: `${episodeId} is not an episode of this production` };
  // A scene belongs to one episode; one listed in two would hand its footage to whichever came
  // later in the season file. Every episode that shares it refuses until the season is fixed.
  const owners = new Map<string, string[]>();
  for (const candidate of production.episodes) {
    for (const sceneId of candidate.scenes) owners.set(sceneId, [...(owners.get(sceneId) ?? []), candidate.id]);
  }
  const shared = episode.scenes.find((sceneId) => (owners.get(sceneId)?.length ?? 0) > 1);
  if (shared !== undefined) {
    const others = (owners.get(shared) ?? []).filter((id) => id !== episode.id);
    return { ok: false, reason: `${episode.title} shares ${shared} with ${others.join(", ")}; a scene belongs to one episode` };
  }
  const owner = new Map<string, string>();
  for (const candidate of production.episodes) {
    for (const sceneId of candidate.scenes) {
      const scene = production.scenes.find((item) => item.id === sceneId);
      for (const shot of scene === undefined ? [] : orderedShots(scene)) owner.set(shot.id, candidate.id);
    }
  }
  const base = basePictureTrack(timeline);
  const clips = base === null ? [] : orderedTrackClips(base);
  const mine = clips.filter((clip) => clip.source.kind === "shot" && owner.get(clip.source.shotId) === episode.id);
  if (mine.length === 0) return { ok: false, reason: `${episode.title} has no Picture clips on the timeline` };
  const startFrame = mine[0]!.startFrame;
  const endFrame = clipEnd(mine[mine.length - 1]!);
  // Episode membership is the authority (SPEC-023 R-12): a shot from a scene no episode claims
  // is as much an intruder as one from another episode, since the episode cut never carried it.
  const intruders = clips.filter((clip) => {
    if (clip.source.kind !== "shot") return false;
    return owner.get(clip.source.shotId) !== episode.id && clip.startFrame < endFrame && clipEnd(clip) > startFrame;
  });
  if (intruders.length > 0) {
    const named = intruders
      .map((clip) => {
        const shotId = clip.source.kind === "shot" ? clip.source.shotId : null;
        const owned = shotId === null ? undefined : production.episodes.find((candidate) => candidate.id === owner.get(shotId));
        return `${clip.source.label} (${owned?.title ?? "no episode"})`;
      })
      .join(", ");
    return { ok: false, reason: `${episode.title} is interleaved with ${named}; an episode delivers one contiguous range` };
  }
  return { ok: true, startFrame, endFrame };
}

/**
 * The editor's first state (SPEC-039 §1.1, decided 2026-09-02): nothing on the timeline and
 * nothing in the Library. A scene reaches the timeline when Arke assembles it from the scene
 * workspace, or when a person adds to the Library and places by hand — the story guides the
 * order without filling the cut by itself.
 */
export function seedEmptyPictureTimeline(production: Pick<ProductionBundle, "meta">): ProductionTimeline {
  return {
    schemaVersion: 1,
    revision: 0,
    frameRate: productionFrameRate(production.meta),
    tracks: [{ id: PICTURE_TRACK_ID, kind: "picture", name: "Picture", order: 0, muted: false, clips: [] }],
    history: { undo: [], redo: [] },
    mix: DEFAULT_MIX,
    library: [],
  };
}

/**
 * The first record for a story production: empty, unless `cut.json` already holds placements —
 * an existing film's shot-anchored sound has nothing to anchor to on an empty track, and the
 * migration would drop it and call the record migrated. A production that was already cut keeps
 * the story seed its placements were made against; a new one starts empty.
 */
export function seedFirstPictureTimeline(production: ProductionBundle): ProductionTimeline {
  const placed = production.cut.overlays.length > 0 || production.cut.audio.some((lane) => lane.entries.length > 0);
  return placed ? seedStoryPictureTimeline(production) : seedEmptyPictureTimeline(production);
}

/** How long a shot plays when the story names no length: the seed's own default, in frames. */
export function storyShotFrames(durationSec: number | undefined, frameRate: FrameRate): number {
  return shotDurationFrames(durationSec, frameRate);
}

export interface SceneAssembly {
  commands: Exclude<TimelineClipCommand, { kind: "detach-audio" }>[];
  /** What the assembly does, in the lines the banner and the Arke pane say (SPEC-039 R-34). */
  notes: string[];
  placed: string[];
  gaps: string[];
}

/**
 * Arke's assembly of one scene (decided 2026-09-02): the scene's shots go into the Library and
 * onto the base Picture track after whatever is already there, in script order; a shot with no
 * accepted take is placed as the same timed clip and resolves as a gap; a subtitle cue is
 * conformed from each shot's spoken line; audio filed against the scene is laid under it as a
 * bed. Pure — the coordinator applies the commands as one revision and one Undo entry, with
 * the notes on the entry. A scene whose shots are all on the timeline already is refused.
 */
export function assembleSceneCommands(input: {
  production: ProductionBundle;
  timeline: ProductionTimeline;
  sceneId: string;
  artifacts: ReadonlyArray<{ id: string; kind: string; file: string; links: readonly string[]; production?: string | null; mediaInfo?: { hasAudio: boolean; durationSec?: number } }>;
  language?: string;
}): SceneAssembly | { refused: string } {
  const { production, timeline, sceneId, artifacts } = input;
  const scene = production.scenes.find((candidate) => candidate.id === sceneId);
  if (scene === undefined) return { refused: `${sceneId} is not a scene of this production` };
  const frameRate = timeline.frameRate;
  const shots = orderedShots(scene);
  if (shots.length === 0) return { refused: `${scene.title} has no shots yet` };
  const shotKey = (shotId: string, sceneNumber: number, shotNumber: number) => `${sceneNumber}:${shotNumber}:${shotId}`;
  const onTimeline = new Set(
    timeline.tracks.flatMap((track) =>
      track.clips.flatMap((clip) =>
        clip.source.kind === "shot" ? [shotKey(clip.source.shotId, clip.source.sceneNumber, clip.source.shotNumber)] : [],
      ),
    ),
  );
  const fresh = shots.filter((shot) => !onTimeline.has(shotKey(shot.id, scene.number, shot.number)));
  if (fresh.length === 0) return { refused: `${scene.title} is already on the timeline` };
  const base = timeline.tracks.find((track) => track.id === PICTURE_TRACK_ID);
  const existingIds = new Set(timeline.tracks.flatMap((track) => track.clips.map((clip) => clip.id)));
  // After the track's whole extent, not only its last clip: a hole a Delete deliberately left at
  // the tail is kept as the track's `endFrame`, and the next scene goes after it.
  let cursor = base === undefined ? 0 : Math.max(base.endFrame ?? 0, base.clips.reduce((end, clip) => Math.max(end, clip.startFrame + clip.durationFrames), 0));
  const startFrame = cursor;
  const commands: SceneAssembly["commands"] = [];
  const placed: string[] = [];
  const gaps: string[] = [];
  const cues: Array<{ id: SubtitleCueId; text: string; startFrame: number; endFrame: number; speaker?: string }> = [];
  // Placed or a gap by the rule the preview and the export use: an accepted take that no longer
  // resolves to media is a gap, whatever the selection says.
  const playable = new Set(
    deriveCut(production).entries
      .filter((entry) => entry.media !== null)
      .map((entry) => shotKey(entry.shot.id, entry.sceneNumber, entry.shot.number)),
  );
  for (const shot of fresh) {
    const durationFrames = shotDurationFrames(shot.durationSec, frameRate);
    let id: TimelineClipId = `cl_${shot.id.replace("_", "-")}`;
    for (let n = 2; existingIds.has(id); n += 1) id = `cl_${shot.id.replace("_", "-")}-${n}`;
    existingIds.add(id);
    commands.push({
      kind: "place",
      trackId: PICTURE_TRACK_ID,
      clip: {
        id,
        startFrame: cursor,
        durationFrames,
        sourceInFrames: 0,
        source: { kind: "shot", shotId: shot.id, sceneNumber: scene.number, shotNumber: shot.number, label: shot.title },
      },
    });
    (playable.has(shotKey(shot.id, scene.number, shot.number)) ? placed : gaps).push(shot.title);
    // Only a spoken line becomes a subtitle (R-45): an sfx note like "wind under the door" is
    // direction for the mix, not words anyone says.
    const spoken = shot.audio?.kind === "vo" || shot.audio?.kind === "dialogue";
    const line = spoken ? (shot.audio?.line?.trim() ?? "") : "";
    if (line !== "") {
      cues.push({
        id: `cu_${id.slice(3)}`,
        text: line.slice(0, 500),
        startFrame: cursor,
        endFrame: cursor + durationFrames,
        ...(shot.audio?.speaker !== undefined ? { speaker: shot.audio.speaker } : {}),
      });
    }
    cursor += durationFrames;
  }
  const library: TimelineLibraryItem[] = shots.map((shot) => ({ kind: "shot", shotId: shot.id }));
  // A bed is the scene's own and the production's own (SPEC-020 R-13): scene ids repeat across
  // productions, and another production's scoped file must not be laid under this one.
  const visible = (artifact: { production?: string | null }) =>
    artifact.production === undefined || artifact.production === null || artifact.production === production.meta.id;
  const beds = artifacts.filter(
    (artifact) => visible(artifact) && artifact.links.includes(scene.id) && (artifact.kind === "audio" || (artifact.kind === "video" && artifact.mediaInfo?.hasAudio === true)),
  );
  for (const bed of beds) library.push({ kind: "artifact", artifactId: bed.id });
  commands.unshift({ kind: "add-to-library", items: library });
  const notes: string[] = [`Placed ${fresh.length} shot${fresh.length === 1 ? "" : "s"} from ${scene.title} in script order.`];
  if (gaps.length > 0) {
    notes.push(`Left ${gaps.length === 1 ? "a gap" : `${gaps.length} gaps`} — ${gaps.slice(0, 4).join(", ")}${gaps.length > 4 ? ", …" : ""} — no accepted take yet, so it needs your call.`);
  }
  if (cues.length > 0) {
    const language = input.language ?? "en";
    // The track of this language, never another's: an English cue on a Spanish track is a wrong
    // deliverable. Of those, the first with the scene's span free of cues; a trailing cue someone
    // wrote past the picture would otherwise refuse the whole assembly.
    const sameLanguage = [...timeline.tracks].sort((a, b) => a.order - b.order).filter((track) => track.kind === "subtitle" && track.language === language);
    const subtitles = sameLanguage.find((track) => !(track.cues ?? []).some((cue) => cue.startFrame < cursor && cue.endFrame > startFrame));
    const takenIds = new Set(timeline.tracks.map((track) => track.id));
    let trackId: TimelineTrackId = subtitles?.id ?? `tr_subs-${language}`;
    for (let n = 2; subtitles === undefined && takenIds.has(trackId); n += 1) trackId = `tr_subs-${language}-${n}`;
    if (subtitles === undefined) {
      commands.push({ kind: "add-subtitle-track", trackId, name: sameLanguage.length > 0 ? `Subtitles ${sameLanguage.length + 1}` : "Subtitles", language });
    }
    const taken = new Set((subtitles?.cues ?? []).map((cue) => cue.id));
    for (const cue of cues) {
      let cueId: SubtitleCueId = cue.id;
      for (let n = 2; taken.has(cueId); n += 1) cueId = `${cue.id}-${n}`;
      taken.add(cueId);
      commands.push({ kind: "add-cue", trackId, cue: { ...cue, id: cueId } });
    }
    notes.push(`Conformed ${cues.length} subtitle${cues.length === 1 ? "" : "s"} from the shot lines.`);
  }
  if (beds.length > 0 && cursor > startFrame) {
    // The first generic or legacy Ambience lane with the span free; a new one when each holds
    // something across it, rather than an overlap that refuses the whole assembly.
    const spanFree = (track: TimelineTrack) => !track.clips.some((clip) => clip.startFrame < cursor && clip.startFrame + clip.durationFrames > startFrame);
    const ambienceLanes = [...timeline.tracks].sort((a, b) => a.order - b.order).filter((track) => track.kind === "ambience" || track.kind === "audio");
    const ambience = ambienceLanes.find(spanFree);
    let trackId: TimelineTrackId = ambience?.id ?? "tr_ambience";
    if (ambience === undefined) {
      const added = newAudioTrack(timeline);
      trackId = added.trackId; commands.push(added);
    }
    // One bed per scene span on one track; a second file for the same scene waits in the Library.
    const bed = beds[0]!;
    let id: TimelineClipId = `cl_bed-${bed.id.slice(3, 11).toLowerCase()}`;
    for (let n = 2; existingIds.has(id); n += 1) id = `cl_bed-${bed.id.slice(3, 11).toLowerCase()}-${n}`;
    existingIds.add(id);
    commands.push({
      kind: "place",
      trackId,
      clip: {
        id,
        startFrame,
        durationFrames: cursor - startFrame,
        sourceInFrames: 0,
        source: { kind: "artifact", artifactId: bed.id, label: bed.file.split("/").pop() ?? bed.file },
        gainDb: -12, role: "ambience",
      },
    });
    notes.push(`Laid ${bed.file.split("/").pop()} under ${scene.title} at −12 dB.`);
  }
  notes.push(`Added ${library.length} item${library.length === 1 ? "" : "s"} to the Library.`);
  return { commands, notes, placed, gaps };
}

/** Materialize every story shot once. A shot without valid media remains the same timed clip and resolves as a gap. */
export function seedStoryPictureTimeline(production: ProductionBundle): ProductionTimeline {
  const frameRate = productionFrameRate(production.meta);
  const seen = new Set<string>();
  let startFrame = 0;
  const clips = orderedStoryShots(production).map(({ sceneNumber, shot }): TimelineClip => {
    if (seen.has(shot.id)) throw new TimelineOperationRefused(`story order contains duplicate shot ${shot.id}`);
    seen.add(shot.id);
    const durationFrames = shotDurationFrames(shot.durationSec, frameRate);
    const clip: TimelineClip = {
      id: `cl_${shot.id.replace("_", "-")}`,
      startFrame,
      durationFrames,
      sourceInFrames: 0,
      source: {
        kind: "shot",
        shotId: shot.id,
        sceneNumber,
        shotNumber: shot.number,
        label: shot.title,
      },
    };
    startFrame += durationFrames;
    return clip;
  });

  return {
    schemaVersion: 1,
    revision: 0,
    frameRate,
    tracks: [{ id: PICTURE_TRACK_ID, kind: "picture", name: "Picture", order: 0, muted: false, clips }],
    history: { undo: [], redo: [] },
    mix: DEFAULT_MIX,
    library: [],
  };
}

/** Clips in play order. Ties on the start frame cannot survive validation, but the sort stays total. */
export function orderedTrackClips(track: Pick<TimelineTrack, "clips">): TimelineClip[] {
  return [...track.clips].sort(
    (a, b) => a.startFrame - b.startFrame || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

function clipEnd(clip: TimelineClip): number {
  return clip.startFrame + clip.durationFrames;
}

function trackOverlaps(ordered: readonly TimelineClip[]): string[] {
  const problems: string[] = [];
  for (let index = 1; index < ordered.length; index++) {
    const previous = ordered[index - 1]!;
    const clip = ordered[index]!;
    if (clip.startFrame < clipEnd(previous)) problems.push(`clips ${previous.id} and ${clip.id} overlap`);
  }
  return problems;
}

/**
 * The base Picture track (R-13): the one the story seeded, or the lowest-ordered Picture track
 * when a record was assembled another way. Higher-ordered Picture tracks composite over it.
 */
export function basePictureTrack(timeline: Pick<ProductionTimeline, "tracks">): TimelineTrack | null {
  const pictures = timeline.tracks.filter((track) => track.kind === "picture");
  return pictures.find((track) => track.id === PICTURE_TRACK_ID) ?? [...pictures].sort((a, b) => a.order - b.order)[0] ?? null;
}

function nextRevision(timeline: ProductionTimeline): number {
  if (timeline.revision >= Number.MAX_SAFE_INTEGER) throw new TimelineOperationRefused("timeline revision is exhausted");
  return timeline.revision + 1;
}

function bounded<T>(entries: T[]): T[] {
  return entries.slice(-TIMELINE_HISTORY_LIMIT);
}

/** Key-order-independent equality, because a clip read from disk may spell its keys in any order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameClip(a: TimelineClip | null | undefined, b: TimelineClip | null | undefined): boolean {
  if (a == null || b == null) return a == null && b == null;
  return canonical(a) === canonical(b);
}

/** Swap adjacent timeline windows without changing their combined range or either clip's duration. */
function swapAdjacent(clips: TimelineClip[], firstIndex: number, secondIndex: number): TimelineClip[] {
  const leftIndex = Math.min(firstIndex, secondIndex);
  if (Math.abs(firstIndex - secondIndex) !== 1) {
    throw new TimelineOperationRefused("a one-position move must swap adjacent clips");
  }
  const left = clips[leftIndex]!;
  const right = clips[leftIndex + 1]!;
  const gapFrames = right.startFrame - clipEnd(left);
  if (gapFrames < 0) throw new TimelineOperationRefused(`clips ${left.id} and ${right.id} overlap`);
  const swapped = [...clips];
  swapped[leftIndex] = { ...right, startFrame: left.startFrame };
  swapped[leftIndex + 1] = {
    ...left,
    startFrame: left.startFrame + right.durationFrames + gapFrames,
  };
  return swapped;
}

// ---------------------------------------------------------------------------
// Applying commands (R-21, R-22): pure, all-or-nothing
// ---------------------------------------------------------------------------

/**
 * How many frames a clip's source can supply from its first frame, when that is known (SPEC-038
 * R-10, SPEC-013 R-5a). Unknown is `undefined` — not measured, never zero — and bounds nothing.
 */
export type SourceLengthFrames = (clip: TimelineClip) => number | undefined;

interface Working {
  timeline: ProductionTimeline;
  sources?: { production: ProductionBundle; artifacts: readonly ArtifactSidecar[] };
  tracks: TimelineTrack[];
  mix: MixSettings;
  library: TimelineLibraryItem[];
  sourceLength: SourceLengthFrames;
  /** Every clip touched so far, keyed by id, with the state it had before the first touch. */
  touched: Map<TimelineClipId, { trackId: TimelineTrackId; before: TimelineClip | null }>;
  /** Every track whose properties or existence changed, with what it was before the first touch. */
  touchedTracks: Map<TimelineTrackId, { kind: TimelineTrackKind; before: TimelineTrackProps | null }>;
  touchedCues: Map<SubtitleCueId, { trackId: TimelineTrackId; before: SubtitleCue | null }>;
}

function touchCue(working: Working, trackId: TimelineTrackId, cueId: SubtitleCueId, before: SubtitleCue | null): void {
  const touched = working.touchedCues.get(cueId);
  // One track per cue id per entry, for the reason clips have it (round eight).
  if (touched !== undefined && touched.trackId !== trackId) {
    throw new TimelineOperationRefused(`subtitle ${cueId} was on ${touched.trackId} earlier in this batch and cannot reappear on ${trackId}`);
  }
  if (touched === undefined) working.touchedCues.set(cueId, { trackId, before });
}

function findCue(working: Working, cueId: SubtitleCueId): { track: TimelineTrack; cue: SubtitleCue } {
  const matches = working.tracks.filter((track) => (track.cues ?? []).some((cue) => cue.id === cueId));
  if (matches.length !== 1) throw new TimelineOperationRefused(`timeline does not contain exactly one subtitle ${cueId}`);
  const track = matches[0]!;
  return { track, cue: track.cues!.find((cue) => cue.id === cueId)! };
}

function subtitleTrack(working: Working, trackId: TimelineTrackId): TimelineTrack {
  const track = working.tracks.find((candidate) => candidate.id === trackId);
  if (track === undefined) throw new TimelineOperationRefused(`track ${trackId} is not on the timeline`);
  if (track.kind !== "subtitle") throw new TimelineOperationRefused(`${track.name} is not a Subtitle track`);
  return track;
}

/** Replace a Subtitle track's cues, refusing overlap and inverted ranges by name (R-22, R-26). */
function replaceTrackCues(working: Working, trackId: TimelineTrackId, cues: SubtitleCue[]): void {
  for (const cue of cues) {
    if (cue.endFrame <= cue.startFrame) throw new TimelineOperationRefused(`subtitle ${cue.id} must end after it starts`);
    if (!Number.isSafeInteger(cue.endFrame)) throw new TimelineOperationRefused(`subtitle ${cue.id} would overflow the frame clock`);
  }
  const ids = new Set<string>();
  for (const cue of cues) {
    if (ids.has(cue.id)) throw new TimelineOperationRefused(`subtitle id ${cue.id} appears twice`);
    ids.add(cue.id);
  }
  const overlaps = cueOverlaps(cues);
  if (overlaps.length > 0) throw new TimelineOperationRefused(overlaps[0]!);
  working.tracks = working.tracks.map((track) => (track.id === trackId ? { ...track, cues: orderedCues(cues) } : track));
}

function assertNewCueId(working: Working, cueId: SubtitleCueId): void {
  if (working.tracks.some((track) => (track.cues ?? []).some((cue) => cue.id === cueId))) {
    throw new TimelineOperationRefused(`subtitle id ${cueId} is already on the timeline`);
  }
  SubtitleCueIdSchema.parse(cueId);
}

function touchTrack(working: Working, track: Pick<TimelineTrack, "id" | "kind">, before: TimelineTrackProps | null): void {
  const touched = working.touchedTracks.get(track.id);
  // A history entry records one kind per track id. A batch that removed a Music track and added
  // a Picture track under the same id would replay its undo onto the wrong kind, so the id is
  // refused rather than recorded half-right (round three).
  if (touched !== undefined && touched.kind !== track.kind) {
    throw new TimelineOperationRefused(`track ${track.id} was a ${touched.kind} track earlier in this batch and cannot return as ${track.kind}`);
  }
  if (touched === undefined) working.touchedTracks.set(track.id, { kind: track.kind, before });
}

/**
 * The base Picture track composites under every other Picture track (SPEC-038 R-8), whatever
 * the saved order says — so the saved order is not allowed to say otherwise (round seven).
 */
function assertBaseBelowOverlays(tracks: readonly TimelineTrack[]): void {
  const base = tracks.find((track) => track.id === PICTURE_TRACK_ID);
  if (base === undefined) return;
  const under = tracks.find((track) => track.kind === "picture" && track.id !== PICTURE_TRACK_ID && track.order < base.order);
  if (under !== undefined) throw new TimelineOperationRefused(`the base Picture track stays below every other Picture track; ${under.name} would sit under it`);
}

function findClip(working: Working, clipId: TimelineClipId): { track: TimelineTrack; clip: TimelineClip; ordered: TimelineClip[]; index: number } {
  const matches = working.tracks.filter((track) => track.clips.some((clip) => clip.id === clipId));
  if (matches.length !== 1) throw new TimelineOperationRefused(`timeline does not contain exactly one clip ${clipId}`);
  const track = matches[0]!;
  const ordered = orderedTrackClips(track);
  const index = ordered.findIndex((clip) => clip.id === clipId);
  return { track, clip: ordered[index]!, ordered, index };
}

function touch(working: Working, trackId: TimelineTrackId, clipId: TimelineClipId, before: TimelineClip | null): void {
  const touched = working.touched.get(clipId);
  // One track per clip id per entry: a batch that deleted a clip here and placed the same id
  // there would record only the deletion, and its Undo would restore a clip whose id is already
  // live on the other track (round six). Moving between tracks is its own batch.
  if (touched !== undefined && touched.trackId !== trackId) {
    throw new TimelineOperationRefused(`clip ${clipId} was on ${touched.trackId} earlier in this batch and cannot reappear on ${trackId}`);
  }
  if (touched === undefined) working.touched.set(clipId, { trackId, before });
}

function replaceTrackClips(working: Working, trackId: TimelineTrackId, clips: TimelineClip[]): void {
  const track = working.tracks.find((candidate) => candidate.id === trackId);
  if (track === undefined) throw new TimelineOperationRefused(`track ${trackId} is not on the timeline`);
  for (const clip of clips) {
    // The kind of thing before the shape of the window: a shot on a Music track is refused as
    // that, not as an overlap with whatever the track already held.
    const problem = sourceProblem(track.kind, clip);
    if (problem !== null) throw new TimelineOperationRefused(problem);
    if (clip.startFrame < 0 || clip.durationFrames < 1 || clip.sourceInFrames < 0) {
      throw new TimelineOperationRefused(`${clip.id} would leave the frame clock`);
    }
    if (!Number.isSafeInteger(clipEnd(clip))) throw new TimelineOperationRefused(`${clip.id} would overflow the frame clock`);
  }
  const overlaps = trackOverlaps(orderedTrackClips({ clips }));
  if (overlaps.length > 0) throw new TimelineOperationRefused(overlaps[0]!);
  // Stored in play order so the file a person opens reads the way the track plays.
  const sorted = orderedTrackClips({ clips });
  working.tracks = working.tracks.map((candidate) => {
    if (candidate.id !== trackId) return candidate;
    const { endFrame, ...rest } = candidate;
    // A remembered end that no longer reaches past the clips says nothing, and is not written.
    return endFrame !== undefined && endFrame > trackEndFrame({ clips: sorted }) ? { ...rest, endFrame, clips: sorted } : { ...rest, clips: sorted };
  });
}

function assertNewClipId(working: Working, newClipId: TimelineClipId): void {
  if (working.tracks.some((track) => track.clips.some((clip) => clip.id === newClipId))) {
    throw new TimelineOperationRefused(`clip id ${newClipId} is already on the timeline`);
  }
  TimelineClipIdSchema.parse(newClipId);
}

/**
 * Re-lay a sequence after a reorder, keeping every hole where it was in the sequence (R-3, R-21).
 *
 * A hole belongs to its slot rather than to a clip: the empty second before the third clip stays
 * before whichever clip is third after the move. That is the same rule the adjacent swap follows,
 * and it is what stops a reorder from silently closing or opening timeline space.
 */
function relayPreservingHoles(before: readonly TimelineClip[], reordered: readonly TimelineClip[]): TimelineClip[] {
  const holes = before.map((clip, index) => clip.startFrame - (index === 0 ? 0 : clipEnd(before[index - 1]!)));
  let cursor = 0;
  return reordered.map((clip, index) => {
    const startFrame = cursor + (holes[index] ?? 0);
    cursor = startFrame + clip.durationFrames;
    return { ...clip, startFrame };
  });
}

function applyClipCommand(working: Working, command: TimelineClipCommand): void {
  switch (command.kind) {
    case "detach-audio": {
      if (!working.sources) throw new TimelineOperationRefused("Detaching audio requires current production sources");
      const current = { ...working.timeline, tracks: working.tracks, mix: working.mix, library: working.library };
      const { production, artifacts } = working.sources;
      for (const edit of detachAudioCommands(production, current, artifacts, command.clipId, command.newClipId)) applyClipCommand(working, edit);
      return;
    }
    case "move-adjacent": {
      const { track, ordered, index } = findClip(working, command.clipId);
      const toIndex = index + (command.direction === "earlier" ? -1 : 1);
      if (toIndex < 0 || toIndex >= ordered.length) throw new TimelineOperationRefused(`${command.clipId} cannot move ${command.direction}`);
      const swapped = swapAdjacent(ordered, index, toIndex);
      for (const position of [index, toIndex]) touch(working, track.id, ordered[position]!.id, ordered[position]!);
      replaceTrackClips(working, track.id, swapped);
      return;
    }
    case "move-to-order": {
      const { track, clip, ordered, index } = findClip(working, command.clipId);
      if (command.index >= ordered.length) throw new TimelineOperationRefused(`${command.clipId} cannot move to position ${command.index + 1} of ${ordered.length}`);
      if (command.index === index) return;
      const without = ordered.filter((candidate) => candidate.id !== clip.id);
      without.splice(command.index, 0, clip);
      const relaid = relayPreservingHoles(ordered, without);
      // Every clip on the track is touched; the ones the re-lay left alone coalesce away below.
      for (const candidate of ordered) touch(working, track.id, candidate.id, candidate);
      replaceTrackClips(working, track.id, relaid);
      return;
    }
    case "move-to-frame": {
      const { track, clip, ordered } = findClip(working, command.clipId);
      if (command.startFrame === clip.startFrame) return;
      const moved = { ...clip, startFrame: command.startFrame };
      const others = ordered.filter((candidate) => candidate.id !== clip.id);
      touch(working, track.id, clip.id, clip);
      replaceTrackClips(working, track.id, [...others, moved]);
      return;
    }
    case "trim": {
      const { track, clip, ordered, index } = findClip(working, command.clipId);
      const delta = command.deltaFrames;
      let next: TimelineClip;
      if (command.edge === "start") {
        next = {
          ...clip,
          startFrame: clip.startFrame + delta,
          durationFrames: clip.durationFrames - delta,
          sourceInFrames: clip.sourceInFrames + delta,
        };
        if (next.sourceInFrames < 0) throw new TimelineOperationRefused(`${clip.id} has no source before its first frame`);
        const previous = ordered[index - 1];
        if (previous !== undefined && next.startFrame < clipEnd(previous)) {
          throw new TimelineOperationRefused(`${clip.id} cannot extend into ${previous.id}`);
        }
      } else {
        next = { ...clip, durationFrames: clip.durationFrames + delta };
        const following = ordered[index + 1];
        if (following !== undefined && clipEnd(next) > following.startFrame) {
          throw new TimelineOperationRefused(`${clip.id} cannot extend into ${following.id}`);
        }
        // A tail that reaches past the measured source is an impossible range, not a held frame.
        const available = working.sourceLength(clip);
        if (available !== undefined && next.sourceInFrames + next.durationFrames > available) {
          throw new TimelineOperationRefused(`${clip.id} has only ${Math.max(0, available - next.sourceInFrames)} source frames from its in point`);
        }
      }
      if (next.durationFrames < 1) throw new TimelineOperationRefused(`${clip.id} must keep at least one frame`);
      if (next.startFrame < 0) throw new TimelineOperationRefused(`${clip.id} cannot start before the timeline`);
      touch(working, track.id, clip.id, clip);
      replaceTrackClips(working, track.id, ordered.map((candidate) => (candidate.id === clip.id ? next : candidate)));
      return;
    }
    case "split": {
      const { track, clip, ordered } = findClip(working, command.clipId);
      assertNewClipId(working, command.newClipId);
      if (command.atFrame <= clip.startFrame || command.atFrame >= clipEnd(clip)) {
        throw new TimelineOperationRefused(`frame ${command.atFrame} is not inside ${clip.id}`);
      }
      const offset = command.atFrame - clip.startFrame;
      const left: TimelineClip = { ...clip, durationFrames: offset };
      const right: TimelineClip = {
        ...clip,
        id: command.newClipId,
        startFrame: command.atFrame,
        durationFrames: clip.durationFrames - offset,
        sourceInFrames: clip.sourceInFrames + offset,
      };
      touch(working, track.id, clip.id, clip);
      touch(working, track.id, right.id, null);
      replaceTrackClips(working, track.id, [...ordered.map((candidate) => (candidate.id === clip.id ? left : candidate)), right]);
      return;
    }
    case "duplicate": {
      const { track, clip, ordered, index } = findClip(working, command.clipId);
      assertNewClipId(working, command.newClipId);
      const following = ordered[index + 1];
      const fitsAfter = following === undefined || following.startFrame - clipEnd(clip) >= clip.durationFrames;
      // Beside the original when the space is free, otherwise after everything: never a ripple.
      const startFrame = fitsAfter ? clipEnd(clip) : clipEnd(ordered[ordered.length - 1]!);
      const copy: TimelineClip = { ...clip, id: command.newClipId, startFrame };
      touch(working, track.id, copy.id, null);
      replaceTrackClips(working, track.id, [...ordered, copy]);
      return;
    }
    case "delete": {
      const { track, clip, ordered } = findClip(working, command.clipId);
      touch(working, track.id, clip.id, clip);
      const remaining = ordered.filter((candidate) => candidate.id !== clip.id);
      // The hole a deleted last clip leaves has no clip after it to mark its far side, so the
      // track remembers where it reached (R-21): Delete is not Ripple delete at the end either.
      const end = trackEndFrame(track);
      if (end > trackEndFrame({ clips: remaining })) {
        touchTrack(working, track, trackProps(track));
        working.tracks = working.tracks.map((candidate) => (candidate.id === track.id ? { ...candidate, endFrame: end } : candidate));
      }
      replaceTrackClips(working, track.id, remaining);
      return;
    }
    case "ripple-delete": {
      const { track, clip, ordered, index } = findClip(working, command.clipId);
      touch(working, track.id, clip.id, clip);
      const shifted = ordered.filter((candidate) => candidate.id !== clip.id).map((candidate, position) => {
        if (position < index) return candidate;
        touch(working, track.id, candidate.id, candidate);
        return { ...candidate, startFrame: candidate.startFrame - clip.durationFrames };
      });
      if (track.endFrame !== undefined) {
        touchTrack(working, track, trackProps(track));
        const endFrame = Math.max(0, track.endFrame - clip.durationFrames);
        working.tracks = working.tracks.map((candidate) =>
          candidate.id === track.id ? { ...candidate, ...(endFrame > trackEndFrame({ clips: shifted }) ? { endFrame } : { endFrame: undefined }) } : candidate,
        );
      }
      replaceTrackClips(working, track.id, shifted);
      return;
    }
    case "place": {
      const track = working.tracks.find((candidate) => candidate.id === command.trackId);
      if (track === undefined) throw new TimelineOperationRefused(`track ${command.trackId} is not on the timeline`);
      assertNewClipId(working, command.clip.id);
      const clip = TimelineClipSchema.parse(AUDIO_TRACK_KINDS.has(track.kind)
        ? { ...command.clip, role: command.clip.role ?? placementAudioRole(track) } : command.clip);
      touch(working, track.id, clip.id, null);
      replaceTrackClips(working, track.id, [...track.clips, clip]);
      return;
    }
    case "set-performance-source": {
      const { track, clip, ordered } = findClip(working, command.clipId);
      if (track.kind !== "picture" || clip.source.kind !== "shot") throw new TimelineOperationRefused("Performance playback belongs to a shot on the Picture track");
      if (command.sourceClipId !== null) {
        const source = findClip(working, command.sourceClipId);
        if (!AUDIO_TRACK_KINDS.has(source.track.kind) || source.clip.source.kind !== "artifact") throw new TimelineOperationRefused("Choose an audio artifact placed on an audio track");
        if (clip.startFrame < source.clip.startFrame || clipEnd(clip) > clipEnd(source.clip)) throw new TimelineOperationRefused("The soundtrack clip must cover the entire shot slot");
      }
      touch(working, track.id, clip.id, clip);
      const { performanceSourceClipId: _previous, ...rest } = clip;
      replaceTrackClips(working, track.id, ordered.map(candidate => candidate.id === clip.id
        ? { ...rest, ...(command.sourceClipId === null ? {} : { performanceSourceClipId: command.sourceClipId }) } : candidate));
      return;
    }
    case "set-clip-audio": {
      const { track, clip, ordered } = findClip(working, command.clipId);
      if (track.kind !== "picture") throw new TimelineOperationRefused("Only picture clips have embedded sound");
      touch(working, track.id, clip.id, clip);
      replaceTrackClips(working, track.id, ordered.map(candidate => candidate.id === clip.id ? { ...candidate, audio: command.audio } : candidate));
      return;
    }
    case "set-clip-role": {
      const { track, clip, ordered } = findClip(working, command.clipId);
      if (!AUDIO_TRACK_KINDS.has(track.kind)) throw new TimelineOperationRefused("Choose a clip on an audio track");
      if (clip.source.kind === "performance" && command.role !== "dialogue") throw new TimelineOperationRefused("Reviewed performances keep their Voice role");
      touch(working, track.id, clip.id, clip);
      replaceTrackClips(working, track.id, ordered.map(candidate => candidate.id === clip.id ? { ...candidate, role: command.role } : candidate));
      return;
    }
    case "set-clip-gain": {
      const { track, clip, ordered } = findClip(working, command.clipId);
      if (!AUDIO_TRACK_KINDS.has(track.kind)) throw new TimelineOperationRefused(`${clip.id} is on a ${track.kind} track, which has no gain`);
      touch(working, track.id, clip.id, clip);
      replaceTrackClips(working, track.id, ordered.map((candidate) => (candidate.id === clip.id ? { ...candidate, gainDb: command.gainDb } : candidate)));
      return;
    }
    case "set-track": {
      const track = working.tracks.find((candidate) => candidate.id === command.trackId);
      if (track === undefined) throw new TimelineOperationRefused(`track ${command.trackId} is not on the timeline`);
      if (command.solo !== undefined && !AUDIO_TRACK_KINDS.has(track.kind)) throw new TimelineOperationRefused(`${track.name} is not an audio track and cannot solo`);
      if (command.defaultRole !== undefined && !AUDIO_TRACK_KINDS.has(track.kind)) throw new TimelineOperationRefused("Only audio tracks have a default role");
      if (command.language !== undefined && track.kind !== "subtitle") throw new TimelineOperationRefused(`${track.name} is not a Subtitle track and has no language`);
      if (command.order !== undefined && working.tracks.some((candidate) => candidate.id !== track.id && candidate.order === command.order)) {
        throw new TimelineOperationRefused(`another track already has order ${command.order}`);
      }
      touchTrack(working, track, trackProps(track));
      const next: TimelineTrack = {
        ...track,
        ...(command.name !== undefined ? { name: command.name } : {}),
        ...(command.defaultRole !== undefined ? { defaultRole: command.defaultRole } : {}),
        ...(command.muted !== undefined ? { muted: command.muted } : {}),
        ...(command.solo !== undefined ? { solo: command.solo } : {}),
        ...(command.order !== undefined ? { order: command.order } : {}),
        ...(command.language !== undefined ? { language: command.language } : {}),
      };
      working.tracks = working.tracks.map((candidate) => (candidate.id === track.id ? next : candidate));
      if (command.order !== undefined) assertBaseBelowOverlays(working.tracks);
      return;
    }
    case "add-track": {
      if (command.trackKind === "subtitle") throw new TimelineOperationRefused("a Subtitle track is added with its language");
      if (command.defaultRole !== undefined && !AUDIO_TRACK_KINDS.has(command.trackKind)) throw new TimelineOperationRefused("Only audio tracks have a default role");
      if (working.tracks.some((candidate) => candidate.id === command.trackId)) {
        throw new TimelineOperationRefused(`track ${command.trackId} is already on the timeline`);
      }
      TimelineTrackIdSchema.parse(command.trackId);
      const order = command.order ?? working.tracks.reduce((high, candidate) => Math.max(high, candidate.order + 1), 0);
      if (working.tracks.some((candidate) => candidate.order === order)) throw new TimelineOperationRefused(`another track already has order ${order}`);
      const track: TimelineTrack = {
        id: command.trackId,
        kind: command.trackKind,
        name: command.name,
        order,
        muted: false,
        ...(AUDIO_TRACK_KINDS.has(command.trackKind) ? { solo: false } : {}),
        ...(command.defaultRole !== undefined ? { defaultRole: command.defaultRole } : {}),
        clips: [],
      };
      touchTrack(working, track, null);
      working.tracks = [...working.tracks, track];
      if (track.kind === "picture") assertBaseBelowOverlays(working.tracks);
      return;
    }
    case "remove-track": {
      const track = working.tracks.find((candidate) => candidate.id === command.trackId);
      if (track === undefined) throw new TimelineOperationRefused(`track ${command.trackId} is not on the timeline`);
      if (track.clips.length > 0) throw new TimelineOperationRefused(`${track.name} still holds ${track.clips.length} clip${track.clips.length === 1 ? "" : "s"}`);
      if ((track.cues ?? []).length > 0) throw new TimelineOperationRefused(`${track.name} still holds ${track.cues!.length} subtitle${track.cues!.length === 1 ? "" : "s"}`);
      if (track.id === PICTURE_TRACK_ID) throw new TimelineOperationRefused("the base Picture track stays");
      touchTrack(working, track, trackProps(track));
      working.tracks = working.tracks.filter((candidate) => candidate.id !== track.id);
      return;
    }
    case "set-mix": {
      working.mix = MixSettingsSchema.parse({ ...working.mix, ...command.mix });
      return;
    }
    case "add-to-library": {
      const present = new Set(working.library.map(libraryItemKey));
      // The same item twice in one command is one item: the set is kept while accepting, not only before.
      const fresh = command.items.filter((item) => {
        const key = libraryItemKey(item);
        if (present.has(key)) return false;
        present.add(key);
        return true;
      });
      if (working.library.length + fresh.length > MAX_LIBRARY_ITEMS) throw new TimelineOperationRefused(`the library holds at most ${MAX_LIBRARY_ITEMS} items`);
      working.library = [...working.library, ...fresh];
      return;
    }
    case "remove-from-library": {
      const gone = new Set(command.items.map(libraryItemKey));
      working.library = working.library.filter((item) => !gone.has(libraryItemKey(item)));
      return;
    }
    case "add-subtitle-track": {
      if (working.tracks.some((candidate) => candidate.id === command.trackId)) {
        throw new TimelineOperationRefused(`track ${command.trackId} is already on the timeline`);
      }
      TimelineTrackIdSchema.parse(command.trackId);
      touchTrack(working, { id: command.trackId, kind: "subtitle" }, null);
      const order = working.tracks.reduce((high, candidate) => Math.max(high, candidate.order + 1), 0);
      const track: TimelineTrack = {
        id: command.trackId,
        kind: "subtitle",
        name: command.name,
        order,
        muted: false,
        clips: [],
        language: command.language,
        style: command.style ?? DEFAULT_SUBTITLE_STYLE,
        cues: [],
      };
      touchTrack(working, track, null);
      working.tracks = [...working.tracks, track];
      return;
    }
    case "add-cue": {
      const track = subtitleTrack(working, command.trackId);
      assertNewCueId(working, command.cue.id);
      const cue = SubtitleCueSchema.parse(command.cue);
      touchCue(working, track.id, cue.id, null);
      replaceTrackCues(working, track.id, [...(track.cues ?? []), cue]);
      return;
    }
    case "edit-cue": {
      const { track, cue } = findCue(working, command.cueId);
      const next: SubtitleCue = {
        ...cue,
        ...(command.text !== undefined ? { text: command.text } : {}),
        ...(command.startFrame !== undefined ? { startFrame: command.startFrame } : {}),
        ...(command.endFrame !== undefined ? { endFrame: command.endFrame } : {}),
      };
      if (command.speaker === null) delete next.speaker;
      else if (command.speaker !== undefined) next.speaker = command.speaker;
      touchCue(working, track.id, cue.id, cue);
      replaceTrackCues(working, track.id, (track.cues ?? []).map((candidate) => (candidate.id === cue.id ? next : candidate)));
      return;
    }
    case "delete-cue": {
      const { track, cue } = findCue(working, command.cueId);
      touchCue(working, track.id, cue.id, cue);
      replaceTrackCues(working, track.id, (track.cues ?? []).filter((candidate) => candidate.id !== cue.id));
      return;
    }
    case "import-cues": {
      const track = subtitleTrack(working, command.trackId);
      const kept = command.replace ? [] : (track.cues ?? []);
      if (command.replace) for (const cue of track.cues ?? []) touchCue(working, track.id, cue.id, cue);
      const incoming = command.cues.map((cue) => SubtitleCueSchema.parse({ ...cue, ...(command.provenance !== undefined && cue.provenance === undefined ? { provenance: command.provenance } : {}) }));
      for (const cue of incoming) {
        if (kept.some((candidate) => candidate.id === cue.id)) throw new TimelineOperationRefused(`subtitle id ${cue.id} is already on the track`);
        assertNewCueId(working, cue.id);
        touchCue(working, track.id, cue.id, null);
      }
      replaceTrackCues(working, track.id, [...kept, ...incoming]);
      return;
    }
    case "set-subtitle-style": {
      const track = subtitleTrack(working, command.trackId);
      touchTrack(working, track, trackProps(track));
      const style = SubtitleStyleSchema.parse({ ...(track.style ?? DEFAULT_SUBTITLE_STYLE), ...command.style });
      working.tracks = working.tracks.map((candidate) => (candidate.id === track.id ? { ...candidate, style } : candidate));
      return;
    }
  }
}

/**
 * Apply a batch as one action (R-24): every command succeeds or the input record is returned
 * unchanged by way of a refusal. The history entry records the net change per clip, so a clip
 * moved twice in one request undoes in one step.
 */
export function applyTimelineCommands(
  timeline: ProductionTimeline,
  commands: readonly TimelineClipCommand[],
  options: {
    label?: string;
    requestId?: string;
    selections?: readonly TimelineSelectionChange[];
    /** Measured source lengths, so a tail trim cannot reach past what a source can supply. */
    sourceLength?: SourceLengthFrames;
    /** Live sources supplied by the coordinator while its write gate is held. */
    sources?: Working["sources"];
    /** What this action did, for the record that explains it (Arke's assembly). */
    notes?: readonly string[];
  } = {},
): ProductionTimeline {
  const working: Working = {
    timeline,
    sources: options.sources,
    tracks: timeline.tracks,
    mix: timeline.mix,
    library: timeline.library,
    sourceLength: options.sourceLength ?? (() => undefined),
    touched: new Map(),
    touchedTracks: new Map(),
    touchedCues: new Map(),
  };
  for (const command of commands) applyClipCommand(working, command);

  const clips: TimelineClipChange[] = [];
  for (const [clipId, { trackId, before }] of working.touched) {
    const after = working.tracks.find((track) => track.id === trackId)?.clips.find((clip) => clip.id === clipId) ?? null;
    if (sameClip(before, after)) continue;
    clips.push({ trackId, before, after });
  }
  const tracks: TimelineTrackChange[] = [];
  for (const [trackId, { kind, before }] of working.touchedTracks) {
    const track = working.tracks.find((candidate) => candidate.id === trackId);
    const after = track === undefined ? null : trackProps(track);
    if (canonical(before) === canonical(after)) continue;
    tracks.push({ trackId, kind, before, after });
  }
  const cues: TimelineCueChange[] = [];
  for (const [cueId, { trackId, before }] of working.touchedCues) {
    const after = working.tracks.find((track) => track.id === trackId)?.cues?.find((cue) => cue.id === cueId) ?? null;
    if (canonical(before) === canonical(after)) continue;
    cues.push({ trackId, before, after });
  }
  const mix = canonical(working.mix) === canonical(timeline.mix) ? undefined : { before: timeline.mix, after: working.mix };
  const library = canonical(working.library) === canonical(timeline.library) ? undefined : { before: timeline.library, after: working.library };
  const selections = [...(options.selections ?? [])].filter((change) => canonical(change.before) !== canonical(change.after));
  if (clips.length === 0 && selections.length === 0 && tracks.length === 0 && cues.length === 0 && mix === undefined && library === undefined) {
    throw new TimelineOperationRefused("the command changes nothing");
  }

  const label = options.label ?? (commands.length === 1 ? describeTimelineCommand(commands[0]!) : `${commands.length} edits`);
  const entry: TimelineChangeHistoryEntry = {
    kind: "change",
    label: label.slice(0, 160),
    clips,
    selections,
    tracks,
    cues,
    ...(mix !== undefined ? { mix } : {}),
    ...(library !== undefined ? { library } : {}),
    ...(options.requestId !== undefined ? { requestId: options.requestId } : {}),
    ...(options.notes !== undefined && options.notes.length > 0 ? { notes: options.notes.map((note) => note.slice(0, 200)).slice(0, 8) } : {}),
  };
  return {
    ...timeline,
    revision: nextRevision(timeline),
    tracks: working.tracks,
    mix: working.mix,
    library: working.library,
    history: { undo: bounded([...timeline.history.undo, entry]), redo: [] },
  };
}

/** Move one Picture clip exactly one temporal position; a successful move is one revision and one undo entry. */
export function movePictureClip(
  timeline: ProductionTimeline,
  clipId: TimelineClipId,
  direction: TimelineMoveDirection,
): ProductionTimeline {
  const track = timeline.tracks.find((candidate) => candidate.clips.some((clip) => clip.id === clipId));
  if (track !== undefined && track.kind !== "picture") throw new TimelineOperationRefused(`${clipId} is not on a Picture track`);
  return applyTimelineCommands(timeline, [{ kind: "move-adjacent", clipId, direction }]);
}

// ---------------------------------------------------------------------------
// Undo and Redo (R-25..R-27)
// ---------------------------------------------------------------------------

function replayMove(
  tracks: readonly TimelineTrack[],
  entry: TimelineMoveHistoryEntry,
  phase: "undo" | "redo",
): TimelineTrack[] {
  const track = tracks.find((candidate) => candidate.id === entry.trackId);
  if (track?.kind !== "picture") throw new TimelineOperationRefused(`Picture track ${entry.trackId} is unavailable`);
  const clips = orderedTrackClips(track);
  const clipIndex = clips.findIndex((clip) => clip.id === entry.clipId);
  const otherIndex = clips.findIndex((clip) => clip.id === entry.swappedWithClipId);
  if (clipIndex < 0 || otherIndex < 0 || Math.abs(clipIndex - otherIndex) !== 1) {
    throw new TimelineOperationRefused("saved move history no longer names adjacent clips");
  }
  const clipShouldBeBefore = phase === "undo" ? entry.direction === "earlier" : entry.direction === "later";
  if ((clipIndex < otherIndex) !== clipShouldBeBefore) {
    throw new TimelineOperationRefused(`saved move history is not in its ${phase} position`);
  }
  const swapped = swapAdjacent(clips, clipIndex, otherIndex);
  return tracks.map((candidate) => (candidate.id === track.id ? { ...candidate, clips: swapped } : candidate));
}

/**
 * Put every clip a change entry names back to the side asked for, refusing if the timeline does
 * not currently read as the other side. Exactness is the whole point: an undo that "mostly"
 * matches would be a new edit wearing history's name.
 */
function replayChange(
  tracks: readonly TimelineTrack[],
  entry: TimelineChangeHistoryEntry,
  phase: "undo" | "redo",
): TimelineTrack[] {
  let next = tracks.map((track) => ({ ...track, clips: [...track.clips] }));
  // A track comes back before the clips it held are put back, and goes only once they are gone:
  // an addition undone is applied after the clip changes, a removal undone before them.
  const applyTracks = (predicate: (change: TimelineTrackChange) => boolean): void => {
    for (const change of entry.tracks.filter(predicate)) {
      const expected = phase === "undo" ? change.after : change.before;
      const target = phase === "undo" ? change.before : change.after;
      const current = next.find((track) => track.id === change.trackId);
      if (canonical(current === undefined ? null : trackProps(current)) !== canonical(expected)) {
        throw new TimelineOperationRefused(`saved history is not in its ${phase} position for track ${change.trackId}`);
      }
      if (target === null) {
        if (current !== undefined && (current.clips.length > 0 || (current.cues ?? []).length > 0)) {
          throw new TimelineOperationRefused(`track ${change.trackId} still holds clips`);
        }
        next = next.filter((track) => track.id !== change.trackId);
      } else if (current === undefined) {
        next = [...next, { id: change.trackId, kind: change.kind, ...target, clips: [], ...(change.kind === "subtitle" ? { cues: [] } : {}) }];
      } else {
        // Rebuilt from the recorded properties rather than spread over the live ones, so a
        // property the other side did not have (a remembered end) is gone and not carried.
        next = next.map((track) =>
          track.id === change.trackId ? { id: track.id, kind: track.kind, ...target, clips: track.clips, ...(track.cues !== undefined ? { cues: track.cues } : {}) } : track,
        );
      }
    }
  };
  applyTracks((change) => (phase === "undo" ? change.before : change.after) !== null);
  for (const change of entry.clips) {
    const expected = phase === "undo" ? change.after : change.before;
    const target = phase === "undo" ? change.before : change.after;
    const track = next.find((candidate) => candidate.id === change.trackId);
    if (track === undefined) throw new TimelineOperationRefused(`track ${change.trackId} named by history is unavailable`);
    const clipId = (change.before ?? change.after)!.id;
    const current = track.clips.find((clip) => clip.id === clipId) ?? null;
    if (!sameClip(current, expected)) {
      throw new TimelineOperationRefused(`saved history is not in its ${phase} position for ${clipId}`);
    }
    const clips = track.clips.filter((clip) => clip.id !== clipId);
    if (target !== null) clips.push(target);
    next = next.map((candidate) => (candidate.id === track.id ? { ...candidate, clips: orderedTrackClips({ clips }) } : candidate));
  }
  for (const change of entry.cues) {
    const expected = phase === "undo" ? change.after : change.before;
    const target = phase === "undo" ? change.before : change.after;
    const track = next.find((candidate) => candidate.id === change.trackId);
    if (track === undefined) throw new TimelineOperationRefused(`track ${change.trackId} named by history is unavailable`);
    const cueId = (change.before ?? change.after)!.id;
    const current = (track.cues ?? []).find((cue) => cue.id === cueId) ?? null;
    if (canonical(current) !== canonical(expected)) {
      throw new TimelineOperationRefused(`saved history is not in its ${phase} position for subtitle ${cueId}`);
    }
    const cues = (track.cues ?? []).filter((cue) => cue.id !== cueId);
    if (target !== null) cues.push(target);
    next = next.map((candidate) => (candidate.id === track.id ? { ...candidate, cues: orderedCues(cues) } : candidate));
  }
  applyTracks((change) => (phase === "undo" ? change.before : change.after) === null);
  for (const track of next) {
    const overlaps = trackOverlaps(orderedTrackClips(track));
    if (overlaps.length > 0) throw new TimelineOperationRefused(overlaps[0]!);
    const cueProblems = cueOverlaps(track.cues ?? []);
    if (cueProblems.length > 0) throw new TimelineOperationRefused(cueProblems[0]!);
  }
  return next;
}

function replayMix(mix: MixSettings, entry: TimelineHistoryEntry, phase: "undo" | "redo"): MixSettings {
  if (entry.kind !== "change" || entry.mix === undefined) return mix;
  const expected = phase === "undo" ? entry.mix.after : entry.mix.before;
  if (canonical(mix) !== canonical(expected)) throw new TimelineOperationRefused(`saved history is not in its ${phase} position for the mix`);
  return phase === "undo" ? entry.mix.before : entry.mix.after;
}

function replayLibrary(library: readonly TimelineLibraryItem[], entry: TimelineHistoryEntry, phase: "undo" | "redo"): TimelineLibraryItem[] {
  if (entry.kind !== "change" || entry.library === undefined) return [...library];
  const expected = phase === "undo" ? entry.library.after : entry.library.before;
  if (canonical(library) !== canonical(expected)) throw new TimelineOperationRefused(`saved history is not in its ${phase} position for the library`);
  return phase === "undo" ? [...entry.library.before] : [...entry.library.after];
}

function replayEntry(tracks: readonly TimelineTrack[], entry: TimelineHistoryEntry, phase: "undo" | "redo"): TimelineTrack[] {
  return entry.kind === "move" ? replayMove(tracks, entry, phase) : replayChange(tracks, entry, phase);
}

/** Whether the saved stack replays from the record it sits beside, and where it stops if not. */
function replayProblem(timeline: ProductionTimeline, stack: "undo" | "redo"): { index: number; message: string } | null {
  let tracks: readonly TimelineTrack[] = timeline.tracks;
  let mix = timeline.mix;
  let library: readonly TimelineLibraryItem[] = timeline.library;
  for (let index = timeline.history[stack].length - 1; index >= 0; index -= 1) {
    try {
      const entry = timeline.history[stack][index]!;
      tracks = replayEntry(tracks, entry, stack);
      mix = replayMix(mix, entry, stack);
      library = replayLibrary(library, entry, stack);
    } catch (error) {
      if (error instanceof TimelineOperationRefused) {
        return { index, message: `saved history is not replayable from its ${stack} position: ${error.reason}` };
      }
      throw error;
    }
  }
  return null;
}

/**
 * The selection writes an entry asks for in `phase`, oriented so the caller always writes
 * `after`: undoing restores what the switch replaced, redoing reinstates what it chose.
 */
export function historySelectionChanges(entry: TimelineHistoryEntry, phase: "undo" | "redo"): TimelineSelectionChange[] {
  if (entry.kind !== "change") return [];
  return entry.selections.map((change) =>
    phase === "redo" ? change : { shotId: change.shotId, before: change.after, after: change.before },
  );
}

export function undoTimelineHistory(timeline: ProductionTimeline): ProductionTimeline {
  const entry = timeline.history.undo.at(-1);
  if (entry === undefined) throw new TimelineOperationRefused("timeline has nothing to undo");
  return {
    ...timeline,
    revision: nextRevision(timeline),
    tracks: replayEntry(timeline.tracks, entry, "undo"),
    mix: replayMix(timeline.mix, entry, "undo"),
    library: replayLibrary(timeline.library, entry, "undo"),
    history: { undo: timeline.history.undo.slice(0, -1), redo: bounded([...timeline.history.redo, entry]) },
  };
}

export function redoTimelineHistory(timeline: ProductionTimeline): ProductionTimeline {
  const entry = timeline.history.redo.at(-1);
  if (entry === undefined) throw new TimelineOperationRefused("timeline has nothing to redo");
  return {
    ...timeline,
    revision: nextRevision(timeline),
    tracks: replayEntry(timeline.tracks, entry, "redo"),
    mix: replayMix(timeline.mix, entry, "redo"),
    library: replayLibrary(timeline.library, entry, "redo"),
    history: { undo: bounded([...timeline.history.undo, entry]), redo: timeline.history.redo.slice(0, -1) },
  };
}

/** The first slice's names, kept for its callers. */
export const undoPictureMove = undoTimelineHistory;
export const redoPictureMove = redoTimelineHistory;

/**
 * The source lengths a production knows (SPEC-013 R-5a): a pass segment's planned range, a
 * measured take, a measured artifact. Anything unmeasured is unknown and bounds nothing.
 */
export function sourceLengthFramesFor(
  production: ProductionBundle,
  artifacts: ReadonlyArray<{ id: string; mediaInfo?: { durationSec: number } }>,
): SourceLengthFrames {
  const frameRate = productionFrameRate(production.meta);
  const takesById = new Map(production.takes.map((take) => [take.id, take] as const));
  const measured = (takeId: string): number | undefined => {
    const seconds = production.takeMediaInfo[takeId]?.mediaInfo.durationSec;
    return seconds === undefined ? undefined : secondsToFrames(seconds, frameRate);
  };
  return (clip) => {
    if (clip.source.kind === "artifact") {
      const seconds = artifacts.find((artifact) => artifact.id === (clip.source.kind === "artifact" ? clip.source.artifactId : ""))?.mediaInfo?.durationSec;
      return seconds === undefined ? undefined : secondsToFrames(seconds, frameRate);
    }
    if (clip.source.kind === "performance") {
      const id = clip.source.performanceId;
      const seconds = production.performances.find(p => p.id === id)?.provenance.outputTechnical.durationSec;
      return seconds == null ? undefined : secondsToFrames(seconds, frameRate);
    }
    if (clip.source.kind === "take") {
      const take = takesById.get(clip.source.takeId);
      const offset = clip.source.offsetSec ?? 0;
      if (!take?.segment) {
        const whole = production.takeMediaInfo[clip.source.takeId]?.mediaInfo.durationSec;
        return whole === undefined ? undefined : Math.max(0, secondsToFrames(whole - offset, frameRate));
      }
      const segment = take.segment;
      const physical = production.takeMediaInfo[segment.passTakeId]?.mediaInfo.durationSec;
      return Math.max(0, secondsToFrames(Math.min(segment.outSec, physical ?? segment.outSec) - segment.inSec - offset, frameRate));
    }
    const takeId = production.selections[clip.source.shotId]?.acceptedTakeId ?? null;
    const take = takeId === null ? undefined : takesById.get(takeId);
    if (take === undefined) return undefined;
    // The selection's own in-point has already consumed the head (round nine): rendering starts
    // there, so the tail can only grow into what the source has left after it.
    const trim = production.selections[clip.source.shotId]?.trimInSec ?? 0;
    if (take.segment !== undefined) return Math.max(1, secondsToFrames(take.segment.outSec - take.segment.inSec - trim, frameRate));
    const whole = measured(take.id);
    return whole === undefined ? undefined : Math.max(1, whole - secondsToFrames(trim, frameRate));
  };
}

// ---------------------------------------------------------------------------
// Story drift (R-4, D7): named, never blocking
// ---------------------------------------------------------------------------

export interface StoryOrderDrift {
  /** The base Picture track's shot order no longer matches scene and shot order. */
  reordered: boolean;
  /** Story shots the timeline no longer plays. */
  missing: string[];
  /** Shots the timeline plays more than once. */
  repeated: string[];
}

export function storyOrderDrift(production: ProductionBundle, timeline: ProductionTimeline): StoryOrderDrift {
  const story = orderedStoryShots(production).map(({ shot }) => shot.id);
  const base = basePictureTrack(timeline);
  const played = base === null ? [] : orderedTrackClips(base).flatMap((clip) => (clip.source.kind === "shot" ? [clip.source.shotId] : []));
  const counts = new Map<string, number>();
  for (const shotId of played) counts.set(shotId, (counts.get(shotId) ?? 0) + 1);
  // Compared on first appearances only, so a repeat is reported as a repeat and not also as a
  // reorder, and a deleted shot is reported as missing rather than shifting everything after it.
  const storyIndex = new Map(story.map((shotId, index) => [shotId, index] as const));
  const firstAppearances = [...new Set(played)].filter((shotId) => storyIndex.has(shotId));
  const reordered = firstAppearances.some(
    (shotId, index) => index > 0 && storyIndex.get(shotId)! < storyIndex.get(firstAppearances[index - 1]!)!,
  );
  return {
    reordered,
    missing: story.filter((shotId) => !counts.has(shotId)),
    repeated: [...counts].filter(([, count]) => count > 1).map(([shotId]) => shotId),
  };
}

// ---------------------------------------------------------------------------
// Resolution: the DerivedCut compatibility path
// ---------------------------------------------------------------------------

export interface ResolvedPictureEntry extends CutEntry {
  /** Present only when a saved timeline, rather than legacy derivation, owns this entry. */
  clipId?: TimelineClipId;
  /** Empty timeline space between clips: no shot asked for it, so it is black rather than a slate. */
  hole?: boolean;
}

/** Structurally compatible with DerivedCut so existing preview and export builders can consume it. */
export interface ResolvedPictureCut extends Omit<DerivedCut, "entries"> {
  entries: ResolvedPictureEntry[];
}

/** Resolve saved Picture order, or preserve the exact legacy derivation when timeline.json is absent. */
export function resolvePictureTimeline(
  production: ProductionBundle,
  state: TimelineState | undefined,
  artifacts: readonly { id: string; file: string; kind: string }[] = [],
): ResolvedPictureCut {
  if (state === undefined || state.status === "absent") return deriveCut(production);
  if (state.status === "invalid") throw new TimelineOperationRefused(state.message);
  const frameRate = productionFrameRate(production.meta);
  if (state.timeline.frameRate !== frameRate) {
    throw new TimelineOperationRefused(
      `timeline is fixed at ${state.timeline.frameRate} fps but production.json says ${frameRate} fps; conform the timeline before changing its clock`,
    );
  }

  const base = basePictureTrack(state.timeline);
  const clips = base === null ? [] : orderedTrackClips(base);

  const derived = deriveCut(production);
  const shotKey = (entry: CutEntry) => `${entry.sceneNumber}:${entry.shot.number}:${entry.shot.id}`;
  const storyShots = new Set(derived.entries.map(shotKey));
  const byShotId = new Map<string, CutEntry[]>();
  for (const entry of derived.entries) {
    const candidates = byShotId.get(entry.shot.id) ?? [];
    candidates.push(entry);
    byShotId.set(entry.shot.id, candidates);
  }
  const entries: ResolvedPictureEntry[] = [];
  let cursor = 0;
  for (const clip of clips) {
    if (clip.startFrame > cursor) {
      const durationSec = framesToSeconds(clip.startFrame - cursor, frameRate);
      entries.push({
        clipId: clip.id,
        hole: true,
        sceneNumber: 0,
        shot: { id: `hole_${cursor}`, number: 0, title: "empty", description: "", durationSec },
        takeId: null,
        take: null,
        media: null,
        durationSec,
        label: `EMPTY · ${formatFrames(clip.startFrame - cursor, frameRate)}`,
      });
    }
    cursor = clipEnd(clip);
    const durationSec = framesToSeconds(clip.durationFrames, frameRate);
    if (clip.source.kind !== "shot") {
      const source = clip.source;
      const artifact = source.kind === "artifact" ? artifacts.find(item => item.id === source.artifactId) : undefined;
      const take = source.kind === "take" ? production.takes.find(item => item.id === source.takeId) : undefined;
      const pass = take?.segment ? production.takes.find(item => item.id === take.segment!.passTakeId) : take;
      // Imported picture is playable footage, with no synthetic shot to fill or generate.
      const media: CutEntry["media"] = artifact && ["video", "image", "board"].includes(artifact.kind)
        ? { path: `artifacts/${artifact.file}`, inSec: framesToSeconds(clip.sourceInFrames, frameRate) }
        : pass?.media ? { path: `productions/${production.meta.id}/takes/${pass.id}/${pass.media}`,
          inSec: (take?.segment?.inSec ?? 0) + (source.kind === "take" ? source.offsetSec ?? 0 : 0) + framesToSeconds(clip.sourceInFrames, frameRate),
          ...(take?.segment ? { outSec: take.segment.outSec } : {}) } : null;
      entries.push({
        clipId: clip.id,
        sceneNumber: 0,
        shot: { id: clip.id, number: 0, title: clip.source.label, description: "", durationSec },
        takeId: media && take ? take.id : null,
        take: media ? take ?? null : null,
        media,
        durationSec,
        label: clip.source.label,
      });
      continue;
    }
    const source = clip.source;
    const candidates = byShotId.get(source.shotId) ?? [];
    const exact = candidates.filter(
      (candidate) =>
        candidate.sceneNumber === source.sceneNumber && candidate.shot.number === source.shotNumber,
    );
    // Scene and shot numbers disambiguate legacy duplicate ids. A unique id remains resolvable
    // after story renumbering; more than one plausible source is a gap rather than a refusal.
    const entry = exact.length === 1 ? exact[0] : candidates.length === 1 ? candidates[0] : undefined;
    if (entry === undefined) {
      const reason = candidates.length === 0 ? "MISSING" : "AMBIGUOUS";
      entries.push({
        clipId: clip.id,
        sceneNumber: source.sceneNumber,
        shot: {
          id: source.shotId,
          number: source.shotNumber,
          title: source.label,
          description: "",
          durationSec,
        },
        takeId: null,
        take: null,
        media: null,
        durationSec,
        label: `${reason} SHOT ${source.shotNumber} · ${source.label}`,
      });
      continue;
    }
    const sourceInSec = framesToSeconds(clip.sourceInFrames, frameRate);
    let media = entry.media;
    if (media !== null && sourceInSec > 0) {
      const inSec = (media.inSec ?? 0) + sourceInSec;
      // Trimmed past the far side of its source, the clip has nothing left to play and is a gap.
      media = media.outSec !== undefined && inSec >= media.outSec ? null : { ...media, inSec };
    }
    entries.push({ ...entry, clipId: clip.id, media, takeId: media === null ? null : entry.takeId, take: media === null ? null : entry.take, durationSec });
  }
  const end = base === null ? 0 : trackEndFrame(base);
  if (end > cursor) {
    // The hole a deleted last clip left: timeline the track still reaches, with nothing on it.
    const durationSec = framesToSeconds(end - cursor, frameRate);
    entries.push({
      clipId: `cl_end`,
      hole: true,
      sceneNumber: 0,
      shot: { id: `hole_${cursor}`, number: 0, title: "empty", description: "", durationSec },
      takeId: null,
      take: null,
      media: null,
      durationSec,
      label: `EMPTY · ${formatFrames(end - cursor, frameRate)}`,
    });
  }
  const gaps = entries.filter((entry) => entry.media === null && entry.hole !== true);
  return {
    entries,
    // Split and duplicate make more clips, not more covered shots.
    covered: new Set(entries.filter((entry) => entry.takeId !== null && storyShots.has(shotKey(entry))).map(shotKey)).size,
    gaps: gaps.length,
    totalSec: entries.reduce((total, entry) => total + entry.durationSec, 0),
    uncoveredSec: gaps.reduce((total, entry) => total + entry.durationSec, 0),
  };
}

/** Track identity is independent of its audio role (SPEC-043). */
export function newAudioTrack(timeline: ProductionTimeline): Extract<TimelineClipCommand, { kind: "add-track" }> {
  let number = 1;
  while (timeline.tracks.some(track => track.id === `tr_audio-${number}` || track.name === `Audio ${number}`)) number++;
  return { kind: "add-track", trackId: `tr_audio-${number}`, trackKind: "audio", name: `Audio ${number}` };
}

/** Detachment freezes embedded sound only; external performances and master bindings stay put. */
export function detachAudioCommands(production: ProductionBundle, timeline: ProductionTimeline,
  artifacts: readonly ArtifactSidecar[], clipId: TimelineClipId, newClipId: TimelineClipId): TimelineClipCommand[] {
  const track = timeline.tracks.find(candidate => candidate.clips.some(clip => clip.id === clipId));
  const clip = track?.clips.find(candidate => candidate.id === clipId);
  if (!clip || track?.kind !== "picture") throw new TimelineOperationRefused("Select a video clip to detach its audio");
  if (clip.audio === "mute") throw new TimelineOperationRefused("This picture's embedded audio is already muted");
  let source = clip.source;
  const sourceInFrames = clip.sourceInFrames;
  let measured: { hasAudio: boolean } | undefined;
  if (source.kind === "artifact") {
    const resolved = resolveProductionArtifact(artifacts, source.artifactId, production.meta.id);
    if (!resolved.ok) throw new TimelineOperationRefused(`${clip.id} cites ${resolved.reason}`);
    const artifact = resolved.artifact;
    if (artifact.kind !== "video") throw new TimelineOperationRefused("This clip has no embedded video audio");
    measured = artifact.mediaInfo;
  } else if (source.kind === "take" || source.kind === "shot") {
    let takeId = source.kind === "take" ? source.takeId : production.selections[source.shotId]?.acceptedTakeId;
    const offsetSec = source.kind === "take" ? source.offsetSec : production.selections[source.shotId]?.trimInSec;
    if (source.kind === "shot") {
      // Freeze the actually resolved take. Selection trims may be finer than a frame, so
      // preserve their exact seconds in the source and keep subsequent frame edits separate.
      const resolved = resolvePictureTimeline(production, { status: "ready", timeline }).entries.find(entry => entry.clipId === clip.id && !entry.hole);
      takeId = resolved?.takeId ?? undefined;
    }
    const take = production.takes.find(candidate => candidate.id === takeId);
    const pass = take?.segment ? production.takes.find(candidate => candidate.id === take.segment!.passTakeId) : take;
    if (!take || !pass?.media) throw new TimelineOperationRefused("The video's source is missing");
    measured = production.takeMediaInfo[pass.id]?.mediaInfo;
    source = { kind: "take", takeId: take.id, label: clip.source.label, ...(offsetSec ? { offsetSec } : {}) };
  } else throw new TimelineOperationRefused("This source is already independent performance audio");
  if (!measured) throw new TimelineOperationRefused("Measure the video before detaching its audio");
  if (!measured.hasAudio) throw new TimelineOperationRefused("This video has no audio stream");
  const destination = timeline.tracks.find(candidate => AUDIO_TRACK_KINDS.has(candidate.kind) && !candidate.muted && candidate.solo !== true &&
    !candidate.clips.some(other => other.startFrame < clip.startFrame + clip.durationFrames && other.startFrame + other.durationFrames > clip.startFrame));
  const added = destination ? null : newAudioTrack(timeline);
  const sound: TimelineClip = {
    id: newClipId, startFrame: clip.startFrame, durationFrames: clip.durationFrames, sourceInFrames,
    source, gainDb: clip.gainDb ?? 0, role: destination?.defaultRole ?? "unspecified",
  };
  return [
    ...(added ? [added] : []),
    { kind: "place", trackId: destination?.id ?? added!.trackId, clip: sound },
    { kind: "set-clip-audio", clipId, audio: "mute" },
  ];
}
