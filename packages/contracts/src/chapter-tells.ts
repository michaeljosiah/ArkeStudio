import { z } from "zod";
import { paragraphSpans, quoteSpans } from "./prose.js";

/*
 * AI tells in the chapter review (design turn 232, issue 1952). The six patterns are defined in
 * docs/research/ai-tells.md. Each is ordinary craft; what gives AI-written prose away is how
 * densely they occur, so nothing here judges an instance. The model only tags: a kind and an
 * exact quotation. Every number the writer sees (stretches, counts, the line, passages) is
 * worked out here, from the saved words, so the same tags always give the same reading and no
 * model gets to state a density or a verdict.
 */

/** In the order the What counts card teaches them. */
export const TELL_KINDS = ["three", "list", "metaphor", "notxy", "pivot", "shorthand"] as const;
export const TellKindSchema = z.enum(TELL_KINDS);
export type TellKind = z.infer<typeof TellKindSchema>;
export const TELL_LABELS: Record<TellKind, string> = {
  three: "Rule of three",
  list: "Stacked list",
  metaphor: "Metaphor",
  notxy: "Not X but Y",
  pivot: "Pivot sentence",
  shorthand: "Emotional shorthand",
};

/*
 * Provisional (issue 1952 S-6): the source counted two AI samples of about 450 words, 21 and
 * about 16 tells, and no human one. 8 sits near half of either so the screens have a number;
 * it is reset from the author's own unaided chapters before the check is promoted.
 */
export const TELL_STRETCH_WORDS = 450;
export const TELL_LINE = 8;
export const TELL_KIND_LINE = 4;

/** What the prose specialist returns for one tell. Short spans keep a long chapter's answer bounded. */
export const TellDraftSchema = z.object({ kind: TellKindSchema, quote: z.string().min(1).max(600) }).strict();
export type TellDraft = z.infer<typeof TellDraftSchema>;
/** An AI-dense 60,000-character chapter holds about 450 at the source's rate; this leaves room. */
export const TELL_ANSWER_MAX = 800;

export const PlacedTellSchema = z.object({
  kind: TellKindSchema,
  /** The tagged words; their first 600 characters when overlapping tags merged into a longer span. */
  quote: z.string().min(1).max(600),
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  // Recorded, not yet used: calibration tests whether dialogue should count (S-6).
  inDialogue: z.boolean(),
}).strict();
export type PlacedTell = z.infer<typeof PlacedTellSchema>;

const ByKindSchema = z.object(Object.fromEntries(TELL_KINDS.map((kind) => [kind, z.number().int().nonnegative()])) as Record<TellKind, z.ZodNumber>).strict();
export type TellsByKind = Record<TellKind, number>;

export const TellStretchSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  words: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
  byKind: ByKindSchema,
}).strict();
export type TellStretch = z.infer<typeof TellStretchSchema>;

export const TellPassageSchema = z.object({
  /** Stable within one reading: the passage's position, `p1` onwards. */
  id: z.string().regex(/^p\d+$/),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  /** The densest 450 words inside it: the note's count and kinds. */
  densest: TellStretchSchema,
}).strict();
export type TellPassage = z.infer<typeof TellPassageSchema>;

export const TellStripBarSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  words: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
  crowded: z.boolean(),
}).strict();

/** The reading pinned in a review, with the line it was read against. */
export const ReviewTellsSchema = z.object({
  version: z.literal(1),
  line: z.number().int().positive(),
  kindLine: z.number().int().positive(),
  stretchWords: z.number().int().positive(),
  words: z.number().int().nonnegative(),
  tells: z.array(PlacedTellSchema).max(TELL_ANSWER_MAX),
  passages: z.array(TellPassageSchema).max(200),
  strip: z.array(TellStripBarSchema).max(200),
  /** Tags whose quotation is not in the saved chapter, or repeats it more often than it occurs. */
  unplaced: z.number().int().nonnegative(),
  /** Same-kind tags that overlapped another and were counted once. */
  merged: z.number().int().nonnegative(),
}).strict();
export type ReviewTells = z.infer<typeof ReviewTellsSchema>;

const emptyByKind = (): TellsByKind => ({ three: 0, list: 0, metaphor: 0, notxy: 0, pivot: 0, shorthand: 0 });

/**
 * Place each tag at its exact quotation. A quotation the chapter does not contain is dropped,
 * as review citations are. The n-th tag of the same kind and words takes the n-th occurrence,
 * so a pivot the chapter uses twice can be tagged twice; a repeat with no occurrence left is
 * dropped. Overlapping tags of one kind are one device; different kinds both count, as the
 * source counted one sentence as Not X but Y and as Metaphor.
 */
export function verifiedTells(body: string, drafts: readonly TellDraft[]): { tells: PlacedTell[]; unplaced: number; merged: number } {
  const used = new Map<string, number>();
  const dialogue = dialogueOf(body);
  const placed: PlacedTell[] = [];
  let unplaced = 0;
  for (const draft of drafts) {
    // Blank quotation marks would otherwise be "found" at the chapter's first space.
    if (draft.quote.trim() === "") { unplaced++; continue; }
    const key = `${draft.kind}\u0000${draft.quote}`;
    let from = 0, at = -1;
    for (let n = used.get(key) ?? 0; n >= 0; n--) {
      at = body.indexOf(draft.quote, from);
      if (at < 0) break;
      from = at + 1;
    }
    if (at < 0) { unplaced++; continue; }
    used.set(key, (used.get(key) ?? 0) + 1);
    placed.push({ kind: draft.kind, quote: draft.quote, start: at, end: at + draft.quote.length, inDialogue: dialogue(at) });
  }
  placed.sort((a, b) => a.start - b.start || a.end - b.end);
  const tells: PlacedTell[] = [];
  let merged = 0;
  for (const tell of placed) {
    const same = tells.findLast((kept) => kept.kind === tell.kind);
    if (same !== undefined && tell.start < same.end) {
      merged++;
      if (tell.end > same.end) {
        same.end = tell.end;
        same.quote = body.slice(same.start, Math.min(same.end, same.start + 600));
      }
      continue;
    }
    tells.push({ ...tell });
  }
  return { tells, unplaced, merged };
}

/** Whether an offset sits inside spoken words, by the cast's own quote rule. Splits the chapter once. */
function dialogueOf(body: string): (offset: number) => boolean {
  const spoken = paragraphSpans(body).flatMap((paragraph) => {
    const raw = body.slice(paragraph.start, paragraph.end);
    const at = paragraph.start + raw.length - raw.trimStart().length;
    return quoteSpans(paragraph.text).map((span) => ({ start: at + span.start, end: at + span.end }));
  });
  return (offset) => spoken.some((span) => offset >= span.start && offset < span.end);
}

const wordsOf = (body: string) => [...body.matchAll(/\S+/g)].map((m) => ({ start: m.index, end: m.index + m[0].length }));

function stretchOf(words: ReadonlyArray<{ start: number; end: number }>, from: number, size: number, tells: readonly PlacedTell[]): TellStretch {
  const last = Math.min(words.length, from + size) - 1;
  const start = words[from]!.start, end = words[last]!.end;
  const byKind = emptyByKind();
  let count = 0;
  // A tell belongs to the stretch it begins in.
  for (const tell of tells) if (tell.start >= start && tell.start < end) { byKind[tell.kind]++; count++; }
  return { start, end, words: last - from + 1, count, byKind };
}

/**
 * Every 450 words that begin a paragraph, up to the first that reaches the chapter's end.
 * Sliding by paragraph means a crowded run cannot hide by straddling two fixed blocks; starting
 * each at a paragraph keeps what the margin marks a passage a reader would recognise.
 */
export function tellStretches(body: string, tells: readonly PlacedTell[], size = TELL_STRETCH_WORDS): TellStretch[] {
  const words = wordsOf(body);
  if (words.length === 0) return [];
  const stretches: TellStretch[] = [];
  let w = 0;
  for (const paragraph of paragraphSpans(body)) {
    while (w < words.length && words[w]!.start < paragraph.start) w++;
    if (w >= words.length) break;
    stretches.push(stretchOf(words, w, size, tells));
    if (w + size >= words.length) break;
  }
  return stretches;
}

export function crowded(stretch: Pick<TellStretch, "count" | "byKind">, line = TELL_LINE, kindLine = TELL_KIND_LINE): boolean {
  return stretch.count >= line || TELL_KINDS.some((kind) => stretch.byKind[kind] >= kindLine);
}

/**
 * Overlapping crowded stretches are one passage; its note reports the densest of them. The
 * passage spans its tells, not the stretches: every 450 words that contain a tight run of ten
 * reach 450 words either side of it, and a bar drawn over all that would mark two screens of
 * prose for one crowded paragraph.
 */
export function crowdedPassages(stretches: readonly TellStretch[], tells: readonly PlacedTell[], line = TELL_LINE, kindLine = TELL_KIND_LINE): TellPassage[] {
  const runs: Array<{ start: number; end: number; densest: TellStretch }> = [];
  for (const stretch of stretches) {
    if (!crowded(stretch, line, kindLine)) continue;
    const open = runs.at(-1);
    if (open !== undefined && stretch.start < open.end) {
      open.end = Math.max(open.end, stretch.end);
      if (stretch.count > open.densest.count) open.densest = stretch;
      continue;
    }
    runs.push({ start: stretch.start, end: stretch.end, densest: stretch });
  }
  return runs.map((run, i) => {
    const inside = tells.filter((tell) => tell.start >= run.start && tell.start < run.end);
    return { id: `p${i + 1}`, start: inside[0]!.start, end: Math.max(...inside.map((tell) => tell.end)), densest: run.densest };
  });
}

/** The chapter at a glance: consecutive 450-word blocks, start to end, each marked if a passage reaches it. */
export function tellStrip(body: string, tells: readonly PlacedTell[], passages: readonly TellPassage[], size = TELL_STRETCH_WORDS): ReviewTells["strip"] {
  const words = wordsOf(body);
  const strip: ReviewTells["strip"] = [];
  for (let from = 0; from < words.length; from += size) {
    const { start, end, words: n, count } = stretchOf(words, from, size, tells);
    strip.push({ start, end, words: n, count, crowded: passages.some((p) => p.start < end && start < p.end) });
  }
  return strip;
}

/** The whole reading for one chapter, pinned in its review with the line it used. */
export function readTells(body: string, drafts: readonly TellDraft[], line = TELL_LINE, kindLine = TELL_KIND_LINE): ReviewTells {
  const { tells, unplaced, merged } = verifiedTells(body, drafts);
  const passages = crowdedPassages(tellStretches(body, tells), tells, line, kindLine);
  return {
    version: 1, line, kindLine, stretchWords: TELL_STRETCH_WORDS, words: wordsOf(body).length,
    tells, passages, strip: tellStrip(body, tells, passages), unplaced, merged,
  };
}

/** Tells per 1,000 words, for the report. A figure, never a pass or fail. */
export function tellsPerThousand(reading: Pick<ReviewTells, "tells" | "words">): number {
  return reading.words === 0 ? 0 : Math.round((reading.tells.length * 1000) / reading.words);
}

export function tellsByKind(tells: readonly Pick<PlacedTell, "kind">[]): TellsByKind {
  const byKind = emptyByKind();
  for (const tell of tells) byKind[tell.kind]++;
  return byKind;
}
