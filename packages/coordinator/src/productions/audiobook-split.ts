import { expectedSpeechSeconds, SPEECH_TOKEN_ESTIMATE, type AudioTranscriptComparison } from "@arke-studio/contracts";
import { runawayTailAt, speechPauses, TAIL_KEEP_SEC, type SpeechPcm } from "../audio/speech-wav.js";
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
  /** The request ran far past its words (`ranLong`). */
  longTail?: true;
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

/**
 * What the split reads off the request's audio beyond the words (design turn 185 follow-up): its
 * pauses, where the last block's cut ends, and where a runaway tail begins.
 */
export interface SplitAudio {
  pauses: ReadonlyArray<{ start: number; end: number }>;
  tailAt: number | null;
}

export function splitAudio(pcm: SpeechPcm): SplitAudio {
  return { pauses: speechPauses(pcm), tailAt: runawayTailAt(pcm) };
}

/** The note a request that ran far past its words carries (design turn 185 follow-up). */
export const LONG_TAIL = "long tail";

/**
 * Whether audio ran far past the speech its words should take: over 1.6 times the estimate's
 * (SPEC-049 R-6's 150 words a minute and a request's lead-in and tail) and ten seconds more. The
 * probe's merged request ran 54.2 s on words the other two packings read in about 24.
 */
export function ranLong(seconds: number, texts: readonly string[]): boolean {
  const expected = texts.reduce((sum, text) => sum + expectedSpeechSeconds(text), 0) + SPEECH_TOKEN_ESTIMATE.edgeSeconds;
  return seconds > 1.6 * expected && seconds - expected > 10;
}

/**
 * Where the last block's cut ends: the middle of the first pause after the word, held to
 * `TAIL_KEEP_SEC` of it, so whatever the reader went on to make after its words — a runaway
 * nonverbal tail, or a long silence — is not kept in the take. Never past a runaway tail.
 */
function endAfter(word: number, audio: SplitAudio, seconds: number): number {
  const pause = audio.pauses.find((candidate) => candidate.start >= word - 0.02 && candidate.end > word);
  let end = pause === undefined ? seconds : Math.min(pause.start + TAIL_KEEP_SEC, (pause.start + pause.end) / 2);
  if (audio.tailAt !== null && audio.tailAt >= word) end = Math.min(end, audio.tailAt);
  return Math.max(word, end);
}

export function splitRequest(
  blocks: ReadonlyArray<{ key: string; text: string }>,
  words: readonly TimedWord[],
  seconds: number,
  hashOf: (start: number, end: number) => string,
  audio?: SplitAudio,
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
  const judged = (block: { key: string; text: string }, start: number, end: number): SplitCut => {
    const inside = words.filter((word) => (word.start + word.end) / 2 >= start && (word.start + word.end) / 2 < end).map((word) => word.text).join(" ");
    const judgement = end > start ? judgeSplit(block.text, inside, hashOf(start, end)) : { matched: false, comparison: compareAudioTranscript({ audioHash: hashOf(start, start), authoredText: block.text, observedText: "", transcriber: { id: "voxa-whisper", version: "runtime-unreported" } }) };
    return { key: block.key, start, end, heard: inside, matched: judgement.matched && end > start, comparison: judgement.comparison };
  };
  const split = blocks.map((block, index) => {
    const start = index === 0 ? 0 : cuts[index - 1]!;
    if (index < blocks.length - 1) return judged(block, start, cuts[index]!);
    if (audio === undefined) return judged(block, start, seconds);
    // The last block ends after its last word heard, not at the end of the audio. A written word
    // after that one may have been heard as something else, so the heard words after it are tried
    // too — as many as there are written words left — and the first end whose words match is
    // kept, else the furthest: a cut is never shortened past what might be its own last word.
    let lastAt = -1;
    blockOf.forEach((owned, at) => {
      if (owned === index) lastAt = at;
    });
    if (lastAt < 0) return judged(block, start, Math.max(start, audio.tailAt !== null && audio.tailAt > start ? Math.min(seconds, audio.tailAt) : seconds));
    const left = written.length - 1 - matched[lastAt]!;
    let furthest: SplitCut | null = null;
    for (let at = lastAt; at <= Math.min(kept.length - 1, lastAt + left); at++) {
      // Whatever whisper made of a runaway tail is not the block's last word.
      if (at > lastAt && audio.tailAt !== null && words[kept[at]!]!.start >= audio.tailAt) break;
      const end = Math.max(start, endAfter(words[kept[at]!]!.end, audio, seconds));
      if (furthest !== null && end <= furthest.end) continue;
      const candidate = judged(block, start, end);
      if (candidate.matched) return candidate;
      furthest = candidate;
    }
    return furthest!;
  });
  // A request that ran long says so on every cut; when what is kept still runs long, the extra is
  // inside the request rather than at its end, and the block that ran furthest past its own words
  // is held for the author as a split that did not match.
  const texts = blocks.map((block) => block.text);
  if (split.length === 0 || !ranLong(seconds, texts)) return split;
  let worst = -1;
  if (ranLong(split.at(-1)!.end, texts)) {
    const over = split.map((cut, index) => cut.end - cut.start - expectedSpeechSeconds(texts[index]!));
    worst = over.indexOf(Math.max(...over));
  }
  return split.map((cut, index) => ({ ...cut, longTail: true as const, ...(index === worst ? { matched: false } : {}) }));
}
