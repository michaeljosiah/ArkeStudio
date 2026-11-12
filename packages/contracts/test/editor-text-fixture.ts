import type { TextFace, TextGlyph, TextInk, TextOutlineCommand } from "../src/editor-text.js";

// A face made by hand, shared by the text tests. Contracts reads no font file, and a real one
// would make every expected number an estimate: here each glyph is a shape whose coverage can be
// stated exactly. Eight units to the em, so an 8-pixel em puts one unit on one pixel.

type Path = TextOutlineCommand[];
const move = (x: number, y: number): TextOutlineCommand => ({ command: "moveTo", args: [x, y] });
const to = (x: number, y: number): TextOutlineCommand => ({ command: "lineTo", args: [x, y] });
const shut: TextOutlineCommand = { command: "closePath", args: [] };
/** Counter-clockwise with y upward: the way an outer contour winds. */
const box = (left: number, bottom: number, right: number, top: number): Path => [move(left, bottom), to(right, bottom), to(right, top), to(left, top), shut];
/** The other way round: a counter. */
const hole = (left: number, bottom: number, right: number, top: number): Path => [move(left, bottom), to(left, top), to(right, top), to(right, bottom), shut];
const triangle: Path = [move(0, 0), to(4, 0), to(0, 4), shut];

/** A quarter of a square with one quadratic corner, and its exact area in square units: the triangle plus two thirds of the control triangle. */
export const PROOF_QUADRATIC_AREA = 8 + 16 / 3;
const quadratic: Path = [move(0, 0), to(4, 0), { command: "quadraticCurveTo", args: [4, 4, 0, 4] }, shut];
/** The same corner as a cubic through (4,2) and (2,4): its sector from the origin is 12.2 square units by the Bezier area formula. */
export const PROOF_CUBIC_AREA = 12.2;
const cubic: Path = [move(0, 0), to(4, 0), { command: "bezierCurveTo", args: [4, 2, 2, 4, 0, 4] }, shut];

interface Shape { advance: number; outline: Path; mark?: boolean; dx?: number; dy?: number }
const SHAPES: Record<string, Shape> = {
  a: { advance: 5, outline: box(0, 0, 4, 4) },
  A: { advance: 6, outline: box(0, 0, 5, 4) },
  o: { advance: 5, outline: [...box(0, 0, 4, 4), ...hole(1, 1, 3, 3)] },
  v: { advance: 5, outline: triangle },
  V: { advance: 6, outline: triangle },
  q: { advance: 5, outline: quadratic },
  c: { advance: 5, outline: cubic },
  f: { advance: 3, outline: box(0, 0, 2, 4) },
  i: { advance: 2, outline: box(0, 0, 1, 4) },
  // Below the baseline, for a gradient's last colour and a rule that meets a letter.
  p: { advance: 5, outline: box(0, -2, 4, 4) },
  // Two contours wound the same way that overlap from 1 to 3: winding 2 where they meet.
  x: { advance: 5, outline: [...box(0, 0, 3, 4), ...box(1, 0, 4, 4)] },
  // Reaches two units back over the glyph before it.
  w: { advance: 5, outline: box(-2, 0, 4, 4) },
  // The precomposed letter NFC makes of "e" and a combining acute.
  "é": { advance: 5, outline: box(0, 0, 4, 4) },
  " ": { advance: 3, outline: [] },
  // A combining acute: no advance, set back over its letter, above the cap line.
  "́": { advance: 0, outline: box(0, 5, 1, 6), mark: true, dx: -3 },
  // A combining grave drawn on the baseline and lifted by the shaping, as a real face lifts a mark onto a capital.
  "̀": { advance: 0, outline: box(0, 0, 1, 1), mark: true, dx: -3, dy: 5 },
};
const LIGATURE: Shape = { advance: 5, outline: box(0, 0, 4, 4) };
/** An "a" before a "v" is drawn one unit closer. */
export const PROOF_KERN = -1;

export interface ProofFace { face: TextFace; asked: { line: string; ligatures: boolean }[] }
/** `asked` records every line the layout had shaped and whether it asked for ligatures. */
export function proofFace(): ProofFace {
  const asked: ProofFace["asked"] = [];
  const face: TextFace = {
    name: "Proof", unitsPerEm: 8, ascent: 6, descent: -2, capHeight: 4,
    has: codePoint => String.fromCodePoint(codePoint) in SHAPES,
    shape(line, { ligatures }) {
      asked.push({ line, ligatures });
      const characters = [...line], glyphs: TextGlyph[] = [];
      for (let at = 0; at < characters.length; at++) {
        const character = characters[at]!, next = characters[at + 1];
        if (ligatures && character === "f" && next === "i") {
          glyphs.push({ codePoints: [0x66, 0x69], mark: false, advance: LIGATURE.advance, dx: 0, dy: 0, outline: LIGATURE.outline });
          at++;
          continue;
        }
        const shape = SHAPES[character]!;
        glyphs.push({ codePoints: [character.codePointAt(0)!], mark: shape.mark ?? false, advance: shape.advance + (character === "a" && next === "v" ? PROOF_KERN : 0),
          dx: shape.dx ?? 0, dy: shape.dy ?? 0, outline: shape.outline });
      }
      return glyphs;
    },
  };
  return { face, asked };
}

/** White, left-aligned at a quarter across and half-way down, one-eighth of the frame high: on a 64-pixel frame the em is 8 pixels and a unit is one. */
export const proofInk = (changes: Partial<TextInk> = {}): TextInk => ({
  size: 0.125, tracking: 0, leading: 1, capitals: false, align: "left", x: 0.25, y: 0.5, room: 1, fill: { kind: "solid", color: "#ffffff" }, ...changes,
});
export const PROOF_FRAME = { width: 64, height: 64 };
