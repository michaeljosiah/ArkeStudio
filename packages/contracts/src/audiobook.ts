import { z } from "zod";
import { CadencePlanSchema, type CadencePlan } from "./cadence.js";
import { ArtifactIdSchema, IsoDateTimeSchema, SlugSchema } from "./ids.js";
import { isSceneBreak } from "./manuscript.js";
import { DeliverySchema } from "./voice.js";
import { chapterParagraphs, voicedBlocks, type VoicedBlock } from "./prose.js";
import { textDigest } from "./subtitles.js";

/**
 * The audiobook (design turn 146, SPEC-047): a story production's third export beside `.docx`
 * and EPUB, kept as one take per block of the manuscript.
 *
 * Nothing here is a second entity model. The block is turn 130's — a paragraph split at its
 * cast lines — with two additions the reading needs and the voiced read did not: the chapter's
 * title as the first block, read by the narrator (R-2), and a scene break as a separator that
 * is silence in the file rather than a spoken row of stars. A take is an ordinary artifact whose
 * sidecar says which block it is for and what made it; this record is the index of what is made
 * and chosen, keyed to the prose it was made from, and never authoritative over the files it
 * names (§2.2).
 */

/** The paragraph index the title block carries: before the first paragraph, and never a real one. */
export const AUDIOBOOK_TITLE_PARAGRAPH = -1;
export const AUDIOBOOK_TITLE_KEY = "title";

export interface AudiobookBlock extends VoicedBlock {
  /** `title`, or `p<paragraph>.<n>` for the n-th block the paragraph splits into. Stable across saves that leave the paragraph's split alone. */
  key: string;
}

/** What the narrator reads at the head of a chapter file (R-24): the number the door shows, then the title. */
export function audiobookHeading(order: number, title: string): string {
  return `Chapter ${order} · ${title}`;
}

/**
 * A chapter's blocks for the audiobook (R-2): the title first, then turn 130's blocks in order
 * with scene-break paragraphs left out. A chapter with no prose has no blocks at all — not even
 * the title — so a run makes nothing for it and an export never holds a title-only file.
 */
export function audiobookBlocks(
  body: string,
  record: Parameters<typeof voicedBlocks>[1],
  heading: string,
): { blocks: AudiobookBlock[]; ambiguous: number } {
  const paragraphs = chapterParagraphs(body);
  if (paragraphs.every((paragraph) => isSceneBreak(paragraph))) return { blocks: [], ambiguous: 0 };
  const voiced = voicedBlocks(body, record);
  const blocks: AudiobookBlock[] = [{ key: AUDIOBOOK_TITLE_KEY, paragraph: AUDIOBOOK_TITLE_PARAGRAPH, text: heading }];
  const within = new Map<number, number>();
  for (const block of voiced.blocks) {
    if (isSceneBreak(block.text)) continue;
    const n = within.get(block.paragraph) ?? 0;
    within.set(block.paragraph, n + 1);
    blocks.push({ ...block, key: `p${block.paragraph}.${n}` });
  }
  return { blocks, ambiguous: voiced.ambiguous };
}

/** The fingerprint a take is keyed to: the block's text with whitespace folded, as it was spoken. */
export function audiobookTextHash(text: string): string {
  return textDigest(text.replace(/\s+/g, " ").trim());
}

/** A concrete voice: the narrator's, or a sheet's assignment as it stood when a take was made. */
export const AudiobookReaderSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    voiceId: z.string().min(1),
    label: z.string().min(1).optional(),
  })
  .strict();
export type AudiobookReader = z.infer<typeof AudiobookReaderSchema>;

/** Why a block fell to the narrator (R-12): said on the door before the take was made, and kept on the take. */
export const AudiobookSubstitutionSchema = z.enum(["no sheet", "no voice", "voice unavailable"]);
export type AudiobookSubstitution = z.infer<typeof AudiobookSubstitutionSchema>;

/**
 * One kept take (R-3, R-4): the artifact that holds the audio and the identity it was made
 * under. `reader` is who spoke; `assigned` is the sheet's voice the block was meant for when
 * the reader is the narrator standing in for it, so a substitution reads as current rather than
 * as stale for ever, and a sheet given a voice later moves the block to `stale` (R-13).
 */
export const AudiobookTakeSchema = z
  .object({
    artifactId: ArtifactIdSchema,
    textHash: z.string().min(1),
    reader: AudiobookReaderSchema,
    assigned: AudiobookReaderSchema.optional(),
    substituted: AudiobookSubstitutionSchema.optional(),
    /** The speaker's sheet, for a line; absent for narration and the title. */
    sheet: SlugSchema.optional(),
    format: z.enum(["wav", "mp3", "flac"]),
    characters: z.number().int().min(0),
    /** How many provider requests the take was joined from (R-5); one for a block within the cap. */
    parts: z.number().int().min(1),
    estimatedMicroUsd: z.number().int().min(0),
    costMicroUsd: z.number().int().min(0).nullable(),
    /** True when the take was adopted from the speech cache rather than made (R-19). */
    adopted: z.literal(true).optional(),
    /** The direction the take was made under (R-6, R-14), as `audiobookDirectionHash` names it; absent for a take made with none. */
    directionHash: z.string().min(1).optional(),
    madeAt: IsoDateTimeSchema,
  })
  .strict();
export type AudiobookTake = z.infer<typeof AudiobookTakeSchema>;

/**
 * A block's direction (R-6, R-8): SPEC-011's cadence plan, kept on the record and never in the
 * prose, keyed to the block's text by `textHash` — the same fingerprint the take carries — so a
 * changed wording drops it (R-9) rather than letting cues authored at positions in other words
 * land in these. The plan's own `sourceTextHash` is the full digest `mapCadence` verifies.
 */
export const AudiobookDirectionSchema = z
  .object({
    textHash: z.string().min(1),
    plan: CadencePlanSchema,
    at: IsoDateTimeSchema,
  })
  .strict();
export type AudiobookDirection = z.infer<typeof AudiobookDirectionSchema>;

/** What a window or a derivation writes: the plan without its hashes, which the coordinator supplies from the block's words. */
export const AudiobookDirectionInputSchema = CadencePlanSchema.omit({ schemaVersion: true, sourceTextHash: true });
export type AudiobookDirectionInput = z.infer<typeof AudiobookDirectionInputSchema>;

/**
 * The name of a direction as a take remembers it (R-14): the plan's fields in a fixed order,
 * so the same direction hashes the same whatever order it was written in, and a phrase or a
 * cue changed moves the block to `stale`.
 */
export function audiobookDirectionHash(plan: CadencePlan): string {
  const canonical = {
    delivery: plan.delivery,
    speed: plan.speed,
    ...(plan.phrase !== undefined ? { phrase: plan.phrase } : {}),
    cues: plan.cues.map((cue) =>
      cue.kind === "emphasis"
        ? { kind: cue.kind, from: cue.span.from, to: cue.span.to, text: cue.span.text, level: cue.level }
        : cue.kind === "pause"
          ? { kind: cue.kind, at: cue.at, length: cue.length }
          : { kind: cue.kind, at: cue.at, action: cue.action },
    ),
  };
  return textDigest(`direction-v1:${JSON.stringify(canonical)}`);
}

/** The block's direction as it stands: the record's, when it was authored for these words (R-9); nothing otherwise. */
export function audiobookDirectionFor(record: Pick<ChapterAudiobook, "direction"> | null, block: Pick<AudiobookBlock, "key" | "text">): AudiobookDirection | null {
  const held = record?.direction[block.key];
  if (held === undefined || held.textHash !== audiobookTextHash(block.text)) return null;
  return held;
}

/** The deliveries, for a panel's seg and a prompt's list. */
export const AUDIOBOOK_DELIVERIES = DeliverySchema.options;

/** A block whose make failed or was refused (R-14): the reason, kept until a later make replaces it. */
export const AudiobookFlagSchema = z.object({ reason: z.string().min(1), at: IsoDateTimeSchema }).strict();
export type AudiobookFlag = z.infer<typeof AudiobookFlagSchema>;

/**
 * The record beside a chapter's cast at `productions/<production>/.audiobook/chapters/<chapter>.json`
 * (R-1): unversioned, no track of the gate's, carried by export, written through the store's
 * ownership-checked path. `chapterVersion` and `hash` say which prose the last run read; a
 * block's own staleness is judged by its take's text hash, since one changed paragraph must not
 * mark every take of the chapter stale.
 */
export const ChapterAudiobookSchema = z
  .object({
    schemaVersion: z.literal(1),
    chapterVersion: z.number().int().min(1),
    /** The hash of the prose the last run read — the body, not the file. */
    hash: z.string().min(1),
    updatedAt: IsoDateTimeSchema,
    takes: z.record(z.string(), AudiobookTakeSchema),
    flags: z.record(z.string(), AudiobookFlagSchema),
    /** The direction per block (R-6); absent on a record the first build wrote, which read the same. */
    direction: z.record(z.string(), AudiobookDirectionSchema).default({}),
  })
  .strict();
export type ChapterAudiobook = z.infer<typeof ChapterAudiobookSchema>;

/** The stamp, which is all the bundle carries: the takes come with the chapter on open. */
export const ChapterAudiobookSummarySchema = z
  .object({
    chapterVersion: z.number().int().min(1),
    hash: z.string().min(1),
    updatedAt: IsoDateTimeSchema,
    takes: z.number().int().min(0),
    flagged: z.number().int().min(0),
  })
  .strict();
export type ChapterAudiobookSummary = z.infer<typeof ChapterAudiobookSummarySchema>;
export const ChapterAudiobookStateSchema = z.union([ChapterAudiobookSummarySchema, z.object({ unreadable: z.literal(true) }).strict()]);
export type ChapterAudiobookState = z.infer<typeof ChapterAudiobookStateSchema>;

export function summariseAudiobook(record: ChapterAudiobook): ChapterAudiobookSummary {
  return {
    chapterVersion: record.chapterVersion,
    hash: record.hash,
    updatedAt: record.updatedAt,
    takes: Object.keys(record.takes).length,
    flagged: Object.keys(record.flags).length,
  };
}

/** The book's reading (R-11): every block the narrator's, or each line its speaker's. */
export const AudiobookReadingSchema = z.enum(["narrator", "cast"]);
export type AudiobookReading = z.infer<typeof AudiobookReadingSchema>;

/**
 * `productions/<production>/.audiobook/book.json`: the one choice the whole book shares. The
 * chapters' records sit under `chapters/`, since a chapter's file stem is unconstrained and one
 * named `book` would otherwise share this path (codex on PR 1180).
 */
export const AudiobookBookSchema = z.object({ schemaVersion: z.literal(1), reading: AudiobookReadingSchema }).strict();
export type AudiobookBook = z.infer<typeof AudiobookBookSchema>;
export const DEFAULT_AUDIOBOOK_BOOK: AudiobookBook = { schemaVersion: 1, reading: "narrator" };

export type AudiobookBlockState = "not made" | "made" | "stale" | "flagged";

const sameReader = (a: AudiobookReader, b: AudiobookReader): boolean =>
  a.provider === b.provider && a.voiceId === b.voiceId && a.model === b.model;

/**
 * A block's state (R-14), derived every time it is asked: nothing on the record says "stale",
 * because a flag that could drift is the thing a derived state exists to avoid. `assigned` is
 * the reader the block is meant for now — the sheet's voice under `cast` when it has one, the
 * narrator otherwise — so a reading switched or a voice reassigned moves the block to `stale`
 * (R-13) while a take that stood in for a voiceless sheet stays current until the sheet has one.
 * `hasArtifact` says whether the take the record names is still on the shelf: the record is an
 * index, never authoritative over the files it names (§2.2), and a world carried by hand can
 * lose a sidecar or its media while the record stands — a block whose take is gone is not made,
 * or it could neither play nor be read again (codex on PR 1180).
 */
export function audiobookBlockState(
  block: Pick<AudiobookBlock, "key" | "text">,
  record: ChapterAudiobook | null,
  assigned: AudiobookReader,
  hasArtifact?: (artifactId: string) => boolean,
): AudiobookBlockState {
  if (record === null) return "not made";
  const take = record.takes[block.key];
  const flag = record.flags[block.key];
  if (flag !== undefined && (take === undefined || flag.at > take.madeAt)) return "flagged";
  if (take === undefined) return "not made";
  if (hasArtifact !== undefined && !hasArtifact(take.artifactId)) return "not made";
  if (take.textHash !== audiobookTextHash(block.text)) return "stale";
  if (!sameReader(take.assigned ?? take.reader, assigned)) return "stale";
  // The direction the take was made under against the one that stands (R-14): a direction
  // added, changed or dropped since is a different take; one authored for other words is none.
  const direction = audiobookDirectionFor(record, block);
  if ((direction === null ? undefined : audiobookDirectionHash(direction.plan)) !== take.directionHash) return "stale";
  return "made";
}

export interface AudiobookCounts {
  total: number;
  made: number;
  stale: number;
  flagged: number;
  notMade: number;
  /** The keys a run makes (R-16): everything that is not `made`, in reading order. */
  toMake: string[];
}

export function audiobookCounts(
  blocks: readonly AudiobookBlock[],
  record: ChapterAudiobook | null,
  assignedOf: (block: AudiobookBlock) => AudiobookReader,
  hasArtifact?: (artifactId: string) => boolean,
): AudiobookCounts {
  const counts: AudiobookCounts = { total: blocks.length, made: 0, stale: 0, flagged: 0, notMade: 0, toMake: [] };
  for (const block of blocks) {
    const state = audiobookBlockState(block, record, assignedOf(block), hasArtifact);
    if (state === "made") counts.made += 1;
    else {
      if (state === "stale") counts.stale += 1;
      else if (state === "flagged") counts.flagged += 1;
      else counts.notMade += 1;
      counts.toMake.push(block.key);
    }
  }
  return counts;
}

/** A chapter exports whole or not at all (R-25): every block, the title included, made and current. */
export function audiobookChapterComplete(counts: Pick<AudiobookCounts, "total" | "made">): boolean {
  return counts.total > 0 && counts.made === counts.total;
}
