import { createHash } from "node:crypto";
import { drawScaled, encodePng, solidImage, type RgbaImage } from "./png.js";

/**
 * The location sheet (#243, design turn 57): a place's accepted views stacked into one labelled
 * image, assembled here and never generated.
 *
 * Local because it is free and lossless — a generated composite would spend money to produce a
 * worse copy of images we already hold. Deterministic because the file is content-addressed by
 * its own digest: the same views in the same order must produce the same bytes, or every kit
 * that references it starts pointing at a file that no longer exists.
 *
 * Everything here is integer arithmetic on RGBA. No canvas, no OS font, no native dependency —
 * a machine with no toolchain still assembles the same sheet, which is the whole point of the
 * decision that it is never generated.
 */

export const SHEET_WIDTH = 1600;
export const PANEL_IMAGE_HEIGHT = 900;
export const PANEL_LABEL_HEIGHT = 60;
export const PANEL_HEIGHT = PANEL_IMAGE_HEIGHT + PANEL_LABEL_HEIGHT;

const IMAGE_BG: [number, number, number, number] = [24, 24, 26, 255];
const LABEL_BG: [number, number, number, number] = [12, 12, 14, 255];
const LABEL_INK: [number, number, number, number] = [237, 237, 237, 255];

const GLYPH_W = 5;
const GLYPH_H = 7;
const GLYPH_SCALE = 4;
const GLYPH_ADVANCE = (GLYPH_W + 1) * GLYPH_SCALE; // 24px, one blank column between glyphs
const LABEL_INSET = 24;

/**
 * A 5x7 bitmap face, one number per row, five significant bits, most significant bit leftmost.
 *
 * Checked in rather than loaded: an OS font would make the output depend on the machine that
 * produced it, and this file's identity is its bytes. The set is exactly what a normalized label
 * can contain; anything else becomes `?` rather than a missing rectangle.
 */
const GLYPHS: Readonly<Record<string, readonly number[]>> = {
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x1f],
  J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  N: [0x11, 0x11, 0x19, 0x15, 0x13, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x1b, 0x11],
  X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
  Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  "0": [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  "1": [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  "2": [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
  "3": [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  "4": [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  "5": [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  "6": [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  "7": [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  "8": [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  "9": [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  " ": [0, 0, 0, 0, 0, 0, 0],
  "-": [0x00, 0x00, 0x00, 0x1f, 0x00, 0x00, 0x00],
  ".": [0x00, 0x00, 0x00, 0x00, 0x00, 0x0c, 0x0c],
  ",": [0x00, 0x00, 0x00, 0x00, 0x0c, 0x0c, 0x08],
  ":": [0x00, 0x0c, 0x0c, 0x00, 0x0c, 0x0c, 0x00],
  "'": [0x04, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00],
  "(": [0x02, 0x04, 0x08, 0x08, 0x08, 0x04, 0x02],
  ")": [0x08, 0x04, 0x02, 0x02, 0x02, 0x04, 0x08],
  "/": [0x01, 0x01, 0x02, 0x04, 0x08, 0x10, 0x10],
  "&": [0x0c, 0x12, 0x14, 0x08, 0x15, 0x12, 0x0d],
  "?": [0x0e, 0x11, 0x01, 0x02, 0x04, 0x00, 0x04],
};

/**
 * A name as the sheet renders it: compatibility-decomposed, stripped of combining marks,
 * upper-cased, whitespace collapsed, and anything the face cannot draw replaced by `?`.
 *
 * The original Unicode name stays in kit.json and in the UI — this is only what gets burned
 * into the image, and a burned-in glyph cannot be corrected later.
 */
export function normalizeLabel(text: string): string {
  const folded = text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
  let out = "";
  for (const ch of folded) out += ch in GLYPHS ? ch : "?";
  return out;
}

function textWidth(text: string): number {
  return text.length === 0 ? 0 : text.length * GLYPH_ADVANCE - GLYPH_SCALE;
}

/** The longest prefix that fits, with an ellipsis when anything was dropped. */
export function fitLabel(text: string, maxWidth: number): string {
  if (textWidth(text) <= maxWidth) return text;
  const ellipsis = "...";
  for (let take = text.length - 1; take >= 0; take -= 1) {
    const candidate = text.slice(0, take).trimEnd() + ellipsis;
    if (textWidth(candidate) <= maxWidth) return candidate;
  }
  return "";
}

function drawGlyph(dst: RgbaImage, glyph: readonly number[], x: number, y: number): void {
  for (let row = 0; row < GLYPH_H; row += 1) {
    const bits = glyph[row]!;
    for (let col = 0; col < GLYPH_W; col += 1) {
      if ((bits & (1 << (GLYPH_W - 1 - col))) === 0) continue;
      for (let sy = 0; sy < GLYPH_SCALE; sy += 1) {
        for (let sx = 0; sx < GLYPH_SCALE; sx += 1) {
          const px = x + col * GLYPH_SCALE + sx;
          const py = y + row * GLYPH_SCALE + sy;
          if (px < 0 || py < 0 || px >= dst.width || py >= dst.height) continue;
          const p = (py * dst.width + px) * 4;
          dst.pixels[p] = LABEL_INK[0];
          dst.pixels[p + 1] = LABEL_INK[1];
          dst.pixels[p + 2] = LABEL_INK[2];
          dst.pixels[p + 3] = LABEL_INK[3];
        }
      }
    }
  }
}

function drawLabel(dst: RgbaImage, text: string, x: number, y: number): void {
  let cursor = x;
  for (const ch of text) {
    drawGlyph(dst, GLYPHS[ch] ?? GLYPHS["?"]!, cursor, y);
    cursor += GLYPH_ADVANCE;
  }
}

/**
 * Contain-fit: the whole image, letterboxed, never cropped. A location view exists to show the
 * geometry of a room, and cropping to fill would remove exactly the edges that carry it.
 */
function containFit(width: number, height: number, boxW: number, boxH: number): { w: number; h: number; x: number; y: number } {
  const scale = Math.min(boxW / width, boxH / height);
  const w = Math.max(1, Math.floor(width * scale));
  const h = Math.max(1, Math.floor(height * scale));
  return { w, h, x: Math.floor((boxW - w) / 2), y: Math.floor((boxH - h) / 2) };
}

export interface LocationSheetPanel {
  /** The view's stable id — part of the digest, so reordering changes the filename. */
  id: string;
  /** The authored name; normalized for drawing, kept verbatim everywhere else. */
  name: string;
  image: RgbaImage;
}

export interface LocationSheet {
  png: Uint8Array;
  /** `location-sheet-<digest12>.png` — content-addressed, so a rebuild is idempotent. */
  file: string;
  width: number;
  height: number;
  /** What each panel says, in order, for the prompt's panel map. */
  labels: string[];
}

/** `PANEL 01 - ESTABLISHING VIEW` — position first, because prompts cite the position. */
export function panelLabel(index: number, name: string): string {
  return normalizeLabel(`PANEL ${String(index + 1).padStart(2, "0")} - ${name}`);
}

/**
 * Compose the sheet. Panels must already be in the order the kit declares (establishing first,
 * then acceptance order) — ordering is a kit decision, not a drawing one.
 */
export function composeLocationSheet(panels: readonly LocationSheetPanel[]): LocationSheet {
  if (panels.length === 0) throw new Error("a location sheet needs at least one view");

  const height = PANEL_HEIGHT * panels.length;
  const canvas = solidImage(SHEET_WIDTH, height, IMAGE_BG);
  const labelBand = solidImage(SHEET_WIDTH, PANEL_LABEL_HEIGHT, LABEL_BG);
  const labels: string[] = [];
  // What the sheet is made of and what it says. The rendered bytes go in below — this part is
  // only so that two sheets which draw identically but came from different views still get
  // different names, because a view's identity is part of what the sheet claims.
  const digest = createHash("sha256");

  panels.forEach((panel, index) => {
    const top = index * PANEL_HEIGHT;
    const fit = containFit(panel.image.width, panel.image.height, SHEET_WIDTH, PANEL_IMAGE_HEIGHT);
    drawScaled(canvas, panel.image, fit.x, top + fit.y, fit.w, fit.h);

    const label = fitLabel(panelLabel(index, panel.name), SHEET_WIDTH - LABEL_INSET * 2);
    labels.push(label);
    drawScaled(canvas, labelBand, 0, top + PANEL_IMAGE_HEIGHT, SHEET_WIDTH, PANEL_LABEL_HEIGHT);
    drawLabel(
      canvas,
      label,
      LABEL_INSET,
      top + PANEL_IMAGE_HEIGHT + Math.floor((PANEL_LABEL_HEIGHT - GLYPH_H * GLYPH_SCALE) / 2),
    );

    digest.update(panel.id, "utf8");
    digest.update(" ");
    digest.update(label, "utf8");
    digest.update(" ");
  });

  // The rendered file, hashed as the file. Hashing the *source* pixels instead left the name
  // blind to everything composition does with them: two source buffers of equal length but
  // different dimensions compose differently, and a later change to the geometry, the ground
  // colour or the bitmap face would go on producing the old name for new bytes — so a world
  // holding the old sheet would never rebuild, and one that did would overwrite a file whose
  // digest still claimed the old content. Content-addressing has to address the content.
  const png = encodePng(canvas);
  digest.update(png);
  const digest12 = digest.digest("hex").slice(0, 12);
  return {
    png,
    file: `location-sheet-${digest12}.png`,
    width: SHEET_WIDTH,
    height,
    labels,
  };
}

/**
 * The sentence a dispatch says about the sheet it is carrying, so a prompt can cite a fixture by
 * the panel it appears in rather than describing it again (#246's spatial block consumes this).
 */
export function panelMapSentence(locationName: string, imageIndex: number, names: readonly string[]): string {
  const parts = names.map((name, index) => {
    const position = index === 0 ? "panel 1 (top)" : index === names.length - 1 ? `panel ${index + 1} (bottom)` : `panel ${index + 1}`;
    return `${position}, ${name}`;
  });
  return `Image ${imageIndex}: ${locationName} location sheet - ${parts.join("; ")}.`;
}
