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

// ---------------------------------------------------------------------------
// Illustrate this chapter (design turn 191b, SPEC-047 R-101, R-102)
// ---------------------------------------------------------------------------

/** About one picture every minute and a half of speech (191b). */
export const PICTURE_PACE_SEC = 90;
/** The shortest a picture holds (186): a proposal is never closer than this to another picture. */
export const PICTURE_PROPOSAL_GAP_SEC = 20;

/** The chapter's blocks on one clock (186c): a made take's length, else its words at the reading rate — and whether any was estimated. */
export function pictureStarts(blocks: ReadonlyArray<{ text: string; seconds: number | null }>, charactersPerSecond = 15): { starts: number[]; total: number; estimated: boolean } {
  const starts: number[] = [];
  let clock = 0;
  let estimated = false;
  for (const block of blocks) {
    starts.push(Math.round(clock * 10) / 10);
    if (block.seconds !== null && block.seconds > 0) clock += block.seconds;
    else {
      estimated = true;
      clock += block.text.length / charactersPerSecond;
    }
  }
  return { starts, total: Math.round(clock * 10) / 10, estimated };
}

/**
 * How many pictures a chapter may be proposed (R-101): one every minute and a half of its speech,
 * counting those already on its blocks — the author's are never moved and never crowded.
 */
export function pictureCap(totalSeconds: number, existing: number): number {
  return Math.max(0, Math.max(1, Math.round(totalSeconds / PICTURE_PACE_SEC)) - existing);
}

/**
 * The proposals kept (R-101): in reading order, one is kept only where it is at least the picture
 * hold from every picture already standing and from every one kept before it — so no picture holds
 * less than twenty seconds — and, past the cap, the one nearest a neighbour goes first until the
 * cap is met. Returns the indexes into `candidates`, in order.
 */
export function thinPictures(candidates: ReadonlyArray<{ at: number }>, standing: readonly number[], cap: number, gap = PICTURE_PROPOSAL_GAP_SEC): number[] {
  const kept: number[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const near = [...standing, ...kept.map((at) => candidates[at]!.at)].some((other) => Math.abs(other - candidate.at) < gap);
    if (!near) kept.push(index);
  }
  const room = (list: number[], index: number): number => {
    const at = candidates[list[index]!]!.at;
    const others = [...standing, ...list.filter((_, position) => position !== index).map((entry) => candidates[entry]!.at)];
    return others.reduce((nearest, other) => Math.min(nearest, Math.abs(other - at)), Infinity);
  };
  while (kept.length > cap) {
    let worst = 0;
    for (let index = 1; index < kept.length; index += 1) if (room(kept, index) <= room(kept, worst)) worst = index;
    kept.splice(worst, 1);
  }
  return kept;
}

/** `a minute and a half`, `two minutes`, `45 s`: the pace a proposal keeps, to the quarter minute. */
export function paceLabel(seconds: number): string {
  const quarter = Math.max(15, Math.round(seconds / 15) * 15);
  if (quarter < 60) return `${quarter} s`;
  const minutes = Math.floor(quarter / 60);
  const rest = quarter % 60;
  const word = ["", "a minute", "two minutes", "three minutes", "four minutes", "five minutes"][minutes] ?? `${minutes} minutes`;
  return rest === 0 ? word : rest === 30 ? `${word} and a half` : `${minutes} m ${rest} s`;
}

/** The card's pace as it reads (191b): `one a minute and a half`, `one every two minutes`, `one every 45 s`. */
export function pacePhrase(seconds: number): string {
  const label = paceLabel(seconds);
  return label.startsWith("a minute") ? `one ${label}` : `one every ${label}`;
}

/** One picture the proposal puts on one block (191b): where, what it shows, who is in it and what it would cost. */
export const IllustrationRowSchema = z
  .object({
    block: z.string().min(1).max(40),
    /** The block's words as they stood: a row whose block has since been reworded is left out of the run. */
    textHash: z.string().min(1),
    /** The block's start on the chapter's clock, estimated until it is read. */
    at: z.number().min(0),
    title: z.string().min(1).max(PICTURE_TITLE_MAX),
    prompt: z.string().min(1).max(PICTURE_PROMPT_MAX),
    who: z.array(PictureWhoSchema).max(24),
    estimatedMicroUsd: z.number().int().min(0),
    look: PictureLookSchema.optional(),
    /**
     * Characters with a sheet and no picture to send (R-100): the row is held until they have one
     * — `Make a reference` — and goes ahead without only if the author says so.
     */
    needs: z.array(z.string().min(1).max(120)).max(24).optional(),
  })
  .strict();
export type IllustrationRow = z.infer<typeof IllustrationRowSchema>;

export const IllustrationProposalSchema = z
  .object({
    proposalId: z.string().min(1).max(64),
    /** The prose the proposal was made for: written onto only while the chapter still says it. */
    hash: z.string().min(1),
    rows: z.array(IllustrationRowSchema).max(60),
    model: PictureModelSchema,
    aspect: z.string().min(1).optional(),
    /** The chapter's length on the proposal's clock, in seconds, and whether any block's time is estimated. */
    seconds: z.number().min(0),
    estimated: z.boolean(),
    /** Pictures already on the chapter's blocks, left as they are. */
    standing: z.number().int().min(0),
    summary: z.string().min(1).optional(),
  })
  .strict();
export type IllustrationProposal = z.infer<typeof IllustrationProposalSchema>;

/** What the card says it will spend: every row that is not skipped and not held (or held and sent without). */
export function illustrationTotal(rows: readonly Pick<IllustrationRow, "block" | "estimatedMicroUsd" | "needs">[], skipped: ReadonlySet<string>, without: ReadonlySet<string>): { count: number; microUsd: number; held: number } {
  let count = 0;
  let microUsd = 0;
  let held = 0;
  for (const row of rows) {
    if (skipped.has(row.block)) continue;
    if ((row.needs?.length ?? 0) > 0 && !without.has(row.block)) {
      held += 1;
      continue;
    }
    count += 1;
    microUsd += row.estimatedMicroUsd;
  }
  return { count, microUsd, held };
}

/** Where a made-one-at-a-time run stands (191d), and what each picture came to. */
export const IllustrationProgressSchema = z
  .object({
    proposalId: z.string().min(1).max(64),
    state: z.enum(["making", "done", "stopped"]),
    /** Pictures asked for, made so far, and spent against the confirmed total. */
    total: z.number().int().min(0),
    made: z.array(z.string().min(1).max(40)).max(60),
    /** A picture that was not made and why: held, and offered again. */
    failed: z.array(z.object({ block: z.string().min(1).max(40), reason: z.string().min(1) }).strict()).max(60),
    current: z.string().min(1).max(40).optional(),
    spentMicroUsd: z.number().int().min(0),
    confirmedMicroUsd: z.number().int().min(0),
  })
  .strict();
export type IllustrationProgress = z.infer<typeof IllustrationProgressSchema>;

/**
 * The brief a picture is made from at the Bench (R-99): the prompt, then who is shown in which
 * attached picture, then the book's look. The prompt is the author's words as they stand.
 */
export function pictureBench(prompt: string, cited: ReadonlyArray<{ name: string; kind: "character" | "place"; token: string }>, art: string | undefined): string {
  return [prompt.replace(/\s+/g, " ").trim(), referenceBriefLine(cited), ...(art !== undefined && art !== "" ? [`The look: ${art}`] : [])].filter((part) => part !== "").join("\n\n");
}
