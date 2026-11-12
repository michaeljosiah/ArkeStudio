import type { TextFace, TextFrame, TextInk } from "./editor-text.js";
import { layoutText, textFillAt, textRgb, type TextRgb } from "./editor-text-layout.js";
import { blurTextPlane, fillTextCoverage, flattenTextOutline, strokeTextCoverage, textBlurBoxes, textBlurReach, textRectOverlap, textSegmentBounds, textSpanCoverage, type TextRasterRect } from "./editor-text-raster.js";

/**
 * The one function that draws a text clip (SPEC-065 R-18): words, look and frame size in, the
 * whole frame out, straight alpha, transparent wherever no ink falls. The Viewer and the export
 * show this picture and draw no words of their own.
 *
 * It reads a face it is handed and nothing of the machine it runs on, and every pixel is decided
 * by + - * / and Math.sqrt, floor, ceil, round, abs, min, max, so the same call gives the same
 * bytes on Windows, macOS and Linux (R-19). A change here that moves ink raises
 * TEXT_PAINTER_VERSION (R-23); the golden hashes in the painter's test fail until it does.
 */

/** A box backing keeps this much of an em clear on every side of the words and their rule (R-12: "the same room on every side"). */
export const TEXT_BOX_PADDING = 0.4;
/** A shade reaches this many ems past the words each way before it has died to nothing: wider than tall, as a line of words is. */
export const TEXT_SHADE_REACH_X = 1.8, TEXT_SHADE_REACH_Y = 1.2;
/** A soft rule fades in over this share of its length and out over the same, leaving the middle half whole. */
export const TEXT_RULE_SOFT_END = 0.25;
/** Softness is how far a shadow visibly spreads, in ems. A Gaussian has all but faded two sigmas out, so its sigma is half of that. */
export const TEXT_SHADOW_SIGMA = 0.5;

export type TextPicture = { ok: true; width: number; height: number; rgba: Uint8Array; drawnSize: number } | { ok: false; reason: string };

/** One thing drawn, in R-13's order: the frame pixels it may ink, and how it inks one row of them from `from` up to `to`. */
interface Layer { rect: TextRasterRect; paint(y: number, from: number, to: number, put: (x: number, color: TextRgb, alpha: number) => void): void }

export function paintText(words: string, ink: TextInk, frame: TextFrame, face: TextFace): TextPicture {
  const laid = layoutText(words, ink, frame, face);
  if (!laid.ok) return laid;
  const { layout } = laid, { width, height } = frame, { em } = layout;
  const rgba = new Uint8Array(width * height * 4), whole: TextRasterRect = { x: 0, y: 0, width, height };
  const inFrame = (left: number, top: number, right: number, bottom: number) =>
    textRectOverlap({ x: Math.floor(left), y: Math.floor(top), width: Math.ceil(right) - Math.floor(left), height: Math.ceil(bottom) - Math.floor(top) }, whole);

  // Outlines as line segments in frame pixels, a list per line because each line is filled by its own gradient.
  const outlines = layout.lines.map(line => {
    const segments: number[] = [];
    for (const { glyph, x, y } of line.glyphs) flattenTextOutline(glyph.outline, layout.unit, x, y, segments);
    return segments;
  });
  const every = outlines.flat(), half = ink.edge ? ink.edge.width * em / 2 : 0;
  const shadow = ink.shadow && ink.shadow.opacity > 0 ? ink.shadow : undefined;
  const boxes = textBlurBoxes(shadow ? shadow.blur * em * TEXT_SHADOW_SIGMA : 0), reach = shadow ? textBlurReach(boxes) : 0;
  // Whole pixels, so a shadow is the letters' own coverage moved and never resampled.
  const offsetX = shadow ? Math.round(shadow.dx * em) : 0, offsetY = shadow ? Math.round(shadow.dy * em) : 0;

  // The working rectangle: where letters and their edge can fall, cut down to what can reach the
  // frame. A shadow reads the silhouette `offset` away and `reach` around, so ink outside the
  // frame still casts its shadow in, and the blur beside a frame edge is the blur it would be
  // anywhere. The room a blur spreads into is not part of it: the blur makes its own.
  const letters = textSegmentBounds(every, half > 0 ? half + 1 : 0);
  const needed: TextRasterRect = !shadow ? whole : {
    x: Math.min(0, -offsetX - reach), y: Math.min(0, -offsetY - reach),
    width: Math.max(width, width - offsetX + reach) - Math.min(0, -offsetX - reach), height: Math.max(height, height - offsetY + reach) - Math.min(0, -offsetY - reach),
  };
  const work = letters && textRectOverlap(letters, needed);

  const fills = outlines.map(segments => {
    const bounds = textSegmentBounds(segments), rect = bounds && work && textRectOverlap(bounds, work);
    return rect ? { rect, plane: fillTextCoverage(segments, rect) } : null;
  });
  const edge = work && ink.edge ? strokeTextCoverage(every, half, work) : null;
  // The frame pixels a shadow can ink: the silhouette's own, moved, and as far around as the blur spreads.
  const shade = work && shadow ? textRectOverlap({ x: work.x + offsetX - reach, y: work.y + offsetY - reach, width: work.width + 2 * reach, height: work.height + 2 * reach }, whole) : null;
  let cast: Float32Array | null = null;
  if (work && shade) {
    // The letters and their edge cast the shadow; the rule and the backing never do.
    const silhouette = edge ? Float32Array.from(edge) : new Float32Array(work.width * work.height);
    for (const fill of fills) if (fill) for (let y = 0; y < fill.rect.height; y++) for (let x = 0; x < fill.rect.width; x++) {
      const at = (y + fill.rect.y - work.y) * work.width + x + fill.rect.x - work.x, covered = fill.plane[y * fill.rect.width + x]!;
      if (covered > silhouette[at]!) silhouette[at] = covered;
    }
    cast = blurTextPlane(silhouette, work, boxes, { ...shade, x: shade.x - offsetX, y: shade.y - offsetY });
  }

  // R-13: backing, shadow, edge, fill, rule. Nothing else is drawn.
  const layers: Layer[] = [], add = (rect: TextRasterRect | null, paint: Layer["paint"]) => { if (rect) layers.push({ rect, paint }); };
  if (ink.backing && ink.backing.opacity > 0) {
    const { bounds } = layout, color = textRgb(ink.backing.color), { opacity } = ink.backing;
    if (ink.backing.kind === "box") {
      const pad = TEXT_BOX_PADDING * em, left = bounds.left - pad, top = bounds.top - pad, right = bounds.right + pad, bottom = bounds.bottom + pad;
      const rect = inFrame(left, top, right, bottom);
      add(rect, (y, from, to, put) => {
        const tall = opacity * textSpanCoverage(top, bottom, y);
        for (let x = from; x < to; x++) put(x, color, tall * textSpanCoverage(left, right, x));
      });
    } else {
      // Full at the middle of the words, nothing at the ellipse, and level at both: a smoothstep of the squared distance.
      const middleX = (bounds.left + bounds.right) / 2, middleY = (bounds.top + bounds.bottom) / 2;
      const wide = (bounds.right - bounds.left) / 2 + TEXT_SHADE_REACH_X * em, tall = (bounds.bottom - bounds.top) / 2 + TEXT_SHADE_REACH_Y * em;
      const rect = inFrame(middleX - wide, middleY - tall, middleX + wide, middleY + tall);
      add(rect, (y, from, to, put) => {
        const down = (y + 0.5 - middleY) / tall;
        for (let x = from; x < to; x++) {
          const across = (x + 0.5 - middleX) / wide, s = Math.min(1, across * across + down * down);
          put(x, color, opacity * (1 - s * s * (3 - 2 * s)));
        }
      });
    }
  }
  if (shade && cast && shadow) {
    const color = textRgb(shadow.color), plane = cast;
    add(shade, (y, from, to, put) => {
      const row = (y - shade.y) * shade.width - shade.x;
      for (let x = from; x < to; x++) put(x, color, shadow.opacity * plane[row + x]!);
    });
  }
  if (work && edge && ink.edge) {
    const color = textRgb(ink.edge.color), rect = textRectOverlap(work, whole);
    add(rect, (y, from, to, put) => {
      const row = (y - work.y) * work.width - work.x;
      for (let x = from; x < to; x++) put(x, color, edge[row + x]!);
    });
  }
  fills.forEach((fill, index) => {
    if (!fill) return;
    const line = layout.lines[index]!, rect = textRectOverlap(fill.rect, whole), rise = line.baseline - line.capLine;
    add(rect, (y, from, to, put) => {
      // One colour for the row: the gradient runs from the cap line to the baseline of this line, read at the pixel's middle.
      const t = rise > 0 ? Math.max(0, Math.min(1, (y + 0.5 - line.capLine) / rise)) : y + 0.5 < line.baseline ? 0 : 1;
      const color = textFillAt(ink.fill, t), row = (y - fill.rect.y) * fill.rect.width - fill.rect.x;
      for (let x = from; x < to; x++) put(x, color, fill.plane[row + x]!);
    });
  });
  if (layout.rule) {
    const { box, color, soft } = layout.rule, rect = inFrame(box.left, box.top, box.right, box.bottom), length = box.right - box.left;
    add(rect, (y, from, to, put) => {
      const tall = textSpanCoverage(box.top, box.bottom, y);
      for (let x = from; x < to; x++) {
        const along = (x + 0.5 - box.left) / length, end = soft ? Math.max(0, Math.min(1, along / TEXT_RULE_SOFT_END, (1 - along) / TEXT_RULE_SOFT_END)) : 1;
        put(x, color, tall * end * textSpanCoverage(box.left, box.right, x));
      }
    });
  }
  if (!layers.length) return { ok: true, width, height, rgba, drawnSize: layout.drawnSize };

  let left = width, top = height, right = 0, bottom = 0;
  for (const { rect } of layers) {
    left = Math.min(left, rect.x); top = Math.min(top, rect.y);
    right = Math.max(right, rect.x + rect.width); bottom = Math.max(bottom, rect.y + rect.height);
  }
  // One row at a time, premultiplied, in floating point: each layer goes over what lies beneath
  // it, and nothing is rounded until the row is written out.
  const row = new Float64Array((right - left) * 4);
  const put = (x: number, color: TextRgb, alpha: number) => {
    if (!(alpha > 0)) return;
    const at = (x - left) * 4, under = 1 - alpha;
    row[at] = color[0] * alpha + row[at]! * under;
    row[at + 1] = color[1] * alpha + row[at + 1]! * under;
    row[at + 2] = color[2] * alpha + row[at + 2]! * under;
    row[at + 3] = alpha + row[at + 3]! * under;
  };
  for (let y = top; y < bottom; y++) {
    row.fill(0);
    for (const layer of layers) if (y >= layer.rect.y && y < layer.rect.y + layer.rect.height) layer.paint(y, layer.rect.x, layer.rect.x + layer.rect.width, put);
    for (let x = left; x < right; x++) {
      // The one place a value becomes a byte. A pixel with no alpha byte is left as four zeros, so
      // a colour never hides under nothing.
      const at = (x - left) * 4, alpha = row[at + 3]!, byte = Math.round(Math.min(1, alpha) * 255);
      if (byte === 0) continue;
      const out = (y * width + x) * 4;
      rgba[out] = Math.min(255, Math.round(row[at]! / alpha));
      rgba[out + 1] = Math.min(255, Math.round(row[at + 1]! / alpha));
      rgba[out + 2] = Math.min(255, Math.round(row[at + 2]! / alpha));
      rgba[out + 3] = byte;
    }
  }
  return { ok: true, width, height, rgba, drawnSize: layout.drawnSize };
}
