import type { ManifestModel } from "./manifest.js";
import { deriveCapabilityAvailability, type ProviderStatus } from "./provider.js";
import { AUDIOBOOK_TITLE_KEY } from "./audiobook.js";
import { isSceneBreak } from "./manuscript.js";
import { expectedSpeechSeconds, quoteSpeech, SPEECH_TOKEN_ESTIMATE, type SpeechQuote } from "./speech-pricing.js";
import { speechUtf8Bytes } from "./speech-input.js";

/**
 * Grouped reads (design turn 185): consecutive blocks of one reader sent as one request, and the
 * request's audio split back into a take a block on this machine.
 *
 * Reading Na Love or Juju chapter 01 — 169 blocks under Performed — stopped at block 101 on
 * 2026-10-03: Google allows gemini-3.8-flash-tts 100 requests a day on Tier 1 and 10 on the Free
 * Tier, so one block a request cannot read a chapter in a day on either. Heard back, the blocks
 * read one a request also did not run on from each other: each line sounded read without the one
 * before it. So a request carries the book note and the chapter note once, each later turn only
 * what changes for it, and a run of blocks under the same direction as one turn.
 */

/** One turn of a request: the words in the reader's syntax, and the style beside them. */
export interface SpeechTurn {
  text: string;
  instructions?: string;
}

/**
 * How a request's turns carry style (design turn 185, amended after listening): `full` sends each
 * block's whole style on its turn, as a solo read would; `deltas` sends the shared notes once, on
 * the request's first turn, and each later turn only its own direction; `merged` is `deltas` with
 * consecutive blocks under the same direction joined into one turn. The probe compares the three
 * by ear; `merged` is the default until it says otherwise.
 */
export type GroupPacking = "full" | "deltas" | "merged";
export const DEFAULT_GROUP_PACKING: GroupPacking = "merged";

/**
 * A request's caps with room to spare under Gemini Flash's 8,192 input and 16,384 output tokens:
 * about 6,000 input tokens, words and styles together, and about five minutes of expected speech,
 * which at 25 audio tokens a second and the estimate's margin is 9,375 tokens.
 */
export const GROUPED_READ_CAPS = { inputTokens: 6_000, speechSeconds: 300 } as const;
export type GroupedReadCaps = { inputTokens: number; speechSeconds: number };

/** The break after a block where a request may close: a scene break or heading, or the end of a paragraph of narration alone. */
export type ReadBreak = "scene" | "paragraph";

/**
 * A block as grouping sees it: who reads it, the notes every block of the chapter shares (the
 * book note and the chapter note), and its parts — the words a solo read sends, each with the
 * style that is the block's own (its delivery, its note, its speaker's note).
 */
export interface BlockTurns {
  key: string;
  /** The reader's identity — provider, model and voice. Two blocks group only when this is the same. */
  reader: string;
  shared?: string;
  parts: ReadonlyArray<{ text: string; style?: string }>;
  /** Where a request may close after this block; absent is inside a paragraph or an exchange. */
  breakAfter?: ReadBreak;
}

/**
 * Where a request may close after each block (design turn 185): after the title, before a scene
 * break and at the chapter's end, a scene; after the last block of a paragraph that is narration
 * alone, a paragraph; nowhere else — not between a line and its tag, not inside an exchange.
 * `paragraphs` are the chapter's, as `chapterParagraphs` splits them.
 */
export function readBreaksFor(blocks: ReadonlyArray<{ key: string; paragraph: number; speaker?: string }>, paragraphs: readonly string[]): Map<string, ReadBreak> {
  const breaks = new Map<string, ReadBreak>();
  blocks.forEach((block, index) => {
    const next = blocks[index + 1];
    if (block.key === AUDIOBOOK_TITLE_KEY || next === undefined) {
      breaks.set(block.key, "scene");
      return;
    }
    if (next.paragraph === block.paragraph) return;
    if (paragraphs.slice(block.paragraph + 1, next.paragraph).some((between) => isSceneBreak(between))) {
      breaks.set(block.key, "scene");
      return;
    }
    if (blocks.every((other) => other.paragraph !== block.paragraph || other.speaker === undefined)) breaks.set(block.key, "paragraph");
  });
  return breaks;
}

/** A turn sent, with the blocks whose words it carries in order. */
export interface PackedTurn extends SpeechTurn {
  keys: string[];
}

const joinStyle = (...styles: ReadonlyArray<string | undefined>): string | undefined => {
  const kept = styles.filter((style): style is string => style !== undefined && style !== "");
  return kept.length > 0 ? kept.join(" ") : undefined;
};

/** The turns a solo read of one block sends: every part with the shared notes ahead of its own style. */
export function soloTurns(block: Pick<BlockTurns, "shared" | "parts">): SpeechTurn[] {
  return block.parts.map((part) => {
    const instructions = joinStyle(block.shared, part.style);
    return { text: part.text, ...(instructions !== undefined ? { instructions } : {}) };
  });
}

/**
 * A request's turns from its blocks in order. Under `deltas` and `merged` the shared notes ride
 * on the first turn, and again on any later turn whose notes differ; a turn after them carries
 * only its own style. Under `merged` a part whose own style, and notes, are the last turn's joins
 * that turn on a new line, so a run under one direction is read as one passage.
 */
export function packTurns(blocks: readonly BlockTurns[], packing: GroupPacking): PackedTurn[] {
  const turns: Array<PackedTurn & { own?: string; shared?: string }> = [];
  let sharedSent: string | undefined;
  for (const block of blocks) {
    for (const part of block.parts) {
      const last = turns[turns.length - 1];
      if (packing === "merged" && last !== undefined && last.own === part.style && last.shared === block.shared) {
        last.text = `${last.text}\n${part.text}`;
        if (last.keys[last.keys.length - 1] !== block.key) last.keys.push(block.key);
        continue;
      }
      const lead = packing === "full" || turns.length === 0 || block.shared !== sharedSent;
      if (lead) sharedSent = block.shared;
      const instructions = lead ? joinStyle(block.shared, part.style) : joinStyle(part.style);
      turns.push({ text: part.text, ...(instructions !== undefined ? { instructions } : {}), keys: [block.key], ...(part.style !== undefined ? { own: part.style } : {}), ...(block.shared !== undefined ? { shared: block.shared } : {}) });
    }
  }
  return turns.map(({ own: _own, shared: _shared, ...turn }) => turn);
}

/** A turn's estimated input: its words and style at the estimate's bytes a token, and the turn's framing. */
export function turnInputTokens(turn: SpeechTurn): number {
  const e = SPEECH_TOKEN_ESTIMATE;
  return Math.ceil((speechUtf8Bytes(turn.text) + speechUtf8Bytes(turn.instructions ?? "")) / e.bytesPerInputToken) + e.inputOverheadTokens;
}

/** What a grouped request's job says it reads: its turns' words, a space between. Activity shows it and the quote prices it. */
export function groupedText(turns: readonly SpeechTurn[]): string {
  return turns.map((turn) => turn.text).join(" ");
}

/**
 * One quote for one request (SPEC-049 R-6): the turns' words and every style, estimated as the
 * words are read — one lead-in and tail for the request, not one a block — and authorised at the
 * service limits, the cap a request can never pass whatever it holds.
 */
export function quoteGroupedSpeech(model: ManifestModel, turns: readonly SpeechTurn[], options: { at?: string } = {}): SpeechQuote {
  const styles = turns.flatMap((turn) => (turn.instructions !== undefined && turn.instructions !== "" ? [turn.instructions] : [])).join(" ");
  return quoteSpeech(model, groupedText(turns), { ...(options.at !== undefined ? { at: options.at } : {}), ...(styles !== "" ? { instructions: styles } : {}) });
}

export interface ReadGroup {
  keys: string[];
  turns: PackedTurn[];
  inputTokens: number;
  /** Expected speech, the words alone. */
  seconds: number;
}

function measure(blocks: readonly BlockTurns[], packing: GroupPacking): { turns: PackedTurn[]; inputTokens: number; seconds: number } {
  const turns = packTurns(blocks, packing);
  return {
    turns,
    inputTokens: turns.reduce((sum, turn) => sum + turnInputTokens(turn), 0),
    seconds: blocks.reduce((sum, block) => sum + block.parts.reduce((inner, part) => inner + expectedSpeechSeconds(part.text), 0), 0),
  };
}

/**
 * The requests a chapter's blocks make (design turn 185): consecutive blocks with the same
 * reader, in reading order, packed under the caps. `null` is a block that is not sent — a take
 * that still stands, a recorded block, a block held from reading — and it closes the request, as
 * a change of reader does; under Cast each voice groups only with itself, and designed voices are
 * never combined. Past the caps a request closes at the latest natural break in it — a scene
 * break or heading, else the end of a paragraph of narration — and never between a line and its
 * tag or inside an exchange; only a run with no break at all is cut where the caps fall. A block
 * over the caps alone is a request of its own.
 */
export function groupReads(blocks: readonly (BlockTurns | null)[], packing: GroupPacking = DEFAULT_GROUP_PACKING, caps: GroupedReadCaps = GROUPED_READ_CAPS): ReadGroup[] {
  const groups: ReadGroup[] = [];
  let open: BlockTurns[] = [];
  const close = (members: BlockTurns[]) => {
    if (members.length > 0) groups.push({ keys: members.map((block) => block.key), ...measure(members, packing) });
  };
  for (const block of blocks) {
    if (block === null || block.parts.length === 0) {
      close(open);
      open = [];
      continue;
    }
    if (open.length > 0 && open[0]!.reader !== block.reader) {
      close(open);
      open = [];
    }
    const next = [...open, block];
    const size = measure(next, packing);
    if (open.length === 0 || (size.inputTokens <= caps.inputTokens && size.seconds <= caps.speechSeconds)) {
      open = next;
      continue;
    }
    // Over the caps: close at the latest scene break, else the latest narration paragraph's end.
    const latest = (kind: ReadBreak) => open.map((member) => member.breakAfter).lastIndexOf(kind);
    const at = latest("scene") >= 0 ? latest("scene") : latest("paragraph");
    const cut = at >= 0 ? at + 1 : open.length;
    close(open.slice(0, cut));
    open = [...open.slice(cut), block];
    // What carried over may itself be past the caps with the new block: it is closed as it stands.
    if (open.length > 1) {
      const carried = measure(open, packing);
      if (carried.inputTokens > caps.inputTokens || carried.seconds > caps.speechSeconds) {
        close(open.slice(0, -1));
        open = [block];
      }
    }
  }
  close(open);
  return groups;
}

/**
 * A request's amount shared among its blocks by their characters (design turn 185): whole
 * micro-dollars, largest remainder first, so the shares always sum to the request's amount.
 * Null stays null — an actual that is not known is not known for any block of it.
 */
export function shareByCharacters(total: number | null, characters: readonly number[]): (number | null)[] {
  if (total === null) return characters.map(() => null);
  if (characters.length === 0) return [];
  const weight = characters.reduce((sum, count) => sum + count, 0);
  if (weight === 0) return characters.map((_, at) => (at === 0 ? total : 0));
  const exact = characters.map((count) => (total * count) / weight);
  const shares = exact.map((value) => Math.floor(value));
  let left = total - shares.reduce((sum, value) => sum + value, 0);
  const order = exact.map((value, at) => ({ at, remainder: value - Math.floor(value) })).sort((a, b) => b.remainder - a.remainder || a.at - b.at);
  for (const entry of order) {
    if (left <= 0) break;
    shares[entry.at] = shares[entry.at]! + 1;
    left -= 1;
  }
  return shares;
}

/** Whether a reader's row may group (design turn 185): its cadence says so, and its price is the token's, which one request a group pays. */
export function readerGroups(model: Pick<ManifestModel, "cadence" | "pricing"> | null | undefined): boolean {
  return model?.cadence?.groupable === true && model.pricing.kind === "perToken";
}

/**
 * Whether this machine can split a grouped request (design turn 185): the local transcriber —
 * whisper.cpp through Voxa — answers that it can transcribe. Without it grouping is not offered.
 */
export function localTranscriberAvailable(statuses: readonly ProviderStatus[]): boolean {
  const local = statuses.filter((status) => status.id === "whispercpp");
  return deriveCapabilityAvailability([...local]).find((entry) => entry.capability === "voice-stt")?.available === true;
}

/**
 * Whether a book's blocks in this reader are sent grouped (design turn 185d): the reader groups,
 * this machine can split, and the book has not chosen one block a request.
 */
export function groupingOffered(model: Pick<ManifestModel, "cadence" | "pricing"> | null | undefined, transcriber: boolean): boolean {
  return readerGroups(model) && transcriber;
}
export function readsGrouped(model: Pick<ManifestModel, "cadence" | "pricing"> | null | undefined, transcriber: boolean, book: { requests?: "per-paragraph" } | null | undefined): boolean {
  return groupingOffered(model, transcriber) && book?.requests !== "per-paragraph";
}
