import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import { TextLookSchema, TextTypedSchema, textSourceProblem, textSourceWritten, textWords, type TextLook } from "./editor-text.js";
import type { TimelineClip, TimelineClipId, TimelineTrack } from "./timeline.js";

/**
 * The one command that changes a text clip's words or look (SPEC-065 R-25). It lives beside the
 * record rather than in the reducer so the reducer only has to call it, as it calls the picture
 * motion commands; the timeline types are imported as types, so nothing here runs before them.
 */

/**
 * The fields of a clip a text source rules out (R-2). This sits here rather than beside the
 * record in `editor-text.ts` because naming the other sources means naming a performance, and the
 * painter's arithmetic check (R-19) reads that module as text and refuses the word, which is how
 * it finds a clock read. This module may take the timeline's types; the record's may not.
 */
export type TextClipCarries = Pick<TimelineClip, "source">
  & Partial<Pick<TimelineClip, "sourceInFrames" | "audio" | "gainDb" | "role" | "linkedClipId" | "performanceSourceClipId">>;
export function textClipProblem(clip: TextClipCarries): string | null {
  if (clip.source.kind !== "text") return null;
  if (clip.audio !== undefined || clip.role !== undefined || clip.performanceSourceClipId !== undefined) return "Text has no sound";
  if (clip.gainDb !== undefined) return "Text has no gain";
  if (clip.linkedClipId !== undefined) return "Text has no linked clip";
  if ((clip.sourceInFrames ?? 0) !== 0) return "Text has no source in-point";
  return textSourceProblem(clip.source);
}

const clipId = z.string().regex(/^cl_[A-Za-z0-9][A-Za-z0-9_-]*$/) as z.ZodType<TimelineClipId>;
/** One command reaches at most this many clips (R-25). More refuse; none are dropped to fit. */
export const TEXT_SET_MAX_CLIPS = 50;
const part = <T extends z.ZodTypeAny>(optional: z.ZodOptional<T>) => optional.unwrap().nullable().optional();

type TextLookPart = "edge" | "shadow" | "rule" | "backing";
/** Any of a look's fields; `null` removes an edge, shadow, rule or backing (SPEC-065 R-25). A part is replaced whole. */
export interface TextLookPatch extends Partial<Omit<TextLook, TextLookPart>> {
  edge?: TextLook["edge"] | null; shadow?: TextLook["shadow"] | null; rule?: TextLook["rule"] | null; backing?: TextLook["backing"] | null;
}
// Named, not inferred (SPEC-065 R-35): a request may carry this command, so every schema that
// embeds a request embeds it too, and the engine's declaration build writes an inferred look out
// in full each time, past the 1,000,000 characters it will write for one type (TS7056).
export const TextLookPatchSchema: z.ZodType<TextLookPatch> = TextLookSchema.partial().extend({
  edge: part(TextLookSchema.shape.edge), shadow: part(TextLookSchema.shape.shadow),
  rule: part(TextLookSchema.shape.rule), backing: part(TextLookSchema.shape.backing),
}).strict();

// A plain object, with no rule across its fields: it is a member of the command union, which
// takes nothing else. What it cannot say here, `textSetProblem` says.
export const TextSetCommandSchema = z.object({
  kind: z.literal("text-set"),
  clipIds: z.array(clipId).min(1).max(TEXT_SET_MAX_CLIPS),
  /** As typed: bounded here by the field every text payload shares (R-26), stored as `textWords` keeps it (R-4). */
  text: TextTypedSchema.optional(),
  look: TextLookPatchSchema.optional(),
}).strict();
export type TextSetCommand = z.infer<typeof TextSetCommandSchema>;
export const isTextSetCommand = (value: { kind: string }): value is TextSetCommand => value.kind === "text-set";

/** Why a well-formed command asks for nothing a text clip can take, or null. */
export function textSetProblem(command: TextSetCommand): string | null {
  if (new Set(command.clipIds).size !== command.clipIds.length) return "Name each text clip once";
  if (command.text === undefined && command.look === undefined) return "Choose words or a look to change";
  if (command.text !== undefined && command.clipIds.length !== 1) return "Words are set on one text clip at a time";
  if (command.text !== undefined) { const words = textWords(command.text); if (!words.ok) return words.reason; }
  return null;
}

/**
 * A look with a patch laid over it. A removed part's key is deleted rather than left undefined,
 * so the look compares equal to one that never had the part, in Undo and in the no-change test.
 */
export function patchTextLook(look: TextLook, patch: TextLookPatch): TextLook {
  const next: Record<string, unknown> = { ...look };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) delete next[key]; else next[key] = value;
  }
  return TextLookSchema.parse(next);
}

/**
 * Every named clip gets the words and the patch, or nothing changes (SPEC-065 R-25): a missing clip
 * or one that is not text refuses the whole command before any clip is touched. The words are
 * stored as a write stores them — outer blank lines and carriage returns gone, the label derived
 * (R-4, R-6) — and only then compared with what the clip holds, so typing the held words with a
 * trailing newline changes nothing. A clip whose source comes out as it went in keeps its
 * identity, so the reducer touches nothing and writes no revision.
 */
export function applyTextSetCommand(tracks: readonly TimelineTrack[], command: TextSetCommand): TimelineTrack[] {
  const problem = textSetProblem(command);
  if (problem !== null) throw new Error(problem);
  const wanted = new Set<string>(command.clipIds), found = new Set<string>();
  for (const track of tracks) for (const clip of track.clips) {
    if (!wanted.has(clip.id)) continue;
    if (clip.source.kind !== "text") throw new Error(`${clip.id} is not text`);
    found.add(clip.id);
  }
  const missing = command.clipIds.find(id => !found.has(id));
  if (missing !== undefined) throw new Error(`timeline does not contain ${missing}`);
  return tracks.map(track => {
    let changed = false;
    const clips = track.clips.map(clip => {
      if (!wanted.has(clip.id) || clip.source.kind !== "text") return clip;
      const look = command.look ? patchTextLook(clip.source.look, command.look) : clip.source.look;
      const written = textSourceWritten(command.text ?? clip.source.text, look);
      if (!written.ok) throw new Error(written.reason);
      if (canonicalJson(written.source) === canonicalJson(clip.source)) return clip;
      changed = true;
      return { ...clip, source: written.source };
    });
    return changed ? { ...track, clips } : track;
  });
}
