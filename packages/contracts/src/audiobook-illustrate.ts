import { z } from "zod";
import { LOOK_LINE_MAX, PictureLookSchema } from "./audiobook-look.js";

/**
 * Pictures proposed by Arke (design turn 191, SPEC-047 R-99..R-102): a suggestion for one block
 * and a proposal for a chapter. Both are drafts the author reads before anything is made; both
 * are made through the Bench, priced and confirmed there, and filed on the block as a picture
 * like any other. Nothing here is spent by being read.
 */

/** Longest picture prompt a suggestion carries: one moment, a few sentences — the model's own cap is checked again at the Bench. */
export const PICTURE_PROMPT_MAX = 1200;
/** A picture's short title in a proposal's card. */
export const PICTURE_TITLE_MAX = 60;

/**
 * Someone or somewhere in a picture (R-100): by the sheet's main picture, or a place's
 * establishing view, up to the number the model takes. `reference` is the world-relative file
 * that would travel; null is a sheet with none — drawn dashed, `Make a reference` — and
 * `carried` is false for one the model's limit leaves out (the model's limit is the only limit).
 */
export const PictureWhoSchema = z
  .object({
    key: z.string().min(1).max(120),
    name: z.string().min(1).max(120),
    sheet: z.string().min(1).max(80).optional(),
    kind: z.enum(["character", "place"]),
    reference: z.string().min(1).max(1000).nullable(),
    carried: z.boolean(),
  })
  .strict();
export type PictureWho = z.infer<typeof PictureWhoSchema>;

/** The model a picture is made on, as the card names it, and what it was priced at (R-99). */
export const PictureModelSchema = z
  .object({
    provider: z.string().min(1),
    id: z.string().min(1),
    name: z.string().min(1),
    /** How many reference pictures it takes: the limit that decides which of `who` ride. */
    references: z.number().int().min(0),
  })
  .strict();
export type PictureModel = z.infer<typeof PictureModelSchema>;

/** One block's suggestion (R-99): the prompt, who is in it, the look it used, the model, ratio and price. */
export const PictureSuggestionSchema = z
  .object({
    block: z.string().min(1).max(40),
    prompt: z.string().min(1).max(PICTURE_PROMPT_MAX),
    who: z.array(PictureWhoSchema).max(24),
    /** The look lines the prompt was written from: the place first, then each person's. */
    lines: z.array(z.object({ label: z.string().min(1), text: z.string().min(1).max(LOOK_LINE_MAX) }).strict()).max(25),
    model: PictureModelSchema,
    /** The shape asked for, in the model's own vocabulary; absent where it offers none. */
    aspect: z.string().min(1).optional(),
    estimatedMicroUsd: z.number().int().min(0),
    /** What the picture will keep of the look: who was in it and a digest of their lines. */
    look: PictureLookSchema.optional(),
  })
  .strict();
export type PictureSuggestion = z.infer<typeof PictureSuggestionSchema>;

/** Price as a card says it: `~$0.04`, to the cent and rounded up — an estimate that errs low is not trusted — and `free` for nothing. */
export function priceLabel(microUsd: number): string {
  if (microUsd <= 0) return "free";
  return `~$${(Math.ceil(microUsd / 10_000) / 100).toFixed(2)}`;
}

/** The sentence-free reference line a Bench brief carries, so each picture is cited by the name the Bench gave it. */
export function referenceBriefLine(cited: ReadonlyArray<{ name: string; kind: "character" | "place"; token: string }>): string {
  if (cited.length === 0) return "";
  return cited.map((entry) => (entry.kind === "place" ? `The setting is ${entry.name}, shown in @${entry.token}.` : `${entry.name} is shown in @${entry.token}.`)).join(" ");
}

/**
 * The brief a picture is made from at the Bench (R-99): the prompt, then who is shown in which
 * attached picture, then the book's look. The prompt is the author's words as they stand.
 */
export function pictureBench(prompt: string, cited: ReadonlyArray<{ name: string; kind: "character" | "place"; token: string }>, art: string | undefined): string {
  return [prompt.replace(/\s+/g, " ").trim(), referenceBriefLine(cited), ...(art !== undefined && art !== "" ? [`The look: ${art}`] : [])].filter((part) => part !== "").join("\n\n");
}
