import { z } from "zod";
import type { ProductionBundle } from "./client-state.js";
import { deriveCut, type CutEntry, type DerivedCut } from "./cut.js";
import { ArtifactIdSchema, ShotIdSchema, TakeIdSchema } from "./ids.js";
import { orderedShots } from "./scene-flow.js";
import { ShotSelectionSchema, sortScenes } from "./scene.js";
import { FrameRateSchema, productionFrameRate, type FrameRate } from "./world.js";

/** The saved timeline's complete track vocabulary. Only Picture behavior is implemented here. */
export const TimelineTrackKindSchema = z.enum(["picture", "dialogue", "ambience", "music", "subtitle"]);
export type TimelineTrackKind = z.infer<typeof TimelineTrackKindSchema>;

export type TimelineTrackId = `tr_${string}`;
export type TimelineClipId = `cl_${string}`;
export const TimelineSourceFingerprintSchema = z.string().regex(/^story-picture-v1:[0-9a-f]{16}$/);

export const TimelineTrackIdSchema = z
  .string()
  .regex(/^tr_[A-Za-z0-9][A-Za-z0-9_-]*$/, "expected a tr_<stable-id> id") as z.ZodType<TimelineTrackId>;
export const TimelineClipIdSchema = z
  .string()
  .regex(/^cl_[A-Za-z0-9][A-Za-z0-9_-]*$/, "expected a cl_<stable-id> id") as z.ZodType<TimelineClipId>;

const WholeFrameSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const DurationFramesSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

/**
 * What a clip plays. A shot resolves through its current accepted take at read time (SPEC-037
 * R-12, D4), so a take switch never rewrites the timeline; a take or an artifact is named
 * directly because nothing else decides what they are.
 */
export const TimelineClipSourceSchema = z.discriminatedUnion("kind", [
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
  z.object({ kind: z.literal("take"), takeId: TakeIdSchema, label: z.string().min(1) }).strict(),
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
    clips: z.array(TimelineClipSchema),
  })
  .strict();
export type TimelineTrack = z.infer<typeof TimelineTrackSchema>;

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

/**
 * One completed action, whatever it did (R-24, D5). Recording the exact before and after of every
 * clip it touched is what lets Undo apply the exact inverse (R-25) without a second implementation
 * of every command, and what lets an accepted Arke request of several commands be one entry.
 */
export const TimelineChangeHistoryEntrySchema = z
  .object({
    kind: z.literal("change"),
    label: z.string().min(1).max(160),
    clips: z.array(TimelineClipChangeSchema).max(500),
    selections: z.array(TimelineSelectionChangeSchema).max(200).default([]),
    /** Present when the entry landed an Arke editor request (SPEC-039 R-30, R-36). */
    requestId: z.string().min(1).max(80).optional(),
  })
  .strict()
  .refine((entry) => entry.clips.length > 0 || entry.selections.length > 0, "a history entry must change something");
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
  })
  .strict()
  .superRefine((timeline, ctx) => {
    const trackIds = new Set<TimelineTrackId>();
    const trackOrders = new Set<number>();
    const clipIds = new Set<TimelineClipId>();

    for (const [trackIndex, track] of timeline.tracks.entries()) {
      if (trackIds.has(track.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tracks", trackIndex, "id"], message: "track ids must be unique" });
      }
      if (trackOrders.has(track.order)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tracks", trackIndex, "order"], message: "track order must be unique" });
      }
      trackIds.add(track.id);
      trackOrders.add(track.order);

      if (track.kind !== "picture" && track.clips.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tracks", trackIndex, "clips"],
          message: "shot-sourced clips belong on Picture tracks",
        });
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
  z.object({ status: z.literal("ready"), timeline: ProductionTimelineSchema }).strict(),
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
]);
export type TimelineCommand = z.infer<typeof TimelineCommandSchema>;
export type TimelineClipCommand = Exclude<TimelineCommand, { kind: "switch-take" }>;

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
  const frames = Math.round(seconds * frameRate);
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

const DEFAULT_SHOT_SEC = 4;
export const PICTURE_TRACK_ID: TimelineTrackId = "tr_picture";

function orderedStoryShots(production: ProductionBundle) {
  return sortScenes(production.scenes).flatMap((scene) =>
    orderedShots(scene).map((shot) => ({ sceneNumber: scene.number, shot })),
  );
}

function shotDurationFrames(durationSec: number | undefined, frameRate: FrameRate): number {
  return Math.max(1, secondsToFrames(durationSec ?? DEFAULT_SHOT_SEC, frameRate));
}

function sourceFingerprint(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `story-picture-v1:${hash.toString(16).padStart(16, "0")}`;
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

interface Working {
  tracks: TimelineTrack[];
  /** Every clip touched so far, keyed by id, with the state it had before the first touch. */
  touched: Map<TimelineClipId, { trackId: TimelineTrackId; before: TimelineClip | null }>;
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
  if (!working.touched.has(clipId)) working.touched.set(clipId, { trackId, before });
}

function replaceTrackClips(working: Working, trackId: TimelineTrackId, clips: TimelineClip[]): void {
  const overlaps = trackOverlaps(orderedTrackClips({ clips }));
  if (overlaps.length > 0) throw new TimelineOperationRefused(overlaps[0]!);
  for (const clip of clips) {
    if (clip.startFrame < 0 || clip.durationFrames < 1 || clip.sourceInFrames < 0) {
      throw new TimelineOperationRefused(`${clip.id} would leave the frame clock`);
    }
    if (!Number.isSafeInteger(clipEnd(clip))) throw new TimelineOperationRefused(`${clip.id} would overflow the frame clock`);
  }
  // Stored in play order so the file a person opens reads the way the track plays.
  const sorted = orderedTrackClips({ clips });
  working.tracks = working.tracks.map((track) => (track.id === trackId ? { ...track, clips: sorted } : track));
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
      replaceTrackClips(working, track.id, ordered.filter((candidate) => candidate.id !== clip.id));
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
      replaceTrackClips(working, track.id, shifted);
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
  options: { label?: string; requestId?: string; selections?: readonly TimelineSelectionChange[] } = {},
): ProductionTimeline {
  const working: Working = { tracks: timeline.tracks, touched: new Map() };
  for (const command of commands) applyClipCommand(working, command);

  const clips: TimelineClipChange[] = [];
  for (const [clipId, { trackId, before }] of working.touched) {
    const after = working.tracks.find((track) => track.id === trackId)?.clips.find((clip) => clip.id === clipId) ?? null;
    if (sameClip(before, after)) continue;
    clips.push({ trackId, before, after });
  }
  const selections = [...(options.selections ?? [])].filter((change) => canonical(change.before) !== canonical(change.after));
  if (clips.length === 0 && selections.length === 0) throw new TimelineOperationRefused("the command changes nothing");

  const label = options.label ?? (commands.length === 1 ? describeTimelineCommand(commands[0]!) : `${commands.length} edits`);
  const entry: TimelineChangeHistoryEntry = {
    kind: "change",
    label: label.slice(0, 160),
    clips,
    selections,
    ...(options.requestId !== undefined ? { requestId: options.requestId } : {}),
  };
  return {
    ...timeline,
    revision: nextRevision(timeline),
    tracks: working.tracks,
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
  for (const track of next) {
    const overlaps = trackOverlaps(orderedTrackClips(track));
    if (overlaps.length > 0) throw new TimelineOperationRefused(overlaps[0]!);
  }
  return next;
}

function replayEntry(tracks: readonly TimelineTrack[], entry: TimelineHistoryEntry, phase: "undo" | "redo"): TimelineTrack[] {
  return entry.kind === "move" ? replayMove(tracks, entry, phase) : replayChange(tracks, entry, phase);
}

/** Whether the saved stack replays from the record it sits beside, and where it stops if not. */
function replayProblem(timeline: ProductionTimeline, stack: "undo" | "redo"): { index: number; message: string } | null {
  let tracks: readonly TimelineTrack[] = timeline.tracks;
  for (let index = timeline.history[stack].length - 1; index >= 0; index -= 1) {
    try {
      tracks = replayEntry(tracks, timeline.history[stack][index]!, stack);
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
    history: { undo: bounded([...timeline.history.undo, entry]), redo: timeline.history.redo.slice(0, -1) },
  };
}

/** The first slice's names, kept for its callers. */
export const undoPictureMove = undoTimelineHistory;
export const redoPictureMove = redoTimelineHistory;

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
  const byShotId = new Map<string, CutEntry>();
  for (const entry of derived.entries) {
    if (byShotId.has(entry.shot.id)) {
      throw new TimelineOperationRefused(`derived story order contains duplicate shot ${entry.shot.id}`);
    }
    byShotId.set(entry.shot.id, entry);
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
      // Take- and artifact-sourced Picture clips are the render plan's business (SPEC-038); the
      // compatibility cut shows them as timed entries it cannot play rather than dropping time.
      entries.push({
        clipId: clip.id,
        sceneNumber: 0,
        shot: { id: clip.id, number: 0, title: clip.source.label, description: "", durationSec },
        takeId: null,
        take: null,
        media: null,
        durationSec,
        label: clip.source.label,
      });
      continue;
    }
    const entry = byShotId.get(clip.source.shotId);
    if (entry === undefined) {
      entries.push({
        clipId: clip.id,
        sceneNumber: clip.source.sceneNumber,
        shot: {
          id: clip.source.shotId,
          number: clip.source.shotNumber,
          title: clip.source.label,
          description: "",
          durationSec,
        },
        takeId: null,
        take: null,
        media: null,
        durationSec,
        label: `MISSING SHOT ${clip.source.shotNumber} · ${clip.source.label}`,
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
  const gaps = entries.filter((entry) => entry.takeId === null && entry.hole !== true);
  return {
    entries,
    covered: entries.filter((entry) => entry.takeId !== null).length,
    gaps: gaps.length,
    totalSec: entries.reduce((total, entry) => total + entry.durationSec, 0),
    uncoveredSec: gaps.reduce((total, entry) => total + entry.durationSec, 0),
  };
}
