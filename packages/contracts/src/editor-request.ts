import { z } from "zod";
import { ConversationActionIdSchema, ConversationIdSchema, SceneIdSchema, ShotIdSchema, SlugSchema, TakeIdSchema } from "./ids.js";
import {
  PICTURE_TRACK_ID,
  TimelineClipIdSchema,
  TimelineCommandSchema,
  TimelineOperationRefused,
  TimelineSourceFingerprintSchema,
  TimelineTrackIdSchema,
  applyTimelineCommands,
  orderedTrackClips,
  type ProductionTimeline,
  type TimelineClip,
  type TimelineClipCommand,
  type TimelineCommand,
  type TimelineSelectionChange,
  type TimelineState,
} from "./timeline.js";

/**
 * Arke's editor requests (SPEC-039 §1.7, issue 684).
 *
 * A request is the one way the model reaches the timeline: exact typed commands against an exact
 * base, staged as a durable pending record, landed or discarded only by a person's visible
 * Accept or Reject. Conversational prose never creates, applies or rejects one — the model's
 * result carries the request in a typed field, the coordinator validates it against the live
 * base before it is written, and a card renders it in the person's terms.
 *
 * Operational records, not SPEC-004 proposals (R-35): they live beside the timeline they are
 * about, in one strict JSON file per production, and never appear in global Approvals.
 */

export const EDITOR_REQUEST_BOUNDS = {
  /** Requests one turn may prepare; a conversation that wants more says so over more turns. */
  perTurn: 2,
  commands: 50,
  summary: 500,
  /** How many records the file keeps; the oldest decided ones fall off the front. */
  kept: 200,
} as const;

export const EditorRequestIdSchema = z
  .string()
  .regex(/^req_[0-9A-HJKMNP-TV-Z]{26}$/, "an editor request id is req_ followed by a ULID");
export type EditorRequestId = z.infer<typeof EditorRequestIdSchema>;

export const EditorRequestStatusSchema = z.enum(["pending", "accepted", "rejected", "stale"]);
export type EditorRequestStatus = z.infer<typeof EditorRequestStatusSchema>;

/**
 * Arke's scene edits (SPEC-036 R-38).
 *
 * The model describes the edit in a typed field and the coordinator prepares a permission card
 * against the exact scene version the model saw. Approval lands it through the same version-fenced
 * `edit-scene` write the header uses. Only in a scene thread, only that scene.
 */
export const SCENE_EDIT_BOUNDS = {
  /** Edits one turn may carry; a rename is one, and nothing else is offered yet. */
  perTurn: 1,
  title: 200,
} as const;

export const ModelSceneEditSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("rename"),
      /** The name as it should read in the header. Whitespace is not a name. */
      title: z.string().trim().min(1).max(SCENE_EDIT_BOUNDS.title),
    })
    .strict(),
]);
export type ModelSceneEdit = z.infer<typeof ModelSceneEditSchema>;

// Live-source detachment is a direct editor action; request ghosts cannot resolve it.
type PreviewableCommandOption = Exclude<(typeof TimelineCommandSchema.options)[number], { shape: { kind: z.ZodLiteral<"detach-audio"> } }>;
const EditorRequestCommandSchema = z.discriminatedUnion("kind", TimelineCommandSchema.options.filter(
  (option): option is PreviewableCommandOption => option.shape.kind.value !== "detach-audio",
) as [PreviewableCommandOption, ...PreviewableCommandOption[]]);

/** What the model returns: a summary in the person's terms and the exact commands (R-27, R-34). */
export const ModelEditorRequestSchema = z
  .object({
    summary: z.string().min(1).max(EDITOR_REQUEST_BOUNDS.summary),
    commands: z.array(EditorRequestCommandSchema).min(1).max(EDITOR_REQUEST_BOUNDS.commands),
  })
  .strict();
export type ModelEditorRequest = z.infer<typeof ModelEditorRequestSchema>;

/** The durable record (R-28). Model output cannot touch it after creation; only a decision moves its status. */
export const EditorRequestSchema = z
  .object({
    id: EditorRequestIdSchema,
    productionId: SlugSchema,
    conversationId: ConversationIdSchema,
    /** Conversation permission action that prepared this record; absent on older records. */
    actionId: ConversationActionIdSchema.optional(),
    /** The revision the commands were prepared against; null when they would materialise the first assembly. */
    baseRevision: z.number().int().min(0).nullable(),
    sourceFingerprint: TimelineSourceFingerprintSchema,
    commands: z.array(EditorRequestCommandSchema).min(1).max(EDITOR_REQUEST_BOUNDS.commands),
    summary: z.string().min(1).max(EDITOR_REQUEST_BOUNDS.summary),
    createdAt: z.string().min(1),
    status: EditorRequestStatusSchema,
    decidedAt: z.string().min(1).optional(),
    /** The revision Accept produced (R-30); that revision's history entry carries this id. */
    resultRevision: z.number().int().min(1).optional(),
    /** Why the request went stale, in the coordinator's words (R-32). */
    reason: z.string().max(300).optional(),
    /** When the accepted revision was undone (R-36); cleared again by Redo. The status stays accepted. */
    undoneAt: z.string().min(1).optional(),
  })
  .strict();
export type EditorRequest = z.infer<typeof EditorRequestSchema>;

/** `productions/<id>/editor-requests.json`. */
export const EditorRequestFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    requests: z.array(EditorRequestSchema).max(EDITOR_REQUEST_BOUNDS.kept),
  })
  .strict();
export type EditorRequestFile = z.infer<typeof EditorRequestFileSchema>;

/** What the person has selected while they talk to Arke (R-26): the subject of "this". */
export const WorldChatSubjectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("timeline-clip"), clipId: TimelineClipIdSchema }).strict(),
  z.object({ kind: z.literal("timeline-track"), trackId: TimelineTrackIdSchema }).strict(),
  z.object({ kind: z.literal("scene"), sceneId: SceneIdSchema }).strict(),
  z.object({ kind: z.literal("shot"), sceneId: SceneIdSchema, shotId: ShotIdSchema }).strict(),
  z.object({ kind: z.literal("board"), sceneId: SceneIdSchema, memberShotIds: z.array(ShotIdSchema).min(1) }).strict(),
  z
    .object({
      kind: z.literal("edge"),
      sceneId: SceneIdSchema,
      fromShotId: ShotIdSchema.nullable(),
      toShotId: ShotIdSchema.nullable(),
    })
    .strict(),
  z.object({ kind: z.literal("take"), takeId: TakeIdSchema }).strict(),
  /**
   * A passage selected in a chapter (turn 128): the chapter, the paragraph counted from one by
   * blank lines, and the words. The structured twin of the dock's subject prefix, carried so a
   * revision the model returns can be held against what was actually selected rather than
   * against its own retelling of it.
   */
  z
    .object({
      kind: z.literal("passage"),
      chapterId: SlugSchema,
      paragraph: z.number().int().min(1).optional(),
      text: z.string().min(1).max(1_200),
    })
    .strict(),
]);
export type WorldChatSubject = z.infer<typeof WorldChatSubjectSchema>;

// ---------------------------------------------------------------------------
// Ghosts and cards (R-33, R-34)
// ---------------------------------------------------------------------------

/** What a request does, counted from the history entry it would write. */
export interface EditorRequestDigest {
  moved: string[];
  added: string[];
  removed: string[];
  changed: string[];
  /** Take switches, which land through the review path rather than as clip changes. */
  takes: string[];
  tracks: string[];
  cues: number;
  mix: boolean;
  /** The frames the request touches, over every clip before and after. */
  range: { startFrame: number; endFrame: number } | null;
  storyOrderChanges: boolean;
  /** Exact net effects shown on the permission card; no command-specific preview list is maintained. */
  effects: Array<{ label: string; detail?: string }>;
}

export type EditorRequestPreview =
  | { ok: true; timeline: ProductionTimeline; digest: EditorRequestDigest }
  | { ok: false; reason: string };

function clipLabel(clip: TimelineClip): string {
  const source = clip.source;
  return source.kind === "shot" ? source.shotId : source.kind === "take" ? source.takeId : source.label;
}

function pictureShotOrder(timeline: ProductionTimeline): string {
  const picture = timeline.tracks.find((track) => track.id === PICTURE_TRACK_ID);
  if (picture === undefined) return "";
  return orderedTrackClips(picture)
    .flatMap((clip) => (clip.source.kind === "shot" ? [clip.source.shotId] : []))
    .join(",");
}

/**
 * Apply a request's commands to a base in memory (R-33): the ghost the timeline may draw, and
 * the digest its card states. Pure, and the coordinator runs the same function before it writes
 * the record, so a request that cannot apply is refused with this reason rather than staged.
 *
 * Take switches are not clip commands and are counted rather than applied here; the review path
 * lands them on Accept exactly as it does for a person's own switch (SPEC-037 R-16).
 */
export function previewEditorRequest(
  base: ProductionTimeline,
  commands: readonly TimelineCommand[],
  options: {
    sourceLength?: Parameters<typeof applyTimelineCommands>[2] extends infer O ? (O extends { sourceLength?: infer S } ? S : never) : never;
    selections?: readonly TimelineSelectionChange[];
  } = {},
): EditorRequestPreview {
  const switches = commands.filter((command): command is Extract<TimelineCommand, { kind: "switch-take" }> => command.kind === "switch-take");
  const clipCommands = commands.filter((command): command is TimelineClipCommand => command.kind !== "switch-take");
  let next: ProductionTimeline;
  try {
    next =
      clipCommands.length === 0 && (options.selections?.length ?? 0) === 0
        ? base
        : applyTimelineCommands(base, clipCommands, {
            label: "request",
            ...(options.sourceLength !== undefined ? { sourceLength: options.sourceLength } : {}),
            ...(options.selections !== undefined ? { selections: options.selections } : {}),
          });
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof TimelineOperationRefused ? error.reason : error instanceof Error ? error.message : String(error),
    };
  }
  const digest: EditorRequestDigest = {
    moved: [],
    added: [],
    removed: [],
    changed: [],
    takes: switches.map((command) => `${command.takeId} for ${command.shotId}`),
    tracks: [],
    cues: 0,
    mix: false,
    range: null,
    storyOrderChanges: pictureShotOrder(base) !== pictureShotOrder(next),
    effects: [],
  };
  const entry = next === base ? undefined : next.history.undo.at(-1);
  if (entry !== undefined && entry.kind === "change") {
    let start = Number.POSITIVE_INFINITY;
    let end = Number.NEGATIVE_INFINITY;
    for (const change of entry.clips) {
      const { before, after } = change;
      if (before === null && after !== null) digest.added.push(clipLabel(after));
      else if (before !== null && after === null) digest.removed.push(clipLabel(before));
      else if (before !== null && after !== null) {
        if (before.startFrame !== after.startFrame) digest.moved.push(clipLabel(after));
        else digest.changed.push(clipLabel(after));
      }
      const clip = after ?? before!;
      const state = (value: TimelineClip | null) => value === null
        ? "not present"
        : `${change.trackId}, frames ${value.startFrame}-${value.startFrame + value.durationFrames}, source ${value.sourceInFrames}-${value.sourceInFrames + value.durationFrames}${value.gainDb === undefined ? "" : `, ${value.gainDb} dB`}${value.audio === undefined ? "" : `, audio ${value.audio}`}`;
      digest.effects.push({
        label: `${before === null ? "Add" : after === null ? "Remove" : "Change"} ${clipLabel(clip)} (${clip.id})`,
        detail: `${state(before)} -> ${state(after)}`,
      });
      for (const clip of [before, after]) {
        if (clip === null) continue;
        start = Math.min(start, clip.startFrame);
        end = Math.max(end, clip.startFrame + clip.durationFrames);
      }
    }
    if (Number.isFinite(start) && Number.isFinite(end)) digest.range = { startFrame: start, endFrame: end };
    digest.tracks = entry.tracks.map((change) =>
      change.after === null ? `removes ${change.trackId}` : change.before === null ? `adds ${change.trackId}` : `changes ${change.trackId}`,
    );
    for (const change of entry.tracks) {
      digest.effects.push({
        label: `${change.before === null ? "Add" : change.after === null ? "Remove" : "Change"} track ${change.trackId}`,
        detail: `${JSON.stringify(change.before)} -> ${JSON.stringify(change.after)}`,
      });
    }
    digest.cues = entry.cues.length;
    for (const change of entry.cues) {
      const cue = change.after ?? change.before!;
      digest.effects.push({
        label: `${change.before === null ? "Add" : change.after === null ? "Remove" : "Change"} subtitle ${cue.id}`,
        detail: `${JSON.stringify(change.before)} -> ${JSON.stringify(change.after)}`,
      });
    }
    digest.mix = entry.mix !== undefined;
    if (entry.mix !== undefined) {
      digest.effects.push({ label: "Change the production mix", detail: `${JSON.stringify(entry.mix.before)} -> ${JSON.stringify(entry.mix.after)}` });
    }
    if (entry.library !== undefined) {
      const key = (item: (typeof entry.library.before)[number]) => item.kind === "shot" ? `shot ${item.shotId}` : `artifact ${item.artifactId}`;
      const before = new Set(entry.library.before.map(key));
      const after = new Set(entry.library.after.map(key));
      for (const item of after) if (!before.has(item)) digest.effects.push({ label: `Add ${item} to the Library` });
      for (const item of before) if (!after.has(item)) digest.effects.push({ label: `Remove ${item} from the Library` });
    }
    for (const change of entry.selections) {
      digest.effects.push({
        label: `Switch take for ${change.shotId}`,
        detail: `${change.before?.acceptedTakeId ?? "no selected take"} -> ${change.after?.acceptedTakeId ?? "no selected take"}`,
      });
    }
  }
  if (digest.storyOrderChanges) digest.effects.push({ label: "Change Picture story order", detail: `${pictureShotOrder(base)} -> ${pictureShotOrder(next)}` });
  return { ok: true, timeline: next, digest };
}

const seconds = (frames: number, frameRate: number): string => `${(frames / frameRate).toFixed(1)}s`;

/** The card's lines (R-34): what moves, what goes, what comes, the range, and whether story order changes. */
export function describeEditorRequestDigest(digest: EditorRequestDigest, frameRate: number): string[] {
  const lines: string[] = [];
  const list = (verb: string, items: readonly string[]) => {
    if (items.length === 0) return;
    lines.push(`${verb} ${items.length}: ${items.slice(0, 6).join(", ")}${items.length > 6 ? ", …" : ""}`);
  };
  list("Moves", digest.moved);
  list("Removes", digest.removed);
  list("Adds", digest.added);
  list("Changes", digest.changed);
  list("Switches takes", digest.takes);
  list("Tracks", digest.tracks);
  if (digest.cues > 0) lines.push(`Subtitles ${digest.cues}`);
  if (digest.mix) lines.push("Changes the mix");
  if (digest.range !== null) lines.push(`Range ${seconds(digest.range.startFrame, frameRate)} – ${seconds(digest.range.endFrame, frameRate)}`);
  lines.push(digest.storyOrderChanges ? "Story order changes" : "Story order unchanged");
  return lines;
}

/**
 * Why a pending request can no longer be accepted (R-32), or null while it can. The revision is
 * the fence against a saved record; against a first assembly it is the source fingerprint, so a
 * story that moved under an unmaterialised request stales it exactly as an edit would.
 */
export function editorRequestStaleness(
  request: Pick<EditorRequest, "status" | "baseRevision" | "sourceFingerprint">,
  timeline: TimelineState | undefined,
  currentFingerprint: string | null,
): string | null {
  if (request.status !== "pending") return null;
  if (timeline?.status === "invalid") return "the timeline is invalid";
  if (timeline?.status === "ready") {
    return request.baseRevision === timeline.timeline.revision ? null : `the timeline moved to revision ${timeline.timeline.revision}`;
  }
  if (request.baseRevision !== null) return "the timeline this request was made against is gone";
  if (currentFingerprint === null) return "the first assembly cannot be derived right now";
  return request.sourceFingerprint === currentFingerprint ? null : "the story changed since this request was made";
}

/**
 * Whether Accept's revision has since been undone (R-36): the status stays; the record says what
 * happened after. Durable on the record rather than read off the redo stack, which the next
 * edit clears while the request's action stays absent (round eight).
 */
export function editorRequestUndone(request: Pick<EditorRequest, "status" | "undoneAt">, _timeline?: TimelineState | undefined): boolean {
  return request.status === "accepted" && request.undoneAt !== undefined;
}
