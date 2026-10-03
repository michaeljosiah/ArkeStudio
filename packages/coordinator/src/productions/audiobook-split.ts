import type { AudioTranscriptComparison } from "@arke-studio/contracts";
import { compareAudioTranscript } from "../audio/transcript-comparison.js";
import type { TimedWord } from "../voice/word-times.js";

/**
 * A grouped request split back into its blocks (design turn 185): the words heard, with their
 * times, aligned to the blocks' words; each block cut at the middle of the pause between its last
 * word and the next block's first, so the reader's own pause is kept and shared between them; and
 * each cut checked against its block's words by the transcript check audio QC already uses.
 */
export interface SplitCut {
  key: string;
  start: number;
  end: number;
  /** The words heard inside the cut, as heard. */
  heard: string;
  matched: boolean;
  comparison: AudioTranscriptComparison;
}

/** A word as the split compares it: case, accents' composition and punctuation set aside. */
export function splitToken(word: string): string {
  return word.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

const tokens = (text: string): string[] => text.split(/\s+/).map(splitToken).filter((token) => token !== "");

/**
 * Heard words matched to written ones in order (a longest common subsequence): for each heard
 * word, the index of the written word it is, or −1.
 */
function align(written: readonly string[], heard: readonly string[]): number[] {
  const matched = heard.map(() => -1);
  // A request is about five minutes, some 800 words; the table is bounded well past that.
  if (written.length * heard.length > 16_000_000) return matched;
  const width = heard.length + 1;
  const table = new Uint16Array((written.length + 1) * width);
  for (let i = written.length - 1; i >= 0; i--) {
    for (let j = heard.length - 1; j >= 0; j--) {
      table[i * width + j] = written[i] === heard[j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }
  for (let i = 0, j = 0; i < written.length && j < heard.length;) {
    if (written[i] === heard[j]) {
      matched[j] = i;
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) i += 1;
    else j += 1;
  }
  return matched;
}

/**
 * Whether a cut is its block (design turn 185c): the words heard against the words written by
 * the transcript check, with case and punctuation set aside since whisper writes its own. A word
 * left out or one added — the split in the wrong place, or the reader skipping — is a mismatch;
 * a short run heard as a different short run is whisper mishearing a name or a Yoruba word, and
 * passes, while there are few of them.
 */
export function judgeSplit(written: string, heard: string, audioHash: string): { matched: boolean; comparison: AudioTranscriptComparison } {
  const comparison = compareAudioTranscript({ audioHash, authoredText: tokens(written).join(" "), observedText: tokens(heard).join(" "), transcriber: { id: "voxa-whisper", version: "runtime-unreported" } });
  if (comparison.status !== "compared") return { matched: false, comparison };
  if (comparison.result === "exact") return { matched: true, comparison };
  const words = Math.max(1, tokens(written).length);
  const misheard = comparison.differences.every((difference) => difference.kind === "changed" && difference.authored.split(" ").length <= 3 && difference.observed.split(" ").length <= 3);
  return { matched: misheard && comparison.differences.length <= Math.max(1, Math.floor(words / 8)), comparison };
}

export function splitRequest(
  blocks: ReadonlyArray<{ key: string; text: string }>,
  words: readonly TimedWord[],
  seconds: number,
  hashOf: (start: number, end: number) => string,
): SplitCut[] {
  const written: string[] = [];
  const owner: number[] = [];
  blocks.forEach((block, index) => {
    for (const token of tokens(block.text)) {
      written.push(token);
      owner.push(index);
    }
  });
  const heard = words.map((word) => splitToken(word.text));
  const kept = words.map((_, at) => at).filter((at) => heard[at] !== "");
  const matched = align(written, kept.map((at) => heard[at]!));
  // Each heard word's block, where it matched one.
  const blockOf = kept.map((_, at) => (matched[at]! >= 0 ? owner[matched[at]!]! : -1));
  const cuts: number[] = [];
  for (let boundary = 0; boundary < blocks.length - 1; boundary++) {
    let last = -1;
    let first = -1;
    blockOf.forEach((block, at) => {
      if (block >= 0 && block <= boundary) last = at;
    });
    for (let at = last + 1; at < blockOf.length; at++) {
      if (blockOf[at]! > boundary) {
        first = at;
        break;
      }
    }
    const floor = cuts[cuts.length - 1] ?? 0;
    if (last >= 0 && first >= 0) {
      // Among the words between, the widest pause is the turn's end.
      let best = last;
      for (let at = last; at < first; at++) {
        const gap = words[kept[at + 1]!]!.start - words[kept[at]!]!.end;
        if (gap > words[kept[best + 1]!]!.start - words[kept[best]!]!.end) best = at;
      }
      cuts.push(Math.max(floor, (words[kept[best]!]!.end + words[kept[best + 1]!]!.start) / 2));
      continue;
    }
    // Nothing heard to place it by: where the written characters put it, between the cuts known.
    const before = blocks.slice(0, boundary + 1).reduce((sum, block) => sum + block.text.length, 0);
    const total = blocks.reduce((sum, block) => sum + block.text.length, 0);
    cuts.push(Math.max(floor, (seconds * before) / Math.max(1, total)));
  }
  return blocks.map((block, index) => {
    const start = index === 0 ? 0 : cuts[index - 1]!;
    const end = index === blocks.length - 1 ? seconds : cuts[index]!;
    const inside = words.filter((word) => (word.start + word.end) / 2 >= start && (word.start + word.end) / 2 < end).map((word) => word.text).join(" ");
    const judged = end > start ? judgeSplit(block.text, inside, hashOf(start, end)) : { matched: false, comparison: compareAudioTranscript({ audioHash: hashOf(start, start), authoredText: block.text, observedText: "", transcriber: { id: "voxa-whisper", version: "runtime-unreported" } }) };
    return { key: block.key, start, end, heard: inside, matched: judged.matched && end > start, comparison: judged.comparison };
  });
}
