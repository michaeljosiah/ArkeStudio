import {
  audiobookSpeakerKey,
  audiobookTextHash,
  contiguousCuts,
  ESTIMATED_CHARACTERS_PER_SECOND,
  formerKeys,
  isReactionKey,
  placeAnchor,
  timeChapter,
  type AudiobookReader,
  type BlockTiming,
  type BlockTimingInput,
  type ChapterAudiobook,
  type ChapterTiming,
  type TimingInputBlock,
  type TimingInputReaction,
  type TimingTake,
} from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import { planAudiobook, updateAudiobook, type AudiobookPlan } from "./audiobook.js";

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

/** The reactions as the clock reads them: who says each, and its take once it is made. */
export function timingReactions(store: WorldStore, record: ChapterAudiobook | null): TimingInputReaction[] {
  return Object.entries(record?.reactions ?? {}).map(([key, reaction]) => {
    const take = record?.takes[key];
    const lane = reaction.speaker === "narrator" ? "narration" : reaction.speaker;
    const timed = take === undefined ? undefined : timingTake(store, take, reaction.words ?? reaction.sound ?? "");
    return { key, lane, ...(timed !== undefined ? { take: timed } : {}) };
  });
}

/** The chapter on its clock with its timing, as the plan reads it. */
export function chapterTiming(store: WorldStore, plan: Pick<AudiobookPlan, "blocks" | "record" | "reading" | "present">, unmade: "skip" | "estimate"): ChapterTiming {
  const record = plan.record === "unreadable" ? null : plan.record;
  return timeChapter({
    blocks: timingBlocks(store, plan),
    reactions: timingReactions(store, record),
    record: record ?? {},
    reading: plan.reading,
    unmade,
  });
}

export class TimingRefusal extends Error {}

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
  if (input.start !== undefined && input.start !== null && bar?.locked.start === true) throw new TimingRefusal("inside a grouped request the start is the reader's");
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
