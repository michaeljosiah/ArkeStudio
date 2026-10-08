import { z } from "zod";
import { CADENCE_NOTE_MAX, CADENCE_PHRASE_MAX, CadencePlanSchema, isPointCue, normalizeSpeechText, VoiceDirectionInputSchema, type CadenceCue, type CadencePlan } from "./cadence.js";
import { orderCues } from "./direction-tags.js";
import { ArtifactIdSchema, IsoDateTimeSchema, SlugSchema } from "./ids.js";
import { isSceneBreak } from "./manuscript.js";
import { DeliverySchema } from "./voice.js";
import { chapterParagraphs, voicedBlocks, type VoicedBlock } from "./prose.js";
import { textDigest } from "./subtitles.js";
import { expectedSpeechSeconds } from "./speech-pricing.js";
import { AudiobookGroupedSchema, AudiobookLoudnessSchema, AudiobookSplitFlagSchema } from "./audiobook-grouped.js";
import { AudiobookPictureSchema } from "./audiobook-pictures.js";
import { AudiobookLookSchema, PictureOwnLooksSchema } from "./audiobook-look.js";
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

/** One speaker's turn inside a block that holds several: its words, and who speaks them. */
export interface AudiobookTurn {
  text: string;
  speaker?: string;
  sheet?: string;
  /** An edited quote that kept its speaker (design turn 198): the row's dashed `kept` mark. */
  kept?: true;
}

export interface AudiobookBlock extends VoicedBlock {
  /** `title`, or `p<paragraph>.<n>` for the n-th block the paragraph splits into. Stable across saves that leave the paragraph's split alone. */
  key: string;
  /**
   * The turns a block holds when one reader reads them all (design turn 190): a line and its tag
   * are one block, read straight through, and the cast's speakers are rows inside it. Absent on a
   * block that is a single turn. A block with rows has no speaker of its own, unless a seam set by
   * hand joined turns of one speaker alone (design turn 198), which that speaker reads.
   */
  rows?: AudiobookTurn[];
  /**
   * A seam set by hand gave the block this shape (design turn 198): it is not one of the blocks
   * the reading cuts on its own. Absent on every block the automatic split makes.
   */
  shaped?: true;
  /** On a shaped block: the automatic blocks it takes words from, by key, in order — whose delivery, note, speed and markers it carries. */
  sources?: string[];
  /** On a shaped block: the automatic blocks whose first turn it holds — a join's, whose first picture it shows. */
  starts?: string[];
}

/** How a chapter's turns become its blocks. */
export interface AudiobookBlockOptions {
  /**
   * One reader reads the chapter (the narrator under `narrator` and `performed`), so the turns of
   * a paragraph are one block; under `cast` a block splits where the reader changes.
   */
  merge?: boolean;
  /** A turn read apart from its neighbours whatever the reading: a speaker a person records. */
  apart?: (turn: VoicedBlock) => boolean;
  /** The seams set by hand on the chapter's record (design turn 198), joins and splits between its turns. */
  seams?: readonly AudiobookSeam[];
}

/**
 * Where a turn stands in the chapter (design turn 198): its paragraph, as `chapterParagraphs`
 * counts them, and its place among that paragraph's turns (SPEC-012 R-46's narration and lines).
 */
export const AudiobookTurnPlaceSchema = z.object({ paragraph: z.number().int().min(0), turn: z.number().int().min(0) }).strict();
export type AudiobookTurnPlace = z.infer<typeof AudiobookTurnPlaceSchema>;

/**
 * A seam set by hand (design turn 198, SPEC-047 R-147): a gap between two turns made a block's
 * edge (`split`) or taken out of one (`join`). It names the turns it sits between and the hash of
 * their words, so a paragraph inserted above leaves it where its words are, and an edit to either
 * turn drops it: the block goes back to its automatic split, as a take goes stale. Kept on the
 * chapter's audiobook record, never in the manuscript.
 */
export const AudiobookSeamSchema = z
  .object({
    kind: z.enum(["join", "split"]),
    before: AudiobookTurnPlaceSchema,
    after: AudiobookTurnPlaceSchema,
    textHash: z.string().min(1),
    at: IsoDateTimeSchema,
  })
  .strict();
export type AudiobookSeam = z.infer<typeof AudiobookSeamSchema>;
/** A beat the director named (design turn 201, SPEC-047 R-175), kept beside the seams that join it. */
export const AudiobookBeatSchema = z
  .object({
    start: z.string().min(1).max(40),
    /** The words of the block the beat was joined into, as `audiobookTextHash` names them. */
    textHash: z.string().min(1),
    name: z.string().min(1).max(80).optional(),
    whose: z.string().min(1).max(120).optional(),
  })
  .strict();
export type AudiobookBeat = z.infer<typeof AudiobookBeatSchema>;

/** A chapter's seams at most: one a gap of a long chapter's turns, with room. */
export const AUDIOBOOK_SEAMS_MAX = 4000;

/**
 * The longest a joined block may be (design turn 198, rule 8): one read, about five minutes of
 * expected speech, the grouped request's own cap (`GROUPED_READ_CAPS.speechSeconds`, turn 185),
 * which a block must fit to be read in one request at all.
 */
export const AUDIOBOOK_JOIN_MAX_SECONDS = 300;

/** Why a Join is drawn off on its seam (rule 8): said only where it bites. */
export type AudiobookSeamLimit = "title" | "scene break" | "over 5 min" | "two voices";

/** A gap's anchor as a press sends it: the turns either side and their words' hash. */
export interface AudiobookSeamAnchor {
  before: AudiobookTurnPlace;
  after: AudiobookTurnPlace;
  textHash: string;
}

/**
 * A gap the Audiobook view can press (design turn 198): between two blocks, a Join; between two
 * rows of one block, a Split. `block` is the block under a Join's gap, or the block a Split's gap
 * is inside, the gap coming after its row `row`. `seam` is the index in the record's seams of the
 * seam that sits on it, applied or held; `auto` says whether the reading would cut there on its own.
 */
export interface AudiobookGap {
  press: "join" | "split";
  block: string;
  row?: number;
  /** Absent only on the title's gap, which no press can change. */
  anchor?: AudiobookSeamAnchor;
  auto: boolean;
  seam?: number;
  limit?: AudiobookSeamLimit;
}

/** What the seams do under this reading: the blocks they shape, the joins held, the seams whose words changed, and every gap. */
export interface AudiobookSeamView {
  changed: number;
  held: number;
  dropped: number;
  /** The record's seams no gap holds any more (their words changed), by index. */
  droppedSeams: number[];
  gaps: AudiobookGap[];
}

/** The words either side of a gap, as a seam remembers them. */
export function audiobookSeamHash(before: string, after: string): string {
  const fold = (text: string) => text.replace(/\s+/g, " ").trim();
  return textDigest(`seam-v1:${JSON.stringify([fold(before), fold(after)])}`);
}

/** The label a Blocks press carries (design turn 198, rule 10): `3 changed · 1 held`, `1 seam dropped · words changed`; null when nothing is set. */
export function audiobookSeamLabel(view: Pick<AudiobookSeamView, "changed" | "held" | "dropped">): string | null {
  if (view.changed === 0 && view.held === 0 && view.dropped === 0) return null;
  return [
    ...(view.changed > 0 || (view.held === 0 && view.dropped === 0) ? [`${view.changed} changed`] : []),
    ...(view.held > 0 ? [`${view.held} held`] : []),
    ...(view.dropped > 0 ? [`${view.dropped} seam${view.dropped === 1 ? "" : "s"} dropped · words changed`] : []),
  ].join(" · ");
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
  options: AudiobookBlockOptions = {},
): { blocks: AudiobookBlock[]; ambiguous: number; seams: AudiobookSeamView } {
  const paragraphs = chapterParagraphs(body);
  const none: AudiobookSeamView = { changed: 0, held: 0, dropped: 0, droppedSeams: [], gaps: [] };
  if (paragraphs.every((paragraph) => isSceneBreak(paragraph))) return { blocks: [], ambiguous: 0, seams: { ...none, dropped: options.seams?.length ?? 0, droppedSeams: (options.seams ?? []).map((_, index) => index) } };
  const voiced = voicedBlocks(body, record);
  // The chapter's turns in order, each with its place (design turn 198): a scene break is in no
  // block (turn 190), so it is no turn here, and the turn after it remembers that it was there.
  interface Unit { turn: VoicedBlock; place: AudiobookTurnPlace; sceneBefore: boolean; apart: boolean }
  const units: Unit[] = [];
  const counted = new Map<number, number>();
  let scene = false;
  for (const turn of voiced.blocks) {
    const at = counted.get(turn.paragraph) ?? 0;
    counted.set(turn.paragraph, at + 1);
    if (isSceneBreak(turn.text)) {
      scene = true;
      continue;
    }
    units.push({ turn, place: { paragraph: turn.paragraph, turn: at }, sceneBefore: scene && units.length > 0, apart: options.apart?.(turn) === true });
    scene = false;
  }
  // One reader, one block (design turn 190): the turns of a paragraph that one reader reads are a
  // run, read as the one passage they are; under `cast` every turn is its own block, and a turn a
  // person records is read apart. A gap is a block's edge on its own (`auto`) by that rule alone.
  const gapCount = Math.max(0, units.length - 1);
  const auto = Array.from({ length: gapCount }, (_, g) => {
    const a = units[g]!;
    const b = units[g + 1]!;
    return options.merge !== true || a.apart || b.apart || b.sceneBefore || a.place.paragraph !== b.place.paragraph;
  });
  const speakerOf = (unit: Unit) => audiobookSpeakerKey(unit.turn);
  // Under Cast only lines in the same voice join (rule 8), and a speaker a person records is a
  // voice of its own whatever the reading.
  const twoVoices = (g: number) => units[g]!.apart || units[g + 1]!.apart || (options.merge !== true && speakerOf(units[g]!) !== speakerOf(units[g + 1]!));
  const gapHash = (g: number) => audiobookSeamHash(units[g]!.turn.text, units[g + 1]!.turn.text);
  const samePlace = (a: AudiobookTurnPlace, b: AudiobookTurnPlace) => a.paragraph === b.paragraph && a.turn === b.turn;
  // A seam set at a paragraph's edge before its lines were cast stands at that edge after (2026-10-08):
  // a cast cuts a paragraph into its narration and its lines, so the turns either side of the edge
  // say less than they did and no gap's words were the seam's — a chapter grouped by beats and then
  // cast lost 16 of its 29 beats. The paragraphs read whole, uncast, are its words still.
  let whole: Map<number, string> | undefined;
  const wholeText = (paragraph: number) => {
    if (whole === undefined) {
      whole = new Map();
      for (const turn of voicedBlocks(body, null).blocks) if (!whole.has(turn.paragraph)) whole.set(turn.paragraph, turn.text);
    }
    return whole.get(paragraph);
  };
  const paragraphEdge = (seam: AudiobookSeam): number | null => {
    if (seam.before.paragraph === seam.after.paragraph) return null;
    const before = wholeText(seam.before.paragraph), after = wholeText(seam.after.paragraph);
    if (before === undefined || after === undefined || audiobookSeamHash(before, after) !== seam.textHash) return null;
    const g = units.findIndex((unit, at) => at < gapCount && unit.place.paragraph === seam.before.paragraph && units[at + 1]!.place.paragraph === seam.after.paragraph);
    return g >= 0 ? g : null;
  };
  // A seam stands where its two turns still say what they said: at its own place, else at the one
  // gap whose words are its words (a paragraph inserted above moved it), else at its paragraphs'
  // edge as above; never placed by guess.
  const locate = (seam: AudiobookSeam): number | null => {
    const own = units.findIndex((unit) => samePlace(unit.place, seam.before));
    if (own >= 0 && own < gapCount && samePlace(units[own + 1]!.place, seam.after) && gapHash(own) === seam.textHash) return own;
    const found: number[] = [];
    for (let g = 0; g < gapCount; g += 1) if (gapHash(g) === seam.textHash) found.push(g);
    return found.length === 1 ? found[0]! : paragraphEdge(seam);
  };
  const edge = [...auto];
  const seamAt = new Map<number, number>();
  const joined = new Set<number>();
  const droppedSeams: number[] = [];
  let held = 0;
  (options.seams ?? []).forEach((seam, index) => {
    const g = locate(seam);
    // A scene break written between its turns is an edit under it too.
    if (g === null || seamAt.has(g) || units[g + 1]!.sceneBefore) {
      droppedSeams.push(index);
      return;
    }
    seamAt.set(g, index);
    if (seam.kind === "split") {
      edge[g] = true;
      return;
    }
    if (!auto[g]) return;
    // Seams follow the reading (rule 9): a join of two voices under Cast is held, not dropped.
    if (twoVoices(g)) {
      held += 1;
      return;
    }
    edge[g] = false;
    joined.add(g);
  });
  const seconds = (from: number, to: number) => {
    let sum = 0;
    for (let at = from; at <= to; at += 1) sum += expectedSpeechSeconds(units[at]!.turn.text);
    return sum;
  };
  // A joined block must fit one read (rule 8). The press refuses one that would not; words grown
  // since under a join that stands hold its joins, as the reading's limit does.
  {
    let from = 0;
    for (let g = 0; g <= gapCount; g += 1) {
      if (g < gapCount && !edge[g]) continue;
      const inside = [...joined].filter((gap) => gap >= from && gap < g);
      if (inside.length > 0 && seconds(from, g) > AUDIOBOOK_JOIN_MAX_SECONDS) {
        for (const gap of inside) {
          edge[gap] = true;
          joined.delete(gap);
          held += 1;
        }
      }
      from = g + 1;
    }
  }
  const runsOf = (edges: readonly boolean[]): Array<[number, number]> => {
    const runs: Array<[number, number]> = [];
    let from = 0;
    for (let g = 0; g <= gapCount; g += 1) {
      if (g < gapCount && !edges[g]) continue;
      if (units.length > 0) runs.push([from, g]);
      from = g + 1;
    }
    return runs;
  };
  // The automatic blocks and their keys, as the reading cuts them: `p<paragraph>.<n>`.
  const autoRuns = runsOf(auto);
  const autoKeyAt = new Map<number, string>();
  const autoOf: number[] = [];
  const within = new Map<number, number>();
  autoRuns.forEach(([from, to], index) => {
    const paragraph = units[from]!.place.paragraph;
    const n = within.get(paragraph) ?? 0;
    within.set(paragraph, n + 1);
    autoKeyAt.set(from, `p${paragraph}.${n}`);
    for (let at = from; at <= to; at += 1) autoOf[at] = index;
  });
  const autoKey = (index: number) => autoKeyAt.get(autoRuns[index]![0])!;
  const textOf = (from: number, to: number): string => {
    if (from === to) return units[from]!.turn.text;
    // Each paragraph's part: the whole paragraph when the turns cover it, so the block is an exact
    // slice of it (a pin finds its words there); else the turns as they read, one space between.
    const parts: string[] = [];
    let at = from;
    while (at <= to) {
      const paragraph = units[at]!.place.paragraph;
      const run: VoicedBlock[] = [];
      while (at <= to && units[at]!.place.paragraph === paragraph) run.push(units[at++]!.turn);
      const whole = paragraphs[paragraph];
      const covers = whole !== undefined && run.map((turn) => turn.text.trim()).join("").replace(/\s+/g, "") === whole.replace(/\s+/g, "");
      parts.push(covers ? whole : run.map((turn) => turn.text).join(" "));
    }
    return parts.join("\n\n");
  };
  const blocks: AudiobookBlock[] = [{ key: AUDIOBOOK_TITLE_KEY, paragraph: AUDIOBOOK_TITLE_PARAGRAPH, text: heading }];
  const runs = runsOf(edge);
  const runOf: number[] = [];
  for (const [index, [from, to]] of runs.entries()) {
    for (let at = from; at <= to; at += 1) runOf[at] = index;
    const first = units[from]!;
    const startsAuto = autoKeyAt.get(from);
    // A join keeps the first block's key, a split's first part the block's; a later part takes the
    // next free key of its paragraph in the same scheme, so a key reused never finds another
    // block's take, which is found by its words as well (rules 6 and 7).
    let key = startsAuto;
    if (key === undefined) {
      const n = within.get(first.place.paragraph) ?? 0;
      within.set(first.place.paragraph, n + 1);
      key = `p${first.place.paragraph}.${n}`;
    }
    const shaped = startsAuto === undefined || autoRuns[autoOf[from]!]![1] !== to;
    const shape = shaped
      ? {
          shaped: true as const,
          sources: [...new Set(Array.from({ length: to - from + 1 }, (_, i) => autoKey(autoOf[from + i]!)))],
          starts: Array.from({ length: to - from + 1 }, (_, i) => from + i).filter((at) => autoKeyAt.has(at)).map((at) => autoKeyAt.get(at)!),
        }
      : {};
    if (from === to) {
      blocks.push({ ...first.turn, key, ...shape });
      continue;
    }
    const rows = units.slice(from, to + 1).map(({ turn }) => ({ text: turn.text, ...(turn.speaker !== undefined ? { speaker: turn.speaker } : {}), ...(turn.sheet !== undefined ? { sheet: turn.sheet } : {}), ...(turn.kept === true ? { kept: true as const } : {}) }));
    // Turns of one speaker joined by hand are that speaker's block (rule 8 keeps Cast's joins to one voice).
    const one = shaped && rows.every((row) => row.speaker !== undefined && audiobookSpeakerKey(row) === audiobookSpeakerKey(rows[0]!)) ? { speaker: rows[0]!.speaker!, ...(rows[0]!.sheet !== undefined ? { sheet: rows[0]!.sheet } : {}) } : {};
    blocks.push({ paragraph: first.place.paragraph, text: textOf(from, to), key, ...one, rows, ...shape });
  }
  // Every gap the view can press, with what a press there would do and why it cannot.
  const gaps: AudiobookGap[] = [];
  if (runs.length > 0) gaps.push({ press: "join", block: blocks[1]!.key, auto: true, limit: "title" });
  for (let g = 0; g < gapCount; g += 1) {
    const anchor = { before: units[g]!.place, after: units[g + 1]!.place, textHash: gapHash(g) };
    const seam = seamAt.get(g);
    const common = { anchor, auto: auto[g]!, ...(seam !== undefined ? { seam } : {}) };
    if (!edge[g]) {
      const run = runs[runOf[g]!]!;
      gaps.push({ press: "split", block: blocks[runOf[g]! + 1]!.key, row: g - run[0], ...common });
      continue;
    }
    const above = runs[runOf[g]!]!;
    const below = runs[runOf[g + 1]!]!;
    const limit: AudiobookSeamLimit | undefined = units[g + 1]!.sceneBefore
      ? "scene break"
      : twoVoices(g)
        ? "two voices"
        : seconds(above[0], below[1]) > AUDIOBOOK_JOIN_MAX_SECONDS
          ? "over 5 min"
          : undefined;
    gaps.push({ press: "join", block: blocks[runOf[g + 1]! + 1]!.key, ...common, ...(limit !== undefined ? { limit } : {}) });
  }
  return {
    blocks,
    ambiguous: voiced.ambiguous,
    seams: { changed: blocks.filter((block) => block.shaped === true).length, held, dropped: droppedSeams.length, droppedSeams, gaps },
  };
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
export function audiobookRekeyed(record: Pick<ChapterAudiobook, "direction"> | null, block: Pick<AudiobookBlock, "key" | "text" | "shaped" | "sources">): { input: AudiobookDirectionInput; dropped: number } | null {
  const held = record?.direction[block.key];
  if (block.shaped === true && (held === undefined || held.textHash !== audiobookTextHash(block.text))) return shapedDirection(record, block);
  if (held === undefined || held.text === undefined || held.textHash === audiobookTextHash(block.text)) return null;
  const { cues, dropped } = rekeyCues(held.text, held.plan.cues, block.text);
  return {
    input: { ...(held.plan.delivery !== undefined ? { delivery: held.plan.delivery } : {}), speed: held.plan.speed, cues, ...(held.plan.note !== undefined ? { note: held.plan.note } : {}) },
    dropped: dropped + (held.dropped ?? 0),
  };
}

/**
 * A block a seam set by hand shaped, directed from the blocks it was made of (design turn 198,
 * rules 6 and 7): the first one's delivery, note and speed — a split's every part a copy of
 * them — and each one's markers where their words now are. Derived every time and written
 * nowhere, so the blocks it came from keep their own directions on the record and a block put
 * back finds them, and its take, as they were. A marker whose words went to another part is in
 * that part, not dropped. Null when none of them is directed.
 */
function shapedDirection(record: Pick<ChapterAudiobook, "direction"> | null, block: Pick<AudiobookBlock, "text" | "sources">): { input: AudiobookDirectionInput; dropped: number } | null {
  const entries = (block.sources ?? []).flatMap((key) => {
    const entry = record?.direction[key];
    return entry === undefined ? [] : [entry];
  });
  if (entries.length === 0) return null;
  // The first block's own: a join of an undirected block and a directed one reads undirected, but
  // for the markers the second's words carry.
  const first = record?.direction[block.sources?.[0] ?? ""];
  const moved = entries.flatMap((entry) => (entry.text === undefined ? [] : rekeyCues(entry.text, entry.plan.cues, block.text).cues));
  const ordered = [...moved].sort((a, b) => (isPointCue(a) ? a.at : a.span.from) - (isPointCue(b) ? b.at : b.span.from));
  const cues = orderCues(ordered);
  if (first === undefined && cues.length === 0) return null;
  return {
    input: { ...(first?.plan.delivery !== undefined ? { delivery: first.plan.delivery } : {}), speed: first?.plan.speed ?? 1, cues, ...(first?.plan.note !== undefined ? { note: first.plan.note } : {}) },
    dropped: 0,
  };
}

/**
 * The direction a block is read and judged under (R-14): the record's for these words, or — on
 * a block a seam shaped — the one its blocks make together (design turn 198). A take of a shaped
 * block is named by it, and keeps nothing of it on the record.
 */
export function audiobookBlockPlan(record: Pick<ChapterAudiobook, "direction"> | null, block: Pick<AudiobookBlock, "key" | "text" | "shaped" | "sources">): CadencePlan | null {
  const standing = audiobookDirectionFor(record, block);
  if (standing !== null || block.shaped !== true) return standing?.plan ?? null;
  const shaped = shapedDirection(record, block);
  return shaped === null ? null : { schemaVersion: 1, sourceTextHash: audiobookTextHash(block.text), ...shaped.input };
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
     * The chapter's look (design turn 191c, SPEC-047 R-98): the place, the time and the light, and
     * what each character wears and carries here, read once from the prose and kept, every line
     * editable. Absent until read or written; the first record with one raises the world to
     * schema 49, and so does a picture that keeps the look it was made under.
     */
    look: AudiobookLookSchema.optional(),
    /**
     * Looks chosen for one block's picture alone and not yet made (design turn 193d, SPEC-047
     * R-146), by block key, then by person: a kit look's id or the main photo. Kept so the choice
     * survives a reload until the picture is made, when it is stamped on the picture instead and
     * goes from here. Absent on a record with none; the first record with one raises the world to
     * schema 65.
     */
    ownLooks: z.record(z.string(), PictureOwnLooksSchema).optional(),
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
    /**
     * The seams set by hand (design turn 198, SPEC-047 R-147): joins and splits between the
     * chapter's turns, kept for the chapter and not for one reading. Absent on a record with none;
     * the first record with one raises the world to schema 66.
     */
    seams: z.array(AudiobookSeamSchema).max(AUDIOBOOK_SEAMS_MAX).optional(),
    /**
     * The beats the director named when the chapter was grouped by beats (design turn 201,
     * SPEC-047 R-175): each beat's first block, the words of the block it was joined into, its
     * name and whose beat it is. A block shows its beat while its words are those words, so a beat
     * changed by hand or by an edit keeps no name. Absent on a record with none; the first record
     * with one raises the world to schema 69.
     */
    beats: z.array(AudiobookBeatSchema).max(AUDIOBOOK_SEAMS_MAX).optional(),
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
     * characters, keyed by sheet id or by a name no sheet carries. Since design turn 200 (R-166)
     * this is the book's own, overriding the character's `narration` for this book alone; a
     * speaker with none here is played with their sheet's narration.
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

/**
 * Each character's narration by sheet id (design turn 200, SPEC-047 R-165): what a book plays a
 * speaker with when it has no note of its own for them. Only a written one, an empty field none, and
 * only a character still in the cast: a book is planned with the active characters, so a retired
 * one's narration would name takes nothing reads.
 */
export function sheetNarrations(sheets: ReadonlyArray<{ id: string; narration?: string | undefined; type?: string; retired?: boolean | undefined }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const sheet of sheets) {
    if ((sheet.type !== undefined && sheet.type !== "character") || sheet.retired === true) continue;
    const narration = sheet.narration?.trim();
    if (narration !== undefined && narration !== "") out[sheet.id] = narration;
  }
  return out;
}

/**
 * A speaker's note as a book plays it (R-166): the book's own, else — for a speaker a sheet names —
 * that character's narration. A name no sheet carries has only the book's.
 */
export function speakerNoteFor(notes: Readonly<Record<string, string>> | undefined, turn: Pick<AudiobookBlock, "speaker" | "sheet">, narrations?: Readonly<Record<string, string>>): string | undefined {
  const key = audiobookNoteKey(turn);
  if (key === null) return undefined;
  return notes?.[key] ?? (turn.sheet !== undefined ? narrations?.[turn.sheet] : undefined);
}

/** Where a speaker's note comes from (R-167): the book's own, the character's, or none at all. */
export function speakerNoteSource(notes: Readonly<Record<string, string>> | undefined, key: string, sheet: string | undefined, narrations?: Readonly<Record<string, string>>): "this book" | "character" | null {
  if (notes?.[key] !== undefined) return "this book";
  return sheet !== undefined && narrations?.[sheet] !== undefined ? "character" : null;
}

/**
 * The note a block is played with under the book's reading (R-44): only under `performed`, only on
 * a line. A block that holds several turns (design turn 190) is played with the notes of the
 * speakers in it: a lone speaker's as it stands, several named by their speaker. `narrations` are
 * the characters' own (R-166), which a book note overrides; without them only the book's count.
 */
export function audiobookNoteFor(book: Pick<AudiobookBook, "reading" | "notes"> | null, block: Pick<AudiobookBlock, "speaker" | "sheet"> & { rows?: readonly AudiobookTurn[] }, narrations?: Readonly<Record<string, string>>): string | undefined {
  if (book?.reading !== "performed") return undefined;
  if (block.rows !== undefined) {
    const seen = new Set<string>();
    const noted: Array<{ who: string; note: string }> = [];
    for (const row of block.rows) {
      const key = audiobookNoteKey(row);
      if (key === null || seen.has(key)) continue;
      seen.add(key);
      const note = speakerNoteFor(book.notes, row, narrations);
      if (note !== undefined) noted.push({ who: row.speaker ?? key, note });
    }
    if (noted.length === 0) return undefined;
    return noted.length === 1 ? noted[0]!.note : noted.map(({ who, note }) => `${who}: ${note}`).join(" ");
  }
  return speakerNoteFor(book.notes, block, narrations);
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

/**
 * How a book's chapters become blocks (design turn 190): one reader reads under `narrator` and
 * `performed`, so a paragraph is a block; under `cast` a block splits where the reader changes;
 * and a speaker a person records is read apart whatever the reading. Every caller derives its
 * blocks with this, so the window and the coordinator name the same ones.
 */
export function audiobookBlockOptions(
  book: Pick<AudiobookBook, "reading" | "recorded"> | null,
  /** The chapter's record, whose seams set by hand reshape the blocks (design turn 198). */
  record?: Pick<ChapterAudiobook, "seams"> | null,
): AudiobookBlockOptions {
  const reading = book?.reading ?? DEFAULT_AUDIOBOOK_BOOK.reading;
  const recorded = new Set(book?.recorded ?? []);
  const seams = record?.seams;
  return {
    merge: reading !== "cast",
    ...(recorded.size > 0 ? { apart: (turn: Pick<AudiobookBlock, "speaker" | "sheet">) => recorded.has(audiobookRecordingKey(turn)) } : {}),
    ...(seams !== undefined && seams.length > 0 ? { seams } : {}),
  };
}

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
  block: Pick<AudiobookBlock, "key" | "text" | "shaped" | "sources">,
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
  // A block whose shape a seam changed has no take for its words yet (design turn 198, rule 4):
  // the take under its key is another shape's, kept, and the block is not read rather than stale.
  if (take.textHash !== audiobookTextHash(block.text)) return block.shaped === true ? "not made" : "stale";
  // A recording is current while its words are (R-34): no reader and no direction made it.
  if (take.source === "recorded") return "made";
  if (!sameReader(take.assigned ?? take.reader, assigned)) return "stale";
  // The direction the take was made under against the one that stands (R-14): a direction
  // added, changed or dropped since is a different take; one authored for other words is none.
  if (audiobookTakeDirectionHash(audiobookBlockPlan(record, block), note, reading) !== take.directionHash) return "stale";
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
    /**
     * The chapter's first picture (design turn 199): the first block's picture the player would
     * show (R-69), world-relative, for the row's thumbnail; absent when the chapter has none.
     */
    picture: z.string().min(1).optional(),
  })
  .strict();
export type AudiobookRow = z.infer<typeof AudiobookRowSchema>;

/** A speaker of the book (design turn 199): their sheet when the cast names one, and their name. */
export const AudiobookCastMemberSchema = z.object({ sheet: SlugSchema.optional(), name: z.string().min(1) }).strict();
export type AudiobookCastMember = z.infer<typeof AudiobookCastMemberSchema>;

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
    /**
     * Every speaker of the book in the order of their first line, whatever the reading (design
     * turn 199): the page's cast. `voices` names only those the reading sets apart, so under
     * `narrator` it holds the narrator alone.
     */
    cast: z.array(AudiobookCastMemberSchema).optional(),
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
