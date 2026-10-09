import { z } from "zod";
import { LOOK_LINE_MAX, LookViewSchema, MAIN_PHOTO_LOOK, PictureLookSchema, type PictureLookPick } from "./audiobook-look.js";
import { CODEX_IMAGE_PLAN_LABEL, aspectOffered, estimateMicroUsd, imageOutputFor, type ManifestModel } from "./manifest.js";
import type { Sheet } from "./world.js";

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
    /**
     * The look that rides for this person (design turn 193, SPEC-047 R-119): the chapter's chosen
     * kit look, and which of its images the frame took (R-118). `reference` is then that image,
     * never the main photo — the two never ride together. Absent where the main photo rides.
     */
    look: z.object({ lookId: z.string().min(1).max(120), view: LookViewSchema }).strict().optional(),
    /**
     * The look that rides — or, with no `look`, the main photo — was chosen for this picture alone
     * (design turn 193d, SPEC-047 R-115, R-146), not the chapter's choice: the card says `this
     * picture only` and the picture's stamp keeps it as its own.
     */
    only: z.literal(true).optional(),
  })
  .strict();
export type PictureWho = z.infer<typeof PictureWhoSchema>;

/**
 * The look stamp's picks from who rode (R-119): each person whose chosen look rode, with the image
 * the frame took; a look chosen for this picture alone is `only`, and so is the main photo chosen
 * for it (R-146), kept under `MAIN_PHOTO_LOOK`.
 */
export function ridingPicks(who: readonly PictureWho[]): Record<string, PictureLookPick> {
  const picks: Record<string, PictureLookPick> = {};
  for (const entry of who) {
    if (entry.kind !== "character") continue;
    if (entry.look !== undefined) picks[entry.key] = { lookId: entry.look.lookId, view: entry.look.view, ...(entry.only === true ? { only: true as const } : {}) };
    else if (entry.only === true) picks[entry.key] = { lookId: MAIN_PHOTO_LOOK, view: "close", only: true };
  }
  return picks;
}

/** The model a picture is made on, as the card names it, and what it was priced at (R-99). */
export const PictureModelSchema = z
  .object({
    provider: z.string().min(1),
    id: z.string().min(1),
    name: z.string().min(1),
    /** How many reference pictures it takes: the limit that decides which of `who` ride. */
    references: z.number().int().min(0),
    plan: z.literal("included-plan").optional(),
  })
  .strict();
export type PictureModel = z.infer<typeof PictureModelSchema>;

// ---------------------------------------------------------------------------
// The shot (design turn 193k, SPEC-047 R-120, R-121)
// ---------------------------------------------------------------------------

/** Longest frame a picture names: a frame word and a few words of subject (`Extreme close-up, Ife's eyes`). */
export const PICTURE_FRAME_MAX = 120;
/** Longest expression, or a detail's ease or tension, the card carries. */
export const PICTURE_EXPRESSION_MAX = 300;
export const PICTURE_DETAIL_PART_MAX = 60;

/** A hand or an arm a detail shot shows (rule 3, 5): whose, which part, its ease or tension. */
export const PictureDetailSchema = z
  .object({
    of: z.string().min(1).max(120),
    part: z.string().min(1).max(PICTURE_DETAIL_PART_MAX),
    state: z.string().min(1).max(PICTURE_EXPRESSION_MAX).optional(),
  })
  .strict();
export type PictureDetail = z.infer<typeof PictureDetailSchema>;

/**
 * One of the seven checks the coordinator runs on a drafted picture (rule 14, R-121): a line on
 * the card, ticked or marked. A mark never blocks Generate.
 */
export const PictureCheckSchema = z
  .object({
    id: z.enum(["reference", "not-in-frame", "frame", "garments", "mood", "closing", "expression"]),
    ok: z.boolean(),
    label: z.string().min(1).max(80),
    note: z.string().min(1).max(240).optional(),
  })
  .strict();
export type PictureCheck = z.infer<typeof PictureCheckSchema>;

/**
 * What the brief answered for one picture and what the coordinator found (R-120, R-121): the frame,
 * who is in it and who is in the scene but not in it, each face's expression by key, the hands or
 * arms a detail shows, and the checks.
 */
export const PictureShotSchema = z
  .object({
    frame: z.string().max(PICTURE_FRAME_MAX),
    inFrame: z.array(z.string().min(1).max(120)).max(24),
    notInFrame: z.array(z.string().min(1).max(120)).max(24),
    expressions: z.record(z.string().min(1).max(120), z.string().min(1).max(PICTURE_EXPRESSION_MAX)),
    details: z.array(PictureDetailSchema).max(12),
    checks: z.array(PictureCheckSchema).max(7),
  })
  .strict();
export type PictureShot = z.infer<typeof PictureShotSchema>;

/**
 * The skin a sheet's Appearance gives, in its own words: the clause that names it ("Deep brown skin
 * with a warm undertone"). A detail shot carries no reference (rule 12), so a hand drawn from the
 * prompt alone was drawn white — Ade's, in Na love or Juju's second chapter. Null where none is said.
 */
export function sheetSkin(sheet: Pick<Sheet, "sections">): string | null {
  const body = sheet.sections.find((section) => section.heading === "Appearance")?.body ?? "";
  const clause = /[^.;,!?\n]*\bskin\b[^.;,!?\n]*/i.exec(body)?.[0]?.replace(/\*+/g, "").trim();
  return clause !== undefined && clause.length > 0 ? clause.slice(0, 120) : null;
}

/** A person whose hand, arm or face a detail shows, with the skin their sheet gives. */
export interface PictureDetailSkin { name: string; part: string; skin: string }

/**
 * The people a detail shows whose sheets say their skin (design turn 193k's closing lines): each
 * once, with the parts of them in frame. Keys that are no sheet, or whose sheet says nothing, are left out.
 */
export function pictureDetailSkins(
  details: ReadonlyArray<Pick<PictureDetail, "of" | "part">>,
  people: ReadonlyArray<{ key: string; name: string; sheet?: string }>,
  sheets: ReadonlyArray<Pick<Sheet, "id" | "sections">>,
): PictureDetailSkin[] {
  const out: PictureDetailSkin[] = [];
  for (const detail of details) {
    const person = people.find((candidate) => candidate.key === detail.of);
    const sheet = person?.sheet === undefined ? undefined : sheets.find((candidate) => candidate.id === person.sheet);
    const skin = sheet === undefined ? null : sheetSkin(sheet);
    if (person === undefined || skin === null) continue;
    const held = out.find((entry) => entry.name === person.name);
    if (held !== undefined) { if (!held.part.split(" and ").includes(detail.part)) held.part = `${held.part} and ${detail.part}`; continue; }
    out.push({ name: person.name, part: detail.part, skin });
  }
  return out;
}

/** The closing line that says whose skin each detailed part is: `Ade's hand: deep brown skin with a warm undertone.` */
function detailSkinLine(detailed: ReadonlyArray<PictureDetailSkin>): string {
  return detailed.map((entry) => `${entry.name}'s ${entry.part}: ${entry.skin.charAt(0).toLowerCase()}${entry.skin.slice(1)}.`).join(" ");
}

/** The identity line the app writes after every prompt with someone in it (rule 8c, 193k). */
export const PICTURE_IDENTITY_LINE = "Keep each person's identity, hair and clothes as in the references; the expression is as written above, not the reference's.";

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
    /** The frame, who is in it and who is not, each face's expression, the details and the checks (design turn 193k, R-120, R-121). */
    shot: PictureShotSchema.optional(),
  })
  .strict();
export type PictureSuggestion = z.infer<typeof PictureSuggestionSchema>;

/** The shape a picture is asked for: widescreen where the model offers it, as the player letterboxes. */
export function pictureAspect(model: ManifestModel): string | undefined {
  return model.unverified !== true && aspectOffered(model, "16:9") ? "16:9" : undefined;
}

/**
 * What a picture would cost on this model with this many reference pictures riding, from the same
 * figures the Bench plans with. Here rather than in the coordinator so a picture already made can
 * say what Make again costs before anything is asked (design turn 194g's foot).
 */
export function pictureQuote(model: ManifestModel, referenceImages: number, aspect = pictureAspect(model)): number {
  const output = imageOutputFor(model, { landscape: true, ...(aspect !== undefined ? { aspect } : {}) });
  return estimateMicroUsd(model, {
    images: 1,
    megapixels: (output.width * output.height) / 1_000_000,
    referenceImages,
    ...(output.resolution !== undefined ? { resolution: output.resolution } : {}),
  });
}

/** Price as a card says it: `~$0.04`, to the cent and rounded up — an estimate that errs low is not trusted — and `free` for nothing. */
export function priceLabel(microUsd: number, plan?: "included-plan"): string {
  if (plan === "included-plan") return CODEX_IMAGE_PLAN_LABEL;
  if (microUsd <= 0) return "free";
  return `~$${(Math.ceil(microUsd / 10_000) / 100).toFixed(2)}`;
}

/**
 * Why a picture was not made, in plain words for a row: a provider's safety refusal reads `refused
 * by the image safety check`, whatever the provider called it; any other reason loses its provider
 * prefix and the advice after the dash (`openai: rate limited — try again later` → `rate limited`).
 */
export function pictureRefusal(reason: string | null | undefined): string {
  const said = (reason ?? "").replace(/\s+/g, " ").trim();
  if (said === "") return "not made";
  if (/\b(safety|moderation|content polic|policy violation|nsfw|flagged)\b/i.test(said)) return "refused by the image safety check";
  const clause = said.replace(/^[a-z0-9-]+:\s*/i, "").split(/\s+[—–]\s+/)[0]!.trim();
  return clause === "" ? "not made" : clause;
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
    /** The row's frame, who is in it and not, the expressions, details and checks (design turn 193k, R-120, R-121). */
    shot: PictureShotSchema.optional(),
    /**
     * Why an accepted run did not make this picture, in plain words (`refused by the image safety
     * check`): the row is held, never offered again as an ordinary one, until the author tries it
     * again (by naming it in `without`, as a row held for a reference is sent) or skips it.
     */
    refused: z.string().min(1).max(200).optional(),
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

/**
 * What the card says it will spend: every row that is not skipped and not held — for a missing
 * reference (`held`) or because a run's picture was refused (`refused`) — unless the author named
 * it in `without` (sent without the reference, or tried again).
 */
export function illustrationTotal(rows: readonly Pick<IllustrationRow, "block" | "estimatedMicroUsd" | "needs" | "refused">[], skipped: ReadonlySet<string>, without: ReadonlySet<string>): { count: number; microUsd: number; held: number; refused: number } {
  let count = 0;
  let microUsd = 0;
  let held = 0;
  let refused = 0;
  for (const row of rows) {
    if (skipped.has(row.block)) continue;
    if (!without.has(row.block) && (row.needs?.length ?? 0) > 0) {
      held += 1;
      continue;
    }
    if (!without.has(row.block) && row.refused !== undefined) {
      refused += 1;
      continue;
    }
    count += 1;
    microUsd += row.estimatedMicroUsd;
  }
  return { count, microUsd, held, refused };
}

/** Whether a row goes when the proposal is accepted: not skipped, and not held unless the author named it in `without`. */
export function illustrationRowGoes(row: Pick<IllustrationRow, "block" | "needs" | "refused">, skipped: ReadonlySet<string>, without: ReadonlySet<string>): boolean {
  if (skipped.has(row.block)) return false;
  return without.has(row.block) || ((row.needs?.length ?? 0) === 0 && row.refused === undefined);
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
 * attached picture, then the chapter's light and mood. The prompt is the author's words as they
 * stand. `mood` is the Mood line (design turn 193, rule 9; R-117), never the art direction's free
 * text, which named clothes and dressed everyone in them.
 */
export function pictureBench(
  prompt: string,
  cited: ReadonlyArray<{ name: string; kind: "character" | "place"; token: string }>,
  mood: string | undefined,
  detailed: ReadonlyArray<PictureDetailSkin> = [],
): string {
  // The closing lines are the app's, never the model's (193k, check 6): who is shown where, that the
  // references fix identity, hair and clothes and never the expression, the light, and no text.
  const people = cited.some((entry) => entry.kind === "character");
  return [
    prompt.replace(/\s+/g, " ").trim(),
    [referenceBriefLine(cited), people ? PICTURE_IDENTITY_LINE : ""].filter((part) => part !== "").join(" "),
    detailSkinLine(detailed),
    mood !== undefined && mood !== "" ? `Light and mood: ${mood}` : "",
    "No text in the picture.",
  ]
    .filter((part) => part !== "")
    .join("\n\n");
}
