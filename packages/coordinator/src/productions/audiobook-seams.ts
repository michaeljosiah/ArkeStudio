import {
  audiobookBlockOptions,
  audiobookBlocks,
  audiobookHeading,
  type AudiobookGap,
  type AudiobookSeam,
  type AudiobookSeamAnchor,
  type ChapterAudiobook,
} from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import { planAudiobook, readAudiobook, updateAudiobook, type AudiobookPlan } from "./audiobook.js";
import { followChapterTakes } from "./audiobook-book.js";
import type { ReadingRoom } from "./audiobook-run.js";

/**
 * Block seams (design turn 198, SPEC-047 R-147..R-152): every gap between two of a chapter's
 * lines is a block's edge or not, and the author changes which by hand. A seam is kept on the
 * chapter's audiobook record, never in the manuscript, through the record's one lane; nothing is
 * read and nothing deleted. After every change the chapter's blocks look for their kept takes
 * again, so a block put back in a shape it had before is made again at no cost.
 */

/** Why a seam was not changed, in one clause the panel says. */
export class SeamRefusal extends Error {}

const samePlace = (a: AudiobookSeamAnchor["before"], b: AudiobookSeamAnchor["before"]) => a.paragraph === b.paragraph && a.turn === b.turn;

/** The gap a press names, in the blocks the record's seams make now. */
function gapFor(plan: Pick<AudiobookPlan, "body" | "cast" | "chapter" | "book">, record: ChapterAudiobook, anchor: AudiobookSeamAnchor): { gap: AudiobookGap | null; dropped: number[] } {
  const derived = audiobookBlocks(plan.body, plan.cast === "unreadable" ? null : plan.cast, audiobookHeading(plan.chapter.order, plan.chapter.title), audiobookBlockOptions(plan.book, record));
  const gap = derived.seams.gaps.find((candidate) => candidate.anchor !== undefined && samePlace(candidate.anchor.before, anchor.before) && samePlace(candidate.anchor.after, anchor.after) && candidate.anchor.textHash === anchor.textHash) ?? null;
  return { gap, dropped: derived.seams.droppedSeams };
}

/**
 * Join or Split pressed on a gap (rules 1, 2, 8): refused when the words under it changed since
 * the press was drawn, when it would break a limit, or when the press is not the one the gap
 * offers. Pressing the opposite press on the same seam undoes it; a seam is only written where
 * the reading would not cut that way on its own. Seams whose words changed are let go on the way,
 * having been counted once on the Blocks press.
 */
export async function setAudiobookSeam(
  store: WorldStore,
  productionId: string,
  chapterId: string,
  input: { press: "join" | "split"; anchor: AudiobookSeamAnchor },
  room: Pick<ReadingRoom, "narrator">,
): Promise<ChapterAudiobook> {
  const plan = await planAudiobook(store, productionId, chapterId, { narrator: room.narrator });
  if (plan.record === "unreadable") throw new SeamRefusal("record unreadable · Read the chapter replaces it");
  let refusal = null as string | null;
  const record = await updateAudiobook(store, productionId, plan.chapter, (current) => {
    // Judged against the record as the lane holds it, so a seam another window set meanwhile is
    // seen, not written over.
    const { gap, dropped } = gapFor(plan, current, input.anchor);
    if (gap === null) {
      refusal = "the words changed · look again";
      return null;
    }
    if (gap.press !== input.press) {
      refusal = "that seam changed · look again";
      return null;
    }
    if (gap.press === "join" && gap.limit !== undefined) {
      refusal = `Join · ${gap.limit}`;
      return null;
    }
    const gone = new Set([...dropped, ...(gap.seam !== undefined ? [gap.seam] : [])]);
    const seams: AudiobookSeam[] = (current.seams ?? []).filter((_, index) => !gone.has(index));
    // A join is needed only where the reading cuts on its own, a split only where it does not.
    if (gap.auto === (input.press === "join")) seams.push({ kind: input.press, before: input.anchor.before, after: input.anchor.after, textHash: input.anchor.textHash, at: store.now() });
    const { seams: _was, ...rest } = current;
    return { ...rest, updatedAt: store.now(), ...(seams.length > 0 ? { seams } : {}) };
  });
  if (refusal !== null) throw new SeamRefusal(refusal);
  await followChapterTakes(store, productionId, plan.chapter, room);
  return (await readCurrent(store, productionId, plan.chapter.file)) ?? record;
}

/**
 * Reset (rule 10): every seam returns to the automatic split, one block a paragraph, or a
 * reader's turn under Cast. It asks nothing, since nothing is lost: the old takes are found again.
 */
export async function resetAudiobookSeams(store: WorldStore, productionId: string, chapterId: string, room: Pick<ReadingRoom, "narrator">): Promise<ChapterAudiobook> {
  const plan = await planAudiobook(store, productionId, chapterId, { narrator: room.narrator });
  if (plan.record === "unreadable") throw new SeamRefusal("record unreadable · Read the chapter replaces it");
  const record = await updateAudiobook(store, productionId, plan.chapter, (current) => {
    if (current.seams === undefined) return null;
    const { seams: _gone, ...rest } = current;
    return { ...rest, updatedAt: store.now() };
  });
  await followChapterTakes(store, productionId, plan.chapter, room);
  return (await readCurrent(store, productionId, plan.chapter.file)) ?? record;
}

async function readCurrent(store: WorldStore, productionId: string, chapterFile: string): Promise<ChapterAudiobook | null> {
  const held = await readAudiobook(store, productionId, chapterFile);
  return held === null || held === "unreadable" ? null : held;
}
