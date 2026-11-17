import { AGENT_SHEET_LIMITS } from "@arke-studio/contracts";
import type { RgbaImage } from "../references/png.js";

/*
 * A contact sheet of a cut (epic #3070, #3072): one frame from the middle of each shot, five to a
 * row, numbered and timed under each tile. The music video's every review round began from a sheet
 * like this, made outside the Studio; with it Arke can see the whole film at once and cite a shot
 * by number. Clip names go in the receipt's table, not on the picture: the tile's own words are
 * digits only, drawn from a small built-in font so nothing depends on a typeface.
 */

/** A cut is a step this many grey levels at least, and this many times the steps around it. */
const CUT_FLOOR = 14, CUT_RATIO = 3, CUT_NEIGHBOURS = 15, MIN_SHOT_SEC = .5;

/** Where the picture cuts, as times after the first frame, from frame-to-frame steps at `fps`. */
export function findCuts(steps: readonly number[], fps: number): number[] {
  const cuts: number[] = [];
  for (let i = 0; i < steps.length; i++) {
    const around: number[] = [];
    for (let j = Math.max(0, i - CUT_NEIGHBOURS); j <= Math.min(steps.length - 1, i + CUT_NEIGHBOURS); j++) if (j !== i) around.push(steps[j]!);
    around.sort((a, b) => a - b);
    const local = around.length ? around[around.length >> 1]! : 0, at = (i + 1) / fps;
    if (steps[i]! >= CUT_FLOOR && steps[i]! >= CUT_RATIO * local && (cuts.length === 0 || at - cuts[cuts.length - 1]! >= MIN_SHOT_SEC) && at >= MIN_SHOT_SEC) cuts.push(at);
  }
  return cuts;
}

/** 5x7 glyphs, rows top to bottom, for the only characters a tile's label needs. */
const GLYPHS: Record<string, string[]> = {
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"], "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"], "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"], "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"], "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"], "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  ":": ["00000", "00100", "00100", "00000", "00100", "00100", "00000"], ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
};

/** "12  2:56.6": the shot's number and its start, minutes and tenths. */
export function tileLabel(number: number, startSec: number): string {
  const tenths = Math.round(startSec * 10), minutes = Math.floor(tenths / 600), seconds = (tenths % 600) / 10;
  return `${number}  ${minutes}:${seconds < 10 ? "0" : ""}${seconds.toFixed(1)}`;
}

function drawText(image: RgbaImage, x: number, y: number, text: string, scale: number) {
  for (const [k, char] of [...text].entries()) {
    const rows = GLYPHS[char] ?? GLYPHS[" "]!;
    for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) {
      if (rows[r]![c] !== "1") continue;
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
        const px = x + (k * 6 + c) * scale + dx, py = y + r * scale + dy;
        if (px < 0 || py < 0 || px >= image.width || py >= image.height) continue;
        image.pixels.set([235, 235, 235, 255], (py * image.width + px) * 4);
      }
    }
  }
}

const GUTTER = 8, LABEL = 22;
/** One page: tiles of RGBA at the sheet's tile size, laid five to a row with their labels beneath. */
export function composeSheetPage(tiles: ReadonlyArray<{ rgba: Uint8Array; label: string }>): RgbaImage {
  const { columns, tileWidth: w, tileHeight: h } = AGENT_SHEET_LIMITS, rows = Math.ceil(tiles.length / columns);
  const width = columns * w + (columns + 1) * GUTTER, height = rows * (h + LABEL) + (rows + 1) * GUTTER;
  const image: RgbaImage = { width, height, pixels: new Uint8Array(width * height * 4) };
  for (let i = 0; i < image.pixels.length; i += 4) image.pixels.set([24, 24, 24, 255], i);
  for (const [i, tile] of tiles.entries()) {
    const x0 = GUTTER + (i % columns) * (w + GUTTER), y0 = GUTTER + Math.floor(i / columns) * (h + LABEL + GUTTER);
    for (let y = 0; y < h; y++) image.pixels.set(tile.rgba.subarray(y * w * 4, (y + 1) * w * 4), ((y0 + y) * width + x0) * 4);
    drawText(image, x0 + 2, y0 + h + 4, tile.label, 2);
  }
  return image;
}
