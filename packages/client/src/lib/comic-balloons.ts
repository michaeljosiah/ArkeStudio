import { BALLOON_EM, type ComicTypeface, type LayoutRect, type LetteringKind, type LetteringPlacement, type PageBox } from "@arke-studio/contracts";

/**
 * Drawing a page's placed words (SPEC-064 R-38a, R-48a). One painter for the stage and the finished
 * image, on a canvas both times, so what is placed is what ships: a DOM balloon beside a canvas
 * flatten would wrap its words differently and the book would differ from the screen.
 */

export const COMIC_TYPEFACES: ReadonlyArray<{ value: ComicTypeface; label: string; family: string; weight: number; capitals: boolean }> = [
  { value: "comic", label: "Comic", family: "Comic Neue", weight: 700, capitals: true },
  { value: "bold", label: "Bold", family: "Bangers", weight: 400, capitals: true },
  { value: "plain", label: "Plain", family: "Jost", weight: 500, capitals: false },
];
export const comicTypeface = (value: ComicTypeface | undefined) => COMIC_TYPEFACES.find((entry) => entry.value === value) ?? COMIC_TYPEFACES[0]!;

export interface PlacedBalloon { placement: LetteringPlacement; text: string; shape: LetteringKind }

const INK = "#111111";
const PAPER = "#ffffff";
const CAPTION = "#f4e7b4";
const SOUND = "#c2410c";

/** The gap around a panel, as page fractions, the same on the stage and in the finished image. */
const GUTTER = 0.008;
export function panelInset(rect: LayoutRect, aspect: string): LayoutRect {
  const [across, down] = aspect.split(":").map(Number) as [number, number];
  const gx = GUTTER;
  const gy = (GUTTER * across) / down;
  return { x: rect.x + gx, y: rect.y + gy, w: Math.max(0, rect.w - 2 * gx), h: Math.max(0, rect.h - 2 * gy) };
}

/** The room inside a shape for its words: an ellipse's text sits inside its corners. */
function textRoom(shape: LetteringKind, width: number, height: number, em: number): { width: number; height: number } {
  if (shape === "sfx") return { width, height };
  if (shape === "caption") return { width: Math.max(em, width - em), height: Math.max(em, height - em * 0.7) };
  const scale = shape === "shout" ? 0.62 : 0.74;
  return { width: width * scale, height: height * scale };
}

function wrap(text: string, width: number, measure: (line: string) => number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (line && measure(next) > width) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * The words set in the box: wrapped to the shape's room at the line's size, the type drawn smaller
 * until they fit, and never below half size, past which it is the box that needs to be bigger.
 */
export function setWords(text: string, room: { width: number; height: number }, em: number, measure: (line: string, px: number) => number): { lines: string[]; px: number } {
  let px = em;
  let lines = wrap(text, room.width, (line) => measure(line, px));
  while (px > em * 0.5 && (lines.length * px * 1.2 > room.height || lines.some((line) => measure(line, px) > room.width))) {
    px *= 0.94;
    lines = wrap(text, room.width, (line) => measure(line, px));
  }
  return { lines, px };
}

function ellipsePath(ctx: CanvasRenderingContext2D, box: { x: number; y: number; w: number; h: number }): void {
  ctx.beginPath();
  ctx.ellipse(box.x + box.w / 2, box.y + box.h / 2, box.w / 2, box.h / 2, 0, 0, Math.PI * 2);
}

function burstPath(ctx: CanvasRenderingContext2D, box: { x: number; y: number; w: number; h: number }): void {
  const spikes = 14;
  ctx.beginPath();
  for (let index = 0; index < spikes * 2; index++) {
    const angle = (index / (spikes * 2)) * Math.PI * 2;
    const reach = index % 2 === 0 ? 0.5 : 0.39;
    const x = box.x + box.w / 2 + Math.cos(angle) * box.w * reach;
    const y = box.y + box.h / 2 + Math.sin(angle) * box.h * reach;
    if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function tailPath(ctx: CanvasRenderingContext2D, box: { x: number; y: number; w: number; h: number }, tail: { x: number; y: number }): void {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const angle = Math.atan2((tail.y - cy) / box.h, (tail.x - cx) / box.w);
  const spread = 0.26;
  // Its base sits just inside the edge, so the shape's fill closes over the join.
  const edge = (at: number) => ({ x: cx + Math.cos(at) * box.w * 0.46, y: cy + Math.sin(at) * box.h * 0.46 });
  const left = edge(angle - spread);
  const right = edge(angle + spread);
  ctx.beginPath();
  ctx.moveTo(left.x, left.y);
  ctx.lineTo(tail.x, tail.y);
  ctx.lineTo(right.x, right.y);
  ctx.closePath();
}

export function paintBalloon(ctx: CanvasRenderingContext2D, balloon: PlacedBalloon, page: { width: number; height: number }, typeface: ComicTypeface | undefined): void {
  const { placement, shape } = balloon;
  const face = comicTypeface(typeface);
  const box = { x: placement.box.x * page.width, y: placement.box.y * page.height, w: placement.box.w * page.width, h: placement.box.h * page.height };
  const em = BALLOON_EM[placement.size ?? "m"] * page.width * (shape === "sfx" ? 1.6 : 1);
  const line = Math.max(1, page.width * 0.0016);
  const tail = placement.tail && { x: placement.tail.x * page.width, y: placement.tail.y * page.height };
  ctx.save();
  ctx.lineWidth = line;
  ctx.lineJoin = "round";
  ctx.strokeStyle = INK;
  ctx.fillStyle = PAPER;
  if (shape === "caption") {
    ctx.fillStyle = CAPTION;
    ctx.fillRect(box.x, box.y, box.w, box.h);
    ctx.strokeRect(box.x, box.y, box.w, box.h);
  } else if (shape !== "sfx") {
    if (tail && shape === "thought") {
      // A thought trails off in circles rather than pointing.
      const cx = box.x + box.w / 2;
      const cy = box.y + box.h / 2;
      for (const [at, radius] of [[0.62, 0.016], [0.84, 0.01]] as const) {
        ctx.beginPath();
        ctx.arc(cx + (tail.x - cx) * at, cy + (tail.y - cy) * at, radius * page.width, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
    // Stroked first and filled over, so the tail and the shape read as one outline.
    if (shape === "whisper") ctx.setLineDash([line * 3, line * 2.5]);
    if (tail && shape !== "thought") { tailPath(ctx, box, tail); ctx.stroke(); }
    (shape === "shout" ? burstPath : ellipsePath)(ctx, box);
    ctx.stroke();
    ctx.fill();
    ctx.setLineDash([]);
    if (tail && shape !== "thought") { tailPath(ctx, box, tail); ctx.fill(); }
  }
  const words = face.capitals ? balloon.text.toLocaleUpperCase() : balloon.text;
  const font = (px: number) => `${face.weight} ${px}px "${face.family}", "Jost", sans-serif`;
  const set = setWords(words, textRoom(shape, box.w, box.h, em), em, (text, px) => { ctx.font = font(px); return ctx.measureText(text).width; });
  ctx.font = font(set.px);
  ctx.textAlign = shape === "caption" ? "left" : "center";
  ctx.textBaseline = "middle";
  const across = shape === "caption" ? box.x + em * 0.5 : box.x + box.w / 2;
  const height = set.px * 1.2;
  const top = box.y + box.h / 2 - ((set.lines.length - 1) * height) / 2;
  if (shape === "sfx") {
    ctx.translate(box.x + box.w / 2, box.y + box.h / 2);
    ctx.rotate(-0.1);
    ctx.translate(-(box.x + box.w / 2), -(box.y + box.h / 2));
    ctx.strokeStyle = INK;
    ctx.lineWidth = line * 2.4;
  }
  set.lines.forEach((text, index) => {
    if (shape === "sfx") ctx.strokeText(text, across, top + index * height);
    ctx.fillStyle = shape === "sfx" ? SOUND : INK;
    ctx.fillText(text, across, top + index * height);
  });
  ctx.restore();
}

/** A canvas redrawn for its size in device pixels: a stage's balloons, sharp on any screen. */
export function paintStage(canvas: HTMLCanvasElement, balloons: readonly PlacedBalloon[], page: { width: number; height: number }, typeface: ComicTypeface | undefined): void {
  const ctx = canvas.getContext?.("2d");
  if (!ctx) return;
  const ratio = globalThis.devicePixelRatio ?? 1;
  canvas.width = Math.round(page.width * ratio);
  canvas.height = Math.round(page.height * ratio);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, page.width, page.height);
  for (const balloon of balloons) paintBalloon(ctx, balloon, page, typeface);
}

/** The width of a finished page: a trade comic's page at about 300 dots an inch. */
const FINISHED_WIDTH = 2000;

/**
 * The finished image (R-48a): each panel centre-cropped into its box, then the words. Read with fetch,
 * not an `<img>`: a drawn cross-origin picture taints the canvas, and a tainted canvas cannot be read.
 */
export async function flattenComicPage(input: { aspect: string; panels: ReadonlyArray<{ url: string; rect: LayoutRect }>; balloons: readonly PlacedBalloon[]; typeface: ComicTypeface | undefined }): Promise<string> {
  const [across, down] = input.aspect.split(":").map(Number) as [number, number];
  const page = { width: FINISHED_WIDTH, height: Math.round((FINISHED_WIDTH * down) / across) };
  const canvas = document.createElement("canvas");
  canvas.width = page.width;
  canvas.height = page.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("this window cannot draw the page");
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, page.width, page.height);
  const face = comicTypeface(input.typeface);
  // A font not yet used on screen is not drawn in until it has loaded.
  await document.fonts?.load(`${face.weight} 40px "${face.family}"`).catch(() => {});
  for (const panel of input.panels) {
    const response = await fetch(panel.url);
    if (!response.ok) throw new Error("a panel's picture could not be read");
    const bitmap = await createImageBitmap(await response.blob());
    const inset = panelInset(panel.rect, input.aspect);
    const box = { x: inset.x * page.width, y: inset.y * page.height, w: inset.w * page.width, h: inset.h * page.height };
    const scale = Math.max(box.w / bitmap.width, box.h / bitmap.height);
    const sw = box.w / scale;
    const sh = box.h / scale;
    ctx.drawImage(bitmap, (bitmap.width - sw) / 2, (bitmap.height - sh) / 2, sw, sh, box.x, box.y, box.w, box.h);
    bitmap.close();
    ctx.strokeStyle = INK;
    ctx.lineWidth = page.width * 0.0016;
    ctx.strokeRect(box.x, box.y, box.w, box.h);
  }
  for (const balloon of input.balloons) paintBalloon(ctx, balloon, page, input.typeface);
  return canvas.toDataURL("image/jpeg", 0.93).split(",")[1]!;
}

/** Page fractions of a box held inside the page. */
export function clampBox(box: PageBox): PageBox {
  const w = Math.min(1, Math.max(0.03, box.w));
  const h = Math.min(1, Math.max(0.02, box.h));
  return { w, h, x: Math.max(0, Math.min(1 - w, box.x)), y: Math.max(0, Math.min(1 - h, box.y)) };
}
