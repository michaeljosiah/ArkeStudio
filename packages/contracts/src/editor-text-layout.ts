import type { TextFace, TextFill, TextFrame, TextGlyph, TextInk } from "./editor-text.js";

/**
 * Where a text clip's words fall (SPEC-065 R-5, R-8 – R-10, R-12): lines, tracking, Fit,
 * alignment and place, in pixels of the frame. No pixel is made here. It stands apart from the
 * painter because the Cut's Inspector needs the size actually drawn and the refusal without a
 * picture, and it holds to the painter's arithmetic (R-19): + - * / and nothing that asks the
 * machine what it thinks.
 */

/** Below 16 an em is under a pixel; 8192 is a 4K frame doubled for a moving still (R-17) with room over. */
export const TEXT_FRAME_MIN = 16, TEXT_FRAME_MAX = 8192;

/** Red, green and blue as sRGB byte values. A place between two gradient stops is not a whole number. */
export type TextRgb = readonly [number, number, number];
/** Edges in frame pixels, y downward. A box may lie partly or wholly outside the frame (R-9). */
export interface TextBox { left: number; top: number; right: number; bottom: number }
/** `x`, `y` is where the outline's own origin sits: the pen, moved by the glyph's `dx`, `dy`. */
export interface TextPlacedGlyph { glyph: TextGlyph; x: number; y: number }
export interface TextLayoutLine {
  /** The line as it was shaped: NFC, and in upper case when Capitals is on. */
  text: string;
  baseline: number;
  /** The top of a flat capital: where a gradient fill begins. */
  capLine: number;
  start: number; width: number;
  glyphs: readonly TextPlacedGlyph[];
}
export interface TextLayoutRule { box: TextBox; color: TextRgb; soft: boolean }
export interface TextLayout {
  frame: TextFrame;
  /** The em actually drawn, in pixels, and one font unit of it. Every em-based length of the ink is a multiple of `em`. */
  em: number; unit: number;
  /** 1, or what Fit drew the whole block smaller by (R-10). */
  factor: number;
  /** The size actually drawn, as the look states size: the stored size times `factor`. */
  drawnSize: number;
  lines: readonly TextLayoutLine[];
  /** Leftmost line start to rightmost line end, first line's ascent to last line's descent. Its middle sits at `y`. */
  block: TextBox;
  rule?: TextLayoutRule;
  /** The block and its rule together: what a backing lies behind. */
  bounds: TextBox;
}
export type TextLayoutResult = { ok: true; layout: TextLayout } | { ok: false; reason: string };

export const textRgb = (color: string): TextRgb => [parseInt(color.slice(1, 3), 16), parseInt(color.slice(3, 5), 16), parseInt(color.slice(5, 7), 16)];

/**
 * A fill's colour at `t`, 0 at a line's cap line and 1 at its baseline. Stops are read in rising
 * order of place; two at one place make a hard step, the later winning at and after it. Channels
 * run straight between stops as byte values: titles are judged by eye on an sRGB screen, and a
 * gamma step would be one more thing for two machines to disagree about. A gradient has a stop:
 * the layout refuses one with none before any colour is asked for.
 */
export function textFillAt(fill: TextFill, t: number): TextRgb {
  if (fill.kind === "solid") return textRgb(fill.color);
  // Array.prototype.sort is stable, so stops typed at one place keep the order they were typed in.
  const stops = [...fill.stops].sort((a, b) => a.at - b.at);
  let from = -1;
  for (let index = 0; index < stops.length; index++) if (stops[index]!.at <= t) from = index;
  if (from < 0) return textRgb(stops[0]!.color);
  const a = stops[from]!, b = stops[from + 1];
  if (!b) return textRgb(a.color);
  const first = textRgb(a.color), second = textRgb(b.color), along = (t - a.at) / (b.at - a.at);
  return [first[0] + (second[0] - first[0]) * along, first[1] + (second[1] - first[1]) * along, first[2] + (second[2] - first[2]) * along];
}

/** The rule takes the fill's colour (R-12); under a gradient, the colour half-way down a line. */
const RULE_GRADIENT_AT = 0.5;

/** A refusal names the character when a reader could see it, and its code point when they could not (R-21). */
function characterName(character: string): string {
  return /^[\p{L}\p{N}\p{P}\p{S}]$/u.test(character) ? character : `U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
}

/** The stored words as they are drawn. Capitals is a display style: the words themselves are never rewritten (R-4). */
export function textDisplayLines(words: string, capitals: boolean): string[] {
  // Never toLocaleUpperCase: a Turkish machine would dot the capital I and draw a different picture.
  return words.split("\n").map(line => capitals ? line.normalize("NFC").toUpperCase().normalize("NFC") : line.normalize("NFC"));
}

export function layoutText(words: string, ink: TextInk, frame: TextFrame, face: TextFace): TextLayoutResult {
  for (const side of [frame.width, frame.height]) {
    if (!Number.isInteger(side) || side < TEXT_FRAME_MIN || side > TEXT_FRAME_MAX) return { ok: false, reason: `A text picture is ${TEXT_FRAME_MIN} to ${TEXT_FRAME_MAX} whole pixels each way` };
  }
  // A clip is never a blank (R-3): words with nothing to draw refuse here as they do when they are typed (R-4).
  if (!words.trim()) return { ok: false, reason: "Type some words" };
  // The record holds two stops or more (R-26). With none there is no colour to draw in, and the fill below would have nothing to read.
  if (ink.fill.kind === "gradient" && !ink.fill.stops.length) return { ok: false, reason: "A gradient fill has no colours" };
  if (!(face.unitsPerEm > 0) || ![face.ascent, face.descent, face.capHeight].every(Number.isFinite)) return { ok: false, reason: `${face.name} cannot be measured` };
  const lines = textDisplayLines(words, ink.capitals);
  // Every character is asked of the chosen face before any is shaped: another face is never tried (R-21).
  for (const line of lines) for (const character of line) {
    if (!face.has(character.codePointAt(0)!)) return { ok: false, reason: `${face.name} has no ${characterName(character)}` };
  }
  // A joined pair would sit tight among spaced letters, so a tracked line is shaped without ligatures.
  const shaped = lines.map(line => line ? face.shape(line, { ligatures: ink.tracking === 0 }) : []);
  // Measured in ems first, so Fit scales a line by one multiplication and never by a second pass of shaping.
  // Tracking falls between characters only: none after the last, so a centred line is centred on its letters.
  const widths = shaped.map(glyphs => {
    let advance = 0, letters = 0;
    for (const glyph of glyphs) { advance += glyph.advance; if (!glyph.mark) letters++; }
    return advance / face.unitsPerEm + ink.tracking * Math.max(0, letters - 1);
  });
  const chosen = ink.size * frame.height, room = ink.room * frame.width;
  let widest = 0;
  for (const width of widths) widest = Math.max(widest, width * chosen);
  // Fit (R-10): one factor for the whole block, so every line and every em-based length shrinks alike.
  const factor = widest > room ? room / widest : 1, em = chosen * factor, unit = em / face.unitsPerEm;
  const anchor = ink.x * frame.width, ascent = face.ascent * unit, descent = face.descent * unit, step = ink.leading * em;
  // The rule is left out of the centring, so switching one on never moves the words.
  const height = ascent + step * (lines.length - 1) - descent, top = ink.y * frame.height - height / 2;
  const placed = (width: number) => ink.align === "left" ? anchor : ink.align === "center" ? anchor - width / 2 : anchor - width;
  const laid: TextLayoutLine[] = shaped.map((glyphs, index) => {
    const width = widths[index]! * em, start = placed(width), baseline = top + ascent + step * index;
    let pen = start, letters = 0;
    const row = glyphs.map(glyph => {
      // A mark rides on the letter before it and takes no space of its own, tracked or not.
      if (!glyph.mark && letters++ > 0) pen += ink.tracking * em;
      const at: TextPlacedGlyph = { glyph, x: pen + glyph.dx * unit, y: baseline - glyph.dy * unit };
      pen += glyph.advance * unit;
      return at;
    });
    return { text: lines[index]!, baseline, capLine: baseline - face.capHeight * unit, start, width, glyphs: row };
  });
  const block: TextBox = { left: Infinity, top, right: -Infinity, bottom: top + height };
  for (const line of laid) { block.left = Math.min(block.left, line.start); block.right = Math.max(block.right, line.start + line.width); }
  let rule: TextLayoutRule | undefined, bounds = block;
  if (ink.rule) {
    // Its length is the frame's and its weight and gap the type's, so Fit thins a rule without shortening it.
    const length = ink.rule.length * frame.width, left = placed(length), ruleTop = laid[laid.length - 1]!.baseline + ink.rule.gap * em;
    const box: TextBox = { left, top: ruleTop, right: left + length, bottom: ruleTop + ink.rule.weight * em };
    rule = { box, color: textFillAt(ink.fill, RULE_GRADIENT_AT), soft: ink.rule.soft };
    bounds = { left: Math.min(block.left, box.left), top: Math.min(block.top, box.top), right: Math.max(block.right, box.right), bottom: Math.max(block.bottom, box.bottom) };
  }
  if (![bounds.left, bounds.top, bounds.right, bounds.bottom].every(Number.isFinite)) return { ok: false, reason: `${face.name} cannot be measured` };
  return { ok: true, layout: { frame: { width: frame.width, height: frame.height }, em, unit, factor, drawnSize: ink.size * factor, lines: laid, block, ...(rule ? { rule } : {}), bounds } };
}
