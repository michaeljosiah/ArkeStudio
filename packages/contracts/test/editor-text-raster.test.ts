import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TEXT_FLATNESS, blurTextPlane, fillTextCoverage, flattenTextOutline, strokeTextCoverage, textBlurBoxes, textBlurReach, textRectOverlap, textSegmentBounds, textSpanCoverage,
  type TextRasterRect,
} from "../src/editor-text-raster.js";
import { PROOF_CUBIC_AREA, PROOF_QUADRATIC_AREA, proofFace } from "./editor-text-fixture.js";

// Coverage from outlines (SPEC-065 §2.2). The shapes here are ones whose coverage can be said
// without a rasteriser: squares on and off the pixel grid, a triangle, and two curves whose areas
// are known in closed form.

/** A square's four sides as segments, in pixels with y downward. */
const square = (left: number, top: number, right: number, bottom: number): number[] =>
  [left, top, right, top, right, top, right, bottom, right, bottom, left, bottom, left, bottom, left, top];
/** One glyph of the proof face as segments: `unit` pixels to a font unit, its origin at `x`, `y`. */
function glyph(character: string, unit: number, x: number, y: number): number[] {
  const segments: number[] = [];
  flattenTextOutline(proofFace().face.shape(character, { ligatures: false })[0]!.outline, unit, x, y, segments);
  return segments;
}
const rect = (x: number, y: number, width: number, height: number): TextRasterRect => ({ x, y, width, height });
const total = (plane: Float32Array) => plane.reduce((sum, value) => sum + value, 0);
const rows = (plane: Float32Array, width: number): number[][] => Array.from({ length: plane.length / width }, (_, y) => Array.from(plane.subarray(y * width, (y + 1) * width)));
/** A plane made over `from`, read where `to` lies inside it. */
const crop = (plane: Float32Array, from: TextRasterRect, to: TextRasterRect): number[] =>
  Array.from({ length: to.width * to.height }, (_, at) => plane[(Math.floor(at / to.width) + to.y - from.y) * from.width + at % to.width + to.x - from.x]!);
/** Planes are 32-bit: two routes to one value agree to its last few bits, not to the bit. */
const close = (actual: ArrayLike<number>, expected: ArrayLike<number>, tolerance = 1e-5) => {
  assert.equal(actual.length, expected.length);
  for (let at = 0; at < actual.length; at++) assert.ok(Math.abs(actual[at]! - expected[at]!) <= tolerance, `at ${at}: ${actual[at]} is not ${expected[at]}`);
};

test("an outline becomes closed runs of straight segments in frame pixels, y downward", () => {
  // A 4-unit square at one pixel a unit, its origin at (16, 34): up the page is toward smaller y.
  assert.deepEqual(glyph("a", 1, 16, 34), [16, 34, 20, 34, 20, 34, 20, 30, 20, 30, 16, 30, 16, 30, 16, 34]);
  assert.deepEqual(glyph("a", 0.5, 1.5, 2), [1.5, 2, 3.5, 2, 3.5, 2, 3.5, 0, 3.5, 0, 1.5, 0, 1.5, 0, 1.5, 2]);
  // A contour left open is closed, by the next moveTo as much as by the end; a line of no length is not a segment.
  const open: number[] = [7, 7, 7, 7];
  flattenTextOutline([
    { command: "moveTo", args: [0, 0] }, { command: "lineTo", args: [2, 0] }, { command: "lineTo", args: [2, 0] }, { command: "lineTo", args: [2, 2] },
    { command: "moveTo", args: [4, 0] }, { command: "lineTo", args: [6, 0] }, { command: "lineTo", args: [6, 2] },
  ], 1, 0, 10, open);
  assert.deepEqual(open, [7, 7, 7, 7, 0, 10, 2, 10, 2, 10, 2, 8, 2, 8, 0, 10, 4, 10, 6, 10, 6, 10, 6, 8, 6, 8, 4, 10]);
  assert.deepEqual(glyph(" ", 1, 0, 0), []);
});

test("a curve is cut into as many chords as keep it within a tenth of a pixel, and no pixel reads the machine", () => {
  assert.equal(TEXT_FLATNESS, 0.1);
  // The quadratic corner of "q" runs from (4,0) round (4,4) to (0,4). A chord's middle leaves a
  // quadratic by a quarter of its second difference times the step squared: the farthest any point of it gets.
  const pieces = [1, 4, 16, 64].map(unit => {
    const segments = glyph("q", unit, 0, 0), chords = segments.length / 4 - 2, bend = Math.sqrt(32) * unit;
    assert.ok(bend / (4 * chords * chords) <= TEXT_FLATNESS, `${unit}: ${chords} chords`);
    // And no more chords than that needs: one fewer would leave the curve by more.
    assert.ok(bend / (4 * (chords - 1) * (chords - 1)) > TEXT_FLATNESS, `${unit}: ${chords} chords`);
    // Every joint lies on the curve: x = 4u(1 - t²), y = -4u(2t - t²) at even steps of t.
    for (let chord = 1; chord <= chords; chord++) {
      const t = chord / chords, at = 4 + (chord - 1) * 4;
      close([segments[at + 2]!, segments[at + 3]!], [4 * unit * (1 - t * t), -4 * unit * (2 * t - t * t)], 1e-9);
    }
    return chords;
  });
  assert.deepEqual(pieces, [4, 8, 16, 31]);
  // The same controls give the same cut, wherever the glyph sits.
  assert.deepEqual(glyph("c", 3, 0, 0).length, glyph("c", 3, 100.25, -40.5).length);
  assert.deepEqual(glyph("c", 3, 0, 0), glyph("c", 3, 0, 0));
  // A curve with no bend in it is one chord.
  const straight: number[] = [];
  flattenTextOutline([{ command: "moveTo", args: [0, 0] }, { command: "quadraticCurveTo", args: [2, 2, 4, 4] }, { command: "bezierCurveTo", args: [3, 3, 2, 2, 1, 1] }], 1, 0, 0, straight);
  assert.deepEqual(straight, [0, 0, 4, -4, 4, -4, 1, -1, 1, -1, 0, 0]);
});

test("a square on the pixel grid covers its pixels wholly and no others", () => {
  const plane = fillTextCoverage(square(2, 2, 6, 6), rect(0, 0, 8, 8));
  assert.deepEqual(rows(plane, 8), Array.from({ length: 8 }, (_, y) => Array.from({ length: 8 }, (_, x) => x >= 2 && x < 6 && y >= 2 && y < 6 ? 1 : 0)));
  // Which way round it is drawn makes no difference to what is inside it.
  const turned = square(2, 2, 6, 6).reverse();
  assert.deepEqual(rows(fillTextCoverage(turned.map((_, at) => turned[at % 2 ? at - 1 : at + 1]!), rect(0, 0, 8, 8)), 8), rows(plane, 8));
  // The rectangle is a window on the frame's grid, not an origin: the same square through a window set elsewhere.
  assert.deepEqual(rows(fillTextCoverage(square(2, 2, 6, 6), rect(1, 3, 4, 2)), 4), [[0, 1, 1, 1], [0, 1, 1, 1]]);
});

test("a square half a pixel off the grid covers its edge pixels by half and its corners by a quarter", () => {
  const plane = fillTextCoverage(square(1.5, 1.5, 4.5, 4.5), rect(0, 0, 6, 6));
  assert.deepEqual(rows(plane, 6), [
    [0, 0, 0, 0, 0, 0],
    [0, 0.25, 0.5, 0.5, 0.25, 0],
    [0, 0.5, 1, 1, 0.5, 0],
    [0, 0.5, 1, 1, 0.5, 0],
    [0, 0.25, 0.5, 0.5, 0.25, 0],
    [0, 0, 0, 0, 0, 0],
  ]);
  // A sliver inside one pixel is that much of it, wherever in the pixel it lies.
  close(fillTextCoverage(square(2.25, 1.125, 2.5, 1.625), rect(0, 0, 4, 3)), [0, 0, 0, 0, 0, 0, 0.125, 0, 0, 0, 0, 0]);
  // A triangle's slanted side cuts each pixel it crosses in half.
  assert.deepEqual(rows(fillTextCoverage(glyph("v", 1, 0, 4), rect(0, 0, 4, 4)), 4), [[0.5, 0, 0, 0], [1, 0.5, 0, 0], [1, 1, 0.5, 0], [1, 1, 1, 0.5]]);
});

test("a counter stays empty and overlapping contours never cover a pixel twice", () => {
  // "o" is a 4-unit square with a 2-unit counter wound the other way.
  assert.deepEqual(rows(fillTextCoverage(glyph("o", 1, 0, 4), rect(0, 0, 4, 4)), 4), [[1, 1, 1, 1], [1, 0, 0, 1], [1, 0, 0, 1], [1, 1, 1, 1]]);
  close(rows(fillTextCoverage(glyph("o", 1.5, 0.25, 6.25), rect(0, 0, 7, 7)), 7)[3]!, [0.75, 0.75, 0, 0, 0.25, 1, 0.25]);
  // "x" is two squares wound the same way that share half their width: the winding there is 2 and the ink is 1.
  const overlapping = fillTextCoverage(glyph("x", 1, 0, 4), rect(0, 0, 4, 4));
  assert.deepEqual(Array.from(overlapping), Array.from({ length: 16 }, () => 1));
  // Two letters that run into each other are filled as one shape: "w" reaches back over the letter before it.
  const joined = fillTextCoverage([...glyph("a", 1.5, 0.25, 6), ...glyph("w", 1.5, 7.75, 6)], rect(0, 0, 15, 6));
  assert.ok(joined.every(value => value <= 1));
  close(rows(joined, 15)[2]!, [0.75, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0.75, 0]);
  // A contour inside another and wound the same way is ink, not a counter: the rule is non-zero, not even-odd.
  assert.deepEqual(Array.from(fillTextCoverage([...square(0, 0, 4, 4), ...square(1, 1, 3, 3)], rect(0, 0, 4, 4))), Array.from({ length: 16 }, () => 1));
});

test("contours that share a pixel ink the area they cover together, not the sum of what each covers", () => {
  const one = rect(0, 0, 1, 1), turned = (segments: number[]) => { const back = [...segments].reverse(); return back.map((_, at) => back[at % 2 ? at - 1 : at + 1]!); };
  // Six tenths of a pixel, drawn twice over, is six tenths: a face draws an accent or a stroke as a second contour laid on the first.
  close(fillTextCoverage(square(0, 0, 0.6, 1), one), [0.6]);
  close(fillTextCoverage([...square(0, 0, 0.6, 1), ...square(0, 0, 0.6, 1)], one), [0.6]);
  // Two that overlap by half, side by side and one above the other: 0 to 0.9 of the pixel, not 1.
  close(fillTextCoverage([...square(0, 0, 0.6, 1), ...square(0.3, 0, 0.9, 1)], one), [0.9]);
  close(fillTextCoverage([...square(0, 0, 1, 0.6), ...square(0, 0.3, 1, 0.9)], one), [0.9]);
  close(fillTextCoverage([...square(0.1, 0.1, 0.6, 0.6), ...square(0.4, 0.4, 0.9, 0.9)], one), [0.25 + 0.25 - 0.04]);
  // Which is listed first changes nothing, and neither does drawing both the other way round.
  close(fillTextCoverage([...square(0.3, 0, 0.9, 1), ...square(0, 0, 0.6, 1)], one), [0.9]);
  close(fillTextCoverage(turned([...square(0, 0, 0.6, 1), ...square(0.3, 0, 0.9, 1)]), one), [0.9]);
  // Wound against each other, the part they share has no winding and is empty: the rule is non-zero.
  close(fillTextCoverage([...square(0, 0, 0.6, 1), ...turned(square(0.3, 0, 0.9, 1))], one), [0.6]);
  // "x" is two boxes that share half their width, so off the grid it is the box "a" and nothing more.
  for (const [unit, x, y] of [[0.2, 0.3, 1.9], [0.4, 0.15, 2.7], [1.3, 0.2, 6.1], [1.92, 16, 33.92], [2.75, 1.3, 12.9]] as const) {
    close(fillTextCoverage(glyph("x", unit, x, y), rect(0, 0, 14, 14)), fillTextCoverage(glyph("a", unit, x, y), rect(0, 0, 14, 14)), 1e-6);
  }
  // Two squares set a little apart both ways: each pixel holds what one covers and what the other covers, less what both do.
  const first = [1.3, 2.1, 5.7, 6.5] as const, second = [3.9, 4.4, 8.3, 8.8] as const, shared = [3.9, 4.4, 5.7, 6.5] as const;
  const boxed = ([left, top, right, bottom]: readonly [number, number, number, number], x: number, y: number) => textSpanCoverage(left, right, x) * textSpanCoverage(top, bottom, y);
  close(fillTextCoverage([...square(...first), ...square(...second)], rect(0, 0, 10, 10)),
    Array.from({ length: 100 }, (_, at) => boxed(first, at % 10, Math.floor(at / 10)) + boxed(second, at % 10, Math.floor(at / 10)) - boxed(shared, at % 10, Math.floor(at / 10))));
  // Slanted sides that cross inside a pixel. Two triangles, x + y ≤ 6 and y ≤ x, share the triangle up to (3,3): 18 + 18 - 9 square units.
  for (const [unit, x, y] of [[1, 0, 0], [1.1, 0.3, 0.4], [2.3, 1.7, 0.25], [0.37, 0.61, 0.83]] as const) {
    const at = (px: number, py: number) => [x + px * unit, y + py * unit];
    const sides = (...corners: number[][]) => corners.flatMap((corner, index) => [...corner, ...corners[(index + 1) % corners.length]!]);
    const pair = [...sides(at(0, 0), at(6, 0), at(0, 6)), ...sides(at(0, 0), at(6, 0), at(6, 6))], plane = fillTextCoverage(pair, rect(0, 0, 18, 18));
    close([total(plane)], [27 * unit * unit], 1e-4);
    assert.ok(plane.every(value => value >= 0 && value <= 1));
    // And the same through a window that cuts the pair on every side.
    const window = rect(Math.floor(x + unit), Math.floor(y + unit), Math.ceil(3 * unit), Math.ceil(2 * unit));
    close(fillTextCoverage(pair, window), crop(plane, rect(0, 0, 18, 18), window), 1e-6);
  }
});

test("a shape half outside the rectangle fills the part inside exactly", () => {
  // A 4-pixel square centred on each edge and each corner of a 4-pixel window.
  const inside = (left: number, top: number) => rows(fillTextCoverage(square(left, top, left + 4, top + 4), rect(0, 0, 4, 4)), 4)
    .map((row, y) => row.map((value, x) => { assert.equal(value, x >= left && x < left + 4 && y >= top && y < top + 4 ? 1 : 0, `${left},${top} at ${x},${y}`); return value; }));
  for (const [left, top] of [[-2, 0], [2, 0], [0, -2], [0, 2], [-2, -2], [2, -2], [-2, 2], [2, 2], [-3, 1]]) inside(left!, top!);
  assert.deepEqual(rows(fillTextCoverage(square(-2.5, -2.5, 1.5, 1.5), rect(0, 0, 3, 3)), 3), [[1, 0.5, 0], [0.5, 0.25, 0], [0, 0, 0]]);
  // Wholly outside is nothing, on any side; wholly around is everything.
  for (const [left, top] of [[-9, 0], [9, 0], [0, -9], [0, 9]]) assert.equal(total(fillTextCoverage(square(left!, top!, left! + 4, top! + 4), rect(0, 0, 4, 4))), 0);
  assert.equal(total(fillTextCoverage(square(-9, -9, 9, 9), rect(0, 0, 4, 4))), 16);
  // Slanted and curved sides too: a window anywhere reads what a larger plane holds there.
  const whole = rect(-4, -4, 40, 40);
  for (const character of ["v", "q", "c", "o"]) {
    const segments = glyph(character, 3.3, 5.3, 20.7), plane = fillTextCoverage(segments, whole);
    for (const window of [rect(8, -4, 28, 40), rect(-4, -4, 14, 40), rect(-4, 12, 40, 24), rect(-4, -4, 40, 18), rect(9, 11, 5, 6), rect(11, 13, 1, 1), rect(6, 8, 2, 2), rect(30, 30, 4, 4)]) {
      close(fillTextCoverage(segments, window), crop(plane, whole, window));
    }
  }
});

test("curves cover their true area to within the flatness times their length", () => {
  // The chords lie inside a corner that bulges outward, so the ink is never more than the true area, and falls
  // short by less than a strip TEXT_FLATNESS wide along the curve. The curve is shorter than its
  // control polygon, 8 units long.
  for (const [character, area] of [["q", PROOF_QUADRATIC_AREA], ["c", PROOF_CUBIC_AREA]] as const) {
    for (const [unit, x, y] of [[1, 2, 6], [2, 2.5, 10.25], [3.7, 1.3, 16.9], [8, 0, 32], [20, 3.5, 83.5]] as const) {
      const size = Math.ceil(4 * unit) + 8, inked = total(fillTextCoverage(glyph(character, unit, x, y), rect(0, 0, size, size))), exact = area * unit * unit;
      assert.ok(inked <= exact + 1e-3 * unit * unit, `${character} at ${unit}: ${inked} over ${exact}`);
      assert.ok(exact - inked <= TEXT_FLATNESS * 8 * unit, `${character} at ${unit}: ${inked} under ${exact}`);
    }
  }
  // Straight sides have no tolerance at all: a triangle of 8 square units.
  for (const [unit, x, y] of [[1, 2, 6], [2.75, 1.3, 14.9]] as const) close([total(fillTextCoverage(glyph("v", unit, x, y), rect(0, 0, 20, 20)))], [8 * unit * unit], 1e-4);
});

test("an edge is as wide as it says, across any straight side and wherever the side falls in a pixel", () => {
  // A side on a pixel boundary with an edge 3 pixels wide: half a pixel, two whole ones and half a pixel.
  const side = strokeTextCoverage([4, -20, 4, 30], 1.5, rect(0, 0, 9, 3));
  assert.deepEqual(rows(side, 9), Array.from({ length: 3 }, () => [0, 0, 0.5, 1, 1, 0.5, 0, 0, 0]));
  // Through the middle of a pixel, half a pixel wide: half of that one pixel.
  assert.deepEqual(rows(strokeTextCoverage([4.5, -20, 4.5, 30], 0.25, rect(0, 0, 9, 1)), 9), [[0, 0, 0, 0, 0.5, 0, 0, 0, 0]]);
  // A hairline tends to nothing rather than to a pixel: a fifth of a pixel wide is a fifth of a pixel's ink.
  close(strokeTextCoverage([4, -20, 4, 30], 0.1, rect(0, 0, 9, 1)), [0, 0, 0, 0.1, 0.1, 0, 0, 0, 0], 1e-6);
  for (const half of [0.02, 0.3, 0.5, 0.75, 1, 2.2, 3.5]) for (const at of [6, 6.25, 6.5, 6.9]) {
    close([total(strokeTextCoverage([at, -20, at, 30], half, rect(0, 0, 13, 1)))], [2 * half], 1e-5);
    close([total(strokeTextCoverage([-20, at, 30, at], half, rect(0, 0, 1, 13)))], [2 * half], 1e-5);
  }
  // The window may sit anywhere on the grid.
  assert.deepEqual(Array.from(strokeTextCoverage([104, -20, 104, 230], 1.5, rect(101, 50, 6, 1))), [0, 0.5, 1, 1, 0.5, 0]);
  assert.equal(total(strokeTextCoverage([], 2, rect(0, 0, 4, 4))), 0);
});

test("an edge is round at ends and corners, and inks nothing past its reach", () => {
  // A level segment through pixel middles from 4.5 to 8.5, 3 pixels wide.
  const plane = strokeTextCoverage([4.5, 4.5, 8.5, 4.5], 1.5, rect(0, 0, 13, 9)), at = (x: number, y: number) => plane[y * 13 + x]!;
  // Past the end it falls away as it does to the side: by distance from the nearest point.
  assert.deepEqual([at(1, 4), at(2, 4), at(3, 4), at(4, 4)], [0, 0, 1, 1]);
  assert.deepEqual([at(6, 1), at(6, 2), at(6, 3), at(6, 4)], [0, 0, 1, 1]);
  assert.deepEqual([at(9, 4), at(10, 4), at(11, 4)], [1, 0, 0]);
  // Diagonally off the end the middle is √2 away: 1.5 less (√2 - 0.5) of that pixel's own width.
  close([at(3, 3), at(3, 5), at(9, 3), at(9, 5)], Array.from({ length: 4 }, () => 2 - Math.sqrt(2)), 1e-6);
  close([at(2, 3)], [0], 0);
  // The outer corner of a square is rounded the same way, and the inner one is not hollowed.
  const corner = strokeTextCoverage(square(4, 4, 12, 12), 1, rect(0, 0, 8, 8)), ring = rows(corner, 8);
  close([ring[3]![3]!], [1.5 - Math.sqrt(0.5)], 1e-6);
  assert.deepEqual(ring[3]!.slice(4), [1, 1, 1, 1]);
  assert.deepEqual(ring[2]!.slice(4), [0, 0, 0, 0]);
  assert.deepEqual(ring[4]!.slice(2), [0, 1, 1, 1, 1, 1]);
  assert.deepEqual(ring[5]!.slice(2), [0, 1, 1, 0, 0, 0]);
  assert.ok(corner.every(value => value >= 0 && value <= 1));
});

test("three boxes stand in for a Gaussian of the sigma asked", () => {
  assert.deepEqual(textBlurBoxes(0), [1, 1, 1]);
  assert.deepEqual(textBlurBoxes(-1), [1, 1, 1]);
  assert.deepEqual(textBlurBoxes(Number.NaN), [1, 1, 1]);
  // Too soft a blur for a 3-pixel box is none.
  assert.deepEqual(textBlurBoxes(0.4), [1, 1, 1]);
  assert.deepEqual(textBlurBoxes(0.6), [1, 1, 3]);
  assert.deepEqual(textBlurBoxes(1), [1, 1, 3]);
  assert.deepEqual(textBlurBoxes(1.5), [3, 3, 3]);
  assert.deepEqual(textBlurBoxes(2), [3, 3, 5]);
  assert.deepEqual(textBlurBoxes(10), [19, 19, 21]);
  assert.equal(textBlurReach([1, 1, 1]), 0);
  assert.equal(textBlurReach([3, 3, 5]), 4);
  assert.equal(textBlurReach([19, 19, 21]), 28);
  // Three boxes of widths w spread like a Gaussian of variance Σ(w² - 1)/12: within a quarter of a pixel of the sigma asked.
  for (let sigma = 0.75; sigma <= 400; sigma *= 1.37) {
    const boxes = textBlurBoxes(sigma), spread = Math.sqrt(boxes.reduce((sum, box) => sum + (box * box - 1) / 12, 0));
    assert.ok(boxes.every(box => Number.isInteger(box) && box % 2 === 1 && box >= 1), `${sigma}: ${boxes}`);
    assert.ok(boxes[0] <= boxes[1] && boxes[1] <= boxes[2] && boxes[2] - boxes[0] <= 2, `${sigma}: ${boxes}`);
    assert.ok(Math.abs(spread - sigma) < 0.25, `${sigma}: ${boxes} spread ${spread}`);
  }
});

test("a blur keeps all the ink it is given room for, and spreads it evenly", () => {
  const size = 21, middle = 10, boxes = textBlurBoxes(2), point = new Float32Array(size * size);
  point[middle * size + middle] = 1;
  const plane = blurTextPlane(point, rect(0, 0, size, size), boxes, rect(0, 0, size, size));
  const at = (x: number, y: number) => plane[y * size + x]!;
  close([total(plane)], [1], 1e-5);
  // Boxes of 3, 3 and 5 put a fifth of a point's ink back on its own column, and so a twenty-fifth on its own pixel.
  close([at(middle, middle)], [0.04], 1e-6);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const value = at(x, y), far = Math.abs(x - middle) > 4 || Math.abs(y - middle) > 4;
    // The same to the left as to the right, above as below, and across the diagonal.
    close([at(size - 1 - x, y), at(x, size - 1 - y), at(y, x)], [value, value, value], 1e-7);
    assert.ok(value <= at(middle, middle) && value >= 0);
    if (far) assert.ok(value < 1e-7, `${x},${y}: ${value}`);
    else assert.ok(value > 0, `${x},${y}`);
  }
  // No blur leaves the plane as it was, to the bit.
  const sharp = Float32Array.from({ length: 12 }, (_, index) => index / 12), before = Float32Array.from(sharp);
  assert.deepEqual(blurTextPlane(sharp, rect(0, 0, 4, 3), textBlurBoxes(0.4), rect(0, 0, 4, 3)), before);
  assert.deepEqual(sharp, before);
  // And read through a window that hangs off it: the part they share, and nothing else.
  assert.deepEqual([...blurTextPlane(sharp, rect(0, 0, 4, 3), textBlurBoxes(0.4), rect(2, -1, 3, 3))], [0, 0, 0, sharp[2], sharp[3], 0, sharp[6], sharp[7], 0]);
});

test("outside a blurred plane is empty, so a blur with room is the same blur anywhere", () => {
  const boxes = textBlurBoxes(2), reach = textBlurReach(boxes);
  // Ink against the plane's side loses what spreads past it: nothing is mirrored back in.
  const edge = new Float32Array(9 * 9);
  edge[4 * 9] = 1;
  const tight = blurTextPlane(edge, rect(0, 0, 9, 9), boxes, rect(0, 0, 9, 9));
  assert.ok(total(tight) < 0.75 && total(tight) > 0.4, `${total(tight)}`);
  // A patch of uneven ink with `reach` of room each side, blurred in two planes that hold it in different places.
  const ink = [0.25, 1, 0.5, 0.125, 1, 1, 0.75, 0, 0.0625, 0.875, 1, 0.3125];
  const blurred = (width: number, height: number, left: number, top: number): number[] => {
    const sharp = new Float32Array(width * height);
    ink.forEach((value, index) => { sharp[(top + Math.floor(index / 4)) * width + left + index % 4] = value; });
    const plane = blurTextPlane(sharp, rect(0, 0, width, height), boxes, rect(0, 0, width, height));
    close([total(plane)], [ink.reduce((sum, value) => sum + value, 0)], 1e-4);
    return crop(plane, rect(0, 0, width, height), rect(left - reach, top - reach, 4 + 2 * reach, 3 + 2 * reach));
  };
  const snug = blurred(4 + 2 * reach, 3 + 2 * reach, reach, reach);
  // To the bit: an empty run before the ink adds nothing to a running sum.
  assert.deepEqual(blurred(40, 31, 17, 9), snug);
  assert.deepEqual(blurred(4 + 2 * reach + 1, 3 + 2 * reach + 5, reach + 1, reach + 5), snug);
  // The ink alone, with no room kept around it, read over the room: the blur makes its own.
  const whole = rect(-reach, -reach, 4 + 2 * reach, 3 + 2 * reach), bare = blurTextPlane(Float32Array.from(ink), rect(0, 0, 4, 3), boxes, whole);
  assert.deepEqual([...bare], snug);
  // Any window on it is that part of it, to the bit: over the ink, beside it, half off it, and where nothing reaches.
  for (const window of [rect(0, 0, 4, 3), rect(1, 1, 2, 1), rect(-reach, -2, 3, 9), rect(3, 2, 1 + reach, 1 + reach), rect(-1, -reach, 6, 2), rect(2, -reach - 3, 5, 6)]) {
    const seen = blurTextPlane(Float32Array.from(ink), rect(0, 0, 4, 3), boxes, window);
    assert.deepEqual([...seen], Array.from({ length: window.width * window.height }, (_, at) => {
      const x = window.x + at % window.width + reach, y = window.y + Math.floor(at / window.width) + reach;
      return x >= 0 && x < whole.width && y >= 0 && y < whole.height ? snug[y * whole.width + x]! : 0;
    }), JSON.stringify(window));
  }
  assert.deepEqual([...blurTextPlane(Float32Array.from(ink), rect(0, 0, 4, 3), boxes, rect(4 + reach, 0, 3, 3))], Array.from({ length: 9 }, () => 0));
  // The plane may sit anywhere: the same ink somewhere else is the same blur there.
  assert.deepEqual([...blurTextPlane(Float32Array.from(ink), rect(-70, 31, 4, 3), boxes, rect(-70 - reach, 31 - reach, 4 + 2 * reach, 3 + 2 * reach))], snug);
});

test("rectangles and spans", () => {
  assert.deepEqual(textSegmentBounds([1.5, 2.25, 6.75, 2.25, 6.75, 2.25, 3, 9]), rect(1, 2, 6, 7));
  assert.deepEqual(textSegmentBounds([1.5, 2.25, 6.75, 2.25, 6.75, 2.25, 3, 9], 1.5), rect(0, 0, 9, 11));
  // The last point counts: a list that ends on its farthest corner.
  assert.deepEqual(textSegmentBounds([0, 0, 4, 0, 4, 0, 9, 12]), rect(0, 0, 9, 12));
  assert.deepEqual(textSegmentBounds([-3.5, -2, -1, -2]), rect(-4, -2, 3, 0));
  assert.equal(textSegmentBounds([]), null);
  assert.deepEqual(textRectOverlap(rect(0, 0, 8, 8), rect(4, -2, 8, 6)), rect(4, 0, 4, 4));
  assert.equal(textRectOverlap(rect(0, 0, 8, 8), rect(8, 0, 4, 4)), null);
  assert.equal(textRectOverlap(rect(0, 0, 8, 8), rect(2, 2, 0, 4)), null);
  assert.deepEqual([textSpanCoverage(2.25, 5.5, 1), textSpanCoverage(2.25, 5.5, 2), textSpanCoverage(2.25, 5.5, 3), textSpanCoverage(2.25, 5.5, 5), textSpanCoverage(2.25, 5.5, 6)], [0, 0.75, 1, 0.5, 0]);
  assert.equal(textSpanCoverage(2.25, 2.5, 2), 0.25);
});
