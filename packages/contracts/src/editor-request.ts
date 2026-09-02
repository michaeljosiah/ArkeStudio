import { z } from "zod";
import { ConversationIdSchema, SlugSchema } from "./ids.js";
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
  /** Requests one turn may stage; a conversation that wants more says so over more turns. */
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
 * Unlike an editor request, a scene edit is not carded: a title is a label, not a change anyone
 * needs to review, and the person is looking at it. The model describes the edit in a typed field,
 * the coordinator lands it through the same version-fenced `edit-scene` write the header uses, and
 * a scene that moved between the prompt and the answer refuses back to the model as a corrective
 * problem — the bible-edit discipline, one record over. Only in a scene thread, only that scene.
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

/** What the model returns: a summary in the person's terms and the exact commands (R-27, R-34). */
export const ModelEditorRequestSchema = z
  .object({
    summary: z.string().min(1).max(EDITOR_REQUEST_BOUNDS.summary),
    commands: z.array(TimelineCommandSchema).min(1).max(EDITOR_REQUEST_BOUNDS.commands),
  })
  .strict();
export type ModelEditorRequest = z.infer<typeof ModelEditorRequestSchema>;

/** The durable record (R-28). Model output cannot touch it after creation; only a decision moves its status. */
export const EditorRequestSchema = z
  .object({
    id: EditorRequestIdSchema,
    productionId: SlugSchema,
    conversationId: ConversationIdSchema,
    /** The revision the commands were prepared against; null when they would materialise the first assembly. */
    baseRevision: z.number().int().min(0).nullable(),
    sourceFingerprint: TimelineSourceFingerprintSchema,
    commands: z.array(TimelineCommandSchema).min(1).max(EDITOR_REQUEST_BOUNDS.commands),
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

/** What the person has selected while they talk to Arke (R-26): the subject of "this" and "the selected clip". */
export const WorldChatSubjectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("timeline-clip"), clipId: TimelineClipIdSchema }).strict(),
  z.object({ kind: z.literal("timeline-track"), trackId: TimelineTrackIdSchema }).strict(),
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
  options: { sourceLength?: Parameters<typeof applyTimelineCommands>[2] extends infer O ? (O extends { sourceLength?: infer S } ? S : never) : never } = {},
): EditorRequestPreview {
  const switches = commands.filter((command): command is Extract<TimelineCommand, { kind: "switch-take" }> => command.kind === "switch-take");
  const clipCommands = commands.filter((command): command is TimelineClipCommand => command.kind !== "switch-take");
  let next: ProductionTimeline;
  try {
    next =
      clipCommands.length === 0
        ? base
        : applyTimelineCommands(base, clipCommands, {
            label: "request",
            ...(options.sourceLength !== undefined ? { sourceLength: options.sourceLength } : {}),
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
  };
  const entry = clipCommands.length === 0 ? undefined : next.history.undo.at(-1);
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
    digest.cues = entry.cues.length;
    digest.mix = entry.mix !== undefined;
  }
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
