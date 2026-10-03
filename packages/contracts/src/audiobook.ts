import { z } from "zod";
import { CADENCE_NOTE_MAX, CADENCE_PHRASE_MAX, CadencePlanSchema, isPointCue, normalizeSpeechText, VoiceDirectionInputSchema, type CadenceCue, type CadencePlan } from "./cadence.js";
import { orderCues } from "./direction-tags.js";
import { ArtifactIdSchema, IsoDateTimeSchema, SlugSchema } from "./ids.js";
import { isSceneBreak } from "./manuscript.js";
import { DeliverySchema } from "./voice.js";
import { chapterParagraphs, voicedBlocks, type VoicedBlock } from "./prose.js";
import { textDigest } from "./subtitles.js";
import { AudiobookGroupedSchema, AudiobookLoudnessSchema, AudiobookSplitFlagSchema } from "./audiobook-grouped.js";
import { AudiobookPictureSchema } from "./audiobook-pictures.js";
import { AudiobookBedSchema, AudiobookBlockSoundSchema, AudiobookReactionSchema, BlockTimingSchema } from "./audiobook-timing.js";

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

/**
 * What the narrator reads at the head of a chapter file (R-24): the number the door shows, then the
 * title. A chapter titled only by its number is read once — "Chapter 1 · Chapter 1" was the number
 * twice, on the screen and in the narrator's mouth (turn 188).
 */
export function audiobookHeading(order: number, title: string): string {
  const number = `Chapter ${order}`;
  return title.trim().toLowerCase() === number.toLowerCase() ? number : `${number} · ${title}`;
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

/**
 * A recording's level against `Retail`'s figures (SPEC-047 R-23, R-35): RMS between −23 and −18
 * dBFS and a peak at or under −3 dB. The foundation measures RMS and sample peak on every file;
 * outside the window is a warning, never a refusal, and an unmeasured figure is neither.
 */
export const RETAIL_RMS_DBFS = { min: -23, max: -18 } as const;
export const RETAIL_PEAK_DBFS = -3;
export function retailLevel(measurements: { rmsDbfs: number | null; samplePeakDbfs: number | null }): { loudness: "pass" | "warning" | "unavailable"; peak: "pass" | "warning" | "unavailable" } {
  const rms = measurements.rmsDbfs;
  const peak = measurements.samplePeakDbfs;
  return {
    loudness: rms === null ? "unavailable" : rms >= RETAIL_RMS_DBFS.min && rms <= RETAIL_RMS_DBFS.max ? "pass" : "warning",
    peak: peak === null ? "unavailable" : peak <= RETAIL_PEAK_DBFS ? "pass" : "warning",
  };
}

/** How many speaker colours there are (SPEC-047 R-33): `--voice-1` to `--voice-6`, repeated past the sixth. */
export const AUDIOBOOK_VOICE_COLOURS = 6;

/** Who speaks a block, as the cast keys a speaker (`summariseVoices`): the sheet, else the name; null for narration and the title. */
export function audiobookSpeakerKey(block: Pick<VoicedBlock, "speaker" | "sheet">): string | null {
  return block.sheet ?? block.speaker ?? null;
}

/** What a chapter summary holds that the colours are read from: its order, whether it is retired, and its cast's stamp. */
export interface SpeakerColourChapter {
  order: number;
  retired?: boolean;
  voices?: { speakers: readonly { speaker: string; sheet?: string }[] } | { unreadable: true };
}

/**
 * A colour for every speaker with a sheet, the same in every chapter (SPEC-047 R-33): the book's
 * speakers numbered in the order they first speak in it — chapter by chapter, and within a chapter
 * in its cast stamp's order — then wrapped past the sixth. The stamp is what every chapter summary
 * carries, so the door, the chapter and another chapter all count the same list; `extra` names
 * speakers the stamps do not hold yet (a cast derived in this window, a chapter with no stamp),
 * numbered after them. A name no sheet carries takes no colour: it is drawn as a dashed dot.
 */
export function audiobookSpeakerColours(
  chapters: readonly SpeakerColourChapter[],
  extra: readonly string[] = [],
): Map<string, number> {
  const order: string[] = [];
  const seen = new Set<string>();
  const add = (sheet: string | undefined): void => {
    if (sheet === undefined || seen.has(sheet)) return;
    seen.add(sheet);
    order.push(sheet);
  };
  for (const chapter of [...chapters].filter((c) => c.retired !== true).sort((a, b) => a.order - b.order)) {
    const voices = chapter.voices;
    if (voices === undefined || "unreadable" in voices) continue;
    for (const who of voices.speakers) add(who.sheet);
  }
  for (const sheet of extra) add(sheet);
  return new Map(order.map((sheet, index) => [sheet, (index % AUDIOBOOK_VOICE_COLOURS) + 1]));
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
    /**
     * `recorded` for a take a person recorded (SPEC-047 R-34); absent for one a voice made. A
     * recording is current while its words are: no reader or direction made it, so neither can
     * make it stale.
     */
    source: z.literal("recorded").optional(),
    /** What the recording was kept with (R-35, R-36): the performer's own label, the checks' warnings, the words' check. */
    recording: z
      .object({
        acknowledgementId: z.string().min(1),
        performer: z.string().min(1).max(80).optional(),
        warnings: z.array(z.string().min(1)).max(20),
        words: z.enum(["match", "differ", "unchecked"]),
      })
      .strict()
      .optional(),
    /** The direction the take was made under (R-6, R-14), as `audiobookDirectionHash` names it; absent for a take made with none. */
    directionHash: z.string().min(1).optional(),
    /** The speaker's note could not be applied (R-45): this narrator's row takes no phrase, so the line was read without it. */
    noteHeld: z.literal(true).optional(),
    /** Cut from a grouped request (design turn 185): the request, its blocks and the cut's place in it. */
    grouped: AudiobookGroupedSchema.optional(),
    /** The loudness the take was filed at (design turn 185). */
    loudness: AudiobookLoudnessSchema.optional(),
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
    /**
     * The words the direction was written for (R-43), so a changed wording can carry each
     * marker to its new place by its anchor rather than drop the whole direction. Absent on a
     * direction an earlier build wrote, which is dropped on a wording change as it always was.
     */
    text: z.string().min(1).optional(),
    /** Markers a wording change could not carry (R-43), counted until the block is directed again. */
    dropped: z.number().int().positive().optional(),
  })
  .strict();
export type AudiobookDirection = z.infer<typeof AudiobookDirectionSchema>;

/**
 * What a window, a derivation or the Bench writes: the plan without its hashes, which the
 * coordinator supplies from the words. An old `phrase` reads as the note (design turn 181).
 */
export const AudiobookDirectionInputSchema = VoiceDirectionInputSchema;
export type AudiobookDirectionInput = z.infer<typeof AudiobookDirectionInputSchema>;

/**
 * The name of a direction as a take remembers it (R-14): the plan's fields in a fixed order,
 * so the same direction hashes the same whatever order it was written in, and a note or a
 * cue changed moves the block to `stale`. The note is named by its old key, `phrase`, so a
 * take made under a phrase is current under the same words as a note (design turn 181).
 */
export function audiobookDirectionHash(plan: CadencePlan): string {
  const canonical = {
    delivery: plan.delivery,
    speed: plan.speed,
    ...(plan.note !== undefined ? { phrase: plan.note } : {}),
    cues: plan.cues.map((cue) =>
      cue.kind === "emphasis"
        ? { kind: cue.kind, from: cue.span.from, to: cue.span.to, text: cue.span.text, level: cue.level }
        : cue.kind === "delivery"
          ? { kind: cue.kind, from: cue.span.from, to: cue.span.to, text: cue.span.text, ...(cue.delivery !== undefined ? { delivery: cue.delivery } : {}), ...(cue.phrase !== undefined ? { phrase: cue.phrase } : {}) }
          : cue.kind === "pause"
          ? { kind: cue.kind, at: cue.at, length: cue.length }
          : cue.kind === "sound"
          ? { kind: cue.kind, at: cue.at, sound: cue.sound }
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

/**
 * Cues carried from the words they were written for to changed words (R-43). A span cue — an
 * emphasis or a marker — is anchored by its span text, a point cue by the word before it, or
 * by the word after it when it sits at the block's start. A cue whose anchor is found exactly
 * once in the new words moves there; every other is dropped and counted. A carried cue that
 * would now break the plan's rules — overlapping another, an emphasis across a marker's edge,
 * a second pause at one place — is dropped too, so what is carried always maps.
 */
export function rekeyCues(oldText: string, cues: readonly CadenceCue[], newText: string): { cues: CadenceCue[]; dropped: number } {
  const before = normalizeSpeechText(oldText);
  const after = normalizeSpeechText(newText);
  const once = (anchor: string): number | null => {
    const first = after.indexOf(anchor);
    return first < 0 || after.indexOf(anchor, first + 1) >= 0 ? null : first;
  };
  const moved: CadenceCue[] = [];
  let dropped = 0;
  for (const cue of cues) {
    if (!isPointCue(cue)) {
      const at = once(cue.span.text);
      if (at === null) dropped += 1;
      else moved.push({ ...cue, span: { ...cue.span, from: at, to: at + cue.span.text.length } });
      continue;
    }
    const head = before.slice(0, cue.at).match(/(\S+)\s*$/);
    if (head !== null) {
      const wordEnd = cue.at - (head[0].length - head[1]!.length);
      const found = once(head[1]!);
      if (found === null) dropped += 1;
      else moved.push({ ...cue, at: Math.min(after.length, found + head[1]!.length + (cue.at - wordEnd)) });
      continue;
    }
    const tail = before.slice(cue.at).match(/^(\s*)(\S+)/);
    const found = tail === null ? null : once(tail[2]!);
    if (tail === null || found === null) dropped += 1;
    else moved.push({ ...cue, at: Math.max(0, found - tail[1]!.length) });
  }
  // In position order first, so the earlier of two clashing cues is the one kept, as before.
  const ordered = [...moved].sort((a, b) => (isPointCue(a) ? a.at : a.span.from) - (isPointCue(b) ? b.at : b.span.from));
  const kept = orderCues(ordered);
  return { cues: kept, dropped: dropped + (ordered.length - kept.length) };
}

/**
 * A direction written for other words, carried to the block's words now (R-43): the block's
 * delivery, note and speed kept, its cues re-keyed, and the count of what could not be
 * carried. Null when the direction stands for these words already, or was written by a build
 * that did not keep its words, which a wording change drops whole as before.
 */
export function audiobookRekeyed(record: Pick<ChapterAudiobook, "direction"> | null, block: Pick<AudiobookBlock, "key" | "text">): { input: AudiobookDirectionInput; dropped: number } | null {
  const held = record?.direction[block.key];
  if (held === undefined || held.text === undefined || held.textHash === audiobookTextHash(block.text)) return null;
  const { cues, dropped } = rekeyCues(held.text, held.plan.cues, block.text);
  return {
    input: { ...(held.plan.delivery !== undefined ? { delivery: held.plan.delivery } : {}), speed: held.plan.speed, cues, ...(held.plan.note !== undefined ? { note: held.plan.note } : {}) },
    dropped: dropped + (held.dropped ?? 0),
  };
}

/** The deliveries, for a panel's seg and a prompt's list. */
export const AUDIOBOOK_DELIVERIES = DeliverySchema.options;

/** A block whose make failed or was refused (R-14): the reason, kept until a later make replaces it. */
export const AudiobookFlagSchema = z
  .object({
    reason: z.string().min(1),
    at: IsoDateTimeSchema,
    /** A grouped read's cut whose words did not match (design turn 185c): kept on the shelf until the author keeps it. */
    split: AudiobookSplitFlagSchema.optional(),
  })
  .strict();
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
    /**
     * The pictures set on blocks (design turn 186c, SPEC-047 R-69), by block key; absent on a
     * record with none, which the builds before them read as before (R-73).
     */
    pictures: z.record(z.string(), AudiobookPictureSchema).optional(),
    /**
     * Timing held to the blocks (design turn 187, SPEC-047 R-80..R-89): each block's start, trim,
     * `under` and nudge by block key; the reactions under their hosts by reaction key (`x<n>`),
     * whose takes sit in `takes` beside the blocks'; the beds from one block to another; the
     * sounds at a block's start. Each absent on a record with none, as the builds before read it.
     */
    timing: z.record(z.string(), BlockTimingSchema).optional(),
    reactions: z.record(z.string(), AudiobookReactionSchema).optional(),
    beds: z.record(z.string(), AudiobookBedSchema).optional(),
    sounds: z.record(z.string(), AudiobookBlockSoundSchema).optional(),
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

/**
 * The book's reading (R-11, R-44): every block the narrator's; the narrator's too, with each
 * line played by its speaker's performance note; or each line its speaker's own voice.
 */
export const AudiobookReadingSchema = z.enum(["narrator", "performed", "cast"]);
export type AudiobookReading = z.infer<typeof AudiobookReadingSchema>;

/**
 * `productions/<production>/.audiobook/book.json`: the one choice the whole book shares. The
 * chapters' records sit under `chapters/`, since a chapter's file stem is unconstrained and one
 * named `book` would otherwise share this path (codex on PR 1180).
 */
export const AudiobookBookSchema = z
  .object({
    schemaVersion: z.literal(1),
    reading: AudiobookReadingSchema,
    /**
     * The speakers a person records (SPEC-047 R-37): `narrator`, a sheet id, or a name no sheet
     * carries. The book's choice, never the sheet's; their blocks are made only by a recording.
     */
    recorded: z.array(z.string().min(1).max(120)).max(200).optional(),
    /**
     * How the narrator plays each character under `performed` (R-44): a phrase of at most 60
     * characters, keyed by sheet id or by a name no sheet carries. The book's, not the sheet's,
     * since another narrator plays a character another way.
     */
    notes: z.record(z.string().min(1).max(120), z.string().min(1).max(CADENCE_PHRASE_MAX)).optional(),
    /**
     * The voice that reads this book (R-46); absent is the app's narrator, followed as it changes.
     * Settings keeps the app's default, which every read outside the audiobook still uses.
     */
    narrator: AudiobookReaderSchema.optional(),
    /**
     * The book note (design turn 184, SPEC-047 R-53): accent, register and pronunciation for the
     * whole book, at most 300 characters, sent with every block before the block's own direction
     * so a chapter of separate requests sounds like one reader. The author's; never drafted
     * unasked.
     */
    note: z.string().min(1).max(CADENCE_NOTE_MAX).optional(),
    /** Each chapter's note (R-53): place, time and mood, keyed by chapter id, at most 300 each. */
    chapterNotes: z.record(z.string().min(1).max(120), z.string().min(1).max(CADENCE_NOTE_MAX)).optional(),
    /**
     * Where a speaker's note came from (R-54): `sheet` for one drafted from the speaker's sheet;
     * absent is the author's own. A note the author wrote is never replaced by a draft.
     */
    noteSources: z.record(z.string().min(1).max(120), z.literal("sheet")).optional(),
    /**
     * How a groupable reader's blocks are sent (design turn 185d): absent is grouped, several
     * blocks a request; `per-paragraph` is one block a request, as every reader read before.
     */
    requests: z.literal("per-paragraph").optional(),
  })
  .strict();
export type AudiobookBook = z.infer<typeof AudiobookBookSchema>;

/**
 * What a block is read under besides its own direction and its speaker's note (design turn 184,
 * SPEC-047 R-53): the book note and its chapter's note. Every block of the chapter carries both,
 * the title included.
 */
export interface AudiobookReadingNotes {
  book?: string;
  chapter?: string;
}

/** The book note and this chapter's note, as the book record holds them; empty when it holds neither. */
export function audiobookReadingNotes(book: Pick<AudiobookBook, "note" | "chapterNotes"> | null | undefined, chapterId: string): AudiobookReadingNotes {
  const chapter = book?.chapterNotes?.[chapterId];
  return { ...(book?.note !== undefined ? { book: book.note } : {}), ...(chapter !== undefined ? { chapter } : {}) };
}

/**
 * What `Direct this chapter` reads, said before it runs (design turn 184a, SPEC-047 R-51): one
 * row each — the chapter, the tone, the speakers' sheets, the narrator, the notes, and what was
 * directed before. Counts and names as data; nothing it reads goes to a voice provider.
 */
export const DirectionReadsSchema = z
  .object({
    chapter: z.object({ order: z.number().int().min(1), version: z.number().int().min(1), synopsis: z.boolean(), pov: z.string().min(1).optional() }).strict(),
    tone: z.string().min(1).optional(),
    speakers: z.array(z.string().min(1)).max(40),
    narrator: z.object({ label: z.string().min(1), description: z.string().min(1).optional() }).strict(),
    notes: z.object({ book: z.boolean(), chapter: z.boolean(), speakers: z.number().int().min(0) }).strict(),
    /** The chapter before, and how many of its blocks are directed; null for the first chapter. */
    before: z.object({ order: z.number().int().min(1), blocks: z.number().int().min(0) }).strict().nullable(),
    /** Under `performed` or `cast`, why the lines are not cast (`not cast`, `cast moved`): the sheet offers casting first. */
    cast: z.string().min(1).optional(),
    /** Under `performed`: the speakers of the chapter's lines with a note, of all of them. */
    speakerNotes: z.object({ set: z.number().int().min(0), of: z.number().int().min(0) }).strict().optional(),
  })
  .strict();
export type DirectionReads = z.infer<typeof DirectionReadsSchema>;

/** Whether a block is read under either note. */
export function hasReadingNotes(reading: AudiobookReadingNotes | undefined): reading is AudiobookReadingNotes {
  return reading !== undefined && (reading.book !== undefined || reading.chapter !== undefined);
}

/** Whose note a line is played with (R-44): the sheet, else the name; none for narration and the title. */
export function audiobookNoteKey(block: Pick<AudiobookBlock, "speaker" | "sheet">): string | null {
  return block.speaker === undefined ? null : (block.sheet ?? block.speaker);
}

/** The note a block is played with under the book's reading (R-44): only under `performed`, only on a line. */
export function audiobookNoteFor(book: Pick<AudiobookBook, "reading" | "notes"> | null, block: Pick<AudiobookBlock, "speaker" | "sheet">): string | undefined {
  if (book?.reading !== "performed") return undefined;
  const key = audiobookNoteKey(block);
  return key === null ? undefined : book.notes?.[key];
}

/**
 * The direction a take is made under, as it remembers it (R-14, R-45): the block's plan and,
 * under `performed`, its speaker's note — so a note changed makes every line of theirs stale.
 * The same name as before for a take with no note, so no take made before notes goes stale.
 */
export function audiobookTakeDirectionHash(plan: CadencePlan | null, note?: string, reading?: AudiobookReadingNotes): string | undefined {
  const inner = note === undefined
    ? plan === null ? undefined : audiobookDirectionHash(plan)
    : textDigest(`performed-v1:${JSON.stringify({ note, direction: plan === null ? null : audiobookDirectionHash(plan) })}`);
  // The book note and the chapter note name the take too (design turn 184, R-53): changing
  // either makes every block they lead stale. With neither the name is the one before them, so
  // no take made before the notes goes stale.
  if (!hasReadingNotes(reading)) return inner;
  return textDigest(`reading-v1:${JSON.stringify({ book: reading.book ?? null, chapter: reading.chapter ?? null, direction: inner ?? null })}`);
}
export const DEFAULT_AUDIOBOOK_BOOK: AudiobookBook = { schemaVersion: 1, reading: "narrator" };

export type AudiobookBlockState = "not made" | "made" | "stale" | "flagged" | "awaiting";

/** Who records a block, as the book's `recorded` names them (R-37): the narrator for narration and the title, else the sheet, else the name. */
export function audiobookRecordingKey(block: Pick<AudiobookBlock, "speaker" | "sheet"> & { text?: string }): string {
  return block.speaker === undefined ? "narrator" : (block.sheet ?? block.speaker);
}

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
  /** The block's speaker is recorded by a person (R-37, R-38): made only by a current recording, `awaiting` until then. */
  recorded = false,
  /** The note the line is played with under `performed` (R-45), part of the direction a take is judged by. */
  note?: string,
  /** The book note and the chapter note the block is read under (R-53), part of it too. */
  reading?: AudiobookReadingNotes,
): AudiobookBlockState {
  if (recorded) {
    const take = record?.takes[block.key];
    const current =
      take !== undefined && take.source === "recorded" && (hasArtifact === undefined || hasArtifact(take.artifactId)) && take.textHash === audiobookTextHash(block.text);
    return current ? "made" : "awaiting";
  }
  if (record === null) return "not made";
  const take = record.takes[block.key];
  const flag = record.flags[block.key];
  if (flag !== undefined && (take === undefined || flag.at > take.madeAt)) return "flagged";
  if (take === undefined) return "not made";
  if (hasArtifact !== undefined && !hasArtifact(take.artifactId)) return "not made";
  if (take.textHash !== audiobookTextHash(block.text)) return "stale";
  // A recording is current while its words are (R-34): no reader and no direction made it.
  if (take.source === "recorded") return "made";
  if (!sameReader(take.assigned ?? take.reader, assigned)) return "stale";
  // The direction the take was made under against the one that stands (R-14): a direction
  // added, changed or dropped since is a different take; one authored for other words is none.
  const direction = audiobookDirectionFor(record, block);
  if (audiobookTakeDirectionHash(direction?.plan ?? null, note, reading) !== take.directionHash) return "stale";
  return "made";
}

export interface AudiobookCounts {
  total: number;
  made: number;
  stale: number;
  flagged: number;
  notMade: number;
  /** Blocks waiting on a person's recording (R-38): never made by a run, never priced. */
  awaiting: number;
  /** The keys a run makes (R-16): everything that is not `made` or `awaiting`, in reading order. */
  toMake: string[];
}

export function audiobookCounts(
  blocks: readonly AudiobookBlock[],
  record: ChapterAudiobook | null,
  assignedOf: (block: AudiobookBlock) => AudiobookReader,
  hasArtifact?: (artifactId: string) => boolean,
  recordedOf: (block: AudiobookBlock) => boolean = () => false,
  /** The speaker's note and the reading notes each block is read under (R-45, R-53). */
  ledBy: (block: AudiobookBlock) => { note?: string; reading?: AudiobookReadingNotes } = () => ({}),
): AudiobookCounts {
  const counts: AudiobookCounts = { total: blocks.length, made: 0, stale: 0, flagged: 0, notMade: 0, awaiting: 0, toMake: [] };
  for (const block of blocks) {
    const led = ledBy(block);
    const state = audiobookBlockState(block, record, assignedOf(block), hasArtifact, recordedOf(block), led.note, led.reading);
    if (state === "made") counts.made += 1;
    else if (state === "awaiting") counts.awaiting += 1;
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

/**
 * The door (R-15, R-29): a row a chapter with its counts, the voices the book reads in, and the
 * price of what a press would make. Computed by the coordinator from every chapter's prose,
 * cast and record — the bundle carries only each chapter's stamp — and answered to a window
 * that opens the door or hears the book change.
 */
export const AudiobookRowSchema = z
  .object({
    chapterId: SlugSchema,
    file: z.string().min(1),
    order: z.number().int().min(1),
    title: z.string(),
    version: z.number().int().min(1),
    /** No prose: the row says `planned`, the run skips it, the count leaves it out (R-2, R-15). */
    planned: z.boolean(),
    total: z.number().int().min(0),
    made: z.number().int().min(0),
    stale: z.number().int().min(0),
    flagged: z.number().int().min(0),
    notMade: z.number().int().min(0),
    /** Blocks waiting on a person's recording (R-38); absent when none. */
    awaiting: z.number().int().min(1).optional(),
    /** The made takes' running time, summed from their measurements; null while any made take is unmeasured. */
    seconds: z.number().min(0).nullable(),
    /** Under `cast`, the run's refusal (R-12) when the cast is not current — said on the row. */
    castTrouble: z.string().min(1).optional(),
  })
  .strict();
export type AudiobookRow = z.infer<typeof AudiobookRowSchema>;

/** A voice on the door's row (R-12): who reads, in what, or why the narrator does instead. */
export const AudiobookVoiceRowSchema = z
  .object({
    sheet: SlugSchema.optional(),
    name: z.string().min(1),
    voice: z.object({ label: z.string().min(1), provider: z.string().min(1), local: z.boolean() }).strict().optional(),
    state: z.enum(["narrator", "reads", "no voice", "voice unavailable", "recorded"]),
    /** Blocks this reader has across the book: the narrator's narration, a speaker's lines. */
    blocks: z.number().int().min(0),
    /** A recorded speaker's blocks still waiting on a recording (R-38). */
    awaiting: z.number().int().min(0).optional(),
    /** The speaker's performance note under `performed` (R-44). */
    note: z.string().min(1).optional(),
    /** The narrator's row takes no phrase, so the note cannot be played (R-45). */
    noteHeld: z.literal(true).optional(),
    /** On the narrator's row: the book has a narrator of its own (R-46), not the app's. */
    book: z.literal(true).optional(),
  })
  .strict();
export type AudiobookVoiceRow = z.infer<typeof AudiobookVoiceRowSchema>;

/** One line of the book's price (R-17): a reader, its characters and what they cost; free for the narrator on this machine and for a speaker the narrator stands in for. */
export const AudiobookPriceLineSchema = z
  .object({
    label: z.string().min(1),
    provider: z.string().min(1),
    /** The narrator's own line, apart from a cast voice that happens to read on the same engine. */
    narrator: z.literal(true).optional(),
    /** Said as the speaker when the narrator stands in (`Odile Sarn · no voice · narrator · free`). */
    speaker: z.string().min(1).optional(),
    substituted: AudiobookSubstitutionSchema.optional(),
    local: z.boolean(),
    characters: z.number().int().min(0),
    estimatedMicroUsd: z.number().int().min(0),
  })
  .strict();
export type AudiobookPriceLine = z.infer<typeof AudiobookPriceLineSchema>;

export const AudiobookDoorSchema = z
  .object({
    reading: AudiobookReadingSchema,
    voices: z.array(AudiobookVoiceRowSchema),
    /** Lines a current cast counts ambiguous, read in the narrator's voice (R-12); summed over the chapters. */
    unattributed: z.number().int().min(0),
    rows: z.array(AudiobookRowSchema),
    /** What `Read the book` would make and spend: the chapters with something to make, the cloud characters, and the lines. */
    price: z
      .object({
        chapters: z.number().int().min(0),
        blocks: z.number().int().min(0),
        cloudBlocks: z.number().int().min(0),
        characters: z.number().int().min(0),
        estimatedMicroUsd: z.number().int().min(0),
        voices: z.array(AudiobookPriceLineSchema),
        /** The requests `Read the book` makes, and a block a request (design turn 185). */
        requests: z.number().int().min(0).optional(),
        perParagraph: z.number().int().min(0).optional(),
      })
      .strict(),
    /** How the book's groupable reader sends blocks (design turn 185d); absent when its reader cannot group or this machine cannot split. */
    requests: z.enum(["grouped", "per-paragraph"]).optional(),
  })
  .strict();
export type AudiobookDoor = z.infer<typeof AudiobookDoorSchema>;

/** `2:09:28`, or `31:04` under an hour: the running time as a player would show it. */
export function formatRunningTime(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

/**
 * A row's word (R-15): `planned` for a chapter with no prose; the cast's trouble under `cast`;
 * `read · 31:04` when every block is made; `not read` when none is; `moved · 3 of 24 stale`
 * when what stands in the way is stale takes alone; otherwise the count made with what is
 * stale and flagged beside it (`22 of 26 made · 1 flagged`).
 */
export function audiobookRowLabel(row: AudiobookRow): string {
  if (row.planned) return "planned";
  if (row.castTrouble !== undefined) return row.castTrouble;
  if (row.total > 0 && row.made === row.total) return row.seconds === null ? "read" : `read · ${formatRunningTime(row.seconds)}`;
  const awaiting = row.awaiting ?? 0;
  if (row.made === 0 && row.stale === 0 && row.flagged === 0 && awaiting === 0) return "not read";
  if (row.flagged === 0 && row.notMade === 0 && awaiting === 0 && row.stale > 0) return `moved · ${row.stale} of ${row.total} stale`;
  return [
    `${row.made} of ${row.total} made`,
    ...(row.stale > 0 ? [`${row.stale} stale`] : []),
    ...(row.flagged > 0 ? [`${row.flagged} flagged`] : []),
    ...(awaiting > 0 ? [`${awaiting} awaiting`] : []),
  ].join(" · ");
}

/** The door's line and the rail's count (R-29): chapters read of those with prose, the running time, the planned ones apart. */
export function audiobookDoorLine(rows: readonly AudiobookRow[]): { read: number; withProse: number; planned: number; seconds: number | null; line: string } {
  const withProse = rows.filter((row) => !row.planned);
  const readRows = withProse.filter((row) => row.total > 0 && row.made === row.total);
  const planned = rows.length - withProse.length;
  const seconds = readRows.length > 0 && readRows.every((row) => row.seconds !== null) ? readRows.reduce((sum, row) => sum + (row.seconds ?? 0), 0) : null;
  const line = [
    `${readRows.length} of ${withProse.length} chapter${withProse.length === 1 ? "" : "s"} read`,
    ...(seconds !== null && readRows.length > 0 ? [formatRunningTime(seconds)] : []),
    ...(planned > 0 ? [`${planned} planned`] : []),
  ].join(" · ");
  return { read: readRows.length, withProse: withProse.length, planned, seconds, line };
}
