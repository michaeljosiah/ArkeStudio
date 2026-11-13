import { z } from "zod";
import { PRESETS } from "./cut.js";
import { TextLookSchema, TextSourceSchema, TextTypedSchema, type TextFrame } from "./editor-text.js";
import { TEXT_SET_MAX_CLIPS } from "./editor-text-set.js";
import { TEXT_TYPEFACE_IDS, type TextTypefaceId } from "./editor-text-typefaces.js";

/**
 * Words being typed, drawn before they are saved (SPEC-065 R-32, §2.3). The Cut cannot lay out or
 * paint: the faces are read by the coordinator, and the painter is handed a face, not a file. So a
 * window asks the coordinator for a draft over its own socket and is answered on that socket alone,
 * as the Studio assistant's replies are. Nothing here is a write: the coordinator keeps no draft
 * once it has answered, and a window holds the picture only as long as it shows it.
 *
 * Every bound is the wire's, so a breach is refused as `invalid` with its request id before the
 * coordinator reads a word of it (§2.5.1 "The wire"). The words and the look are the record's own
 * schemas: a draft can never show words a write would refuse for a reason the record states.
 */

/**
 * Whether a frame is one a film is delivered at (`PRESETS`): the Viewer plans at one of these and a
 * draft is painted at the Viewer's frame. Never doubled: a moving title's draft is drawn at the
 * plain frame and shown in its doubled picture's place, which keeps its geometry and costs a
 * quarter of the paint (R-17). Read when asked, not when this module loads, since the cut module
 * that holds the presets is a large one other modules reach this one through.
 */
export function textDraftFrame(frame: TextFrame): boolean {
  return Object.values(PRESETS).some(preset => preset.width === frame.width && preset.height === frame.height);
}

/** The most a draft's picture may weigh as base64: a whole 1920×1080 frame of ink with nothing deflated, and room over. */
export const TEXT_DRAFT_PNG_MAX = 12_000_000;
/** The most one typeface file may weigh as base64. The largest Regular shipped, EB Garamond's, is about 840,000. */
export const TEXT_TYPEFACE_DATA_MAX = 2_000_000;

const base64 = (max: number) => z.string().min(1).max(max).regex(/^[A-Za-z0-9+/]+={0,2}$/);
const frame = z.object({ width: z.number().int(), height: z.number().int() }).strict()
  .refine(textDraftFrame, "A draft is drawn at a delivery size");

/** One clip's words as typed and its look. The look goes in under its name, which keeps the wire's declarations small (TS7056). */
export const TextDraftItemSchema = z.object({ text: TextTypedSchema, look: TextSourceSchema.shape.look }).strict();
export type TextDraftItem = z.infer<typeof TextDraftItemSchema>;

/**
 * `paint` draws one clip's words in its look and sends the picture back with its drawn size;
 * `measure` lays out up to fifty and sends back each drawn size or refusal, with no picture. A
 * window measures before it commits a choice that can refuse (a typeface, Italic, Capitals) for
 * every clip it names, and paints only the one the Viewer shows. A picture is asked of one clip at
 * a time, so no ask can make the coordinator paint more than one.
 */
export const TextDraftCommandSchema = z.object({
  kind: z.literal("text-draft"),
  requestId: z.string().uuid(),
  frame,
  ask: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("paint"), item: TextDraftItemSchema }).strict(),
    z.object({ kind: z.literal("measure"), items: z.array(TextDraftItemSchema).min(1).max(TEXT_SET_MAX_CLIPS) }).strict(),
  ]),
}).strict();
export type TextDraftCommand = z.infer<typeof TextDraftCommandSchema>;

/** The six Regular files, so the Typeface menu can draw each name in its own face (§2.5). Asked once a session. */
export const TextTypefacesCommandSchema = z.object({ kind: z.literal("text-typefaces"), requestId: z.string().uuid() }).strict();
export type TextTypefacesCommand = z.infer<typeof TextTypefacesCommandSchema>;

/**
 * The control a refusal belongs under, when the Inspector cannot tell from what was just changed:
 * the words (empty, too many, or a character the face lacks or cannot place), the typeface (a
 * weight or slant it lacks, or a file that is missing or not the one shipped), or the look's
 * values (a value out of range, an unknown field).
 */
export const TEXT_DRAFT_FIELDS = ["words", "typeface", "look"] as const;
export type TextDraftField = (typeof TEXT_DRAFT_FIELDS)[number];
/** One clip's answer: the size Fit drew it at (R-10), or the painter's refusal in its own words (R-21). */
export type TextDraftResult = { ok: true; drawnSize: number } | { ok: false; reason: string; field: TextDraftField };
/** A painted draft: the name a kept picture of these words would have at this frame, and the PNG as base64. */
export interface TextDraftPicture { name: string; png: string }
/**
 * `superseded`: a newer ask of the same kind from this window took this one's place before it was
 * drawn. `drawn`: a result per item asked, in order, and for `paint` whose words drew, the picture.
 */
export type TextDraftAnswer =
  | { kind: "superseded" }
  | { kind: "drawn"; results: TextDraftResult[]; picture?: TextDraftPicture | undefined };
/** One face's Regular file as base64. A face whose file is missing or is not the one shipped is left out. */
export interface TextTypefaceBytes { id: TextTypefaceId; data: string }

const result = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), drawnSize: z.number().finite().min(0).max(TextLookSchema.shape.size.maxValue ?? 1) }).strict(),
  z.object({ ok: z.literal(false), reason: z.string().min(1).max(500), field: z.enum(TEXT_DRAFT_FIELDS) }).strict(),
]);
// Named, not inferred: these ride in the frame union, whose declaration the engine's build writes
// out whole, and an inferred look or answer at each place it appears is what TS7056 counts.
export const TextDraftAnswerSchema: z.ZodType<TextDraftAnswer, z.ZodTypeDef, unknown> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("superseded") }).strict(),
  z.object({
    kind: z.literal("drawn"),
    results: z.array(result).min(1).max(TEXT_SET_MAX_CLIPS),
    picture: z.object({ name: z.string().regex(/^[0-9a-f]{64}$/), png: base64(TEXT_DRAFT_PNG_MAX) }).strict().optional(),
  }).strict(),
]).superRefine((answer, ctx) => {
  // A picture answers a paint, which names one clip, and only words that drew have one.
  if (answer.kind === "drawn" && answer.picture !== undefined && (answer.results.length !== 1 || !answer.results[0]!.ok)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["picture"], message: "A draft's picture answers one clip that drew" });
  }
});
export const TextTypefaceBytesSchema: z.ZodType<TextTypefaceBytes[], z.ZodTypeDef, unknown> = z.array(
  z.object({ id: z.enum(TEXT_TYPEFACE_IDS), data: base64(TEXT_TYPEFACE_DATA_MAX) }).strict(),
).max(TEXT_TYPEFACE_IDS.length).refine(faces => new Set(faces.map(face => face.id)).size === faces.length, "Each face once");
