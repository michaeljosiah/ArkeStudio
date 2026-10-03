import { z } from "zod";
import { SoundSchema, type Sound } from "./cadence.js";
import { isSceneBreak } from "./manuscript.js";
import {
  AudioSourceInputSchema,
  audiobookTimingHash,
  BED_DEFAULTS,
  formerKeys,
  nextReactionKey,
  nextTimingKey,
  placeAnchor,
  reactionText,
  REACTION_WORDS_MAX,
  TIMING_START_MAX_SEC,
  TIMING_START_MIN_SEC,
  TIMING_UNDER_MAX_SEC,
  type AudiobookAudioSource,
  type BlockTiming,
  type ChapterTimingRecord,
} from "./audiobook-timing.js";

/**
 * Propose timing (design turn 187b, SPEC-047 R-86): Arke reads the takes' word times on this
 * machine, the words and their punctuation, the direction and the cast, and proposes starts,
 * pauses, reactions and beds — drawn dashed until accepted whole, as 184b's direction is. Timing
 * the author set is never moved and is counted as kept. Nothing here asks a model or spends: the
 * proposal is read off the chapter as it stands, by rules a reader of the page would recognise.
 */

/** A start Arke proposes for a block: against the end of the block before, as the author's would be. */
export const ProposedStartSchema = z.object({ start: z.number().min(TIMING_START_MIN_SEC).max(TIMING_START_MAX_SEC), why: z.enum(["cuts in", "tightens", "pause", "scene", "heading"]) }).strict();
export const ProposedReactionSchema = z
  .object({ host: z.string().min(1).max(40), speaker: z.string().min(1).max(120), sound: SoundSchema.optional(), words: z.string().min(1).max(REACTION_WORDS_MAX).optional(), offset: z.number().min(0).max(TIMING_UNDER_MAX_SEC) })
  .strict();
export const ProposedBedSchema = z
  .object({ from: z.string().min(1).max(40), to: z.string().min(1).max(40), source: AudioSourceInputSchema, label: z.string().min(1).max(120), levelDb: z.number().min(-40).max(0), fadeInSec: z.number().min(0).max(30), fadeOutSec: z.number().min(0).max(30), duckDb: z.number().min(0).max(30) })
  .strict();

export const TimingProposalSchema = z
  .object({
    starts: z.record(z.string(), ProposedStartSchema),
    reactions: z.array(ProposedReactionSchema).max(200),
    beds: z.array(ProposedBedSchema).max(20),
    /** Places a rule would have changed where the author's timing stands: left, and counted (R-86). */
    kept: z.number().int().min(0),
    /** Takes whose ends were measured on this machine, to time a cut-in by where the words stop. */
    heard: z.number().int().min(0),
  })
  .strict();
export type TimingProposal = z.infer<typeof TimingProposalSchema>;

/** A block as the proposal reads it. */
export interface ProposalBlock {
  key: string;
  text: string;
  paragraph: number;
  /** Who speaks it, as the book keys a speaker; null for narration and the title. */
  speaker: string | null;
  /** Their name, as the prose names them. */
  name: string | null;
  /** Its take: how long, and the quiet after the last word, when it was heard on this machine. */
  take?: { seconds: number; tail?: number };
}

const round = (seconds: number) => Math.round(seconds * 20) / 20;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** A line that breaks off: its last words end in a dash, inside or outside the closing quote. */
export function breaksOff(text: string): boolean {
  return /(?:—|–|--|-)\s*["'”’)]*\s*$/.test(text.trim());
}

/** The verbs a narration names a reaction by, and the sound each is. */
const REACTION_VERBS: ReadonlyArray<[RegExp, Sound]> = [
  [/\b(laugh(?:s|ed|ing)?)\b/i, "laughs"],
  [/\b(chuckl(?:es|ed|ing))\b/i, "chuckles"],
  [/\b(sigh(?:s|ed|ing)?)\b/i, "sighs"],
  [/\b(gasp(?:s|ed|ing)?)\b/i, "gasps"],
  [/\b(groan(?:s|ed|ing)?)\b/i, "groans"],
];

/** Words of four letters or more, lower-cased, for matching a sound's name against the prose. */
const wordsOf = (text: string): string[] => (text.toLowerCase().match(/\p{L}{4,}/gu) ?? []);

export function proposeTiming(input: {
  blocks: readonly ProposalBlock[];
  /** The chapter's paragraphs, to find the scene breaks between blocks. */
  paragraphs: readonly string[];
  record: (ChapterTimingRecord & { takes?: Readonly<Record<string, { textHash: string }>> }) | null;
  /** The sounds the world holds, for a bed the words name. */
  sounds: readonly AudiobookAudioSource[];
  /** Blocks whose start is the reader's (R-85): a grouped request's inside under Performed. */
  locked?: ReadonlySet<string>;
}): TimingProposal {
  const { blocks, record } = input;
  const hashed = blocks.map((block) => ({ key: block.key, textHash: audiobookTimingHash(block.text) }));
  const former = formerKeys(record?.takes);
  // The author's timing, on the blocks it stands on now: never moved by a proposal (R-86).
  const authored = new Set<string>();
  for (const [key, entry] of Object.entries(record?.timing ?? {}) as Array<[string, BlockTiming]>) {
    if (entry.by !== "author" || (entry.start === undefined && entry.under === undefined)) continue;
    const place = placeAnchor(hashed, { key, textHash: entry.textHash }, former);
    if (place.state !== "gone") authored.add(blocks[place.index]!.key);
  }
  const starts: TimingProposal["starts"] = {};
  let kept = 0;
  let heard = 0;
  const propose = (key: string, start: number, why: TimingProposal["starts"][string]["why"]) => {
    if (input.locked?.has(key) === true) return;
    if (authored.has(key)) {
      kept += 1;
      return;
    }
    starts[key] = { start: round(clamp(start, TIMING_START_MIN_SEC, TIMING_START_MAX_SEC)), why };
  };
  for (const block of blocks) if (block.take?.tail !== undefined) heard += 1;

  blocks.forEach((block, index) => {
    if (index === 0) return;
    const before = blocks[index - 1]!;
    // A scene break between them is a long pause; the heading is followed by a breath.
    const between = input.paragraphs.slice(Math.max(0, before.paragraph + 1), block.paragraph);
    if (before.key === "title") return propose(block.key, 1, "heading");
    if (between.some((paragraph) => isSceneBreak(paragraph))) return propose(block.key, 1.5, "scene");
    const tail = before.take?.tail ?? 0.25;
    // A line that breaks off is cut into by the next speaker where its words stop (R-86): the
    // quiet after them is taken back, and a little more, so the next voice lands on the dash.
    if (before.speaker !== null && block.speaker !== null && before.speaker !== block.speaker && breaksOff(before.text)) {
      return propose(block.key, -clamp(tail + 0.12, 0.2, 1.5), "cuts in");
    }
    // An exchange between two speakers runs tight: a reader's long breath between lines is taken in.
    if (before.speaker !== null && block.speaker !== null && before.speaker !== block.speaker && tail > 0.4) {
      return propose(block.key, -(tail - 0.25), "tightens");
    }
  });
  // A short last line of a paragraph — `Read. No reply.` — is let sit, where nothing else is proposed after it.
  blocks.forEach((block, index) => {
    const next = blocks[index + 1];
    const words = block.text.trim().split(/\s+/).length;
    if (next === undefined || starts[next.key] !== undefined || next.paragraph === block.paragraph || block.key === "title") return;
    if (words <= 4 && /[.!?…]["'”’]?\s*$/.test(block.text.trim())) propose(next.key, 0.6, "pause");
  });

  // Reactions the narration names: `Tunde laughed`, beside another's line (R-83). One a speaker,
  // sound and line; never one the record has already.
  const reactions: TimingProposal["reactions"] = [];
  const speakers = new Map<string, string>();
  for (const block of blocks) if (block.speaker !== null && block.name !== null) speakers.set(block.name, block.speaker);
  const existing = new Set(Object.values(record?.reactions ?? {}).map((reaction) => `${reaction.host.key}/${reaction.speaker}/${reactionText(reaction)}`));
  blocks.forEach((block, index) => {
    if (block.speaker !== null) return;
    for (const [name, key] of speakers) {
      if (!new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(block.text)) continue;
      const verb = REACTION_VERBS.find(([pattern]) => pattern.test(block.text));
      if (verb === undefined) continue;
      const host = [blocks[index - 1], blocks[index + 1]].find((candidate) => candidate !== undefined && candidate.speaker !== null && candidate.speaker !== key);
      if (host === undefined) continue;
      const sound = verb[1];
      if (existing.has(`${host.key}/${key}/[${sound}]`) || reactions.some((reaction) => reaction.host === host.key && reaction.speaker === key)) continue;
      reactions.push({ host: host.key, speaker: key, sound, offset: round((host.take?.seconds ?? 2) * 0.4) });
    }
  });

  // A bed the words name: a sound the world holds whose name is in the prose, from the first block
  // that names it to the end of its scene. One a chapter, and none where a bed already starts.
  const beds: TimingProposal["beds"] = [];
  if (Object.keys(record?.beds ?? {}).length === 0) {
    for (const source of input.sounds) {
      const named = wordsOf(source.label);
      if (named.length === 0) continue;
      const first = blocks.findIndex((block) => wordsOf(block.text).some((word) => named.includes(word)));
      if (first < 0) continue;
      let last = blocks.length - 1;
      for (let index = first + 1; index < blocks.length; index++) {
        const between = input.paragraphs.slice(blocks[index - 1]!.paragraph + 1, blocks[index]!.paragraph);
        if (between.some((paragraph) => isSceneBreak(paragraph))) {
          last = index - 1;
          break;
        }
      }
      beds.push({ from: blocks[first]!.key, to: blocks[last]!.key, source: { file: source.file, origin: source.origin }, label: source.label, levelDb: BED_DEFAULTS.levelDb, fadeInSec: BED_DEFAULTS.fadeInSec, fadeOutSec: BED_DEFAULTS.fadeOutSec, duckDb: BED_DEFAULTS.duckDb });
      break;
    }
  }
  return { starts, reactions, beds, kept, heard };
}

/** What the card says (187b), as data: `14 changes · 3 overlaps · 2 reactions · 6 pauses · 0 of yours changed`. */
export function proposalCounts(proposal: TimingProposal): { changes: number; overlaps: number; reactions: number; pauses: number; beds: number; kept: number } {
  const starts = Object.values(proposal.starts);
  const overlaps = starts.filter((start) => start.start < 0).length;
  return {
    changes: starts.length + proposal.reactions.length + proposal.beds.length,
    overlaps,
    reactions: proposal.reactions.length,
    pauses: starts.length - overlaps,
    beds: proposal.beds.length,
    kept: proposal.kept,
  };
}

/**
 * The record as it would stand with the proposal accepted (R-86): each proposed start set by
 * Arke where the author's does not stand, the reactions and beds added under fresh keys. Used by
 * the window to draw the proposal dashed and by the coordinator to write it — the same rule.
 */
export function applyTimingProposal<T extends ChapterTimingRecord & { takes?: Readonly<Record<string, { textHash: string }>> }>(
  record: T,
  proposal: TimingProposal,
  blocks: readonly { key: string; text: string }[],
  at: string,
  sources: (bed: TimingProposal["beds"][number]) => AudiobookAudioSource | null = (bed) => ({ file: bed.source.file, origin: bed.source.origin, label: bed.label }),
): T {
  const textOf = new Map(blocks.map((block) => [block.key, block.text]));
  const timing: Record<string, BlockTiming> = { ...record.timing };
  for (const [key, proposed] of Object.entries(proposal.starts)) {
    const text = textOf.get(key);
    if (text === undefined) continue;
    const held = timing[key];
    if (held !== undefined && held.by === "author" && (held.start !== undefined || held.under !== undefined)) continue;
    timing[key] = { ...held, textHash: audiobookTimingHash(text), start: proposed.start, by: "arke", at } as BlockTiming;
  }
  const reactions = { ...record.reactions };
  for (const proposed of proposal.reactions) {
    const text = textOf.get(proposed.host);
    if (text === undefined) continue;
    const key = nextReactionKey(reactions);
    reactions[key] = { host: { key: proposed.host, textHash: audiobookTimingHash(text) }, speaker: proposed.speaker, ...(proposed.sound !== undefined ? { sound: proposed.sound } : { words: proposed.words ?? "mm" }), offset: proposed.offset, by: "arke", at };
  }
  const beds = { ...record.beds };
  for (const proposed of proposal.beds) {
    const from = textOf.get(proposed.from);
    const to = textOf.get(proposed.to);
    const source = sources(proposed);
    if (from === undefined || to === undefined || source === null) continue;
    beds[nextTimingKey("b", beds)] = { from: { key: proposed.from, textHash: audiobookTimingHash(from) }, to: { key: proposed.to, textHash: audiobookTimingHash(to) }, source, levelDb: proposed.levelDb, fadeInSec: proposed.fadeInSec, fadeOutSec: proposed.fadeOutSec, duckDb: proposed.duckDb, by: "arke", at };
  }
  return {
    ...record,
    ...(Object.keys(timing).length > 0 ? { timing } : {}),
    ...(Object.keys(reactions).length > 0 ? { reactions } : {}),
    ...(Object.keys(beds).length > 0 ? { beds } : {}),
  };
}

