import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { compositeRgba, layoutText, paintText, type TextFrame, type TextInk, type TextLook, type TextPicture } from "../packages/contracts/src/index.js";
import { loadTextFaceFile } from "../packages/coordinator/src/media/text-typefaces.js";
import { paintTextPicture, textPicturePng } from "../packages/coordinator/src/productions/editor-text-pictures.js";
import { decodePng, encodePng } from "../packages/coordinator/src/references/png.js";

/**
 * The painter's proof (SPEC-065 slice 1): the pictures a person looks at before the painter is
 * trusted with a film. It paints the four names of the Juju promo as that film draws them, a few
 * cards in the shipped typeface, and — given the film's own frames — each name beside the picture
 * the film uses today. The looks are exported because the coordinator's test pins the same
 * pictures by their pixels; what is looked at and what is pinned are one thing.
 *
 *   npx tsx scripts/text-painter-proof.mts <out dir> [frames dir]
 */

type Painted = Extract<TextPicture, { ok: true }>;

/**
 * DejaVu Serif stands in for the promo's own serif. It ships for the story PDF and is not a text
 * typeface (R-22): no look can name it, so the names are painted with the face handed straight to
 * the painter, and nothing here adds it to the table.
 */
export const PROOF_SERIF = { file: "DejaVuSerif.ttf", sha256: "42d1edeb7952f31b1f96d767ed7030b08a39e0c372b0071641518864e2bffb51", name: "DejaVu Serif" } as const;
export const PROOF_NAME_FRAME: TextFrame = { width: 1080, height: 1920 };
/** The pixel row the film's names stand on. */
export const PROOF_NAME_BASELINE = 1452;
export const PROOF_NAMES = [
  { slug: "ade", text: "Ade" }, { slug: "tunde", text: "Tunde" }, { slug: "ife", text: "Ife" }, { slug: "lady", text: "The Lady in White" },
] as const;

/** The promo's name look, all but where it stands: `y` is the middle of the line, and the film is given by its baseline. */
const NAME_INK: Omit<TextInk, "y"> = {
  size: 0.0708, tracking: 0, leading: 1.2, capitals: false, align: "center", x: 0.5, room: 0.815,
  fill: { kind: "gradient", stops: [{ at: 0, color: "#f6da94" }, { at: 0.38, color: "#e9c069" }, { at: 0.7, color: "#c9973d" }, { at: 1, color: "#9c6a1e" }] },
  edge: { color: "#180e04", width: 0.022 },
  shadow: { color: "#000000", opacity: 0.85, blur: 0.25, dx: 0, dy: 0.03 },
  rule: { length: 0.178, weight: 0.022, gap: 0.42, soft: true },
  backing: { kind: "shade", color: "#060402", opacity: 0.9 },
};

export function proofSerif() {
  const loaded = loadTextFaceFile(PROOF_SERIF.file, PROOF_SERIF.sha256, PROOF_SERIF.name);
  if (!loaded.ok) throw new Error(loaded.reason);
  return loaded.face;
}

/**
 * A name's ink, with `y` worked back from the baseline. A line's middle is half its ascent and
 * descent above the baseline, and Fit (R-10) shrinks both, so the long name needs a different `y`
 * from the short ones to stand on the same row: the line is laid out once to learn what Fit made
 * of it.
 */
export function proofNameInk(text: string): TextInk {
  const face = proofSerif(), laid = layoutText(text, { ...NAME_INK, y: 0.5 }, PROOF_NAME_FRAME, face);
  if (!laid.ok) throw new Error(laid.reason);
  return { ...NAME_INK, y: (PROOF_NAME_BASELINE - (face.ascent + face.descent) / 2 * laid.layout.unit) / PROOF_NAME_FRAME.height };
}

export function paintProofName(text: string): { ink: TextInk; picture: Painted } {
  const ink = proofNameInk(text), picture = paintText(text, ink, PROOF_NAME_FRAME, proofSerif());
  if (!picture.ok) throw new Error(picture.reason);
  return { ink, picture };
}

const GEIST = { typeface: "geist", weight: "regular", italic: false } as const;
const WHITE = { kind: "solid", color: "#ffffff" } as const;
/** Cards in the shipped typeface, each asking one thing of the layout that the names do not. */
export const PROOF_CARDS: readonly { slug: string; text: string; look: TextLook; width: number; height: number }[] = [
  { // Three lines from one left edge, on a box that keeps the same room all round (R-12).
    slug: "block", width: 1080, height: 1920, text: "Lagos\nSeven years after the fire\nNobody says her name",
    look: { ...GEIST, size: 0.032, tracking: 0, leading: 1.35, capitals: false, align: "left", x: 0.12, y: 0.78, room: 0.76, fill: WHITE, backing: { kind: "box", color: "#101418", opacity: 0.82 } },
  },
  { // Spaced capitals, typed in lower case, over a square-ended rule.
    slug: "capitals", width: 1080, height: 1920, text: "Part two",
    look: { ...GEIST, size: 0.04, tracking: 0.2, leading: 1.2, capitals: true, align: "center", x: 0.5, y: 0.5, room: 0.9, fill: { kind: "solid", color: "#f2ead8" }, shadow: { color: "#000000", opacity: 0.6, blur: 0.3, dx: 0, dy: 0.04 }, rule: { length: 0.24, weight: 0.03, gap: 0.5, soft: false } },
  },
  { // A line far wider than its room: Fit draws it smaller and the stored size stays.
    slug: "fit", width: 1080, height: 1920, text: "The house on the hill kept every one of its promises",
    look: { ...GEIST, size: 0.06, tracking: 0, leading: 1.2, capitals: false, align: "center", x: 0.5, y: 0.3, room: 0.5, fill: WHITE, edge: { color: "#000000", width: 0.05 }, rule: { length: 0.5, weight: 0.02, gap: 0.4, soft: true } },
  },
  { // A block set from its right edge, hung so most of it lies off the frame (R-9).
    slug: "overhang", width: 1080, height: 1920, text: "What the river took\nit did not give back",
    look: { ...GEIST, size: 0.07, tracking: 0, leading: 1.1, capitals: false, align: "right", x: 0.55, y: 0.96, room: 1, fill: { kind: "gradient", stops: [{ at: 0, color: "#ffffff" }, { at: 1, color: "#7fb4ff" }] }, shadow: { color: "#001030", opacity: 0.9, blur: 0.4, dx: 0.06, dy: 0.06 } },
  },
  { // The same kind of card on a wide frame.
    slug: "wide", width: 1920, height: 1080, text: "Three weeks earlier\nIbadan",
    look: { ...GEIST, size: 0.07, tracking: 0.02, leading: 1.25, capitals: false, align: "center", x: 0.5, y: 0.82, room: 0.8, fill: WHITE, edge: { color: "#0a0a0a", width: 0.03 }, shadow: { color: "#000000", opacity: 0.7, blur: 0.5, dx: 0, dy: 0.05 }, backing: { kind: "shade", color: "#000000", opacity: 0.7 } },
  },
];

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A whole-frame picture laid over a frame of the film, as the cut would lay it: straight alpha, over. */
function over(frame: Uint8Array, picture: Uint8Array): Uint8ClampedArray {
  return compositeRgba(Uint8ClampedArray.from(frame), new Uint8ClampedArray(picture.buffer, picture.byteOffset, picture.length));
}

/** Two frames side by side at half size, each pixel the mean of the four it stands for. */
function sheet(left: Uint8ClampedArray, right: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const halfWidth = width >> 1, halfHeight = height >> 1, out = new Uint8Array(halfWidth * 2 * halfHeight * 4);
  [left, right].forEach((frame, side) => {
    for (let y = 0; y < halfHeight; y++) for (let x = 0; x < halfWidth; x++) for (let channel = 0; channel < 4; channel++) {
      const at = (y * 2 * width + x * 2) * 4 + channel;
      out[(y * halfWidth * 2 + side * halfWidth + x) * 4 + channel] = Math.round((frame[at]! + frame[at + 4]! + frame[at + width * 4]! + frame[at + width * 4 + 4]!) / 4);
    }
  });
  return out;
}

async function main(outDir: string, framesDir?: string): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const line = (file: string, drawnSize: number, ms: number, rgba: Uint8Array) =>
    process.stdout.write(`${file}  drawn size ${drawnSize.toFixed(5)}  ${ms.toFixed(0)} ms  rgba sha256 ${sha256(rgba)}\n`);
  const names = new Map<string, Painted>();
  for (const { slug, text } of PROOF_NAMES) {
    const began = performance.now(), { ink, picture } = paintProofName(text), ms = performance.now() - began;
    names.set(slug, picture);
    const file = join(outDir, `name-${slug}.png`);
    await writeFile(file, textPicturePng(picture));
    line(file, picture.drawnSize, ms, picture.rgba);
    process.stdout.write(`  "${text}" stored size ${ink.size}, y ${ink.y.toFixed(6)}\n`);
  }
  for (const { slug, text, look, width, height } of PROOF_CARDS) {
    const began = performance.now(), picture = paintTextPicture({ text, look, width, height }), ms = performance.now() - began;
    if (!picture.ok) throw new Error(`${slug}: ${picture.reason}`);
    const file = join(outDir, `card-${slug}.png`);
    await writeFile(file, textPicturePng(picture));
    line(file, picture.drawnSize, ms, picture.rgba);
    process.stdout.write(`  stored size ${look.size}, name ${picture.name}\n`);
  }
  if (!framesDir) return;
  for (const { slug } of PROOF_NAMES) {
    const full = join(framesDir, `full-${slug}.png`), current = join(framesDir, `name-low-${slug}.png`);
    if (!existsSync(full) || !existsSync(current)) { process.stdout.write(`no comparison for ${slug}: ${full} and ${current} are not both there\n`); continue; }
    const frame = decodePng(await readFile(full)), film = decodePng(await readFile(current)), ours = names.get(slug)!;
    const { width, height } = PROOF_NAME_FRAME;
    if ([frame, film].some(image => image.width !== width || image.height !== height)) { process.stdout.write(`no comparison for ${slug}: its frames are not ${width}x${height}\n`); continue; }
    // Left: the painter's picture. Right: the picture the film uses today.
    const pixels = sheet(over(frame.pixels, ours.rgba), over(frame.pixels, film.pixels), width, height);
    const file = join(outDir, `compare-${slug}.png`);
    await writeFile(file, encodePng({ width: (width >> 1) * 2, height: height >> 1, pixels }));
    process.stdout.write(`${file}  left: this painter, right: the film's picture\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [outDir, framesDir] = process.argv.slice(2);
  if (!outDir) throw new Error("Usage: npx tsx scripts/text-painter-proof.mts <out dir> [frames dir]");
  await main(resolve(outDir), framesDir ? resolve(framesDir) : undefined);
}
