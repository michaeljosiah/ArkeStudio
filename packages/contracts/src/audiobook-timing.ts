import { z } from "zod";
import { SoundSchema } from "./cadence.js";
import { ArtifactIdSchema, IsoDateTimeSchema } from "./ids.js";
import { textDigest } from "./subtitles.js";

/**
 * Timing, held to the blocks (design turn 187, SPEC-047 R-80..R-89).
 *
 * The audiobook stays one take a block (146's no-timeline rule). What a full cast lacked was
 * timing between the blocks, and it is kept on the blocks it belongs to rather than on a clip
 * placed in a second timeline: where a block starts against the one before (a pause, or a
 * negative start — an interruption or an overlap — down to −1.5 s), its take's trim at head and
 * tail, whether it plays after or under another block, and the nudge of a grouped cut (185).
 * The words stay the order, so a re-take never has to be placed again.
 *
 * Everything here is pure: the record's shapes, where each entry stands on the blocks as they
 * are now, the chapter's clock with the timing applied, and the mix plan one renderer turns into
 * audio for the chapter's Play, the player (186) and the exports. Nothing reads a file or a clock.
 */

/** The earliest a block may start against the end of the one before: an interruption or overlap (R-80). */
export const TIMING_START_MIN_SEC = -1.5;
/** The longest pause the panel and the view set between two blocks. */
export const TIMING_START_MAX_SEC = 3;
/** How far a grouped cut may be moved either way (185's split, fine-tuned by ear). */
export const TIMING_NUDGE_MAX_SEC = 0.5;
/** The most a trim may take off either end of a take. */
export const TIMING_TRIM_MAX_SEC = 10;
/** What a trim always leaves of a take, so a bar never vanishes under its handles. */
export const TIMING_MIN_TAKE_SEC = 0.1;
/** The furthest under its host a block or a reaction may start. */
export const TIMING_UNDER_MAX_SEC = 600;
/** A reaction typed by the author is a few words, not a line (R-83). */
export const REACTION_WORDS_MAX = 40;
/** A bed's defaults (R-84): a level under the voices, fades in and out, and a duck under speech. */
export const BED_DEFAULTS = { levelDb: -14, fadeInSec: 2, fadeOutSec: 4, duckDb: 10 } as const;
/** A sound at a block's start sits a little under the voices by default. */
export const SOUND_DEFAULT_LEVEL_DB = -6;
/** How the duck moves: down ahead of the speech, so a voice never lands on a full bed, and back up slowly after it. */
export const DUCK_ATTACK_SEC = 0.15;
export const DUCK_RELEASE_SEC = 0.5;
/** A block with no take is drawn at about this reading rate, as the chapter view estimates it (186). */
export const TIMING_ESTIMATED_CPS = 15;

/** Who set a block's placement (R-86): the author, or Arke's proposal once accepted. A proposal never moves the author's. */
export const TimingBySchema = z.enum(["author", "arke"]);
export type TimingBy = z.infer<typeof TimingBySchema>;

/**
 * A block named as timing names it: its key, and its words when it was named, so the entry can
 * follow the words when a paragraph inserted above moves the keys (as 186's pictures do).
 */
export const TimingAnchorSchema = z.object({ key: z.string().min(1).max(40), textHash: z.string().min(1) }).strict();
export type TimingAnchor = z.infer<typeof TimingAnchorSchema>;

/**
 * One block's timing (R-80, R-81). `start` is seconds against the end of the block before it —
 * the pause before it, negative for a block that cuts in; the block before's `Pause after` is the
 * same value seen from the other side, so it is kept once. `under` plays the block under another
 * block from `offset` seconds after that block starts, and takes it out of the run of blocks
 * after one another. `trim` belongs to the take it was set on, named by its artifact: a new take
 * keeps the start and drops the trim. `nudge` moves a grouped cut (185) between this block and
 * the next, later when positive.
 */
export const BlockTimingSchema = z
  .object({
    textHash: z.string().min(1),
    start: z.number().min(TIMING_START_MIN_SEC).max(TIMING_START_MAX_SEC).optional(),
    under: z.object({ host: TimingAnchorSchema, offset: z.number().min(0).max(TIMING_UNDER_MAX_SEC) }).strict().optional(),
    trim: z.object({ artifactId: ArtifactIdSchema, head: z.number().min(0).max(TIMING_TRIM_MAX_SEC), tail: z.number().min(0).max(TIMING_TRIM_MAX_SEC) }).strict().optional(),
    nudge: z.number().min(-TIMING_NUDGE_MAX_SEC).max(TIMING_NUDGE_MAX_SEC).optional(),
    /** Who set the start or the `under` (R-86); a trim and a nudge are only ever the author's. */
    by: TimingBySchema,
    at: IsoDateTimeSchema,
  })
  .strict();
export type BlockTiming = z.infer<typeof BlockTimingSchema>;

/**
 * A reaction (R-83): a short sound or a few words that play under another block — a sound from
 * the cadence list in a speaker's voice, or words the author types (`mm`, `Ehen!`). Audio only:
 * never in the manuscript, the .docx or the EPUB. Listed on its host block, read as any block is
 * and priced as any read; its take sits in the record's takes under the reaction's own key.
 * `speaker` is who says it, as the book names a reader: `narrator`, a sheet, or a name.
 */
export const AudiobookReactionSchema = z
  .object({
    host: TimingAnchorSchema,
    speaker: z.string().min(1).max(120),
    sound: SoundSchema.optional(),
    words: z.string().trim().min(1).max(REACTION_WORDS_MAX).optional(),
    offset: z.number().min(0).max(TIMING_UNDER_MAX_SEC),
    by: TimingBySchema,
    at: IsoDateTimeSchema,
  })
  .strict()
  .refine((reaction) => (reaction.sound === undefined) !== (reaction.words === undefined), { message: "a reaction is a sound or a few words" });
export type AudiobookReaction = z.infer<typeof AudiobookReactionSchema>;

/** Reaction keys are their own namespace beside the blocks' `title` and `p<n>.<m>`. */
export const REACTION_KEY_PREFIX = "x";
export function isReactionKey(key: string): boolean {
  return /^x\d+$/.test(key);
}
/** The next free reaction key in a record. */
export function nextReactionKey(reactions: Readonly<Record<string, unknown>> | undefined): string {
  let n = 1;
  for (const key of Object.keys(reactions ?? {})) {
    const at = /^x(\d+)$/.exec(key);
    if (at !== null) n = Math.max(n, Number(at[1]) + 1);
  }
  return `${REACTION_KEY_PREFIX}${n}`;
}

/** Where a bed or a sound comes from (R-84): the world's sounds, a library sound, or one generated for the book. */
export const AudiobookAudioSourceSchema = z
  .object({
    /** World-relative, as the media route serves it. */
    file: z.string().min(1).max(1000),
    origin: z.enum(["world", "library", "generated"]),
    label: z.string().min(1).max(120),
    seconds: z.number().positive().optional(),
  })
  .strict();
export type AudiobookAudioSource = z.infer<typeof AudiobookAudioSourceSchema>;

/**
 * A bed (R-84): from one block to another under the voices, with a level, fades in and out, and a
 * duck under speech. It loops when the source is shorter than the run it covers.
 */
export const AudiobookBedSchema = z
  .object({
    from: TimingAnchorSchema,
    to: TimingAnchorSchema,
    source: AudiobookAudioSourceSchema,
    levelDb: z.number().min(-40).max(0),
    fadeInSec: z.number().min(0).max(30),
    fadeOutSec: z.number().min(0).max(30),
    duckDb: z.number().min(0).max(30),
    by: TimingBySchema,
    at: IsoDateTimeSchema,
  })
  .strict();
export type AudiobookBed = z.infer<typeof AudiobookBedSchema>;

/** A sound at a block's start (R-84): a door, a gate, a phone. */
export const AudiobookBlockSoundSchema = z
  .object({
    block: TimingAnchorSchema,
    source: AudiobookAudioSourceSchema,
    levelDb: z.number().min(-40).max(6),
    by: TimingBySchema,
    at: IsoDateTimeSchema,
  })
  .strict();
export type AudiobookBlockSound = z.infer<typeof AudiobookBlockSoundSchema>;

/** The timing a chapter's record carries (R-87): each part absent when empty, as the record is written. */
export interface ChapterTimingRecord {
  timing?: Record<string, BlockTiming>;
  reactions?: Record<string, AudiobookReaction>;
  beds?: Record<string, AudiobookBed>;
  sounds?: Record<string, AudiobookBlockSound>;
}

/** Whether a record carries any timing at all: the record's Play joins takes back to back without it. */
export function hasTiming(record: ChapterTimingRecord | null | undefined): boolean {
  if (record === null || record === undefined) return false;
  return [record.timing, record.reactions, record.beds, record.sounds].some((part) => part !== undefined && Object.keys(part).length > 0);
}

// ————————————————————————————————————————————————————————————————————————————————————————————
// Where an entry stands on the blocks now.

/** `title` before every paragraph, then `p<paragraph>.<n>` in order: how a key sorts when it names no block now. */
function keyOrder(key: string): [number, number] {
  if (key === "title") return [-1, 0];
  const at = /^p(\d+)\.(\d+)$/.exec(key);
  return at === null ? [Number.MAX_SAFE_INTEGER, 0] : [Number(at[1]), Number(at[2])];
}

export type AnchorPlace = { index: number; state: "here" | "moved" | "changed" } | { index: -1; state: "gone"; near: number };

/**
 * Where an anchor stands (R-82), by 186's rule for a picture: on its own key while that block
 * says what it said; else on the one block that does; else on its key whatever it says now — the
 * words were changed, and timing holds to the block. It is `gone` when its key names no block, or
 * names one whose words a take says were another key's (the paragraphs closed up over a removed
 * one). `near` is where it would have stood: a bed that ended there ends at the block before.
 */
export function placeAnchor(
  blocks: readonly { key: string; textHash: string }[],
  anchor: TimingAnchor,
  /** The key a take of these words was made under, when one was: how a block that moved up is told from one whose words changed. */
  formerKey: (textHash: string) => string | undefined = () => undefined,
): AnchorPlace {
  const own = blocks.findIndex((block) => block.key === anchor.key);
  if (own >= 0 && blocks[own]!.textHash === anchor.textHash) return { index: own, state: "here" };
  const found = blocks.flatMap((block, index) => (block.textHash === anchor.textHash ? [index] : []));
  if (found.length === 1) return { index: found[0]!, state: "moved" };
  if (own >= 0) {
    const was = formerKey(blocks[own]!.textHash);
    if (was === undefined || was === anchor.key) return { index: own, state: "changed" };
    return { index: -1, state: "gone", near: own };
  }
  const [p, n] = keyOrder(anchor.key);
  const after = blocks.findIndex((block) => {
    const [bp, bn] = keyOrder(block.key);
    return bp > p || (bp === p && bn > n);
  });
  return { index: -1, state: "gone", near: after < 0 ? blocks.length : after };
}

/** A take's words by the key it was made under, the hint `placeAnchor` reads. */
export function formerKeys(takes: Readonly<Record<string, { textHash: string }>> | undefined): (textHash: string) => string | undefined {
  const byHash = new Map<string, string>();
  for (const [key, take] of Object.entries(takes ?? {})) if (!isReactionKey(key)) byHash.set(take.textHash, key);
  return (textHash) => byHash.get(textHash);
}

// ————————————————————————————————————————————————————————————————————————————————————————————
// The chapter's clock.

export interface TimingTake {
  artifactId: string;
  /** World-relative media. */
  file: string;
  seconds: number;
  grouped?: { request: string; offsetSec: number; durationSec: number };
}

/** A block as the clock reads it: its words, its lane, and its take when it is made and current. */
export interface TimingInputBlock {
  key: string;
  text: string;
  /** `narration` for narration and the title; the speaker's key (`audiobookSpeakerKey`) for a line. */
  lane: string;
  take?: TimingTake;
}

/** A reaction as the clock reads it: its lane and its take when it is made. */
export interface TimingInputReaction {
  key: string;
  lane: string;
  take?: TimingTake;
}

/** A piece of a source file, in seconds: what a bar plays, in order. */
export interface MixSegment {
  file: string;
  from: number;
  to: number;
}

export interface TimedBar {
  key: string;
  kind: "block" | "reaction";
  /** The block's index in the chapter; a reaction's host's. */
  index: number;
  lane: string;
  at: number;
  seconds: number;
  /** False for a block with no take: drawn at the reading rate, never in the mix. */
  made: boolean;
  /** The gap applied before it (R-80): its start against the block before, after the limits. */
  start: number;
  /** The next block's start, seen from this one: `Pause after`. Null for the last, and for a bar under another. */
  pauseAfter: number | null;
  /** The block it plays under and from where, for a block or a reaction under another. */
  under: { host: string; offset: number } | null;
  /** The trim that applies: set on this take. */
  trim: { head: number; tail: number } | null;
  /** The take was trimmed on another take: the trim was dropped with it (R-82). */
  trimDropped: boolean;
  /** The nudge applied to the cut after it, and whether this block's cut can be nudged at all. */
  nudge: number;
  nudgeable: boolean;
  by: TimingBy | null;
  /**
   * Under Performed a grouped request is one turn's audio (R-85): inside it the starts and pauses
   * are the reader's, and only the group's first start and its last pause can be set.
   */
  locked: { start: boolean; pauseAfter: boolean };
  /** It sounds over another bar. */
  overlaps: boolean;
  segments: MixSegment[];
}

export interface TimedBed {
  id: string;
  fromIndex: number;
  toIndex: number;
  at: number;
  seconds: number;
  source: AudiobookAudioSource;
  levelDb: number;
  fadeInSec: number;
  fadeOutSec: number;
  duckDb: number;
  /** An end moved because its block was removed (R-84): `to` ends at the block before, `from` starts at the block after. */
  cut: "from" | "to" | null;
  by: TimingBy;
}

export interface TimedSound {
  id: string;
  index: number;
  at: number;
  source: AudiobookAudioSource;
  levelDb: number;
  by: TimingBy;
}

export interface ChapterTiming {
  seconds: number;
  bars: TimedBar[];
  beds: TimedBed[];
  sounds: TimedSound[];
  /** Where two or more voices sound at once: hatched across the lanes. */
  overlaps: Array<{ from: number; to: number }>;
  /** Where any voice sounds: what a bed ducks under. */
  speech: Array<{ from: number; to: number }>;
  /** Entries whose block is gone (R-84): a sound flagged, a reaction without its host, a bed with nowhere to run. */
  lost: { sounds: string[]; reactions: string[]; beds: string[] };
  /** Some bar is drawn at the reading rate. */
  estimated: boolean;
}

const round = (seconds: number): number => Math.round(seconds * 1000) / 1000;
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** Two takes cut back to back from one grouped request (185): the cut between them is a nudge, and under Performed the reader's. */
export function contiguousCuts(a: TimingTake | undefined, b: TimingTake | undefined): boolean {
  if (a?.grouped === undefined || b?.grouped === undefined) return false;
  return a.grouped.request === b.grouped.request && Math.abs(a.grouped.offsetSec + a.grouped.durationSec - b.grouped.offsetSec) < 0.02;
}

/** The trim that stands for a take (R-82): the one set on it, or none — a trim set on another take was dropped with it. */
export function trimFor(entry: BlockTiming | undefined, take: TimingTake | undefined): { trim: { head: number; tail: number } | null; dropped: boolean } {
  if (entry?.trim === undefined) return { trim: null, dropped: false };
  if (take === undefined || entry.trim.artifactId !== take.artifactId) return { trim: null, dropped: true };
  return { trim: { head: entry.trim.head, tail: entry.trim.tail }, dropped: false };
}

/** Pieces with `head` taken off the front and `tail` off the end. */
function trimSegments(segments: MixSegment[], head: number, tail: number): MixSegment[] {
  const out = segments.map((segment) => ({ ...segment }));
  let cut = head;
  while (cut > 0 && out.length > 0) {
    const first = out[0]!;
    const length = first.to - first.from;
    if (length > cut) {
      first.from += cut;
      cut = 0;
    } else {
      cut -= length;
      out.shift();
    }
  }
  cut = tail;
  while (cut > 0 && out.length > 0) {
    const last = out[out.length - 1]!;
    const length = last.to - last.from;
    if (length > cut) {
      last.to -= cut;
      cut = 0;
    } else {
      cut -= length;
      out.pop();
    }
  }
  return out.map((segment) => ({ file: segment.file, from: round(segment.from), to: round(segment.to) }));
}

const lengthOf = (segments: readonly MixSegment[]): number => segments.reduce((sum, segment) => sum + (segment.to - segment.from), 0);

/** Intervals merged where they touch or cross. */
function union(intervals: Array<{ from: number; to: number }>): Array<{ from: number; to: number }> {
  const sorted = [...intervals].filter((interval) => interval.to > interval.from).sort((a, b) => a.from - b.from);
  const out: Array<{ from: number; to: number }> = [];
  for (const interval of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && interval.from <= last.to) last.to = Math.max(last.to, interval.to);
    else out.push({ ...interval });
  }
  return out.map((interval) => ({ from: round(interval.from), to: round(interval.to) }));
}

/** Where two or more of these sound at once. */
function overlapsOf(bars: readonly { at: number; seconds: number }[]): Array<{ from: number; to: number }> {
  const edges = bars.flatMap((bar) => [{ t: bar.at, d: 1 }, { t: bar.at + bar.seconds, d: -1 }]).sort((a, b) => a.t - b.t || a.d - b.d);
  const out: Array<{ from: number; to: number }> = [];
  let active = 0;
  let open = 0;
  for (const edge of edges) {
    const before = active;
    active += edge.d;
    if (before < 2 && active >= 2) open = edge.t;
    if (before >= 2 && active < 2 && edge.t - open > 0.005) out.push({ from: open, to: edge.t });
  }
  return union(out);
}

/**
 * The chapter on one clock with its timing (R-80..R-85). The blocks run after one another, each
 * starting its `start` after the block before it ends — never before that block starts, and never
 * before the chapter does; a block under another starts at its host's start and its offset, and
 * the block after it runs on from the block before it. Reactions sit under their hosts.
 *
 * `unmade` says what a block with no take is: `skip` — the clock stands, as the player plays a
 * chapter read in part (186) and as the mix renders it — or `estimate`, drawn at the reading rate
 * as the Timing view shows a chapter not yet read.
 */
export function timeChapter(input: {
  blocks: readonly TimingInputBlock[];
  record: ChapterTimingRecord & { takes?: Readonly<Record<string, { textHash: string }>> };
  reactions?: readonly TimingInputReaction[];
  /** The book's reading: under `performed` a grouped request's inside is the reader's (R-85). */
  reading: "narrator" | "performed" | "cast";
  unmade: "skip" | "estimate";
}): ChapterTiming {
  const { blocks, record } = input;
  const hashed = blocks.map((block) => ({ key: block.key, textHash: audiobookTimingHash(block.text) }));
  const former = formerKeys(record.takes);
  // Each timing entry on the block it stands on now; two on one block keep the one set there.
  const entries = new Map<number, { entry: BlockTiming; here: boolean }>();
  for (const [key, entry] of Object.entries(record.timing ?? {})) {
    const place = placeAnchor(hashed, { key, textHash: entry.textHash }, former);
    if (place.state === "gone") continue;
    const held = entries.get(place.index);
    const here = place.state !== "moved";
    if (held === undefined || (!held.here && here)) entries.set(place.index, { entry, here });
  }
  const entryAt = (index: number): BlockTiming | undefined => entries.get(index)?.entry;
  const hostIndex = (anchor: TimingAnchor): number => {
    const place = placeAnchor(hashed, anchor, former);
    return place.state === "gone" ? -1 : place.index;
  };

  // Each block's pieces: its take, nudged at either cut it shares with a neighbour, then trimmed.
  const nudgeAfter = (index: number): number => {
    const take = blocks[index]?.take;
    const next = blocks[index + 1]?.take;
    const nudge = entryAt(index)?.nudge ?? 0;
    if (nudge === 0 || take === undefined || next === undefined || !contiguousCuts(take, next)) return 0;
    return clamp(nudge, -(take.seconds - TIMING_MIN_TAKE_SEC), next.seconds - TIMING_MIN_TAKE_SEC);
  };
  const pieces = blocks.map((block, index): { segments: MixSegment[]; trim: { head: number; tail: number } | null; dropped: boolean } => {
    const take = block.take;
    if (take === undefined) return { segments: [], trim: null, dropped: false };
    let segments: MixSegment[] = [{ file: take.file, from: 0, to: take.seconds }];
    const before = index > 0 ? nudgeAfter(index - 1) : 0;
    const prev = blocks[index - 1]?.take;
    if (before > 0) segments = [{ file: take.file, from: before, to: take.seconds }];
    if (before < 0 && prev !== undefined) segments = [{ file: prev.file, from: prev.seconds + before, to: prev.seconds }, ...segments];
    const after = nudgeAfter(index);
    const next = blocks[index + 1]?.take;
    if (after > 0 && next !== undefined) segments = [...segments, { file: next.file, from: 0, to: after }];
    if (after < 0) {
      const last = segments[segments.length - 1]!;
      segments = [...segments.slice(0, -1), { ...last, to: last.to + after }];
    }
    const { trim, dropped } = trimFor(entryAt(index), take);
    if (trim !== null) {
      // A trim always leaves something to hear.
      const room = Math.max(0, lengthOf(segments) - TIMING_MIN_TAKE_SEC);
      const head = Math.min(trim.head, room);
      const tail = Math.min(trim.tail, room - head);
      segments = trimSegments(segments, head, tail);
      return { segments, trim: { head: round(head), tail: round(tail) }, dropped };
    }
    return { segments: segments.map((segment) => ({ ...segment, from: round(segment.from), to: round(segment.to) })), trim: null, dropped };
  });

  const estimateOf = (text: string): number => Math.max(0.6, text.replace(/\s+/g, " ").trim().length / TIMING_ESTIMATED_CPS);
  const performed = input.reading === "performed";
  const bars: TimedBar[] = [];
  const barOf = new Map<number, TimedBar>();
  let estimated = false;

  // Which blocks play under another: placed after the run, at their host's.
  const underOf = new Map<number, { host: number; offset: number }>();
  blocks.forEach((_, index) => {
    const under = entryAt(index)?.under;
    if (under === undefined) return;
    const host = hostIndex(under.host);
    if (host >= 0 && host !== index) underOf.set(index, { host, offset: under.offset });
  });
  // A chain that comes back on itself plays after, as if `under` were not set.
  for (const index of underOf.keys()) {
    const seen = new Set<number>([index]);
    let at = underOf.get(index)?.host;
    while (at !== undefined && underOf.has(at)) {
      if (seen.has(at)) {
        underOf.delete(index);
        break;
      }
      seen.add(at);
      at = underOf.get(at)?.host;
    }
  }

  let prevStart = 0;
  let prevEnd = 0;
  let prevIndex = -1;
  blocks.forEach((block, index) => {
    if (underOf.has(index)) return;
    const made = block.take !== undefined && lengthOf(pieces[index]!.segments) > 0;
    if (!made && input.unmade === "skip") return;
    if (!made) estimated = true;
    const entry = entryAt(index);
    const seconds = made ? lengthOf(pieces[index]!.segments) : estimateOf(block.text);
    const lockedStart = performed && prevIndex === index - 1 && contiguousCuts(blocks[prevIndex]?.take, block.take);
    const asked = lockedStart ? 0 : (entry?.start ?? 0);
    const at = Math.max(prevIndex < 0 ? 0 : prevStart, prevEnd + asked, 0);
    const bar: TimedBar = {
      key: block.key,
      kind: "block",
      index,
      lane: block.lane,
      at: round(at),
      seconds: round(seconds),
      made,
      start: round(prevIndex < 0 ? at : at - prevEnd),
      pauseAfter: null,
      under: null,
      trim: pieces[index]!.trim,
      trimDropped: pieces[index]!.dropped,
      nudge: round(nudgeAfter(index)),
      nudgeable: block.take !== undefined && contiguousCuts(block.take, blocks[index + 1]?.take),
      by: entry !== undefined && (entry.start !== undefined || entry.under !== undefined) ? entry.by : null,
      locked: { start: lockedStart, pauseAfter: false },
      overlaps: false,
      segments: made ? pieces[index]!.segments : [],
    };
    const previous = prevIndex >= 0 ? barOf.get(prevIndex) : undefined;
    if (previous !== undefined) {
      previous.pauseAfter = bar.start;
      previous.locked.pauseAfter = lockedStart;
    }
    bars.push(bar);
    barOf.set(index, bar);
    prevStart = at;
    prevEnd = at + seconds;
    prevIndex = index;
  });

  // Blocks under another, hosts first, so a block under a block that is itself under one lands.
  const pending = [...underOf.entries()];
  for (let guard = 0; pending.length > 0 && guard < blocks.length + 1; guard++) {
    for (let i = 0; i < pending.length;) {
      const [index, under] = pending[i]!;
      const host = barOf.get(under.host);
      if (host === undefined && underOf.has(under.host) && pending.some(([waiting]) => waiting === under.host)) {
        i += 1;
        continue;
      }
      pending.splice(i, 1);
      const block = blocks[index]!;
      const made = block.take !== undefined && lengthOf(pieces[index]!.segments) > 0;
      if (host === undefined || (!made && input.unmade === "skip")) continue;
      if (!made) estimated = true;
      const entry = entryAt(index);
      const offset = Math.min(under.offset, host.seconds);
      const bar: TimedBar = {
        key: block.key,
        kind: "block",
        index,
        lane: block.lane,
        at: round(host.at + offset),
        seconds: round(made ? lengthOf(pieces[index]!.segments) : estimateOf(block.text)),
        made,
        start: 0,
        pauseAfter: null,
        under: { host: host.key, offset: round(offset) },
        trim: pieces[index]!.trim,
        trimDropped: pieces[index]!.dropped,
        nudge: 0,
        nudgeable: false,
        by: entry?.by ?? null,
        locked: { start: false, pauseAfter: false },
        overlaps: false,
        segments: made ? pieces[index]!.segments : [],
      };
      bars.push(bar);
      barOf.set(index, bar);
    }
  }

  // Reactions under their hosts (R-83).
  const lost = { sounds: [] as string[], reactions: [] as string[], beds: [] as string[] };
  const reactionInput = new Map((input.reactions ?? []).map((reaction) => [reaction.key, reaction]));
  for (const [key, reaction] of Object.entries(record.reactions ?? {})) {
    const host = hostIndex(reaction.host);
    const hostBar = host >= 0 ? barOf.get(host) : undefined;
    if (host < 0) {
      lost.reactions.push(key);
      continue;
    }
    if (hostBar === undefined) continue;
    const given = reactionInput.get(key);
    const take = given?.take;
    const made = take !== undefined && take.seconds > 0;
    if (!made && input.unmade === "skip") continue;
    if (!made) estimated = true;
    const offset = Math.min(reaction.offset, hostBar.seconds);
    bars.push({
      key,
      kind: "reaction",
      index: host,
      lane: given?.lane ?? "narration",
      at: round(hostBar.at + offset),
      seconds: round(made ? take.seconds : reaction.words !== undefined ? estimateOf(reaction.words) : 1.2),
      made,
      start: 0,
      pauseAfter: null,
      under: { host: hostBar.key, offset: round(offset) },
      trim: null,
      trimDropped: false,
      nudge: 0,
      nudgeable: false,
      by: reaction.by,
      locked: { start: false, pauseAfter: false },
      overlaps: false,
      segments: made ? [{ file: take.file, from: 0, to: round(take.seconds) }] : [],
    });
  }

  bars.sort((a, b) => a.at - b.at || a.index - b.index);
  const overlaps = overlapsOf(bars);
  for (const bar of bars) bar.overlaps = overlaps.some((span) => span.from < bar.at + bar.seconds - 0.005 && span.to > bar.at + 0.005);
  const speech = union(bars.map((bar) => ({ from: bar.at, to: bar.at + bar.seconds })));
  let end = bars.reduce((max, bar) => Math.max(max, bar.at + bar.seconds), 0);

  // Beds from one block to another (R-84): a removed block ends a bed at the block before it.
  const blockBars = bars.filter((bar) => bar.kind === "block").sort((a, b) => a.index - b.index);
  const beds: TimedBed[] = [];
  for (const [id, bed] of Object.entries(record.beds ?? {})) {
    const from = placeAnchor(hashed, bed.from, former);
    const to = placeAnchor(hashed, bed.to, former);
    const fromIndex = from.state === "gone" ? from.near : from.index;
    const toIndex = to.state === "gone" ? to.near - 1 : to.index;
    const first = blockBars.find((bar) => bar.index >= fromIndex && bar.index <= toIndex);
    const last = [...blockBars].reverse().find((bar) => bar.index <= toIndex && bar.index >= fromIndex);
    if (fromIndex > toIndex || first === undefined || last === undefined) {
      if (fromIndex > toIndex || from.state === "gone" || to.state === "gone") lost.beds.push(id);
      continue;
    }
    const at = first.at;
    const until = Math.max(...blockBars.filter((bar) => bar.index >= first.index && bar.index <= last.index).map((bar) => bar.at + bar.seconds));
    beds.push({
      id,
      fromIndex,
      toIndex,
      at: round(at),
      seconds: round(until - at),
      source: bed.source,
      levelDb: bed.levelDb,
      fadeInSec: bed.fadeInSec,
      fadeOutSec: bed.fadeOutSec,
      duckDb: bed.duckDb,
      cut: to.state === "gone" ? "to" : from.state === "gone" ? "from" : null,
      by: bed.by,
    });
  }

  // Sounds at a block's start; one whose block is gone is flagged, never played elsewhere.
  const sounds: TimedSound[] = [];
  for (const [id, sound] of Object.entries(record.sounds ?? {})) {
    const place = placeAnchor(hashed, sound.block, former);
    if (place.state === "gone") {
      lost.sounds.push(id);
      continue;
    }
    const bar = barOf.get(place.index);
    if (bar === undefined) continue;
    sounds.push({ id, index: place.index, at: bar.at, source: sound.source, levelDb: sound.levelDb, by: sound.by });
    end = Math.max(end, bar.at + (sound.source.seconds ?? 0));
  }

  return { seconds: round(end), bars, beds, sounds, overlaps, speech, lost, estimated };
}

/** The words' fingerprint timing follows: the take's own (`audiobookTextHash`), repeated here to keep this module free of the record's. */
export function audiobookTimingHash(text: string): string {
  return textDigest(text.replace(/\s+/g, " ").trim());
}

// ————————————————————————————————————————————————————————————————————————————————————————————
// The mix.

/** What the renderer plays (R-85): every voice's pieces at its place, the beds faded and ducked, the sounds. */
export interface ChapterMix {
  seconds: number;
  voices: Array<{ key: string; at: number; segments: MixSegment[] }>;
  beds: Array<{ id: string; at: number; seconds: number; file: string; levelDb: number; fadeInSec: number; fadeOutSec: number; duckDb: number }>;
  sounds: Array<{ id: string; at: number; file: string; levelDb: number }>;
  speech: Array<{ from: number; to: number }>;
}

/** The mix of a chapter timed with `unmade: "skip"`: only what is made sounds. */
export function chapterMix(timing: ChapterTiming): ChapterMix {
  return {
    seconds: timing.seconds,
    voices: timing.bars.filter((bar) => bar.made && bar.segments.length > 0).map((bar) => ({ key: bar.key, at: bar.at, segments: bar.segments })),
    beds: timing.beds.map((bed) => ({ id: bed.id, at: bed.at, seconds: bed.seconds, file: bed.source.file, levelDb: bed.levelDb, fadeInSec: bed.fadeInSec, fadeOutSec: bed.fadeOutSec, duckDb: bed.duckDb })),
    sounds: timing.sounds.map((sound) => ({ id: sound.id, at: sound.at, file: sound.source.file, levelDb: sound.levelDb })),
    speech: timing.speech,
  };
}

/** The mix's name: the same plan renders the same audio, so a render is kept under it and reused. */
export function mixKey(mix: ChapterMix): string {
  return textDigest(`mix-v1:${JSON.stringify(mix)}`).replace(/^text-v1:/, "");
}

/**
 * How far a bed is ducked at each frame, 0 to 1 of its duck (R-84): fully under speech, down
 * over `attack` before a voice starts and back up over `release` after it ends.
 */
export function duckEnvelope(speech: readonly { from: number; to: number }[], seconds: number, frameSec = 0.01, attack = DUCK_ATTACK_SEC, release = DUCK_RELEASE_SEC): Float32Array {
  const frames = Math.max(0, Math.ceil(seconds / frameSec));
  const out = new Float32Array(frames);
  for (const span of speech) {
    const first = Math.max(0, Math.floor((span.from - attack) / frameSec));
    const last = Math.min(frames - 1, Math.ceil((span.to + release) / frameSec));
    for (let frame = first; frame <= last; frame++) {
      const t = frame * frameSec;
      const depth = t < span.from ? 1 - (span.from - t) / attack : t > span.to ? 1 - (t - span.to) / release : 1;
      if (depth > out[frame]!) out[frame] = Math.max(0, Math.min(1, depth));
    }
  }
  return out;
}

/** A bed's fade at a time inside it, 0 to 1 in amplitude: up over its fade in, down over its fade out. */
export function bedFade(t: number, bed: { at: number; seconds: number; fadeInSec: number; fadeOutSec: number }): number {
  const into = t - bed.at;
  const left = bed.at + bed.seconds - t;
  if (into < 0 || left < 0) return 0;
  const fadeIn = bed.fadeInSec > 0 ? into / bed.fadeInSec : 1;
  const fadeOut = bed.fadeOutSec > 0 ? left / bed.fadeOutSec : 1;
  return Math.max(0, Math.min(1, fadeIn, fadeOut));
}

// ————————————————————————————————————————————————————————————————————————————————————————————
// Writing timing.

/** What a window writes for one block (R-81): each field set, or null to clear it; `reset` clears the block. */
export const BlockTimingInputSchema = z
  .object({
    start: z.number().min(TIMING_START_MIN_SEC).max(TIMING_START_MAX_SEC).nullable().optional(),
    /** The pause after this block: written as the next block's start. */
    pauseAfter: z.number().min(TIMING_START_MIN_SEC).max(TIMING_START_MAX_SEC).nullable().optional(),
    under: z.object({ host: z.string().min(1).max(40), offset: z.number().min(0).max(TIMING_UNDER_MAX_SEC) }).strict().nullable().optional(),
    trim: z.object({ head: z.number().min(0).max(TIMING_TRIM_MAX_SEC), tail: z.number().min(0).max(TIMING_TRIM_MAX_SEC) }).strict().nullable().optional(),
    nudge: z.number().min(-TIMING_NUDGE_MAX_SEC).max(TIMING_NUDGE_MAX_SEC).nullable().optional(),
    reset: z.literal(true).optional(),
  })
  .strict();
export type BlockTimingInput = z.infer<typeof BlockTimingInputSchema>;

/** Seconds as the panel says them: `−0.4 s`, `0.3 s`, `+0.06 s` for a nudge. */
export function formatTimingSeconds(seconds: number, signed = false): string {
  const hundredths = Math.round(Math.abs(seconds) * 100);
  const text = (hundredths / 100).toFixed(hundredths % 10 === 0 ? 1 : 2);
  if (hundredths === 0) return "0.0 s";
  if (seconds < 0) return `−${text} s`;
  return `${signed ? "+" : ""}${text} s`;
}
