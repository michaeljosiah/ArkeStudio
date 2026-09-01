import { z } from "zod";
import type { ProductionBundle } from "./client-state.js";
import { deriveCut, type CutEntry, type DerivedCut } from "./cut.js";
import { ShotIdSchema } from "./ids.js";
import { orderedShots } from "./scene-flow.js";
import { sortScenes } from "./scene.js";
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

export const TimelineClipSourceSchema = z
  .object({
    kind: z.literal("shot"),
    shotId: ShotIdSchema,
    /** Kept only so a later story deletion remains a labelled gap instead of blocking the edited cut. */
    sceneNumber: z.number().int().min(1),
    shotNumber: z.number().int().min(1),
    label: z.string().min(1),
  })
  .strict();
export type TimelineClipSource = z.infer<typeof TimelineClipSourceSchema>;

export const TimelineClipSchema = z
  .object({
    id: TimelineClipIdSchema,
    startFrame: WholeFrameSchema,
    durationFrames: DurationFramesSchema,
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

export const TIMELINE_HISTORY_LIMIT = 100;

export const TimelineHistorySchema = z
  .object({
    undo: z.array(TimelineMoveHistoryEntrySchema).max(TIMELINE_HISTORY_LIMIT),
    redo: z.array(TimelineMoveHistoryEntrySchema).max(TIMELINE_HISTORY_LIMIT),
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
    const tracks = new Map<TimelineTrackId, TimelineTrack>();

    for (const [trackIndex, track] of timeline.tracks.entries()) {
      if (trackIds.has(track.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tracks", trackIndex, "id"], message: "track ids must be unique" });
      }
      if (trackOrders.has(track.order)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tracks", trackIndex, "order"], message: "track order must be unique" });
      }
      trackIds.add(track.id);
      trackOrders.add(track.order);
      tracks.set(track.id, track);

      if (track.kind !== "picture" && track.clips.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tracks", trackIndex, "clips"],
          message: "shot-sourced clips belong on Picture tracks",
        });
      }

      const ordered = orderedClips(track);
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
      for (let index = 1; index < ordered.length; index++) {
        const previous = ordered[index - 1]!;
        const clip = ordered[index]!;
        if (clip.startFrame < previous.startFrame + previous.durationFrames) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["tracks", trackIndex, "clips"],
            message: `clips ${previous.id} and ${clip.id} overlap`,
          });
        }
      }
    }

    for (const stack of ["undo", "redo"] as const) {
      for (const [entryIndex, entry] of timeline.history[stack].entries()) {
        const track = tracks.get(entry.trackId);
        const ids = new Set(track?.clips.map((clip) => clip.id) ?? []);
        if (track === undefined || !ids.has(entry.clipId) || !ids.has(entry.swappedWithClipId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["history", stack, entryIndex],
            message: "move history must cite two clips on its saved track",
          });
        }
        if (entry.clipId === entry.swappedWithClipId) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["history", stack, entryIndex, "swappedWithClipId"],
            message: "a move must cite the adjacent clip it swapped with",
          });
        }
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
      const phase = stack === "undo" ? "undo" : "redo";
      const simulated = new Map(
        timeline.tracks.map((track) => [track.id, orderedClips(track)] as const),
      );
      for (let entryIndex = timeline.history[stack].length - 1; entryIndex >= 0; entryIndex -= 1) {
        const entry = timeline.history[stack][entryIndex]!;
        const clips = simulated.get(entry.trackId);
        if (clips === undefined) break;
        const clipIndex = clips.findIndex((clip) => clip.id === entry.clipId);
        const otherIndex = clips.findIndex((clip) => clip.id === entry.swappedWithClipId);
        const clipShouldBeBefore = phase === "undo" ? entry.direction === "earlier" : entry.direction === "later";
        if (
          clipIndex < 0 ||
          otherIndex < 0 ||
          Math.abs(clipIndex - otherIndex) !== 1 ||
          (clipIndex < otherIndex) !== clipShouldBeBefore
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["history", stack, entryIndex],
            message: `saved move history is not replayable from its ${phase} position`,
          });
          break;
        }
        try {
          simulated.set(entry.trackId, swapAdjacent(clips, clipIndex, otherIndex));
        } catch {
          break;
        }
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

function orderedClips(track: TimelineTrack): TimelineClip[] {
  return [...track.clips].sort(
    (a, b) => a.startFrame - b.startFrame || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

function nextRevision(timeline: ProductionTimeline): number {
  if (timeline.revision >= Number.MAX_SAFE_INTEGER) throw new TimelineOperationRefused("timeline revision is exhausted");
  return timeline.revision + 1;
}

function bounded(entries: TimelineMoveHistoryEntry[]): TimelineMoveHistoryEntry[] {
  return entries.slice(-TIMELINE_HISTORY_LIMIT);
}

/** Swap adjacent timeline windows without changing their combined range or either clip's duration. */
function swapAdjacent(clips: TimelineClip[], firstIndex: number, secondIndex: number): TimelineClip[] {
  const leftIndex = Math.min(firstIndex, secondIndex);
  if (Math.abs(firstIndex - secondIndex) !== 1) {
    throw new TimelineOperationRefused("a one-position move must swap adjacent clips");
  }
  const left = clips[leftIndex]!;
  const right = clips[leftIndex + 1]!;
  const gapFrames = right.startFrame - (left.startFrame + left.durationFrames);
  if (gapFrames < 0) throw new TimelineOperationRefused(`clips ${left.id} and ${right.id} overlap`);
  const swapped = [...clips];
  swapped[leftIndex] = { ...right, startFrame: left.startFrame };
  swapped[leftIndex + 1] = {
    ...left,
    startFrame: left.startFrame + right.durationFrames + gapFrames,
  };
  return swapped;
}

function withTrackClips(
  timeline: ProductionTimeline,
  trackId: TimelineTrackId,
  clips: TimelineClip[],
  history: TimelineHistory,
): ProductionTimeline {
  return {
    ...timeline,
    revision: nextRevision(timeline),
    tracks: timeline.tracks.map((track) => (track.id === trackId ? { ...track, clips } : track)),
    history,
  };
}

/** Move one Picture clip exactly one temporal position; a successful move is one revision and one undo entry. */
export function movePictureClip(
  timeline: ProductionTimeline,
  clipId: TimelineClipId,
  direction: TimelineMoveDirection,
): ProductionTimeline {
  const matches = timeline.tracks.filter((track) => track.clips.some((clip) => clip.id === clipId));
  if (matches.length !== 1) throw new TimelineOperationRefused(`timeline does not contain exactly one clip ${clipId}`);
  const track = matches[0]!;
  if (track.kind !== "picture") throw new TimelineOperationRefused(`${clipId} is not on a Picture track`);
  const clips = orderedClips(track);
  const fromIndex = clips.findIndex((clip) => clip.id === clipId);
  const toIndex = fromIndex + (direction === "earlier" ? -1 : 1);
  if (toIndex < 0 || toIndex >= clips.length) throw new TimelineOperationRefused(`${clipId} cannot move ${direction}`);
  const swappedWithClipId = clips[toIndex]!.id;
  const entry: TimelineMoveHistoryEntry = {
    kind: "move",
    trackId: track.id,
    clipId,
    swappedWithClipId,
    direction,
  };
  return withTrackClips(timeline, track.id, swapAdjacent(clips, fromIndex, toIndex), {
    undo: bounded([...timeline.history.undo, entry]),
    redo: [],
  });
}

function replayMove(
  timeline: ProductionTimeline,
  entry: TimelineMoveHistoryEntry,
  phase: "undo" | "redo",
): TimelineClip[] {
  const track = timeline.tracks.find((candidate) => candidate.id === entry.trackId);
  if (track?.kind !== "picture") throw new TimelineOperationRefused(`Picture track ${entry.trackId} is unavailable`);
  const clips = orderedClips(track);
  const clipIndex = clips.findIndex((clip) => clip.id === entry.clipId);
  const otherIndex = clips.findIndex((clip) => clip.id === entry.swappedWithClipId);
  if (clipIndex < 0 || otherIndex < 0 || Math.abs(clipIndex - otherIndex) !== 1) {
    throw new TimelineOperationRefused("saved move history no longer names adjacent clips");
  }
  const clipShouldBeBefore = phase === "undo" ? entry.direction === "earlier" : entry.direction === "later";
  if ((clipIndex < otherIndex) !== clipShouldBeBefore) {
    throw new TimelineOperationRefused(`saved move history is not in its ${phase} position`);
  }
  return swapAdjacent(clips, clipIndex, otherIndex);
}

export function undoPictureMove(timeline: ProductionTimeline): ProductionTimeline {
  const entry = timeline.history.undo.at(-1);
  if (entry === undefined) throw new TimelineOperationRefused("timeline has no move to undo");
  return withTrackClips(timeline, entry.trackId, replayMove(timeline, entry, "undo"), {
    undo: timeline.history.undo.slice(0, -1),
    redo: bounded([...timeline.history.redo, entry]),
  });
}

export function redoPictureMove(timeline: ProductionTimeline): ProductionTimeline {
  const entry = timeline.history.redo.at(-1);
  if (entry === undefined) throw new TimelineOperationRefused("timeline has no move to redo");
  return withTrackClips(timeline, entry.trackId, replayMove(timeline, entry, "redo"), {
    undo: bounded([...timeline.history.undo, entry]),
    redo: timeline.history.redo.slice(0, -1),
  });
}

export interface ResolvedPictureEntry extends CutEntry {
  /** Present only when a saved timeline, rather than legacy derivation, owns this entry. */
  clipId?: TimelineClipId;
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

  const pictureTracks = state.timeline.tracks.filter((track) => track.kind === "picture");
  if (pictureTracks.length > 1) {
    throw new TimelineOperationRefused("the DerivedCut compatibility path supports exactly one Picture track");
  }
  const clips = pictureTracks.length === 0 ? [] : orderedClips(pictureTracks[0]!);
  let expectedStart = 0;
  for (const clip of clips) {
    if (clip.startFrame !== expectedStart) {
      throw new TimelineOperationRefused("the DerivedCut compatibility path cannot collapse a timeline hole");
    }
    expectedStart += clip.durationFrames;
  }

  const derived = deriveCut(production);
  const byShotId = new Map<string, CutEntry>();
  for (const entry of derived.entries) {
    if (byShotId.has(entry.shot.id)) {
      throw new TimelineOperationRefused(`derived story order contains duplicate shot ${entry.shot.id}`);
    }
    byShotId.set(entry.shot.id, entry);
  }
  const entries = clips.map((clip): ResolvedPictureEntry => {
    const entry = byShotId.get(clip.source.shotId);
    if (entry === undefined) {
      const durationSec = framesToSeconds(clip.durationFrames, frameRate);
      return {
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
      };
    }
    return {
      ...entry,
      clipId: clip.id,
      durationSec: framesToSeconds(clip.durationFrames, frameRate),
    };
  });
  const gaps = entries.filter((entry) => entry.takeId === null);
  return {
    entries,
    covered: entries.length - gaps.length,
    gaps: gaps.length,
    totalSec: entries.reduce((total, entry) => total + entry.durationSec, 0),
    uncoveredSec: gaps.reduce((total, entry) => total + entry.durationSec, 0),
  };
}
