import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { TextFrame, TextInk } from "../src/editor-text.js";
import { TEXT_BOX_PADDING, TEXT_RULE_SOFT_END, TEXT_SHADE_REACH_X, TEXT_SHADE_REACH_Y, TEXT_SHADOW_SIGMA, paintText, type TextPicture } from "../src/editor-text-painter.js";
import { TEXT_FLATNESS } from "../src/editor-text-raster.js";
import { TEXT_PAINTER_VERSION } from "../src/editor-text-typefaces.js";
import { PROOF_CUBIC_AREA, PROOF_FRAME, PROOF_QUADRATIC_AREA, proofFace, proofInk } from "./editor-text-fixture.js";

// The picture itself (SPEC-065 R-11 – R-13, R-18, R-19). On the 64-pixel proof frame the proof
// face's em is 8 pixels and its "a" a 4-pixel square from (16, 30) to (20, 34), so every byte
// asserted here was worked out by hand before the painter was asked.

type Painted = Extract<TextPicture, { ok: true }>;
function paint(words: string, changes: Partial<TextInk> = {}, frame: TextFrame = PROOF_FRAME): Painted {
  const picture = paintText(words, proofInk(changes), frame, proofFace().face);
  if (!picture.ok) throw new Error(picture.reason);
  return picture;
}
const pixel = (picture: Painted, x: number, y: number): number[] => Array.from(picture.rgba.subarray((y * picture.width + x) * 4, (y * picture.width + x) * 4 + 4));
/** The alpha bytes of row `y` from `from` up to `to`. */
const alphas = (picture: Painted, y: number, from: number, to: number): number[] => Array.from({ length: to - from }, (_, at) => picture.rgba[(y * picture.width + from + at) * 4 + 3]!);
const inked = (picture: Painted): number => picture.rgba.reduce((count, value, at) => count + (at % 4 === 3 && value > 0 ? 1 : 0), 0);
/** All the ink in the picture, in whole pixels of full ink. */
const weight = (picture: Painted): number => picture.rgba.reduce((sum, value, at) => sum + (at % 4 === 3 ? value : 0), 0) / 255;
const hash = (picture: Painted): string => createHash("sha256").update(picture.rgba).digest("hex");
/** Every pixel is `ink` inside the box and four zeros outside it. */
function only(picture: Painted, left: number, top: number, right: number, bottom: number, ink = [255, 255, 255, 255]): void {
  for (let y = 0; y < picture.height; y++) for (let x = 0; x < picture.width; x++) {
    assert.deepEqual(pixel(picture, x, y), x >= left && x < right && y >= top && y < bottom ? ink : [0, 0, 0, 0], `${x},${y}`);
  }
}
/** `near` read at (x, y) is `far` read `dx`, `dy` further on, wherever both lie in their frames. */
function shifted(near: Painted, far: Painted, dx: number, dy: number): void {
  let compared = 0;
  for (let y = 0; y < near.height; y++) for (let x = 0; x < near.width; x++) {
    if (x + dx < 0 || x + dx >= far.width || y + dy < 0 || y + dy >= far.height) continue;
    assert.deepEqual(pixel(near, x, y), pixel(far, x + dx, y + dy), `${x},${y}`);
    compared++;
  }
  assert.ok(compared > 0);
}
/** A 4-pixel bar through boxes of 3, 3 and 5, in 45ths: what a sigma of 2 makes of one side of the proof "a". */
const SPREAD = [1, 4, 10, 18, 26, 31, 31, 26, 18, 10, 4, 1];
/** The alpha byte of that letter's soft shadow, `column` and `row` counted from the spread's corner. */
const spread = (opacity: number, column: number, row: number): number => Math.round(opacity * SPREAD[column]! * SPREAD[row]! / 2025 * 255);
/** How many pixels of the spread hold ink from `from` columns in. */
const spreadInked = (opacity: number, from = 0): number => SPREAD.slice(from).reduce((count, _, column) => count + SPREAD.filter((__, row) => spread(opacity, from + column, row) > 0).length, 0);
const repeat = (count: number, value: number): number[] => Array.from({ length: count }, () => value);
const BLACK = "#000000", RED = "#ff0000", BLUE = "#0000ff";
/** Black at the cap line to (200, 100, 50) at the baseline. */
const GRADIENT = { kind: "gradient" as const, stops: [{ at: 0, color: BLACK }, { at: 1, color: "#c86432" }] };

test("a letter on the pixel grid inks its own pixels wholly and leaves the rest of the frame empty", () => {
  const picture = paint("a");
  assert.deepEqual([picture.width, picture.height, picture.rgba.length, picture.drawnSize], [64, 64, 64 * 64 * 4, 0.125]);
  assert.ok(picture.rgba instanceof Uint8Array);
  only(picture, 16, 30, 20, 34);
  // The same record on a frame twice the size is the same picture twice the size.
  only(paint("a", {}, { width: 128, height: 128 }), 32, 60, 40, 68);
  only(paint("a", { align: "right", x: 0.75, y: 0.25 }), 43, 14, 47, 18);
});

test("a letter half a pixel off the grid inks its edge pixels by half and its corners by a quarter", () => {
  const picture = paint("a", { x: 16.5 / 64, y: 32.5 / 64, fill: { kind: "solid", color: "#3c78b4" } });
  assert.deepEqual(alphas(picture, 29, 15, 22), repeat(7, 0));
  assert.deepEqual(alphas(picture, 30, 15, 22), [0, 64, 128, 128, 128, 64, 0]);
  for (const y of [31, 32, 33]) assert.deepEqual(alphas(picture, y, 15, 22), [0, 128, 255, 255, 255, 128, 0]);
  assert.deepEqual(alphas(picture, 34, 15, 22), [0, 64, 128, 128, 128, 64, 0]);
  assert.deepEqual(alphas(picture, 35, 15, 22), repeat(7, 0));
  assert.equal(inked(picture), 25);
  // Straight alpha: a pixel a quarter covered is the fill's own colour at a quarter, not a darker one.
  assert.deepEqual(pixel(picture, 16, 30), [60, 120, 180, 64]);
  assert.deepEqual(pixel(picture, 18, 32), [60, 120, 180, 255]);
});

test("a counter stays empty and letters that overlap are inked once", () => {
  // At a 16-pixel em "o" is an 8-pixel square from (16, 28) with a 4-pixel counter from (18, 30).
  const ring = paint("o", { size: 0.25 });
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const outer = x >= 16 && x < 24 && y >= 28 && y < 36, counter = x >= 18 && x < 22 && y >= 30 && y < 34;
    assert.deepEqual(pixel(ring, x, y), outer && !counter ? [255, 255, 255, 255] : [0, 0, 0, 0], `${x},${y}`);
  }
  // "x" is two contours that overlap into the square "a" is: the same bytes.
  assert.deepEqual(paint("x").rgba, paint("a").rgba);
  // "w" reaches two pixels back over the letter before it.
  only(paint("aw"), 16, 30, 25, 34);
  // And by a part of a pixel: nothing is inked more than wholly, and the last pixel by its 0.6.
  assert.deepEqual(alphas(paint("aw", { tracking: -0.05 }), 31, 15, 26), [0, ...repeat(8, 255), 153, 0]);
  // Off the grid the two contours share part-inked pixels, and those are inked by the area the
  // two cover together: adding what each covers alone drew a bead wherever letters met.
  for (const changes of [{ y: 32.5 / 64 }, { x: 16.3 / 64, y: 32.7 / 64 }, { size: 0.025 }, { size: 0.03 }, { size: 0.05, x: 0.26 }, { size: 0.4, x: 0.013, y: 0.47 }]) {
    assert.deepEqual(paint("x", changes).rgba, paint("a", changes).rgba, JSON.stringify(changes));
    assert.ok(inked(paint("x", changes)) > 0);
  }
  // Half a pixel down, "w" lies over the last column of "a" on a row both half cover: half ink, not whole.
  const met = paint("aw", { y: 32.5 / 64 });
  assert.deepEqual(alphas(met, 30, 15, 26), [0, ...repeat(9, 128), 0]);
  assert.deepEqual(alphas(met, 32, 15, 26), [0, ...repeat(9, 255), 0]);
  assert.deepEqual(alphas(met, 34, 15, 26), [0, ...repeat(9, 128), 0]);
  // And all of it is the square's 16 pixels, however the two contours share them.
  assert.ok(Math.abs(weight(paint("x", { y: 32.5 / 64 })) - 16) < 0.05);
});

test("a letter half outside the frame inks the part inside exactly and nothing else (SPEC-065 R-9)", () => {
  only(paint("a", { align: "right", x: 3 / 64 }), 0, 30, 2, 34);
  only(paint("a", { x: 62 / 64 }), 62, 30, 64, 34);
  only(paint("a", { y: 0 }), 16, 0, 20, 2);
  only(paint("a", { y: 1 }), 16, 62, 20, 64);
  only(paint("a", { align: "right", x: 3 / 64, y: 0 }), 0, 0, 2, 2);
  only(paint("a", { x: 62 / 64, y: 1 }), 62, 62, 64, 64);
  const part = paint("a", { align: "right", x: 2.5 / 64 });
  assert.deepEqual(alphas(part, 31, 0, 3), [255, 128, 0]);
  assert.equal(inked(part), 8);
  // Wholly outside is an empty picture, not a refusal.
  for (const changes of [{ align: "right" as const, x: 0 }, { x: 1 }, { x: 1, y: 0 }]) assert.ok(paint("a", changes).rgba.every(value => value === 0));
  // A slant and two curves, cut by the left edge and by the top: the part inside is what the same
  // letter shows there on a frame it lies wholly within.
  for (const letter of ["v", "q", "c", "o"]) {
    const within = paint(letter, { size: 0.25, align: "right", x: 38 / 128, y: 0.5 }, { width: 128, height: 64 });
    assert.equal(inked(paint(letter, { size: 0.25, align: "right", x: 6 / 64 })) > 0, true);
    shifted(paint(letter, { size: 0.25, align: "right", x: 6 / 64 }), within, 32, 0);
    shifted(paint(letter, { size: 0.25, align: "right", x: 38 / 128, y: 2 / 64 }, { width: 128, height: 64 }), within, 0, 30);
  }
});

test("curves ink their true area to within the flatness times their length", () => {
  // The largest type a look allows on a tall frame: 8 pixels to the unit, the corner 32 pixels across.
  for (const [letter, area] of [["q", PROOF_QUADRATIC_AREA], ["c", PROOF_CUBIC_AREA]] as const) {
    for (const [size, unit] of [[0.05, 1], [0.1, 2], [0.4, 8]] as const) {
      const drawn = weight(paint(letter, { size }, { width: 64, height: 160 })), exact = area * unit * unit;
      // Chords lie inside the curve, so the ink falls short, by less than a strip TEXT_FLATNESS wide
      // along a curve no longer than its 8-unit control polygon. Half a pixel more for rounding to bytes.
      assert.ok(drawn <= exact + 0.5 && exact - drawn <= TEXT_FLATNESS * 8 * unit + 0.5, `${letter} at ${size}: ${drawn} for ${exact}`);
    }
  }
});

test("the edge is a line of its own width centred on the outline, under the fill (SPEC-065 R-11)", () => {
  // A 16-pixel em and an edge an eighth of it: one pixel either side of an 8-pixel square from (16, 28).
  const edged = paint("a", { size: 0.25, edge: { color: RED, width: 0.125 } });
  assert.deepEqual(alphas(edged, 26, 13, 27), repeat(14, 0));
  // Round at the corners: the corner pixel's middle is √½ from the corner, and inked 1.5 - √½.
  assert.deepEqual(alphas(edged, 27, 13, 27), [0, 0, 202, ...repeat(8, 255), 202, 0, 0]);
  assert.deepEqual(alphas(edged, 30, 13, 27), [0, 0, ...repeat(10, 255), 0, 0]);
  assert.deepEqual(pixel(edged, 15, 30), [255, 0, 0, 255]);
  assert.deepEqual(pixel(edged, 15, 27), [255, 0, 0, 202]);
  // The inner half is there and the fill lies over it.
  for (const x of [16, 17, 23]) assert.deepEqual(pixel(edged, x, 30), [255, 255, 255, 255]);
  assert.deepEqual(pixel(edged, 24, 30), [255, 0, 0, 255]);
  assert.equal(inked(edged), 100);
  // In a counter the inner half shows: one pixel in from each side of the 4-pixel hole, round where two sides meet.
  const ring = paint("o", { size: 0.25, edge: { color: RED, width: 0.125 } });
  assert.deepEqual([pixel(ring, 18, 31), pixel(ring, 18, 30), pixel(ring, 19, 31), pixel(ring, 20, 32)], [[255, 0, 0, 255], [255, 0, 0, 255], [0, 0, 0, 0], [0, 0, 0, 0]]);
  // The thinnest edge a look allows is 0.08 of a pixel here: it tends to nothing, never to a whole pixel.
  const hair = paint("a", { size: 0.25, edge: { color: RED, width: 0.005 } });
  assert.deepEqual(pixel(hair, 15, 30), [255, 0, 0, 10]);
  assert.deepEqual(pixel(hair, 14, 30), [0, 0, 0, 0]);
  assert.deepEqual(pixel(hair, 16, 30), [255, 255, 255, 255]);
  // An outline through pixel middles: the edge inks that pixel wholly and the fill lies over half of it.
  const through = paint("a", { size: 0.25, x: 16.5 / 64, edge: { color: RED, width: 0.0625 } });
  assert.deepEqual(pixel(through, 16, 31), [255, 128, 128, 255]);
  assert.deepEqual(pixel(through, 15, 31), [0, 0, 0, 0]);
  assert.deepEqual(pixel(through, 17, 31), [255, 255, 255, 255]);
});

test("the shadow is the letters' own shape, moved by whole pixels, under them", () => {
  const shadow = { color: BLACK, opacity: 0.5, blur: 0, dx: 0.25, dy: 0.125 };
  const cast = paint("a", { shadow });
  // Two pixels right and one down of the letter, at half strength where the letter does not cover it.
  for (let y = 28; y < 38; y++) for (let x = 14; x < 26; x++) {
    const letter = x >= 16 && x < 20 && y >= 30 && y < 34, moved = x >= 18 && x < 22 && y >= 31 && y < 35;
    assert.deepEqual(pixel(cast, x, y), letter ? [255, 255, 255, 255] : moved ? [0, 0, 0, 128] : [0, 0, 0, 0], `${x},${y}`);
  }
  assert.equal(inked(cast), 26);
  // An offset is rounded to whole pixels, so a shadow is never a resampled, softer copy.
  assert.deepEqual(paint("a", { shadow: { ...shadow, dx: 0.3 } }).rgba, cast.rgba);
  assert.notDeepEqual(paint("a", { shadow: { ...shadow, dx: 0.32 } }).rgba, cast.rgba);
  assert.deepEqual(pixel(paint("a", { shadow: { ...shadow, dx: -0.25, dy: -0.125 } }), 14, 29), [0, 0, 0, 128]);
  // No opacity is no shadow.
  assert.deepEqual(paint("a", { shadow: { ...shadow, opacity: 0 } }).rgba, paint("a").rgba);
  // The edge casts with the letters; the rule and the backing cast nothing.
  const edged = paint("a", { size: 0.25, edge: { color: RED, width: 0.125 }, shadow: { color: BLACK, opacity: 1, blur: 0, dx: 1, dy: 0 } });
  assert.deepEqual([pixel(edged, 31, 30), pixel(edged, 31, 27), pixel(edged, 30, 30), pixel(edged, 40, 30), pixel(edged, 41, 30)], [[0, 0, 0, 255], [0, 0, 0, 202], [0, 0, 0, 0], [0, 0, 0, 255], [0, 0, 0, 0]]);
  const ruled = paint("a", { rule: { length: 0.5, weight: 0.125, gap: 0.25, soft: false }, backing: { kind: "box", color: BLUE, opacity: 0 }, shadow: { color: BLACK, opacity: 1, blur: 0, dx: 0, dy: 1 } });
  assert.deepEqual(alphas(ruled, 36, 15, 49), [0, ...repeat(32, 255), 0]);
  assert.deepEqual(alphas(ruled, 40, 15, 49), [0, ...repeat(4, 255), ...repeat(29, 0)]);
  assert.deepEqual(alphas(ruled, 44, 15, 49), repeat(34, 0));
});

test("softness spreads the shadow evenly and keeps all of it", () => {
  assert.equal(TEXT_SHADOW_SIGMA, 0.5);
  // Softness 0.5 of an 8-pixel em is a sigma of 2: boxes of 3, 3 and 5, reaching 4 pixels. Moved a
  // whole em down, the shadow is clear of the letter: a 4-pixel square from (16, 38), spread over (12, 34) to (24, 46).
  const soft = paint("a", { shadow: { color: "#102030", opacity: 0.5, blur: 0.5, dx: 0, dy: 1 } });
  only({ ...soft, rgba: soft.rgba.slice(0, 34 * 64 * 4), height: 34 }, 16, 30, 20, 34);
  let shade = 0;
  for (let y = 34; y < 64; y++) for (let x = 0; x < 64; x++) {
    const alpha = x >= 12 && x < 24 && y >= 34 && y < 46 ? spread(0.5, x - 12, y - 34) : 0;
    assert.deepEqual(pixel(soft, x, y), alpha ? [16, 32, 48, alpha] : [0, 0, 0, 0], `${x},${y}`);
    shade += alpha / 255;
  }
  // Half of 16 pixels of letter, give or take the rounding of 144 bytes: none of it is lost at the rim.
  assert.ok(Math.abs(shade - 8) < 0.3, `${shade}`);
  // The middle four pixels hold the most, and the corner one part in 45² of a pixel: too little to be a byte, and so four zeros.
  assert.deepEqual([pixel(soft, 17, 39)[3], pixel(soft, 18, 40)[3], pixel(soft, 12, 39)[3], pixel(soft, 12, 34)[3]], [61, 61, 2, 0]);
});

test("a shadow beside the frame's edge is the shadow it would be anywhere, and ink outside the frame still casts in", () => {
  const shadow = { color: "#102030", opacity: 0.8, blur: 0.5, dx: 0, dy: 0 };
  const far = paint("a", { shadow });
  // Twelve pixels square, less the three faintest of each corner, which round to no byte.
  assert.deepEqual([inked(far), spreadInked(0.8)], [132, 132]);
  // One pixel in from the left, where the blur reaches three pixels past the frame; then the same at the top.
  shifted(paint("a", { shadow, x: 1 / 64 }), far, 15, 0);
  shifted(paint("a", { shadow, y: 2 / 64 }), far, 0, 30);
  shifted(paint("a", { shadow, x: 61 / 64, y: 1 }), far, -45, -32);
  // Half the letter outside: its hidden half still darkens the frame.
  const half = paint("a", { shadow, align: "right", x: 3 / 64 });
  shifted(half, paint("a", { shadow, align: "right", x: 21 / 64 }), 18, 0);
  assert.deepEqual([inked(half), spreadInked(0.8, 6)], [66, 66]);
  // The whole letter outside and its shadow thrown a whole em in: no letter in the picture, and all of its shadow.
  const thrown = { color: BLACK, opacity: 1, blur: 0, dx: 1, dy: 0 };
  only(paint("a", { shadow: thrown, align: "right", x: 0 }), 3, 30, 7, 34, [0, 0, 0, 255]);
  const outside = paint("a", { shadow: { ...thrown, blur: 0.5 }, align: "right", x: 0 });
  shifted(outside, paint("a", { shadow: { ...thrown, blur: 0.5 } }), 21, 0);
  assert.deepEqual([inked(outside), spreadInked(1, 1)], [130, 130]);
  // And the other way: a shadow thrown out of the frame leaves the letter alone.
  assert.deepEqual(paint("a", { shadow: { ...thrown, dx: -1, dy: -1, blur: 0.25 }, x: 0, y: 0 }).rgba, paint("a", { x: 0, y: 0 }).rgba);
});

test("a gradient runs from each line's cap line to its baseline, read at the middle of each pixel (SPEC-065 R-11)", () => {
  const graded = paint("a", { fill: GRADIENT });
  // Rows 30 to 33 are an eighth, three, five and seven eighths of the way down.
  assert.deepEqual([30, 31, 32, 33].map(y => pixel(graded, 17, y)), [[25, 13, 6, 255], [75, 38, 19, 255], [125, 63, 31, 255], [175, 88, 44, 255]]);
  assert.deepEqual(pixel(graded, 16, 31), pixel(graded, 19, 31));
  // Below the baseline is the last colour and above the cap line the first: a descender and an accent.
  const below = paint("p", { fill: GRADIENT });
  assert.deepEqual([33, 34, 35].map(y => pixel(below, 17, y)), [[175, 88, 44, 255], [200, 100, 50, 255], [200, 100, 50, 255]]);
  assert.deepEqual(pixel(paint("v́", { fill: GRADIENT }), 18, 28), [0, 0, 0, 255]);
  // Each line starts the gradient again.
  const lines = paint("a\na", { fill: GRADIENT });
  assert.deepEqual([26, 29, 34, 37].map(y => pixel(lines, 17, y)), [[25, 13, 6, 255], [175, 88, 44, 255], [25, 13, 6, 255], [175, 88, 44, 255]]);
  // Half a pixel down, the first row's middle is on the cap line and the last row's on the baseline.
  const offset = paint("a", { fill: GRADIENT, y: 32.5 / 64 });
  assert.deepEqual([30, 31, 34].map(y => pixel(offset, 17, y)), [[0, 0, 0, 128], [50, 25, 13, 255], [200, 100, 50, 128]]);
  // Two stops at one place are a hard step, the later colour at the place itself.
  const step = { kind: "gradient" as const, stops: [{ at: 0, color: RED }, { at: 0.5, color: RED }, { at: 0.5, color: BLUE }, { at: 1, color: BLUE }] };
  assert.deepEqual([30, 31, 32, 33].map(y => pixel(paint("a", { fill: step }), 17, y)), [[255, 0, 0, 255], [255, 0, 0, 255], [0, 0, 255, 255], [0, 0, 255, 255]]);
  assert.deepEqual([31, 32, 33].map(y => pixel(paint("a", { fill: step, y: 32.5 / 64 }), 17, y)), [[255, 0, 0, 255], [0, 0, 255, 255], [0, 0, 255, 255]]);
});

test("the rule is a bar in the fill's colour, hard or faded over its first and last quarter (SPEC-065 R-12)", () => {
  assert.equal(TEXT_RULE_SOFT_END, 0.25);
  const rule = { length: 0.5, weight: 0.125, gap: 0.25, soft: false };
  // Half the frame long from the anchor, an eighth of an em thick, a quarter of an em under the baseline.
  const hard = paint("aa", { rule });
  assert.deepEqual(alphas(hard, 36, 15, 49), [0, ...repeat(32, 255), 0]);
  for (const y of [34, 35, 37]) assert.deepEqual(alphas(hard, y, 0, 64), repeat(64, 0));
  assert.deepEqual(pixel(hard, 40, 36), [255, 255, 255, 255]);
  const ramp = [16, 48, 80, 112, 143, 175, 207, 239];
  assert.deepEqual(alphas(paint("aa", { rule: { ...rule, soft: true } }), 36, 15, 49), [0, ...ramp, ...repeat(16, 255), ...ramp.toReversed(), 0]);
  // Edges by area: half a pixel thick is half ink, and a bar across two rows shares itself between them.
  assert.deepEqual(alphas(paint("aa", { rule: { ...rule, weight: 0.0625 } }), 36, 15, 49), [0, ...repeat(32, 128), 0]);
  const across = paint("aa", { rule: { ...rule, gap: 0.3125 } });
  assert.deepEqual([pixel(across, 20, 36)[3], pixel(across, 20, 37)[3], pixel(across, 20, 38)[3]], [128, 128, 0]);
  assert.deepEqual(alphas(paint("aa", { rule: { ...rule, length: 0.3984375 } }), 36, 40, 43), [255, 128, 0]);
  // Under a gradient it is the colour half-way down a line, the whole bar one colour.
  const graded = paint("aa", { rule, fill: GRADIENT });
  assert.deepEqual([pixel(graded, 16, 36), pixel(graded, 47, 36)], [[100, 50, 25, 255], [100, 50, 25, 255]]);
  // It is drawn last: over a descender that reaches it.
  const over = paint("p", { rule: { ...rule, gap: 0 }, fill: GRADIENT });
  assert.deepEqual([pixel(over, 17, 33), pixel(over, 17, 34), pixel(over, 17, 35), pixel(over, 30, 34)], [[175, 88, 44, 255], [100, 50, 25, 255], [200, 100, 50, 255], [100, 50, 25, 255]]);
});

test("a box backing keeps 0.4 of an em clear on every side of the words and their rule (SPEC-065 R-12)", () => {
  assert.equal(TEXT_BOX_PADDING, 0.4);
  // The block is (16, 28) to (21, 36); 3.2 pixels out is (12.8, 24.8) to (24.2, 39.2), its edges by area.
  const boxed = paint("a", { backing: { kind: "box", color: "#204060", opacity: 1 } });
  assert.deepEqual(alphas(boxed, 23, 10, 27), repeat(17, 0));
  assert.deepEqual(alphas(boxed, 24, 10, 27), [0, 0, 10, ...repeat(11, 51), 10, 0, 0]);
  assert.deepEqual(alphas(boxed, 26, 10, 27), [0, 0, 51, ...repeat(11, 255), 51, 0, 0]);
  assert.deepEqual(alphas(boxed, 39, 10, 27), [0, 0, 10, ...repeat(11, 51), 10, 0, 0]);
  assert.deepEqual(alphas(boxed, 40, 10, 27), repeat(17, 0));
  assert.deepEqual([pixel(boxed, 14, 26), pixel(boxed, 12, 26), pixel(boxed, 17, 31)], [[32, 64, 96, 255], [32, 64, 96, 51], [255, 255, 255, 255]]);
  const faint = paint("a", { backing: { kind: "box", color: "#204060", opacity: 0.6 } });
  assert.deepEqual([pixel(faint, 14, 26), pixel(faint, 12, 26), pixel(faint, 17, 31)], [[32, 64, 96, 153], [32, 64, 96, 31], [255, 255, 255, 255]]);
  // It lies behind the rule as well as the words: the rule runs to 48 and sits from 36 to 37.
  const ruled = paint("a", { backing: { kind: "box", color: "#204060", opacity: 1 }, rule: { length: 0.5, weight: 0.125, gap: 0.25, soft: false } });
  assert.deepEqual(alphas(ruled, 26, 49, 54), [255, 255, 51, 0, 0]);
  assert.deepEqual([pixel(ruled, 30, 39)[3], pixel(ruled, 30, 40)[3], pixel(ruled, 30, 41)[3]], [255, 51, 0]);
  // The room is the type's: at twice the em it is twice as many pixels.
  assert.deepEqual(alphas(paint("a", { size: 0.25, backing: { kind: "box", color: "#204060", opacity: 1 } }), 30, 8, 12), [0, 102, 255, 255]);
  assert.deepEqual(paint("a", { backing: { kind: "box", color: "#204060", opacity: 0 } }).rgba, paint("a").rgba);
});

test("a shade backing is fullest behind the words and gone 1.8 ems to the side and 1.2 above and below", () => {
  assert.deepEqual([TEXT_SHADE_REACH_X, TEXT_SHADE_REACH_Y], [1.8, 1.2]);
  const shaded = paint("a", { backing: { kind: "shade", color: "#0a141e", opacity: 0.5 } });
  // The block's middle is (18.5, 32); the ellipse is half its width and 14.4 pixels wide of that, half its height and 9.6 tall.
  const wide = 2.5 + 14.4, tall = 4 + 9.6;
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    if (x >= 16 && x < 20 && y >= 30 && y < 34) { assert.deepEqual(pixel(shaded, x, y), [255, 255, 255, 255]); continue; }
    const across = (x + 0.5 - 18.5) / wide, down = (y + 0.5 - 32) / tall, s = Math.min(1, across * across + down * down);
    const byte = Math.round(0.5 * (1 - s * s * (3 - 2 * s)) * 255);
    assert.deepEqual(pixel(shaded, x, y), byte ? [10, 20, 30, byte] : [0, 0, 0, 0], `${x},${y}`);
  }
  // Beside the letter it is all but the whole opacity, and it has gone before the ellipse's own edge.
  assert.deepEqual([pixel(shaded, 15, 31)[3], pixel(shaded, 20, 32)[3]], [127, 127]);
  assert.deepEqual([pixel(shaded, 1, 31)[3], pixel(shaded, 35, 31)[3], pixel(shaded, 18, 18)[3], pixel(shaded, 18, 45)[3]], [0, 0, 0, 0]);
  assert.ok(pixel(shaded, 6, 31)[3]! > 0 && pixel(shaded, 18, 22)[3]! > 0);
  // Falling away the same on both sides, and never rising on the way out.
  for (let x = 20; x < 36; x++) {
    assert.equal(pixel(shaded, x, 36)[3], pixel(shaded, 36 - x, 36)[3], `${x}`);
    assert.ok(pixel(shaded, x + 1, 36)[3]! <= pixel(shaded, x, 36)[3]!, `${x}`);
  }
  assert.deepEqual(paint("a", { backing: { kind: "shade", color: "#0a141e", opacity: 0 } }).rgba, paint("a").rgba);
});

test("backing, shadow, edge, fill, rule: each goes over the ones before it (SPEC-065 R-13)", () => {
  // One pixel that all five reach, none of them wholly. "p" set half a pixel right puts its left
  // side down the middle of column 16, and it descends to row 36, past a rule on the baseline:
  //   the fill covers half of pixel (16, 34), in the gradient's last colour, yellow;
  //   the edge, half a pixel wide and centred on that side, half of it, in red;
  //   the shadow, unmoved and sharp, is their shape at 0.8: 0.4, in black;
  //   the rule, half a pixel thick from the baseline and starting mid-pixel, a quarter, in the colour half-way down;
  //   the box is whole there, in blue.
  const look: Partial<TextInk> = {
    x: 16.5 / 64, fill: { kind: "gradient", stops: [{ at: 0, color: "#00ff00" }, { at: 1, color: "#ffff00" }] },
    edge: { color: RED, width: 0.0625 }, shadow: { color: BLACK, opacity: 0.8, blur: 0, dx: 0, dy: 0 },
    rule: { length: 0.5, weight: 0.0625, gap: 0, soft: false }, backing: { kind: "box", color: BLUE, opacity: 1 },
  };
  type Colour = [number, number, number, number];
  const over = (under: Colour, [red, green, blue]: number[], alpha: number): Colour =>
    [red! * alpha + under[0] * (1 - alpha), green! * alpha + under[1] * (1 - alpha), blue! * alpha + under[2] * (1 - alpha), alpha + under[3] * (1 - alpha)];
  const layers: [number[], number][] = [[[0, 0, 255], 1], [[0, 0, 0], 0.4], [[255, 0, 0], 0.5], [[255, 255, 0], 0.5], [[127.5, 255, 0], 0.25]];
  const bytes = ([red, green, blue, alpha]: Colour) => [Math.round(red / alpha), Math.round(green / alpha), Math.round(blue / alpha), Math.round(alpha * 255)];
  const stacked = (order: number[]) => bytes(order.reduce<Colour>((under, index) => over(under, ...layers[index]!), [0, 0, 0, 0]));
  assert.deepEqual(stacked([0, 1, 2, 3, 4]), [175, 159, 29, 255]);
  assert.deepEqual(pixel(paint("p", look), 16, 34), [175, 159, 29, 255]);
  // Any two neighbours the other way round would be a different pixel, so this one pixel fixes the whole order.
  for (const order of [[1, 0, 2, 3, 4], [0, 2, 1, 3, 4], [0, 1, 3, 2, 4], [0, 1, 2, 4, 3]]) assert.notDeepEqual(stacked(order), [175, 159, 29, 255]);
  // With nothing behind them the four go over an empty frame: straight alpha, the colour kept whole.
  assert.deepEqual(stacked([1, 2, 3, 4]), [198, 180, 0, 226]);
  assert.deepEqual(pixel(paint("p", { ...look, backing: undefined }), 16, 34), [198, 180, 0, 226]);
  // And each pair in turn.
  assert.deepEqual(pixel(paint("p", { ...look, backing: undefined, rule: undefined, fill: { kind: "solid", color: "#ffff00" } }), 16, 34), stacked([1, 2, 3]));
  assert.deepEqual(pixel(paint("p", { ...look, backing: undefined, rule: undefined, shadow: undefined, fill: { kind: "solid", color: "#ffff00" } }), 16, 34), stacked([2, 3]));
  assert.deepEqual(pixel(paint("p", { ...look, edge: undefined, shadow: undefined }), 16, 34), stacked([0, 3, 4]));
});

test("a pixel with no ink is four zero bytes, whatever passed over it", () => {
  const looks: Partial<TextInk>[] = [
    { backing: { kind: "shade", color: "#ff8040", opacity: 0.3 }, shadow: { color: "#4080ff", opacity: 0.4, blur: 1, dx: 0.5, dy: 0.5 }, edge: { color: RED, width: 0.2 } },
    { backing: { kind: "box", color: "#ff8040", opacity: 0.001 }, rule: { length: 1, weight: 0.005, gap: 2, soft: true }, fill: GRADIENT },
    { shadow: { color: "#ffffff", opacity: 0.002, blur: 0.25, dx: 0, dy: 0 }, size: 0.4, x: 0, y: 1 },
  ];
  for (const look of looks) {
    const picture = paint("qo\nv́a", look, { width: 96, height: 64 });
    let empty = 0;
    for (let at = 0; at < picture.rgba.length; at += 4) {
      if (picture.rgba[at + 3]! > 0) continue;
      empty++;
      assert.deepEqual([picture.rgba[at], picture.rgba[at + 1], picture.rgba[at + 2]], [0, 0, 0], `${at / 4}`);
    }
    assert.ok(empty > 0 && inked(picture) > 0);
  }
  // Ink too faint to be a byte is no ink: the colour is not left behind under an alpha of nothing.
  assert.ok(paint("a", { fill: { kind: "solid", color: "#000000" }, backing: { kind: "box", color: "#ffffff", opacity: 0.001 } }).rgba.every((value, at) => value === 0 || (at >> 2) % 64 >= 16));
  // A space has no outline: nothing is drawn for it, and the word after it stands three units on.
  const spaced = paint("a a");
  assert.equal(inked(spaced), 32);
  assert.deepEqual(alphas(spaced, 31, 15, 29), [0, ...repeat(4, 255), 0, 0, 0, 0, ...repeat(4, 255), 0]);
  // Words that are only spaces are no words. There is no blank picture to hand back, with a rule under it or without (R-3).
  const rule = { length: 0.5, weight: 0.125, gap: 0.25, soft: false };
  for (const words of [" ", "", "\n", "  \n "]) for (const changes of [{}, { rule }, { backing: { kind: "box" as const, color: RED, opacity: 1 } }]) {
    assert.deepEqual(paintText(words, proofInk(changes), PROOF_FRAME, proofFace().face), { ok: false, reason: "Type some words" }, JSON.stringify(words));
  }
  // A gradient with no colours is refused by name and never thrown out of the painter.
  assert.deepEqual(paintText("a", proofInk({ fill: { kind: "gradient", stops: [] } }), PROOF_FRAME, proofFace().face), { ok: false, reason: "A gradient fill has no colours" });
  assert.equal(inked(paint("a ", { rule })), 16 + 32);
});

test("Fit draws smaller and says what size it drew (SPEC-065 R-10)", () => {
  // Eight letters are 40 pixels wide where 32 are allowed: everything is drawn at four fifths.
  const fitted = paint("aaaaaaaa", { room: 0.5 });
  assert.ok(Math.abs(fitted.drawnSize - 0.1) < 1e-12);
  assert.equal(paint("aaaaaaaa", { room: 0.625 }).drawnSize, 0.125);
  // Each letter is 3.2 pixels square now, 4 apart, from the cap line at 30.4.
  assert.ok(Math.abs(weight(fitted) - 8 * 3.2 * 3.2) < 0.2, `${weight(fitted)}`);
  assert.deepEqual(alphas(fitted, 31, 15, 25), [0, 255, 255, 255, 51, 255, 255, 255, 51, 255]);
  assert.deepEqual(alphas(fitted, 30, 16, 20), [153, 153, 153, 31]);
  assert.deepEqual(alphas(fitted, 31, 44, 49), [255, 255, 255, 51, 0]);
  // A box keeps 0.4 of the em drawn, not of the em chosen: 2.56 pixels around a block from (16, 28.8) to (48, 35.2).
  const boxed = paint("aaaaaaaa", { room: 0.5, backing: { kind: "box", color: "#204060", opacity: 1 } });
  assert.deepEqual([alphas(boxed, 28, 12, 15), alphas(boxed, 28, 49, 52)], [[0, 143, 255], [255, 143, 0]]);
  assert.deepEqual([[25, 26, 27].map(y => pixel(boxed, 30, y)[3]), [36, 37, 38].map(y => pixel(boxed, 30, y)[3])], [[0, 194, 255], [255, 194, 0]]);
  // A shadow is thrown by the em drawn as well: 0.7 of 6.4 pixels is 4 whole pixels down, where 0.7 of 8 would be 6.
  const thrown = paint("aaaaaaaa", { room: 0.5, shadow: { color: BLACK, opacity: 1, blur: 0, dx: 0, dy: 0.7 } });
  assert.deepEqual([33, 34, 35, 36, 37, 38, 39].map(y => pixel(thrown, 17, y)), [[255, 255, 255, 153], [0, 0, 0, 153], [0, 0, 0, 255], [0, 0, 0, 255], [0, 0, 0, 153], [0, 0, 0, 0], [0, 0, 0, 0]]);
});

test("a mark is drawn where the shaping lifts it: up the frame for an offset above the baseline", () => {
  // The proof grave is drawn on the baseline and lifted five units: over "v" it is the pixel at (18, 28).
  const lifted = paint("v̀");
  assert.deepEqual([pixel(lifted, 18, 28), pixel(lifted, 18, 27), pixel(lifted, 18, 29), pixel(lifted, 18, 38), pixel(lifted, 18, 39)], [[255, 255, 255, 255], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
  // The letter's eight pixels and the mark's one: a mark left on the baseline would be lost inside the letter.
  assert.ok(Math.abs(weight(lifted) - 9) < 0.01, `${weight(lifted)}`);
  assert.ok(Math.abs(weight(paint("v")) - 8) < 0.01);
  // Twice the em lifts it twice as far.
  assert.deepEqual(pixel(paint("v̀", { size: 0.25 }), 20, 24), [255, 255, 255, 255]);
});

test("an edge and a shadow on letters that hang off the left and the top are the picture a larger frame shows there", () => {
  // The working rectangle reaches past the frame for the shadow's sake: the edge must still ink only the frame.
  const look: Partial<TextInk> = { size: 0.25, align: "right", edge: { color: RED, width: 0.125 }, shadow: { color: "#102030", opacity: 0.8, blur: 0.5, dx: 0.25, dy: 0.125 } };
  for (const letter of ["a", "o", "v", "q"]) {
    const within = paint(letter, { ...look, x: 38 / 128, y: 0.5 }, { width: 128, height: 64 });
    const hung = paint(letter, { ...look, x: 6 / 64, y: 2 / 64 });
    assert.ok(inked(hung) > 20 && inked(hung) < inked(within), letter);
    shifted(hung, within, 32, 30);
    // The same hanging off the right and the bottom, where the shadow is thrown out of the frame.
    shifted(paint(letter, { ...look, x: 66 / 64, y: 62 / 64 }), paint(letter, { ...look, x: 66 / 128, y: 0.5 }, { width: 128, height: 64 }), 0, -30);
  }
  // The letter is (-4, -2) to (4, 6): its edge's red runs down the fifth column and along the seventh row, cut by the frame.
  const hung = paint("a", { ...look, x: 6 / 64, y: 2 / 64 });
  assert.deepEqual([pixel(hung, 4, 3), pixel(hung, 0, 6), pixel(hung, 3, 0)], [[255, 0, 0, 255], [255, 0, 0, 255], [255, 255, 255, 255]]);
});

/** The cells of every working plane a call makes, counted as the call makes them. */
function cellsMade(run: () => void): number {
  const kinds = [["Float32Array", Float32Array], ["Float64Array", Float64Array]] as const, scope = globalThis as unknown as Record<string, unknown>;
  let cells = 0;
  for (const [name, kind] of kinds) scope[name] = new Proxy(kind, { construct(target, args, made) { const plane = Reflect.construct(target, args, made) as ArrayLike<number>; cells += plane.length; return plane; } });
  try { run(); } finally { for (const [name, kind] of kinds) scope[name] = kind; }
  return cells;
}

test("the softest shadow and the widest edge work on the letters' own pixels, not on planes many frames wide", () => {
  // The heaviest look a record allows on a phone frame at a quarter: the largest type, the widest
  // edge, a shadow as soft as it goes, thrown. Its blur reaches further than the frame is wide, and
  // a plane grown by that reach each way was 20 frames of cells here, and seconds at full size.
  const frame = { width: 270, height: 480 }, heavy: Partial<TextInk> = { size: 0.4, x: 0.1, room: 1, edge: { color: RED, width: 0.2 }, shadow: { color: BLACK, opacity: 1, blur: 1, dx: 0.1, dy: 0.1 } };
  let picture: Painted | undefined;
  const cells = cellsMade(() => { picture = paint("aqo", heavy, frame); });
  assert.ok(picture && inked(picture) > frame.width * frame.height / 2);
  assert.ok(cells < 8 * frame.width * frame.height, `${cells / (frame.width * frame.height)} frames of cells`);
  // Counting changes nothing that is drawn.
  assert.deepEqual(picture!.rgba, paint("aqo", heavy, frame).rgba);
});

test("a refusal carries its reason and no picture", () => {
  const { face } = proofFace(), frame = "A text picture is 16 to 8192 whole pixels each way";
  for (const side of [15, 8193, 64.5, Number.NaN, 0, -64]) {
    assert.deepEqual(paintText("a", proofInk(), { width: side, height: 64 }, face), { ok: false, reason: frame });
    assert.deepEqual(paintText("a", proofInk(), { width: 64, height: side }, face), { ok: false, reason: frame });
  }
  assert.deepEqual(paintText("az", proofInk(), PROOF_FRAME, face), { ok: false, reason: "Proof has no z" });
  assert.deepEqual(paintText("a\tv", proofInk({ capitals: true }), PROOF_FRAME, face), { ok: false, reason: "Proof has no U+0009" });
  assert.equal(paintText("a", proofInk(), { width: 16, height: 16 }, face).ok, true);
});

const TITLE: Partial<TextInk> = {
  align: "center", x: 0.5, tracking: 0.02,
  fill: { kind: "gradient", stops: [{ at: 0, color: "#fff4c8" }, { at: 0.4, color: "#e8c46a" }, { at: 0.7, color: "#b98a2e" }, { at: 1, color: "#8a5f1a" }] },
  edge: { color: "#1a1208", width: 0.03 }, shadow: { color: "#000000", opacity: 0.8, blur: 0.25, dx: 0, dy: 0.05 },
  rule: { length: 0.3, weight: 0.03, gap: 0.3, soft: true }, backing: { kind: "shade", color: "#000000", opacity: 0.5 },
};

test("the same words, look and frame give the same bytes, and any change gives others", () => {
  const ink = proofInk(TITLE), stored = structuredClone(ink), first = paintText("qco\nav a", ink, { width: 96, height: 64 }, proofFace().face);
  const second = paintText("qco\nav a", ink, { width: 96, height: 64 }, proofFace().face);
  assert.deepEqual(ink, stored);
  assert.ok(first.ok && second.ok);
  if (!first.ok || !second.ok) return;
  assert.notEqual(first.rgba, second.rgba);
  assert.deepEqual(first.rgba, second.rgba);
  const base: Partial<TextInk> = { ...TITLE, size: 0.15, leading: 1.1, room: 0.9 };
  const changes: [string, string, Partial<TextInk>, TextFrame][] = [
    ["the base", "qco\nav a", {}, { width: 96, height: 64 }],
    ["a word", "qco\nva a", {}, { width: 96, height: 64 }],
    ["a line end", "qco av a", {}, { width: 96, height: 64 }],
    ["the frame's width", "qco\nav a", {}, { width: 97, height: 64 }],
    ["the frame's height", "qco\nav a", {}, { width: 96, height: 65 }],
    ["size", "qco\nav a", { size: 0.16 }, { width: 96, height: 64 }],
    ["tracking", "qco\nav a", { tracking: 0.03 }, { width: 96, height: 64 }],
    ["leading", "qco\nav a", { leading: 1.2 }, { width: 96, height: 64 }],
    // The proof face has capitals for "a" and "v" alone.
    ["other words", "av a", {}, { width: 96, height: 64 }],
    ["capitals", "av a", { capitals: true }, { width: 96, height: 64 }],
    ["align", "qco\nav a", { align: "left" }, { width: 96, height: 64 }],
    ["x", "qco\nav a", { x: 0.51 }, { width: 96, height: 64 }],
    ["y", "qco\nav a", { y: 0.51 }, { width: 96, height: 64 }],
    ["room", "qco\nav a", { room: 0.2 }, { width: 96, height: 64 }],
    ["a stop's colour", "qco\nav a", { fill: { kind: "gradient", stops: [{ at: 0, color: "#fff4c9" }, { at: 0.4, color: "#e8c46a" }, { at: 0.7, color: "#b98a2e" }, { at: 1, color: "#8a5f1a" }] } }, { width: 96, height: 64 }],
    ["a stop's place", "qco\nav a", { fill: { kind: "gradient", stops: [{ at: 0, color: "#fff4c8" }, { at: 0.5, color: "#e8c46a" }, { at: 0.7, color: "#b98a2e" }, { at: 1, color: "#8a5f1a" }] } }, { width: 96, height: 64 }],
    ["a solid fill", "qco\nav a", { fill: { kind: "solid", color: "#fff4c8" } }, { width: 96, height: 64 }],
    ["the edge's colour", "qco\nav a", { edge: { color: "#1a1209", width: 0.03 } }, { width: 96, height: 64 }],
    ["the edge's width", "qco\nav a", { edge: { color: "#1a1208", width: 0.04 } }, { width: 96, height: 64 }],
    ["no edge", "qco\nav a", { edge: undefined }, { width: 96, height: 64 }],
    ["the shadow's colour", "qco\nav a", { shadow: { ...TITLE.shadow!, color: "#000010" } }, { width: 96, height: 64 }],
    ["the shadow's opacity", "qco\nav a", { shadow: { ...TITLE.shadow!, opacity: 0.7 } }, { width: 96, height: 64 }],
    ["the shadow's softness", "qco\nav a", { shadow: { ...TITLE.shadow!, blur: 0.5 } }, { width: 96, height: 64 }],
    ["the shadow's place", "qco\nav a", { shadow: { ...TITLE.shadow!, dx: 0.2 } }, { width: 96, height: 64 }],
    ["no shadow", "qco\nav a", { shadow: undefined }, { width: 96, height: 64 }],
    ["the rule's length", "qco\nav a", { rule: { ...TITLE.rule!, length: 0.35 } }, { width: 96, height: 64 }],
    ["the rule's weight", "qco\nav a", { rule: { ...TITLE.rule!, weight: 0.05 } }, { width: 96, height: 64 }],
    ["the rule's gap", "qco\nav a", { rule: { ...TITLE.rule!, gap: 0.4 } }, { width: 96, height: 64 }],
    ["a hard rule", "qco\nav a", { rule: { ...TITLE.rule!, soft: false } }, { width: 96, height: 64 }],
    ["no rule", "qco\nav a", { rule: undefined }, { width: 96, height: 64 }],
    ["a box", "qco\nav a", { backing: { ...TITLE.backing!, kind: "box" } }, { width: 96, height: 64 }],
    ["the backing's colour", "qco\nav a", { backing: { ...TITLE.backing!, color: "#100000" } }, { width: 96, height: 64 }],
    ["the backing's opacity", "qco\nav a", { backing: { ...TITLE.backing!, opacity: 0.6 } }, { width: 96, height: 64 }],
    ["no backing", "qco\nav a", { backing: undefined }, { width: 96, height: 64 }],
  ];
  const seen = new Map<string, string>();
  for (const [name, words, change, frame] of changes) {
    const digest = hash(paint(words, { ...base, ...change }, frame));
    assert.equal(seen.get(digest), undefined, `${name} draws what ${seen.get(digest)} draws`);
    seen.set(digest, name);
  }
  assert.equal(seen.size, changes.length);
});

test("the painter's pictures are pinned: a change that moves ink raises the painter version (SPEC-065 R-23)", () => {
  // SHA-256 over the raw RGBA, never over an encoded file. These are the pictures of "text-painter-v2",
  // which v1 drew alike: none of them holds a glyph v2 places differently.
  // A hash that changes here means kept pictures no longer match what the painter draws: raise
  // TEXT_PAINTER_VERSION in the same change, then pin the new hashes.
  assert.equal(TEXT_PAINTER_VERSION, "text-painter-v2");
  const pictures: Record<string, [string, Partial<TextInk>, TextFrame]> = {
    // A phone frame at an eighth: the title look, one 17-character line brought in by Fit.
    "title, 135x240": ["qcoqc oqcoq cqoqc", { ...TITLE, size: 0.071, y: 0.75, room: 0.815 }, { width: 135, height: 240 }],
    "plain, 64x64": ["qco", { size: 0.25, x: 0.1 }, { width: 64, height: 64 }],
    // A wide frame: a lower third on a box, tracked, with a hard rule.
    "lower third, 320x136": ["av fi a\nqo p", { size: 0.14, tracking: 0.08, leading: 1.2, x: 0.08, y: 0.72, room: 0.6, fill: { kind: "solid", color: "#f4f1ea" },
      rule: { length: 0.2, weight: 0.05, gap: 0.35, soft: false }, backing: { kind: "box", color: "#101820", opacity: 0.85 } }, { width: 320, height: 136 }],
    // An odd size: three lines with a blank one between, set right, a stepped gradient and a hard shadow.
    "credits, 97x61": ["v́a o\n\nfi qc", { size: 0.16, leading: 1.5, align: "right", x: 0.93, y: 0.48, capitals: false,
      fill: { kind: "gradient", stops: [{ at: 0.5, color: "#3050c0" }, { at: 0, color: "#ffffff" }, { at: 0.5, color: "#ffd040" }, { at: 1, color: "#c03020" }] },
      shadow: { color: "#201008", opacity: 1, blur: 0, dx: 0.1, dy: 0.1 } }, { width: 97, height: 61 }],
    // The largest type, hanging off two edges, with the widest edge and the softest shadow.
    "overhang, 80x48": ["oq", { size: 0.4, x: 0.7, y: 0.2, edge: { color: "#102040", width: 0.2 }, shadow: { color: "#000000", opacity: 0.6, blur: 1, dx: -0.2, dy: 0.3 } }, { width: 80, height: 48 }],
    // Capitals, centred and set tight, with the thinnest edge, over a soft rule in a gradient.
    "capitals, 240x135": ["av a\nva", { size: 0.2, tracking: -0.02, leading: 0.9, capitals: true, align: "center", x: 0.5, y: 0.4,
      fill: { kind: "gradient", stops: [{ at: 0, color: "#e0f0ff" }, { at: 1, color: "#4080c0" }] }, edge: { color: "#ffffff", width: 0.005 },
      rule: { length: 0.5, weight: 0.08, gap: 0.1, soft: true }, backing: { kind: "shade", color: "#200030", opacity: 1 } }, { width: 240, height: 135 }],
    "every part at once, 160x90": ["qc o\nx w", { ...TITLE, size: 0.22, leading: 0.95, room: 0.7, capitals: false, backing: { kind: "box", color: "#203040", opacity: 0.7 } }, { width: 160, height: 90 }],
  };
  const pinned: Record<string, string> = {
    "title, 135x240": "c6a0d21ddaf6d598e0b60a7c6b17d7e91d29f370969fabb8fa4fc7850d0ef26f",
    "plain, 64x64": "5466a5ba63f2c61998764fc730b3aa1132cc53831b34441560c543253cf0966a",
    "lower third, 320x136": "681a14850230650519da12036132c2312f78a5589904ac0e6f83211e9bbfc9b2",
    "credits, 97x61": "84e6acd85a06c92f9718a39a2e790a56ea0c14a84ca1ce19635d0dcc88b5d9fb",
    "overhang, 80x48": "a8bf7b7873596d8603678209cd5a1c338b2dca7429f62d250047d62400848817",
    "capitals, 240x135": "9998ba9cc5f4c300685023c488e6e15543fc211a6d7aa1a114565921f0d16e6c",
    "every part at once, 160x90": "e2afe767798c8de13dad62cd70a1890434a703f58e2f0012e33217f751fceabf",
  };
  const drawn = Object.fromEntries(Object.entries(pictures).map(([name, [words, look, frame]]) => {
    const picture = paint(words, look, frame);
    // A pinned picture of nothing would pin nothing: each has ink, and room around it.
    assert.ok(inked(picture) > 50 && inked(picture) < picture.width * picture.height, name);
    return [name, hash(picture)];
  }));
  assert.deepEqual(drawn, pinned);
  assert.equal(new Set(Object.values(drawn)).size, 7);
});
