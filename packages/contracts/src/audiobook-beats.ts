import { AUDIOBOOK_JOIN_MAX_SECONDS, AUDIOBOOK_TITLE_KEY, audiobookTextHash, type AudiobookBeat, type AudiobookBlock, type AudiobookGap, type AudiobookSeam } from "./audiobook.js";
import { expectedSpeechSeconds } from "./speech-pricing.js";

/**
 * Blocks grouped by beats (SPEC-047 R-172): a chapter read one paragraph a request reset the
 * narrator at every paragraph — Chapter 2 of *Na Love or Juju* was 224 requests on Eleven v4, and
 * its whispered car scene took sixteen block edits to put right. A beat is the stretch where one
 * character's intention and the scene's pressure hold; the director names where each begins, and
 * the blocks of a beat are joined by the seams design turn 198 already keeps, so a beat is one
 * block: one read, one direction, one take. Nothing new is stored, and Reset undoes it.
 */

/**
 * The longest a beat is joined to: the join's own cap (`AUDIOBOOK_JOIN_MAX_SECONDS`) with room,
 * since a joined block whose words grow past the cap loses every join in it (design turn 198,
 * rule 8). A beat longer than this is cut where it would cross.
 */
export const BEAT_MAX_SECONDS = Math.round(AUDIOBOOK_JOIN_MAX_SECONDS * 0.8);

/** A beat as joined: the key of its first block, how many blocks it holds and their expected seconds. */
export interface JoinedBeat {
  start: string;
  blocks: number;
  seconds: number;
}

export interface BeatJoins {
  /** The join seams that make each beat one block, in the chapter's order. */
  seams: AudiobookSeam[];
  beats: JoinedBeat[];
  /** Beats begun where the director named none: a scene break, a gap no join may cross, or the length cap. */
  cut: number;
}

/**
 * The joins that make the named beats blocks, over the chapter's automatic blocks and their gaps
 * (`audiobookBlocks` with no seams). A beat begins at every block the director named, and also
 * wherever no join may go — the title, a scene break, two voices — and where joining the next
 * block would carry the beat past `BEAT_MAX_SECONDS`.
 */
export function beatSeams(blocks: readonly Pick<AudiobookBlock, "key" | "text">[], gaps: readonly AudiobookGap[], starts: ReadonlySet<string>, at: string): BeatJoins {
  const above = new Map(gaps.filter((gap) => gap.press === "join").map((gap) => [gap.block, gap] as const));
  const seams: AudiobookSeam[] = [];
  const beats: JoinedBeat[] = [];
  let cut = 0;
  for (const block of blocks) {
    if (block.key === AUDIOBOOK_TITLE_KEY) continue;
    const seconds = expectedSpeechSeconds(block.text);
    const current = beats.at(-1);
    const gap = above.get(block.key);
    const named = starts.has(block.key);
    const barred = gap?.anchor === undefined || gap.limit !== undefined || !gap.auto;
    const over = current !== undefined && current.seconds + seconds > BEAT_MAX_SECONDS;
    if (current === undefined || named || barred || over) {
      if (current !== undefined && !named) cut += 1;
      beats.push({ start: block.key, blocks: 1, seconds });
      continue;
    }
    seams.push({ kind: "join", before: gap!.anchor!.before, after: gap!.anchor!.after, textHash: gap!.anchor!.textHash, at });
    current.blocks += 1;
    current.seconds += seconds;
  }
  return { seams, beats, cut };
}

/**
 * The beat a block is (design turn 201, rule 4): the record names a beat starting at the block's
 * key, and the block's words are still the words it was joined into. A beat a Join, a Split or an
 * edit has changed since is no longer the director's, and has no name; null for every block that
 * is not a named beat.
 */
export function audiobookBeatAt(beats: readonly AudiobookBeat[] | undefined, block: Pick<AudiobookBlock, "key" | "text">): AudiobookBeat | null {
  const beat = beats?.find((candidate) => candidate.start === block.key);
  return beat !== undefined && beat.textHash === audiobookTextHash(block.text) ? beat : null;
}

/** How many of the blocks are named beats, for the Blocks press's `N beats` (design turn 201, rule 1). */
export function audiobookBeatCount(beats: readonly AudiobookBeat[] | undefined, blocks: ReadonlyArray<Pick<AudiobookBlock, "key" | "text">>): number {
  if (beats === undefined || beats.length === 0) return 0;
  return blocks.filter((block) => audiobookBeatAt(beats, block) !== null).length;
}
