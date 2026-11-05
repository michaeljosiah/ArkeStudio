import { z } from "zod";
import type { ImageJsonRunner } from "../harness/review-task.js";

/**
 * What places a panel's words (SPEC-064 R-39a, turn 269e): it looks at the art and says where each
 * line sits clear of faces and hands, and where a spoken line's tail points. It spends no picture
 * credit, and what it answers becomes ordinary placements the author moves like their own.
 */
export interface PagePlacer {
  place(input: PagePlacerInput, signal: AbortSignal): Promise<PlacedLine[]>;
}

export interface PagePlacerInput {
  picture: { bytes: Uint8Array; extension: string };
  description: string;
  lines: ReadonlyArray<{ id: string; kind: string; speaker?: string; text: string }>;
}

/** The top left of the line's box and its tail's aim, as fractions of the panel. */
export interface PlacedLine { item: string; x: number; y: number; tail?: { x: number; y: number } }

export const PANEL_PLACING_PROMPT = [
  "Image block panel is one comic book panel with no words on it yet. Say where each of the lines below is set over it.",
  "Keep every line clear of faces and hands, and of what the panel is about. Prefer sky, walls, shadow and empty ground. Put lines in reading order: the first higher and further left than the next, so a reader meets them in order.",
  "A caption goes in a corner. A sound effect goes beside what makes it. A speech, thought, shout or whisper line goes near its speaker, with a tail aimed at their mouth.",
  'Give x and y for the top left of each line, as fractions of the panel. Return ONLY JSON: {"lines":[{"id":"...","x":0.05,"y":0.05,"tail":{"x":0.4,"y":0.5}}]}. Leave tail out of captions and sound effects.',
].join("\n");

const AnswerSchema = z.object({ lines: z.array(z.unknown()).max(60) }).passthrough();
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
      return answer.lines.flatMap((raw): PlacedLine[] => {
        const entry = raw as { id?: unknown; x?: unknown; y?: unknown; tail?: { x?: unknown; y?: unknown } };
        const x = unit(entry.x);
        const y = unit(entry.y);
        if (typeof entry.id !== "string" || !known.has(entry.id) || x === null || y === null) return [];
        const tailX = unit(entry.tail?.x);
        const tailY = unit(entry.tail?.y);
        return [{ item: entry.id, x, y, ...(tailX !== null && tailY !== null ? { tail: { x: tailX, y: tailY } } : {}) }];
      });
    },
  };
}
