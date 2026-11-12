import { z } from "zod";
import { TEXT_TYPEFACE_IDS } from "./editor-text-typefaces.js";

/**
 * A text clip's record (SPEC-065 §2.1): the words as typed and the look they are drawn in. Every
 * length is a fraction, of the frame or of the type size (the em), so one record draws alike at
 * every frame size. Nothing here draws; the layout and the painter read these types.
 */

export const TEXT_MAX_CHARACTERS = 500, TEXT_MAX_LINES = 12;
/** R-6 leaves the label limit to the build: the first line, cut to this many characters. */
export const TEXT_LABEL_LIMIT = 80;

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const TextFillSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("solid"), color }).strict(),
  z.object({ kind: z.literal("gradient"), stops: z.array(z.object({ at: z.number().min(0).max(1), color }).strict()).min(2).max(4) }).strict(),
]);
export type TextFill = z.infer<typeof TextFillSchema>;
export const TextLookSchema = z.object({
  typeface: z.enum(TEXT_TYPEFACE_IDS), weight: z.enum(["regular", "bold"]), italic: z.boolean(),
  /** The em as a fraction of the frame's height. */
  size: z.number().min(0.01).max(0.4),
  /** Extra space between characters, in ems. */
  tracking: z.number().min(-0.05).max(0.5),
  /** Baseline to baseline, in ems. */
  leading: z.number().min(0.8).max(2),
  capitals: z.boolean(),
  align: z.enum(["left", "center", "right"]),
  x: z.number().min(0).max(1), y: z.number().min(0).max(1),
  /** The widest the block may be drawn, as a fraction of the frame's width (R-10). */
  room: z.number().min(0.1).max(1),
  fill: TextFillSchema,
  edge: z.object({ color, width: z.number().min(0.005).max(0.2) }).strict().optional(),
  shadow: z.object({ color, opacity: z.number().min(0).max(1), blur: z.number().min(0).max(1), dx: z.number().min(-1).max(1), dy: z.number().min(-1).max(1) }).strict().optional(),
  rule: z.object({ length: z.number().min(0.02).max(1), weight: z.number().min(0.005).max(0.2), gap: z.number().min(0).max(2), soft: z.boolean() }).strict().optional(),
  backing: z.object({ kind: z.enum(["shade", "box"]), color, opacity: z.number().min(0).max(1) }).strict().optional(),
}).strict();
export type TextLook = z.infer<typeof TextLookSchema>;
/** What the painter reads of a look. The typeface, weight and slant choose the face it is handed and nothing else. */
export type TextInk = Omit<TextLook, "typeface" | "weight" | "italic">;
/** The picture's size in whole pixels. */
export interface TextFrame { width: number; height: number }

export type TextWords = { ok: true; text: string } | { ok: false; reason: string };
/**
 * The words as they are stored (R-4): line ends become `\n`, blank lines before the first words
 * and after the last are dropped, and everything else stays as typed. Nothing is cut to fit: too
 * many characters or lines refuse.
 */
export function textWords(typed: string): TextWords {
  const lines = typed.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length && !lines[0]!.trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  if (!lines.length) return { ok: false, reason: "Type some words" };
  if (lines.length > TEXT_MAX_LINES) return { ok: false, reason: `Text holds at most ${TEXT_MAX_LINES} lines` };
  const text = lines.join("\n");
  if (text.length > TEXT_MAX_CHARACTERS) return { ok: false, reason: `Text holds at most ${TEXT_MAX_CHARACTERS} characters` };
  return { ok: true, text };
}

/** The clip's label (R-6). Cut by whole characters, so a pair of surrogates is never split. */
export const textLabel = (text: string): string => [...(text.split("\n")[0] ?? "").trim()].slice(0, TEXT_LABEL_LIMIT).join("") || "Text";

export type TextOutlineCommand = { command: "moveTo" | "lineTo" | "quadraticCurveTo" | "bezierCurveTo" | "closePath"; args: readonly number[] };
/** One shaped glyph. Every number is in the face's own units, with y upward from the baseline. */
export interface TextGlyph {
  /** The characters this glyph stands for: several for a ligature, one for a combining mark. */
  codePoints: readonly number[];
  /** A combining mark sits on the glyph before it and takes no tracking of its own. */
  mark: boolean;
  /** How far the pen moves on after this glyph, kerning included. */
  advance: number;
  /** Where the outline sits from the pen. */
  dx: number; dy: number;
  outline: readonly TextOutlineCommand[];
}
/**
 * A typeface file as the layout and the painter see it. The coordinator fills this from the
 * shipped file; a test fills it by hand. Contracts reads no font itself, which keeps the layout
 * free to run in the client.
 */
export interface TextFace {
  /** The name a refusal uses: "Geist". */
  name: string;
  unitsPerEm: number;
  /** The line's top and bottom from the baseline; `descent` is negative. */
  ascent: number; descent: number;
  /** The top of a flat capital from the baseline: where a gradient fill begins. */
  capHeight: number;
  has(codePoint: number): boolean;
  /**
   * One line, left to right, already in upper case when Capitals is on. Kerning is always
   * applied; `ligatures` is off when the line is tracked, so a joined pair is not left tight
   * among spaced letters.
   */
  shape(line: string, options: { ligatures: boolean }): readonly TextGlyph[];
}
