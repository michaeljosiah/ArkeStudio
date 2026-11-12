import type { TextOutlineCommand } from "./editor-text.js";

/**
 * Coverage from outlines, for the text painter (SPEC-065 §2.2). Nothing here knows about words:
 * it turns closed outlines into planes saying how much of each pixel is inked.
 *
 * Every plane is a Float32Array, row by row from the top, holding 0 to 1. Everything that decides
 * a value is + - * / and Math.sqrt, floor, ceil, round, abs, min, max, which IEEE 754 fixes to
 * the last bit, so the same outline gives the same plane on every machine (R-19). No sine, no
 * power, no lookup that a JavaScript engine may round its own way.
 */

/** A whole-pixel rectangle of the frame's grid. It may reach outside the frame: ink there still casts a shadow in. */
export interface TextRasterRect { x: number; y: number; width: number; height: number }

/** A curve is drawn as straight pieces that leave it by at most this much of a pixel: far under what an eye or an 8-bit alpha can tell. */
export const TEXT_FLATNESS = 0.1;
/** A curve that needs more pieces than this spans thousands of pixels; the cap only keeps a broken outline from asking for millions. */
const MAX_CURVE_PIECES = 512;

/** How many chords keep a curve within TEXT_FLATNESS, from the size of its second difference: a chord of step h leaves a curve by at most |B″|·h²/8. */
function curvePieces(bend: number, scale: number): number {
  const pieces = Math.ceil(Math.sqrt(bend * scale / TEXT_FLATNESS));
  return pieces >= 1 ? Math.min(MAX_CURVE_PIECES, pieces) : 1;
}

/**
 * One glyph's outline as line segments in frame pixels, appended to `out` four numbers at a time
 * (x0, y0, x1, y1). The outline is in font units with y upward; `unit` is one of them in pixels
 * and `x`, `y` where its origin sits. Curves are cut at even steps of their parameter, the count
 * a function of the control points alone, and every contour is closed, as a fill needs.
 */
export function flattenTextOutline(outline: readonly TextOutlineCommand[], unit: number, x: number, y: number, out: number[]): void {
  let startX = 0, startY = 0, penX = 0, penY = 0, open = false;
  const line = (toX: number, toY: number) => { if (toX !== penX || toY !== penY) out.push(penX, penY, toX, toY); penX = toX; penY = toY; };
  const close = () => { if (open) line(startX, startY); open = false; };
  for (const { command, args } of outline) {
    const a = (index: number) => x + args[index]! * unit, b = (index: number) => y - args[index]! * unit;
    if (command === "moveTo") { close(); startX = penX = a(0); startY = penY = b(1); open = true; }
    else if (command === "lineTo") line(a(0), b(1));
    else if (command === "quadraticCurveTo") {
      const x0 = penX, y0 = penY, x1 = a(0), y1 = b(1), x2 = a(2), y2 = b(3);
      const bendX = x0 - 2 * x1 + x2, bendY = y0 - 2 * y1 + y2;
      const pieces = curvePieces(Math.sqrt(bendX * bendX + bendY * bendY), 0.25);
      for (let piece = 1; piece < pieces; piece++) {
        const t = piece / pieces, s = 1 - t;
        line(s * s * x0 + 2 * s * t * x1 + t * t * x2, s * s * y0 + 2 * s * t * y1 + t * t * y2);
      }
      line(x2, y2);
    } else if (command === "bezierCurveTo") {
      const x0 = penX, y0 = penY, x1 = a(0), y1 = b(1), x2 = a(2), y2 = b(3), x3 = a(4), y3 = b(5);
      const firstX = x0 - 2 * x1 + x2, firstY = y0 - 2 * y1 + y2, lastX = x1 - 2 * x2 + x3, lastY = y1 - 2 * y2 + y3;
      const pieces = curvePieces(Math.sqrt(Math.max(firstX * firstX + firstY * firstY, lastX * lastX + lastY * lastY)), 0.75);
      for (let piece = 1; piece < pieces; piece++) {
        const t = piece / pieces, s = 1 - t, c0 = s * s * s, c1 = 3 * s * s * t, c2 = 3 * s * t * t, c3 = t * t * t;
        line(c0 * x0 + c1 * x1 + c2 * x2 + c3 * x3, c0 * y0 + c1 * y1 + c2 * y2 + c3 * y3);
      }
      line(x3, y3);
    } else close();
  }
  close();
}

/** The whole pixels a set of segments touches, grown by `reach` pixels, or null when there are none. */
export function textSegmentBounds(segments: readonly number[], reach = 0): TextRasterRect | null {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (let at = 0; at + 1 < segments.length; at += 2) {
    const x = segments[at]!, y = segments[at + 1]!;
    if (x < left) left = x;
    if (x > right) right = x;
    if (y < top) top = y;
    if (y > bottom) bottom = y;
  }
  if (!(left <= right && top <= bottom)) return null;
  const x = Math.floor(left - reach), y = Math.floor(top - reach);
  return { x, y, width: Math.ceil(right + reach) - x, height: Math.ceil(bottom + reach) - y };
}

/** Where two rectangles overlap, or null. */
export function textRectOverlap(a: TextRasterRect, b: TextRasterRect): TextRasterRect | null {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y), width = Math.min(a.x + a.width, b.x + b.width) - x, height = Math.min(a.y + a.height, b.y + b.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

/** How much of the pixel that begins at `pixel` the span from `start` to `end` covers: an edge inside a pixel is inked by area. */
export const textSpanCoverage = (start: number, end: number, pixel: number): number => Math.max(0, Math.min(end, pixel + 1) - Math.max(start, pixel));

/**
 * A crossing's share of one row, as signed area. A crossing of height `cover` at x inks its own
 * pixel by what lies right of it and every pixel after by all of it; a slanted crossing spreads
 * the first part over the pixels it passes. `from` and `to` lie within 0..width, low to high.
 */
function addCrossing(sums: Float64Array, from: number, to: number, cover: number): void {
  const first = Math.floor(from), last = Math.ceil(to);
  if (last <= first + 1) {
    const middle = 0.5 * (from + to) - first;
    sums[first] = sums[first]! + cover - cover * middle;
    sums[first + 1] = sums[first + 1]! + cover * middle;
    return;
  }
  const slope = 1 / (to - from), head = 1 - (from - first), tail = to - last + 1;
  const enter = 0.5 * slope * head * head, leave = 0.5 * slope * tail * tail;
  sums[first] = sums[first]! + cover * enter;
  if (last === first + 2) sums[first + 1] = sums[first + 1]! + cover * (1 - enter - leave);
  else {
    const second = slope * (head + 0.5);
    sums[first + 1] = sums[first + 1]! + cover * (second - enter);
    for (let x = first + 2; x < last - 1; x++) sums[x] = sums[x]! + cover * slope;
    sums[last - 1] = sums[last - 1]! + cover * (1 - second - (last - first - 3) * slope - leave);
  }
  sums[last] = sums[last]! + cover * leave;
}

/**
 * How much of each pixel of `rect` lies inside the outlines: exact area under the non-zero rule.
 * The outlines are closed contours, as `flattenTextOutline` makes them.
 *
 * Adding up what every segment sweeps and taking no more than 1 of the sum is the usual short
 * cut, and it is only exact where no two contours share a pixel: two that each cover 0.6 of one
 * come to 1 whether they lie on each other or side by side. A face draws a stroked or accented
 * letter as contours laid over each other, and tight letters and a mark sunk into its letter
 * overlap the same way, so those pixels came out too dark by up to half. Here only the boundary
 * of the inked region is swept. A row is cut into bands in which no edge begins, ends or crosses
 * another; in a band the edges stand in one order, the winding between two neighbours is one
 * number, and an edge counts only where the winding leaves nothing or returns to it. What the
 * counted edges sweep is the region's own area, however many contours lie inside it.
 *
 * Outlines may lie anywhere. What is above or below the rectangle is cut away; what is left of it
 * counts in full for every pixel of its row, and what is right of it for none, so a letter half
 * off an edge fills its visible half exactly (R-9).
 */
export function fillTextCoverage(segments: readonly number[], rect: TextRasterRect): Float32Array {
  const { width, height } = rect, plane = new Float32Array(width * height), count = segments.length >> 2;
  // Every edge is kept running downward; `turn` is which way its segment ran, and 0 for a level
  // one, which sweeps nothing but still joins what it lies across.
  const x0 = new Float64Array(count), y0 = new Float64Array(count), x1 = new Float64Array(count), y1 = new Float64Array(count), slant = new Float64Array(count);
  const turn = new Int8Array(count), begins = new Int32Array(count), queue: number[] = [];
  for (let edge = 0; edge < count; edge++) {
    const ax = segments[edge * 4]! - rect.x, ay = segments[edge * 4 + 1]! - rect.y, bx = segments[edge * 4 + 2]! - rect.x, by = segments[edge * 4 + 3]! - rect.y;
    if (!(Number.isFinite(ax) && Number.isFinite(ay) && Number.isFinite(bx) && Number.isFinite(by))) continue;
    const down = ay <= by;
    x0[edge] = down ? ax : bx; y0[edge] = down ? ay : by; x1[edge] = down ? bx : ax; y1[edge] = down ? by : ay;
    if (!(y1[edge]! > 0 && y0[edge]! < height)) continue;
    // A level edge on the line between two rows lies in neither.
    if (ay === by) { if (ay === Math.floor(ay)) continue; }
    else { turn[edge] = down ? 1 : -1; slant[edge] = (x1[edge]! - x0[edge]!) / (y1[edge]! - y0[edge]!); }
    begins[edge] = Math.max(0, Math.floor(y0[edge]!));
    queue.push(edge);
  }
  queue.sort((a, b) => begins[a]! - begins[b]!);
  // An edge's x at a height, from the segment's own ends: nothing drifts down a tall stem, and two edges that share a corner agree on it to the bit.
  const xAt = (edge: number, y: number) => y === y0[edge]! ? x0[edge]! : y === y1[edge]! ? x1[edge]! : x0[edge]! + (y - y0[edge]!) * slant[edge]!;

  // One row's sums, in doubles: a boundary's two sides must cancel to nothing, and they are added many pixels apart.
  // Two spare cells: a crossing spills one pixel past itself, and a crossing on the right edge one more.
  const sums = new Float64Array(width + 2);
  const addPiece = (xa: number, xb: number, cover: number) => {
    const from = Math.min(xa, xb), to = Math.max(xa, xb);
    if (to <= 0) sums[0] = sums[0]! + cover;
    else if (from >= width) return;
    else if (from >= 0 && to <= width) addCrossing(sums, from, to, cover);
    else {
      // The crossing leaves the rectangle within this band: its cover is shared out by how far it runs on each side.
      const span = to - from, before = from < 0 ? -from / span : 0, after = to > width ? (to - width) / span : 0;
      if (before > 0) sums[0] = sums[0]! + cover * before;
      addCrossing(sums, Math.max(0, from), Math.min(width, to), cover * (1 - before - after));
    }
  };

  // What each edge is within the row at hand: the heights it runs between and the columns it keeps to.
  const top = new Float64Array(count), bottom = new Float64Array(count), low = new Float64Array(count), high = new Float64Array(count);
  const xStart = new Float64Array(count), xEnd = new Float64Array(count);
  const byLow = (a: number, b: number) => low[a]! - low[b]!, byMiddle = (a: number, b: number) => xStart[a]! + xEnd[a]! - xStart[b]! - xEnd[b]!, rising = (a: number, b: number) => a - b;
  const active: number[] = [], row: number[] = [], cuts: number[] = [], band: number[] = [];
  let next = 0;
  for (let y = 0; y < height; y++) {
    while (next < queue.length && begins[queue[next]!]! <= y) active.push(queue[next++]!);
    row.length = 0;
    for (const edge of active) {
      top[edge] = Math.max(y, y0[edge]!); bottom[edge] = Math.min(y + 1, y1[edge]!);
      // A level edge keeps to every column it lies across, or the two sides it joins would be taken for separate shapes.
      const xa = turn[edge] ? xAt(edge, top[edge]!) : x0[edge]!, xb = turn[edge] ? xAt(edge, bottom[edge]!) : x1[edge]!;
      low[edge] = Math.min(xa, xb); high[edge] = Math.max(xa, xb);
      // Right of the rectangle an edge inks nothing here, and nothing left of it is changed by it.
      if (low[edge]! < width) row.push(edge);
    }
    let kept = 0;
    for (const edge of active) if (y1[edge]! > y + 1) active[kept++] = edge;
    active.length = kept;
    if (!row.length) continue;
    row.sort(byLow);
    // Edges whose columns touch are worked together. Between two such groups a line can be drawn
    // down the whole row that meets no edge, so the winding along it is one whole number: the
    // sum of what the groups left of it turn.
    let winding = 0;
    for (let from = 0, to = 0; from < row.length; from = to) {
      let reach = high[row[from]!]!, net = 0;
      for (to = from + 1; to < row.length && low[row[to]!]! <= reach; to++) reach = Math.max(reach, high[row[to]!]!);
      cuts.length = 0;
      for (let at = from; at < to; at++) {
        const edge = row[at]!;
        if (!turn[edge]) continue;
        cuts.push(top[edge]!, bottom[edge]!);
        net += turn[edge]! * (bottom[edge]! - top[edge]!);
        // Where two edges cross, their order changes: a band ends there.
        for (let beside = at + 1; beside < to && low[row[beside]!]! <= high[edge]!; beside++) {
          const other = row[beside]!, start = Math.max(top[edge]!, top[other]!), end = Math.min(bottom[edge]!, bottom[other]!);
          // Two edges wholly left of the rectangle ink it alike in either order.
          if (!turn[other] || !(start < end) || (high[edge]! <= 0 && high[other]! <= 0)) continue;
          const before = xAt(edge, start) - xAt(other, start), after = xAt(edge, end) - xAt(other, end);
          if (!((before < 0 && after > 0) || (before > 0 && after < 0))) continue;
          const cross = start + (end - start) * before / (before - after);
          if (cross > start && cross < end) cuts.push(cross);
        }
      }
      cuts.sort(rising);
      for (let cut = 1; cut < cuts.length; cut++) {
        const start = cuts[cut - 1]!, end = cuts[cut]!;
        if (!(end > start)) continue;
        band.length = 0;
        for (let at = from; at < to; at++) {
          const edge = row[at]!;
          if (!turn[edge] || top[edge]! > start || bottom[edge]! < end) continue;
          xStart[edge] = xAt(edge, start); xEnd[edge] = xAt(edge, end);
          band.push(edge);
        }
        band.sort(byMiddle);
        let around = winding;
        for (const edge of band) {
          const was = around !== 0;
          around += turn[edge]!;
          if (was !== (around !== 0)) addPiece(xStart[edge]!, xEnd[edge]!, was ? start - end : end - start);
        }
      }
      winding += Math.round(net);
    }
    let covered = 0;
    for (let x = 0; x < width; x++) {
      covered += sums[x]!;
      plane[y * width + x] = Math.max(0, Math.min(1, covered));
    }
    sums.fill(0);
  }
  return plane;
}

/**
 * A line of total width `2 × half` centred on the outlines, round at joins and ends: the edge
 * around a letter. A pixel's coverage is how much of its own width, set across the line, falls
 * within `half` of the nearest segment. That is exact along a straight side and tends to nothing
 * for a hairline; at a corner it is the same rule read along the distance, which rounds the join.
 */
export function strokeTextCoverage(segments: readonly number[], half: number, rect: TextRasterRect): Float32Array {
  const { width, height } = rect, reach = half + 0.5;
  // First the squared distance from each pixel centre to its nearest segment; the root is taken once, at the end.
  const plane = new Float32Array(width * height).fill(Infinity);
  for (let at = 0; at + 3 < segments.length; at += 4) {
    const ax = segments[at]! - rect.x, ay = segments[at + 1]! - rect.y, bx = segments[at + 2]! - rect.x, by = segments[at + 3]! - rect.y;
    const ex = bx - ax, ey = by - ay, length = ex * ex + ey * ey;
    // Wider than the reach by a pixel: a pixel beyond it scores nothing either way, so the box only saves work.
    const left = Math.max(0, Math.floor(Math.min(ax, bx) - reach) - 1), right = Math.min(width, Math.ceil(Math.max(ax, bx) + reach) + 1);
    const top = Math.max(0, Math.floor(Math.min(ay, by) - reach) - 1), bottom = Math.min(height, Math.ceil(Math.max(ay, by) + reach) + 1);
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
      const px = x + 0.5 - ax, py = y + 0.5 - ay, along = length > 0 ? Math.max(0, Math.min(1, (px * ex + py * ey) / length)) : 0;
      const dx = px - along * ex, dy = py - along * ey, squared = dx * dx + dy * dy;
      if (squared < plane[y * width + x]!) plane[y * width + x] = squared;
    }
  }
  for (let at = 0; at < plane.length; at++) {
    const squared = plane[at]!;
    if (squared === Infinity) { plane[at] = 0; continue; }
    const distance = Math.sqrt(squared);
    plane[at] = Math.max(0, Math.min(distance + 0.5, half) - Math.max(distance - 0.5, -half));
  }
  return plane;
}

/**
 * Three box widths, each odd, that blurred one after another come closest to a Gaussian of
 * `sigma` pixels: the usual integer widths (Kovesi's "fast almost-Gaussian filtering"). A sigma
 * too small for a 3-pixel box gives three boxes of 1, which is no blur at all.
 */
export function textBlurBoxes(sigma: number): [number, number, number] {
  if (!(sigma > 0)) return [1, 1, 1];
  const variance = 12 * sigma * sigma;
  let narrow = Math.floor(Math.sqrt(variance / 3 + 1));
  if (narrow % 2 === 0) narrow--;
  const narrowCount = Math.round((variance - 3 * narrow * narrow - 12 * narrow - 9) / (-4 * narrow - 4));
  return [narrowCount > 0 ? narrow : narrow + 2, narrowCount > 1 ? narrow : narrow + 2, narrowCount > 2 ? narrow : narrow + 2];
}

/** How far three boxes spread ink, in whole pixels: ink further than this from a pixel leaves nothing on it. */
export const textBlurReach = (boxes: readonly number[]): number => boxes.reduce((reach, box) => reach + (box - 1) / 2, 0);

/**
 * One box pass along a row. `from` holds the cells that begin at `fromAt`, and nothing lies
 * outside them; `to` takes the cells that begin at `toAt`.
 */
function boxAcross(from: Float32Array, fromAt: number, fromLength: number, to: Float32Array, toAt: number, toLength: number, box: number): void {
  const radius = (box - 1) / 2, end = fromAt + fromLength;
  // A running window: add the value coming in on the right, drop the one leaving on the left.
  let sum = 0;
  for (let at = Math.max(fromAt, toAt - radius); at < Math.min(end, toAt + radius); at++) sum += from[at - fromAt]!;
  for (let at = toAt; at < toAt + toLength; at++) {
    const enter = at + radius, leave = at - radius;
    if (enter >= fromAt && enter < end) sum += from[enter - fromAt]!;
    // The running sum can end a hair under nothing where the ink has passed; a plane never holds less than 0.
    to[at - toAt] = Math.max(0, sum / box);
    if (leave >= fromAt && leave < end) sum -= from[leave - fromAt]!;
  }
}

/**
 * The same pass down the columns of rows `width` wide, with a window kept for every column so
 * that the rows are read in the order they lie in. Walking down one column at a time read a
 * plane wider than the cache a cell at a time, and was most of what a soft shadow cost.
 */
function boxDown(from: Float32Array, fromAt: number, fromRows: number, to: Float32Array, toAt: number, toRows: number, width: number, box: number): void {
  const radius = (box - 1) / 2, end = fromAt + fromRows, sums = new Float64Array(width);
  const add = (row: number, sign: number) => {
    const start = (row - fromAt) * width;
    for (let x = 0; x < width; x++) sums[x] = sums[x]! + sign * from[start + x]!;
  };
  for (let row = Math.max(fromAt, toAt - radius); row < Math.min(end, toAt + radius); row++) add(row, 1);
  for (let row = toAt; row < toAt + toRows; row++) {
    const enter = row + radius, leave = row - radius, start = (row - toAt) * width;
    if (enter >= fromAt && enter < end) add(enter, 1);
    for (let x = 0; x < width; x++) to[start + x] = Math.max(0, sums[x]! / box);
    if (leave >= fromAt && leave < end) add(leave, -1);
  }
}

/**
 * The alpha plane over `rect`, blurred by the three boxes and read over `out`. Outside `rect` is
 * empty, not a mirror of its edge, and `out` may lie anywhere: ink beside it blurs into it, and
 * what spreads past it is not kept.
 *
 * The boxes go along the rows first and then down the columns, which is the same blur as taking
 * them turn about. Each pass is worked only as far from `out` as the passes still to come can
 * carry ink, and only the rows that hold ink are blurred along: a plane with `textBlurReach` of
 * empty room on every side of the ink, blurred whole, was three times the frame each way for
 * the softest shadow and took seconds to walk.
 */
export function blurTextPlane(plane: Float32Array, rect: TextRasterRect, boxes: readonly number[], out: TextRasterRect): Float32Array {
  const wide = boxes.filter(box => box > 1), reach = textBlurReach(wide), result = new Float32Array(out.width * out.height);
  const top = Math.max(rect.y, out.y - reach), bottom = Math.min(rect.y + rect.height, out.y + out.height + reach);
  if (bottom <= top) return result;
  if (!wide.length) {
    const shared = textRectOverlap(rect, out);
    if (shared) for (let y = shared.y; y < shared.y + shared.height; y++) {
      const start = (y - rect.y) * rect.width + shared.x - rect.x;
      result.set(plane.subarray(start, start + shared.width), (y - out.y) * out.width + shared.x - out.x);
    }
    return result;
  }
  const last = wide.length - 1, lines = [new Float32Array(out.width + 2 * reach), new Float32Array(out.width + 2 * reach)];
  let rows = new Float32Array(out.width * (bottom - top)), rowsAt = top, rowCount = bottom - top;
  for (let y = top; y < bottom; y++) {
    let from = plane.subarray((y - rect.y) * rect.width, (y - rect.y + 1) * rect.width), fromAt = rect.x, fromLength = rect.width, left = reach;
    for (let pass = 0; pass <= last; pass++) {
      left -= (wide[pass]! - 1) / 2;
      const to = pass === last ? rows.subarray((y - top) * out.width, (y - top + 1) * out.width) : lines[pass % 2]!;
      boxAcross(from, fromAt, fromLength, to, out.x - left, out.width + 2 * left, wide[pass]!);
      from = to; fromAt = out.x - left; fromLength = out.width + 2 * left;
    }
  }
  for (let pass = 0, left = reach; pass <= last; pass++) {
    const radius = (wide[pass]! - 1) / 2;
    left -= radius;
    // No further than this pass can have carried the ink it was given.
    const toAt = pass === last ? out.y : Math.max(out.y - left, rowsAt - radius), toEnd = pass === last ? out.y + out.height : Math.min(out.y + out.height + left, rowsAt + rowCount + radius);
    const to = pass === last ? result : new Float32Array(out.width * (toEnd - toAt));
    boxDown(rows, rowsAt, rowCount, to, toAt, toEnd - toAt, out.width, wide[pass]!);
    rows = to; rowsAt = toAt; rowCount = toEnd - toAt;
  }
  return result;
}
