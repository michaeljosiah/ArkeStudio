import { z } from "zod";
import { PageTextRegionSchema, type PageTextRegion } from "@arke-studio/contracts";
import type { ImageJsonRunner } from "../harness/review-task.js";

/**
 * What reads a comic page back (SPEC-064 R-29): a named, versioned port, as a transcriber is for
 * audio, so the identity rides on every check and a different reader is a different check. No
 * local OCR ships; the harness's own vision read is the reader, and sending a page to it is the same
 * consent as any other image inspection (R-35).
 */
export interface PageReader {
  /** Whether its boxes are measured rather than estimated (graphic-novel-check `precise`). */
  precise: boolean;
  /** What it read, and who read it: the model is part of the identity, since another reads differently (R-31). */
  read(bytes: Uint8Array, extension: string, signal: AbortSignal): Promise<{ regions: PageTextRegion[]; reader: { id: string; version: string } }>;
}

export const PAGE_READ_PROMPT = [
  "This is one comic book page. List every piece of text visible on it: speech and thought balloons, caption boxes, sound effects, signs, titles, page numbers, anything lettered.",
  "Transcribe each exactly as drawn, letter for letter, misspellings and missing words included. Never correct a word, never complete a cut-off word, never guess a word you cannot read.",
  "Give one entry per balloon, caption or block of text, in the order a reader would read the page. For each, estimate its box as fractions of the page width and height (x and y from the top-left corner, w and h its size), and set cut to true only when the page edge or a panel border visibly cuts letters off.",
  'Return ONLY JSON: {"regions":[{"text":"...","box":{"x":0.1,"y":0.05,"w":0.3,"h":0.06},"cut":false}]}. A page with no text returns {"regions":[]}.',
].join("\n\n");

const ReadSchema = z.object({ regions: z.array(z.unknown()).max(200) }).passthrough();

/** Box numbers a model rounds outside the page are clamped, not refused: they are estimates. */
function region(raw: unknown): PageTextRegion | null {
  if (typeof raw !== "object" || raw === null) return null;
  const entry = raw as { text?: unknown; box?: { x?: unknown; y?: unknown; w?: unknown; h?: unknown }; cut?: unknown };
  if (typeof entry.text !== "string" || entry.text.trim() === "") return null;
  const unit = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null);
  const box = entry.box && [entry.box.x, entry.box.y, entry.box.w, entry.box.h].every((value) => unit(value) !== null)
    ? { x: unit(entry.box.x)!, y: unit(entry.box.y)!, w: unit(entry.box.w)!, h: unit(entry.box.h)! } : undefined;
  return PageTextRegionSchema.parse({ text: entry.text.slice(0, 2000), ...(box ? { box } : {}), ...(entry.cut === true ? { cut: true } : {}) });
}

export function harnessPageReader(ask: ImageJsonRunner): PageReader {
  return {
    precise: false,
    async read(bytes, extension, signal) {
      let model: string | undefined;
      const answer = ReadSchema.parse(await ask({ agent: "page-lettering-reader", prompt: PAGE_READ_PROMPT, images: [{ block: "page", bytes, extension }] }, signal,
        async (receipt) => { model = receipt.model; }));
      return {
        regions: answer.regions.map(region).filter((entry): entry is PageTextRegion => entry !== null),
        reader: { id: "harness-vision", version: `1${model ? `:${model}` : ""}` },
      };
    },
  };
}
