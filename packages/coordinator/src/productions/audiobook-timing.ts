import {
  audiobookSpeakerKey,
  audiobookTextHash,
  contiguousCuts,
  ESTIMATED_CHARACTERS_PER_SECOND,
  formerKeys,
  isReactionKey,
  isWorldAudioPath,
  nextReactionKey,
  nextTimingKey,
  placeAnchor,
  reactionText,
  timeChapter,
  type AudiobookAudioSource,
  type AudiobookBed,
  type AudiobookBlockSound,
  type AudiobookReader,
  type BedInput,
  type BlockSoundInput,
  type ReactionInput,
  type BlockTiming,
  type BlockTimingInput,
  type ChapterAudiobook,
  type ChapterTiming,
  type TimingInputBlock,
  type TimingInputReaction,
  type TimingTake,
} from "@arke-studio/contracts";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import type { WorldStore } from "../world/store.js";
import { assignReaders, planAudiobook, updateAudiobook, type AudiobookPlan, type PlannedBlock } from "./audiobook.js";

/**
 * Timing on the blocks (design turn 187, SPEC-047 R-80..R-89): the chapter read as the clock
 * reads it, and one block's timing written through the record's lane. The record holds the
 * values; where each lands and what the chapter sounds like is derived every time it is asked,
 * so nothing written can drift from the takes and words it is about.
 */

/** A take's length: as measured when it was filed, else its cut from a grouped request, else its words at the reading rate. */
export function takeLength(store: WorldStore, artifactId: string, take: { grouped?: { durationSec: number } }, text: string): number {
  const artifact = store.getBundle().artifacts.find((candidate) => candidate.id === artifactId);
  const measured = artifact?.mediaInfo?.durationSec;
  if (measured !== undefined && measured > 0) return measured;
  if (take.grouped !== undefined) return take.grouped.durationSec;
  return Math.max(1, text.length / ESTIMATED_CHARACTERS_PER_SECOND);
}

function timingTake(store: WorldStore, take: ChapterAudiobook["takes"][string], text: string): TimingTake | undefined {
  const artifact = store.getBundle().artifacts.find((candidate) => candidate.id === take.artifactId);
  if (artifact === undefined) return undefined;
  return {
    artifactId: take.artifactId,
    file: `artifacts/${artifact.file}`,
    seconds: takeLength(store, take.artifactId, take, text),
    ...(take.grouped !== undefined ? { grouped: { request: take.grouped.request, offsetSec: take.grouped.offsetSec, durationSec: take.grouped.durationSec } } : {}),
  };
}

/**
 * The chapter's blocks as the clock reads them: each with its lane, and its take when the take
 * says the block's words now and is on the shelf — the player's rule (186, codex on PR 1491), so
 * what the mix plays is what the listening plan plays, whoever would read the block today.
 */
export function timingBlocks(store: WorldStore, plan: Pick<AudiobookPlan, "blocks" | "record" | "present">): TimingInputBlock[] {
  const record = plan.record === "unreadable" ? null : plan.record;
  return plan.blocks.map((planned) => {
    const block: TimingInputBlock = { key: planned.block.key, text: planned.block.text, lane: audiobookSpeakerKey(planned.block) ?? "narration" };
    const take = record?.takes[planned.block.key];
    if (take === undefined || !plan.present.has(take.artifactId) || take.textHash !== audiobookTextHash(planned.block.text)) return block;
    const timed = timingTake(store, take, planned.block.text);
    return timed === undefined ? block : { ...block, take: timed };
  });
}

/**
 * The reactions as the clock reads them: who says each, and its take once it is made — by the
 * blocks' rule (codex on PR 1497): on the shelf, and of what the reaction says now.
 */
export function timingReactions(store: WorldStore, record: ChapterAudiobook | null, present: ReadonlySet<string>): TimingInputReaction[] {
  return Object.entries(record?.reactions ?? {}).map(([key, reaction]) => {
    const said = reactionText(reaction);
    const held = record?.takes[key];
    const take = held !== undefined && present.has(held.artifactId) && held.textHash === audiobookTextHash(said) ? held : undefined;
    const lane = reaction.speaker === "narrator" ? "narration" : reaction.speaker;
    const timed = take === undefined ? undefined : timingTake(store, take, said);
    return { key, lane, ...(timed !== undefined ? { take: timed } : {}) };
  });
}

/** The chapter on its clock with its timing, as the plan reads it. */
export function chapterTiming(store: WorldStore, plan: Pick<AudiobookPlan, "blocks" | "record" | "reading" | "present">, unmade: "skip" | "estimate"): ChapterTiming {
  const record = plan.record === "unreadable" ? null : plan.record;
  return timeChapter({
    blocks: timingBlocks(store, plan),
    reactions: timingReactions(store, record, plan.present),
    record: record ?? {},
    reading: plan.reading,
    unmade,
  });
}

export class TimingRefusal extends Error {}

/**
 * The chapter's reactions as blocks a run reads (R-83): each on the paragraph of the block it
 * plays under, with the reader its speaker is assigned — the narrator's, or the speaker's own
 * voice under Cast — and a state judged as a block's is, against what the reaction says now. A
 * reaction whose host is gone is flagged in the view and read by nobody. A sound is read without
 * the notes, which are style for words; a few words are read as any line.
 */
export function plannedReactions(store: WorldStore, plan: Pick<AudiobookPlan, "blocks" | "record" | "present" | "reading" | "book">, narrator: AudiobookReader): PlannedBlock[] {
  const record = plan.record === "unreadable" ? null : plan.record;
  if (record === null || record.reactions === undefined) return [];
  const hashed = plan.blocks.map((planned) => ({ key: planned.block.key, textHash: audiobookTextHash(planned.block.text) }));
  const former = formerKeys(record.takes);
  const sheets = store.getBundle().sheets.filter((sheet) => sheet.type === "character" && !sheet.retired);
  const recorded = new Set(plan.book?.recorded ?? []);
  const out: PlannedBlock[] = [];
  for (const [key, reaction] of Object.entries(record.reactions)) {
    const place = placeAnchor(hashed, reaction.host, former);
    if (place.state === "gone") continue;
    const host = plan.blocks[place.index]!;
    const sheet = reaction.speaker === "narrator" ? undefined : sheets.find((candidate) => candidate.id === reaction.speaker);
    const speaker = reaction.speaker === "narrator" ? {} : sheet !== undefined ? { speaker: sheet.name, sheet: sheet.id } : { speaker: reaction.speaker };
    const block = { key, paragraph: host.block.paragraph, text: reactionText(reaction), ...speaker };
    const notes = reaction.sound !== undefined ? {} : (plan.book?.notes ?? {});
    const reading = reaction.sound !== undefined ? {} : (host.reading ?? {});
    const [planned] = assignReaders([block], plan.reading, narrator, sheets, store.getBundle().clonedVoices ?? [], record, (artifactId) => plan.present.has(artifactId), recorded, notes, reading);
    if (planned === undefined) continue;
    out.push({ ...planned, ...(reaction.sound !== undefined ? { reaction: { sound: reaction.sound } } : { reaction: {} }) });
  }
  return out;
}

/**
 * The record's timing with each entry on the block it stands on now (R-82): an entry that followed
 * its words to another key is written under that key with them; one whose block is gone is let go.
 * Applied on every timing write, so the record says what the view shows.
 */
export function rekeyTiming(record: ChapterAudiobook, blocks: readonly { key: string; text: string }[]): Record<string, BlockTiming> {
  const hashed = blocks.map((block) => ({ key: block.key, textHash: audiobookTextHash(block.text) }));
  const former = formerKeys(record.takes);
  const out: Record<string, BlockTiming> = {};
  const here = new Set<string>();
  for (const [key, entry] of Object.entries(record.timing ?? {})) {
    const place = placeAnchor(hashed, { key, textHash: entry.textHash }, former);
    if (place.state === "gone") continue;
    const at = hashed[place.index]!;
    // Two on one block keep the one set there.
    if (out[at.key] !== undefined && (here.has(at.key) || place.state === "moved")) continue;
    if (place.state !== "moved") here.add(at.key);
    out[at.key] = { ...entry, textHash: at.textHash };
  }
  return out;
}

/** An entry with nothing set is no entry. */
function emptyEntry(entry: BlockTiming): boolean {
  return entry.start === undefined && entry.under === undefined && entry.trim === undefined && entry.nudge === undefined;
}

/**
 * One block's timing set by the author (R-81): a start, the pause after it (the next block's
 * start), plays under another block, its take's trim, its grouped cut's nudge, or the block's
 * timing reset. Refused in one clause where the binding forbids it: under Performed a grouped
 * request's inside is the reader's (R-85); a trim needs a take; a nudge needs a grouped cut.
 */
export async function setBlockTiming(
  store: WorldStore,
  productionId: string,
  chapterFile: string,
  key: string,
  input: BlockTimingInput,
  narrator: AudiobookReader,
): Promise<ChapterAudiobook> {
  const production = store.getBundle().productions.find((p) => p.meta.id === productionId);
  const summary = production?.chapters.find((c) => c.file === chapterFile || c.id === chapterFile);
  if (summary === undefined) throw new TimingRefusal("that chapter is no longer in this production");
  const plan = await planAudiobook(store, productionId, summary.id, { narrator });
  const index = plan.blocks.findIndex((planned) => planned.block.key === key);
  if (index < 0 || isReactionKey(key)) throw new TimingRefusal("that block is no longer in the chapter");
  const timing = chapterTiming(store, plan, "estimate");
  const bar = timing.bars.find((candidate) => candidate.kind === "block" && candidate.key === key);
  const blocks = timingBlocks(store, plan);
  const take = blocks[index]?.take;
  const now = store.now();

  // The block whose start is this one's pause after: the next one running after it.
  let pauseTarget: number | null = null;
  if (input.pauseAfter !== undefined) {
    if (bar === undefined || bar.under !== null) throw new TimingRefusal("a block under another has no pause after");
    const next = timing.bars.filter((candidate) => candidate.kind === "block" && candidate.under === null && candidate.index > index).sort((a, b) => a.index - b.index)[0];
    if (next === undefined) throw new TimingRefusal("the last block has no pause after");
    if (input.pauseAfter !== null && next.locked.start) throw new TimingRefusal("inside a grouped request the pause is the reader's");
    pauseTarget = next.index;
  }
  // Playing a block under another is a placement too (codex on PR 1497): inside a grouped
  // request under Performed, the reader's as its start is.
  if (((input.start !== undefined && input.start !== null) || (input.under !== undefined && input.under !== null)) && bar?.locked.start === true) {
    throw new TimingRefusal("inside a grouped request the start is the reader's");
  }
  if (input.trim !== undefined && input.trim !== null) {
    if (take === undefined) throw new TimingRefusal("a block with no take has nothing to trim");
    if (input.trim.head + input.trim.tail > take.seconds - 0.1) throw new TimingRefusal("the trim would leave nothing to hear");
  }
  if (input.nudge !== undefined && input.nudge !== null && !(take !== undefined && contiguousCuts(take, blocks[index + 1]?.take))) {
    throw new TimingRefusal("only a cut between two blocks of one request can be nudged");
  }
  let host: { key: string; textHash: string } | null = null;
  if (input.under !== undefined && input.under !== null) {
    const found = plan.blocks.find((planned) => planned.block.key === input.under!.host);
    if (found === undefined) throw new TimingRefusal("that block is no longer in the chapter");
    if (found.block.key === key) throw new TimingRefusal("a block cannot play under itself");
    host = { key: found.block.key, textHash: audiobookTextHash(found.block.text) };
  }

  return updateAudiobook(store, productionId, plan.chapter, (current) => {
    const entries = rekeyTiming(current, plan.blocks.map((planned) => planned.block));
    const write = (at: number, change: (entry: BlockTiming) => BlockTiming | null): void => {
      const block = plan.blocks[at]!.block;
      const held = entries[block.key] ?? { textHash: audiobookTextHash(block.text), by: "author" as const, at: now };
      const next = change({ ...held, textHash: audiobookTextHash(block.text), at: now });
      if (next === null || emptyEntry(next)) delete entries[block.key];
      else entries[block.key] = next;
    };
    write(index, (entry) => {
      if (input.reset === true) return null;
      const out: BlockTiming = { ...entry };
      if (input.start !== undefined) {
        if (input.start === null) delete out.start;
        else out.start = input.start;
      }
      if (input.under !== undefined) {
        if (input.under === null || host === null) delete out.under;
        else out.under = { host, offset: input.under.offset };
      }
      if (input.trim !== undefined) {
        if (input.trim === null || take === undefined) delete out.trim;
        else out.trim = { artifactId: take.artifactId, head: input.trim.head, tail: input.trim.tail };
      }
      if (input.nudge !== undefined) {
        if (input.nudge === null || input.nudge === 0) delete out.nudge;
        else out.nudge = input.nudge;
      }
      // A trim set on a take since replaced belonged to that take (R-82): written away here.
      if (out.trim !== undefined && out.trim.artifactId !== take?.artifactId) delete out.trim;
      // The author touched the placement: it is theirs now, and a proposal leaves it (R-86).
      if (input.start !== undefined || input.under !== undefined || input.pauseAfter !== undefined) out.by = "author";
      return out;
    });
    if (pauseTarget !== null) {
      write(pauseTarget, (entry) => {
        const out: BlockTiming = { ...entry, by: "author" };
        if (input.pauseAfter === null) delete out.start;
        else out.start = input.pauseAfter!;
        return out;
      });
    }
    const { timing: _old, ...rest } = current;
    return { ...rest, updatedAt: now, ...(Object.keys(entries).length > 0 ? { timing: entries } : {}) };
  });
}

/** The chapter and its plan, for a write that names blocks by key. */
async function chapterPlan(store: WorldStore, productionId: string, chapterFile: string, narrator: AudiobookReader): Promise<AudiobookPlan> {
  const production = store.getBundle().productions.find((p) => p.meta.id === productionId);
  const summary = production?.chapters.find((c) => c.file === chapterFile || c.id === chapterFile);
  if (summary === undefined) throw new TimingRefusal("that chapter is no longer in this production");
  return planAudiobook(store, productionId, summary.id, { narrator });
}

function anchorOf(plan: AudiobookPlan, key: string): { key: string; textHash: string } {
  const planned = plan.blocks.find((candidate) => candidate.block.key === key);
  if (planned === undefined || isReactionKey(key)) throw new TimingRefusal("that block is no longer in the chapter");
  return { key, textHash: audiobookTextHash(planned.block.text) };
}

/**
 * A source a bed or a sound may play (R-84): an audio file the world holds on its shelf, as the
 * panel offers it — never a path from outside the world, never a take of the audiobook itself.
 */
async function audioSource(store: WorldStore, input: { file: string; origin: AudiobookAudioSource["origin"] }): Promise<AudiobookAudioSource> {
  const artifact = isWorldAudioPath(input.file) ? store.getBundle().artifacts.find((candidate) => `artifacts/${candidate.file}` === input.file && candidate.retiredAt === undefined) : undefined;
  const there = artifact === undefined ? false : await stat(toExtendedLength(join(store.dir, fromPortable(input.file)))).then((s) => s.isFile(), () => false);
  if (artifact === undefined || artifact.kind !== "audio" || artifact.generation?.source === "audiobook" || !there) throw new TimingRefusal("that sound is not in this world");
  const label = artifact.file.split("/").pop()!.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").slice(0, 120) || "sound";
  const seconds = artifact.mediaInfo?.durationSec;
  return { file: input.file, origin: input.origin, label, ...(seconds !== undefined && seconds > 0 ? { seconds } : {}) };
}

/**
 * A reaction set, changed or taken away (R-83). A new one takes the next free key; taking one
 * away lets its take go from the record too — the artifact stays on the shelf, as a take always
 * does. A reaction is never written into the prose.
 */
export async function setReaction(store: WorldStore, productionId: string, chapterFile: string, key: string | null, input: ReactionInput | null, narrator: AudiobookReader): Promise<ChapterAudiobook> {
  const plan = await chapterPlan(store, productionId, chapterFile, narrator);
  if (key !== null && !isReactionKey(key)) throw new TimingRefusal("that is not a reaction");
  const host = input === null ? null : anchorOf(plan, input.host);
  return updateAudiobook(store, productionId, plan.chapter, (current) => {
    const reactions = { ...current.reactions };
    const takes = { ...current.takes };
    const flags = { ...current.flags };
    const at = key ?? nextReactionKey(reactions);
    if (input === null || host === null) {
      if (reactions[at] === undefined) return null;
      delete reactions[at];
      delete takes[at];
      delete flags[at];
    } else {
      const was = reactions[at];
      reactions[at] = { host, speaker: input.speaker, ...(input.sound !== undefined ? { sound: input.sound } : { words: input.words! }), offset: input.offset, by: "author", at: store.now() };
      // Other words, or another sound, are another take: an old refusal is not this one's.
      if (was !== undefined && reactionText(was) !== reactionText(reactions[at]!)) delete flags[at];
    }
    const { reactions: _old, ...rest } = current;
    return { ...rest, takes, flags, updatedAt: store.now(), ...(Object.keys(reactions).length > 0 ? { reactions } : {}) };
  });
}

/** A bed set, changed or taken away (R-84): from one block to the same or a later one. */
export async function setBed(store: WorldStore, productionId: string, chapterFile: string, key: string | null, input: BedInput | null, narrator: AudiobookReader): Promise<ChapterAudiobook> {
  const plan = await chapterPlan(store, productionId, chapterFile, narrator);
  let value: AudiobookBed | null = null;
  if (input !== null) {
    const from = anchorOf(plan, input.from);
    const to = anchorOf(plan, input.to);
    const order = (block: string) => plan.blocks.findIndex((planned) => planned.block.key === block);
    if (order(input.to) < order(input.from)) throw new TimingRefusal("a bed ends at or after the block it starts on");
    value = { from, to, source: await audioSource(store, input.source), levelDb: input.levelDb, fadeInSec: input.fadeInSec, fadeOutSec: input.fadeOutSec, duckDb: input.duckDb, by: "author", at: store.now() };
  }
  return updateAudiobook(store, productionId, plan.chapter, (current) => {
    const beds = { ...current.beds };
    const at = key ?? nextTimingKey("b", beds);
    if (value === null) {
      if (beds[at] === undefined) return null;
      delete beds[at];
    } else beds[at] = value;
    const { beds: _old, ...rest } = current;
    return { ...rest, updatedAt: store.now(), ...(Object.keys(beds).length > 0 ? { beds } : {}) };
  });
}

/** A sound at a block's start set, changed or taken away (R-84). */
export async function setBlockSound(store: WorldStore, productionId: string, chapterFile: string, key: string | null, input: BlockSoundInput | null, narrator: AudiobookReader): Promise<ChapterAudiobook> {
  const plan = await chapterPlan(store, productionId, chapterFile, narrator);
  const value: AudiobookBlockSound | null = input === null ? null : { block: anchorOf(plan, input.block), source: await audioSource(store, input.source), levelDb: input.levelDb, by: "author", at: store.now() };
  return updateAudiobook(store, productionId, plan.chapter, (current) => {
    const sounds = { ...current.sounds };
    const at = key ?? nextTimingKey("s", sounds);
    if (value === null) {
      if (sounds[at] === undefined) return null;
      delete sounds[at];
    } else sounds[at] = value;
    const { sounds: _old, ...rest } = current;
    return { ...rest, updatedAt: store.now(), ...(Object.keys(sounds).length > 0 ? { sounds } : {}) };
  });
}
