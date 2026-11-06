import { z } from "zod";
import type { LayoutRect, PageBox } from "@arke-studio/contracts";
import type { ImageJsonRunner } from "../harness/review-task.js";

/**
 * What places a panel's words (SPEC-064 R-39a, turn 269e): it looks at the art and says where each
 * line sits clear of faces and hands, and where a spoken line's tail points. It spends no picture
 * credit, and what it answers becomes ordinary placements the author moves like their own.
 */
export interface PagePlacer {
  place(input: PagePlacerInput, signal: AbortSignal): Promise<PlacedPanel>;
}

export interface PagePlacerInput {
  picture: { bytes: Uint8Array; extension: string };
  description: string;
  lines: ReadonlyArray<{ id: string; kind: string; speaker?: string; text: string }>;
}

/** The top left of the line's box and its tail's aim, as fractions of the panel. */
export interface PlacedLine { item: string; x: number; y: number; tail?: { x: number; y: number } }

/** Its lines, and the faces it saw as fractions of the panel, which the code then holds them clear of (turn 271). */
export interface PlacedPanel { lines: PlacedLine[]; faces: PageBox[] }

export const PANEL_PLACING_PROMPT = [
  "Image block panel is one comic book panel with no words on it yet. Say where each of the lines below is set over it.",
  "Keep every line clear of faces and hands, and of what the panel is about. Prefer sky, walls, shadow and empty ground. Put lines in reading order: the first higher and further left than the next, so a reader meets them in order.",
  "A caption goes in a corner. A sound effect goes beside what makes it. A speech, thought, shout or whisper line goes near its speaker, with a tail aimed at their mouth, stopping short of the face.",
  'Give x and y for the top left of each line, as fractions of the panel, and a box for every face you can see. Return ONLY JSON: {"lines":[{"id":"...","x":0.05,"y":0.05,"tail":{"x":0.4,"y":0.5}}],"faces":[{"x":0.3,"y":0.4,"w":0.2,"h":0.25}]}. Leave tail out of captions and sound effects. A panel with no faces sends "faces":[].',
].join("\n");

const AnswerSchema = z.object({ lines: z.array(z.unknown()).max(60), faces: z.array(z.unknown()).max(60).optional() }).passthrough();
const unit = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null);

export function harnessPagePlacer(ask: ImageJsonRunner): PagePlacer {
  return {
    async place(input, signal) {
      const lines = input.lines.map((line) => `${line.id} · ${line.kind}${line.speaker ? ` · ${line.speaker}` : ""} · "${line.text}"`).join("\n");
      const answer = AnswerSchema.parse(await ask({
        agent: "comic-page-reviewer",
        prompt: `${PANEL_PLACING_PROMPT}\n\nTHE PANEL SHOWS: ${input.description}\n\nTHE LINES, IN ORDER:\n${lines}`,
        images: [{ block: "panel", ...input.picture }],
      }, signal, async () => {}));
      const known = new Set(input.lines.map((line) => line.id));
      // Only the lines it was given, and only with a place it could say: a line it left out stays unplaced.
      const placed = answer.lines.flatMap((raw): PlacedLine[] => {
        const entry = (raw ?? {}) as { id?: unknown; x?: unknown; y?: unknown; tail?: { x?: unknown; y?: unknown } };
        const x = unit(entry.x);
        const y = unit(entry.y);
        if (typeof entry.id !== "string" || !known.has(entry.id) || x === null || y === null) return [];
        const tailX = unit(entry.tail?.x);
        const tailY = unit(entry.tail?.y);
        return [{ item: entry.id, x, y, ...(tailX !== null && tailY !== null ? { tail: { x: tailX, y: tailY } } : {}) }];
      });
      // A face it could not box is one less to avoid, never a reason to lose the page's lines.
      const faces = (answer.faces ?? []).flatMap((raw): PageBox[] => {
        const entry = (raw ?? {}) as { x?: unknown; y?: unknown; w?: unknown; h?: unknown };
        const [x, y, w, h] = [unit(entry.x), unit(entry.y), unit(entry.w), unit(entry.h)];
        return x === null || y === null || w === null || h === null || w === 0 || h === 0 ? [] : [{ x, y, w, h }];
      });
      return { lines: placed, faces };
    },
  };
}

const overlaps = (a: PageBox, b: PageBox) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (point: { x: number; y: number }, box: PageBox) => point.x >= box.x && point.x <= box.x + box.w && point.y >= box.y && point.y <= box.y + box.h;

/**
 * A balloon moved off the faces it landed on, by the least distance that clears them and stays in its
 * panel and off the other balloons (R-39a, turn 271). In round 95 the model's own "clear of faces" still
 * put a tail on one. With no clear place left it stays where it was asked for, for the author to move.
 */
export function clearOfFaces(box: PageBox, faces: readonly PageBox[], others: readonly PageBox[], panel: LayoutRect): PageBox {
  if (!faces.some((face) => overlaps(box, face))) return box;
  const candidates = faces.flatMap((face) => [
    { x: box.x, y: face.y - box.h }, { x: box.x, y: face.y + face.h },
    { x: face.x - box.w, y: box.y }, { x: face.x + face.w, y: box.y },
  ]).map((spot) => ({ ...box, ...spot }))
    .filter((spot) => spot.x >= panel.x && spot.y >= panel.y && spot.x + spot.w <= panel.x + panel.w && spot.y + spot.h <= panel.y + panel.h)
    .filter((spot) => ![...faces, ...others].some((other) => overlaps(spot, other)))
    .sort((a, b) => Math.hypot(a.x - box.x, a.y - box.y) - Math.hypot(b.x - box.x, b.y - box.y));
  return candidates[0] ?? box;
}

/** A tail's aim held in its panel and stopped at the first face its line would cross. */
export function tailClearOfFaces(box: PageBox, tail: { x: number; y: number }, faces: readonly PageBox[], panel: LayoutRect): { x: number; y: number } {
  const aim = { x: Math.max(panel.x, Math.min(panel.x + panel.w, tail.x)), y: Math.max(panel.y, Math.min(panel.y + panel.h, tail.y)) };
  const from = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  const STEPS = 48;
  let last = from;
  for (let step = 1; step <= STEPS; step += 1) {
    const at = { x: from.x + ((aim.x - from.x) * step) / STEPS, y: from.y + ((aim.y - from.y) * step) / STEPS };
    if (faces.some((face) => inside(at, face))) return last;
    last = at;
  }
  return aim;
}
