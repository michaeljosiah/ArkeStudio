import { expectedSpeechSeconds, SPEECH_TOKEN_ESTIMATE, type AudioTranscriptComparison } from "@arke-studio/contracts";
import { runawayTailAt, speechPauses, TAIL_KEEP_SEC, type SpeechPcm } from "../audio/speech-wav.js";
import { alignWords, annotations, FILLERS, runSimilarity, SIMILAR, SIMILAR_LOOSE, textTokens, tokenSimilarity, wordsTokens } from "../audio/heard-match.js";
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

const tokens = textTokens;

/**
 * What the split knows of a block's words beyond them (2026-10-03): the blocks either side,
 * whose words in this cut say it is in the wrong place; the chapter's names and the words not in
 * English, which whisper is expected to mishear; and whether the block's direction makes a sound,
 * which whisper writes as "uh-huh" or "ah".
 */
export interface SplitContext {
  before?: string;
  after?: string;
  /** Matching tokens (`splitLexicon`). */
  lexicon?: ReadonlySet<string>;
  sounds?: boolean;
}

/**
 * The words whisper is expected to mishear (2026-10-03): the world's names — every sheet's, and
 * the chapter cast's speakers — and every word capitalised inside a sentence of the chapter,
 * which is a name or a place ("Victoria Island", "Ilesha", "Lekki"). A word in the lexicon is
 * matched more loosely and counts for less when it is missing, never for nothing.
 */
export function splitLexicon(names: Iterable<string>, texts: Iterable<string>): Set<string> {
  const lexicon = new Set<string>();
  const add = (word: string) => {
    for (const token of textTokens(word)) if (token.length >= 2 && !NAME_FILLER.has(token)) lexicon.add(token);
  };
  for (const name of names) add(name);
  for (const text of texts) {
    const words = text.split(/\s+/u).filter((word) => word !== "");
    words.forEach((word, at) => {
      // A sentence's first word, a quotation's or a text message's is capitalised whatever it is.
      if (at === 0 || /[.!?:;·—–]$/u.test(words[at - 1]!.replace(/["'“”‘’)*_]+$/u, ""))) return;
      if (/^["'“‘(*_]/u.test(word)) return;
      // "I" and "I'm" are capitalised everywhere and are nobody's name.
      if (/^I(?:['’]|$)/u.test(word)) return;
      if (/^\p{Lu}\p{Ll}/u.test(word)) add(word);
    });
  }
  return lexicon;
}

/** The small words of a place's name ("The Sister's Bungalow, Ibadan"), which are not what whisper mishears. */
const NAME_FILLER: ReadonlySet<string> = new Set(["the", "of", "and", "in", "on", "at", "to", "by", "de", "la", "le", "von", "van"]);

/** A heard token, or a note of whisper's (`*laughs*`, `(speaking in foreign language)`) as one blank. */
interface HeardToken {
  token: string;
  blank: boolean;
}

/**
 * A written word whisper writes as a filler: a filler itself, or an interjection of vowels, h and
 * n — "Ehn", "Ehen", "Ahah" — which an English whisper hears as "Eh" or "Ah".
 */
const interjection = (token: string) => FILLERS.has(token) || /^[aeiou][aeiouhn]*h[aeiouhn]*$/u.test(token);

/**
 * A block whose direction makes a sound has the fillers heard set aside, unless its own words
 * carry an interjection: "Ehn-ehn. The goat was in the boot" heard as "Eh, eh. The goat..." is
 * its words, and with the fillers dropped it read as its first words missing (2026-10-05).
 */
function heardTokens(heard: string, sounds: boolean, want: readonly string[]): HeardToken[] {
  const words = heard.split(/\s+/u).filter((word) => word !== "");
  const notes = annotations(words);
  const drop = sounds && !want.some(interjection);
  const out: HeardToken[] = [];
  wordsTokens(words).forEach((spoken, at) => {
    if (notes[at]) {
      if (at === 0 || !notes[at - 1]) out.push({ token: "", blank: true });
      return;
    }
    for (const token of spoken) if (!(drop && FILLERS.has(token))) out.push({ token, blank: false });
  });
  return out;
}

/**
 * What a written word left unheard weighs: a name a quarter, since whisper may have written it as
 * nothing at all; a short word a half, since whisper drops "so" and "and" where it breaks a
 * sentence; any other word a whole one.
 */
const missingWeight = (token: string, lexicon: ReadonlySet<string>) => (lexicon.has(token) ? 0.25 : token.length <= 3 ? 0.5 : 1);

/** A word that turns a line to its opposite, as a matching token: "not", "never", "didn't". */
const NEGATIONS: ReadonlySet<string> = new Set(["not", "no", "never", "nor", "neither", "none", "nothing", "nobody", "nowhere", "cannot"]);
const negates = (token: string) => NEGATIONS.has(token) || /^(?:do|does|did|is|are|was|were|has|have|had|ca|can|wo|could|would|should|must|need|ai)nt$/u.test(token);

/** How close a cut's edge must read to its neighbour's words — a name's more loosely — to be taken for them. */
const NEIGHBOUR = 0.6;
const NEIGHBOUR_LOOSE = 0.4;

/**
 * Whether a cut's edge carries the block beside it (2026-10-03): the first heard words (or the
 * last) read, letter for letter, as the block before's last words (or the block after's first)
 * — "Good night, Tundi." opening the cut of "Goodnight, palm tree." after "Goodnight, Tunde.";
 * "He's sad." closing the cut of "Sit, if you are going to stand there." before "He sat." —
 * and this block's words are heard as well without them. "Sunday" may read as a neighbour's
 * word, but it is this block's "Tunde", and taking it away loses it. This is what a cut in the
 * wrong place looks like, and it is a mismatch however well the rest of the words were heard.
 */
function carriesNeighbour(want: readonly string[], said: readonly string[], neighbour: readonly string[], lexicon: ReadonlySet<string>, side: "start" | "end"): boolean {
  if (neighbour.length === 0 || want.length === 0) return false;
  const coverage = (heard: readonly string[]) => alignWords(want, heard, { loose: (at) => lexicon.has(want[at]!) }).reduce((sum, match) => sum + match.wn * match.similarity, 0);
  let full: number | undefined;
  for (let length = 1; length <= Math.min(6, said.length - 1); length++) {
    const edge = side === "start" ? said.slice(0, length) : said.slice(said.length - length);
    if (edge.join("").length < 3) continue;
    // The edge read against the neighbour's edge words and against this block's own, each at its
    // closest: it is the neighbour's when it reads as them, and plainly better than as its own.
    const closest = (words: readonly string[], fromEnd: boolean) => {
      let best = { similarity: 0, loose: false };
      for (let count = 1; count <= Math.min(words.length, length + 1); count++) {
        const near = fromEnd ? words.slice(words.length - count) : words.slice(0, count);
        const similarity = runSimilarity(near, edge);
        if (similarity > best.similarity) best = { similarity, loose: near.some((token) => lexicon.has(token)) };
      }
      return best;
    };
    const theirs = closest(neighbour, side === "start");
    const mine = closest(want, side === "end");
    if (theirs.similarity < (theirs.loose ? NEIGHBOUR_LOOSE : NEIGHBOUR) || theirs.similarity < mine.similarity + 0.1) continue;
    full ??= coverage(said);
    if (coverage(side === "start" ? said.slice(length) : said.slice(0, said.length - length)) >= full - 0.25) return true;
  }
  return false;
}

/** The whole block letter by letter at or past this reads as its words, whatever the word rule says. */
export const SPLIT_LETTERS_MATCH = 0.75;

/**
 * Whether the words heard in a cut are its block's (2026-10-03), as an English whisper hears a
 * book full of Nigerian names, Yoruba and Pidgin.
 *
 * The words are aligned by `alignWords` — near spellings and near sounds match, one word may be
 * heard as two — and what lies between the words heard exactly is read run by run. A run of
 * written words heard as other words is a mishearing when the two runs' letters are close
 * ("Adeyemi Akinola, abeg" as "a te yemi aki no la, a big"), or when whisper wrote a note in
 * their place. What a wrong cut looks
 * like is kept as a mismatch whatever else passes: a word missing (a name weighs a quarter, a
 * short word a half, so a whole one is a content word or two short ones) — at the edge, the cut
 * is early or late; inside, the reader skipped it — or the cut's edge carrying the words of the
 * block beside it. Short of that, the block passes when what was misheard costs no more than one
 * word in eight, or when the whole block, letter by letter, is close to its words.
 */
export function heardAsWritten(written: string, heard: string, context: SplitContext = {}): boolean {
  const lexicon = context.lexicon ?? new Set<string>();
  const want = tokens(written);
  const got = heardTokens(heard, context.sounds === true, want);
  const said = got.filter((token) => !token.blank).map((token) => token.token);
  if (want.length === 0) return said.length === 0;
  // Nothing heard but a note: a block wholly of names or Yoruba heard as "(speaking in foreign language)".
  if (said.length === 0) return got.length > 0 && want.every((token) => lexicon.has(token));
  if (context.before !== undefined && carriesNeighbour(want, said, tokens(context.before), lexicon, "start")) return false;
  if (context.after !== undefined && carriesNeighbour(want, said, tokens(context.after), lexicon, "end")) return false;
  // The runs lie between the words heard exactly: where the near matches fell inside a run of
  // mishearings is the aligner's guess ("glass" took "is glass", leaving "up his" unheard), and
  // the run's letters as a whole are the better witness.
  const anchors = alignWords(want, got.map((token) => token.token), { loose: (at) => lexicon.has(want[at]!), blank: (at) => got[at]!.blank }).filter((match) => match.similarity === 1);
  let cost = 0;
  let w = 0;
  let h = 0;
  for (const match of [...anchors, { w: want.length, wn: 0, h: got.length, hn: 0 }]) {
    if (match.w > w || match.h > h) {
      const runWritten = want.slice(w, match.w);
      const runSaid = got.slice(h, match.h).filter((token) => !token.blank).map((token) => token.token);
      const note = got.slice(h, match.h).some((token) => token.blank);
      const missing = runWritten.reduce((sum, token) => sum + missingWeight(token, lexicon), 0);
      // Whisper's note stands for a few words only where they are a name or a word not in
      // English it would not write ("(speaking in foreign language)" for "Then Ikoyi"), and even
      // then the English words beside it are charged; a note in place of "took all the money"
      // is those words left out (codex on PR 1515).
      const noted = note && runSaid.length === 0 && runWritten.length <= 4 && runWritten.some((token) => lexicon.has(token));
      // A negation left out or put in reverses the line: never a discount (codex on PR 1515).
      if ((runSaid.length === 0 && runWritten.some(negates)) || (runWritten.length === 0 && runSaid.some(negates))) return false;
      if (runWritten.length > 0 && runSaid.length === 0 && !noted) {
        if (missing >= 1) return false;
        cost += missing;
      } else if (runWritten.length === 0) {
        cost += 0.25 * runSaid.length;
      } else if (runSaid.length === 0) {
        cost += runWritten.filter((token) => !lexicon.has(token)).reduce((sum, token) => sum + missingWeight(token, lexicon), 0);
      } else {
        const loose = runWritten.some((token) => lexicon.has(token));
        if (runSimilarity(runWritten, runSaid) < (loose ? SIMILAR_LOOSE : SIMILAR)) cost += Math.max(missing, 0.5 * runSaid.length);
      }
    }
    w = match.w + match.wn;
    h = match.h + match.hn;
  }
  if (cost <= Math.max(1, want.length / 8)) return true;
  return tokenSimilarity(want.join(""), said.join("")) >= SPLIT_LETTERS_MATCH;
}

/**
 * Whether a cut is its block (design turn 185c, amended 2026-10-03): the transcript check's exact
 * comparison is kept as the record of what differs, and the cut matches when it is exact or when
 * `heardAsWritten` reads the difference as whisper mishearing rather than a cut in the wrong place.
 */
export function judgeSplit(written: string, heard: string, audioHash: string, context: SplitContext = {}): { matched: boolean; comparison: AudioTranscriptComparison } {
  const comparison = compareAudioTranscript({ audioHash, authoredText: tokens(written).join(" "), observedText: tokens(heard).join(" "), transcriber: { id: "voxa-whisper", version: "runtime-unreported" } });
  if (comparison.status !== "compared") return { matched: false, comparison };
  if (comparison.result === "exact") return { matched: true, comparison };
  return { matched: heardAsWritten(written, heard, context), comparison };
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

/**
 * Heard words left between two that matched — a name heard as some other word — given to the
 * blocks whose words lie between (2026-10-03). Without this a block whose every word was misheard
 * owned no heard word, every boundary around it found the same last and first words and fell in
 * the same pause, and it was cut to nothing while its neighbour carried its words: "Ehen," and
 * "said Tunde." came back empty and the next block heard "Uh-huh. Saitundi. What?". Each boundary
 * a run spans is put in the run's widest pause, near where the written characters put it: a turn
 * ends at a pause, and inside a stretch the words have no pause between them to choose.
 */
function fillUnmatched(
  strong: readonly number[],
  from: readonly number[],
  to: readonly number[],
  owner: readonly number[],
  written: readonly string[],
  timeOf: (position: number) => TimedWord,
  seconds: number,
): number[] {
  const blockOf = [...strong];
  const anchors = strong.map((_, at) => at).filter((at) => strong[at]! >= 0);
  for (let a = -1; a < anchors.length; a++) {
    const p = a >= 0 ? anchors[a]! : -1;
    const q = a + 1 < anchors.length ? anchors[a + 1]! : strong.length;
    const n = q - p - 1;
    if (n <= 0) continue;
    const wFrom = p >= 0 ? to[p]! + 1 : 0;
    const wTo = q < strong.length ? from[q]! - 1 : written.length - 1;
    // Nothing written between: what was heard there was added, and the boundary rule places it.
    if (wFrom > wTo) continue;
    const left = p >= 0 ? owner[to[p]!]! : owner[wFrom]!;
    const right = q < strong.length ? owner[from[q]!]! : owner[wTo]!;
    if (left === right) {
      for (let at = p + 1; at < q; at++) blockOf[at] = left;
      continue;
    }
    // Every word written between is one side's: the other side's edge word was heard, so what was
    // heard between is this side's, wherever the reader paused. "Ehn-ehn." opening Tunde's line,
    // heard as "Mm-hmm." with a longer pause after it than before, went to Ade's "...in the boot,
    // Tunde." by the widest pause, and Ade's cut ended on Tunde's first words (2026-10-05).
    const sides = new Set(owner.slice(wFrom, wTo + 1));
    if (sides.size === 1 && (sides.has(left) || sides.has(right))) {
      for (let at = p + 1; at < q; at++) blockOf[at] = sides.has(left) ? left : right;
      continue;
    }
    // Gap g sits before the run's word g; gap n after its last.
    const gap = (g: number) => {
      const end = p + g >= 0 ? timeOf(p + g).end : 0;
      const start = p + g + 1 < strong.length ? timeOf(p + g + 1).start : seconds;
      return start - end;
    };
    let total = 0;
    for (let w = wFrom; w <= wTo; w++) total += written[w]!.length;
    const boundaries = right - left;
    const expected = Array.from({ length: boundaries }, (_, t) => {
      let before = 0;
      for (let w = wFrom; w <= wTo; w++) if (owner[w]! <= left + t) before += written[w]!.length;
      return (n * before) / Math.max(1, total);
    });
    // A block with no word of its own matched keeps one of the run's where the run has enough:
    // the edge gaps are the pause to an anchor, or the request's own lead-in or tail when there is
    // no anchor that side, and that silence must not take a block's only word (codex on PR 1515).
    let low = p < 0 ? 1 : 0;
    let high = q >= strong.length ? n - 1 : n;
    if (high - low + 1 < boundaries) {
      low = 0;
      high = n;
    }
    const strict = boundaries <= high - low + 1;
    // A pause wins over closeness to the characters' estimate unless it is a few words further.
    const score = (t: number, g: number) => (g < low || g > high ? -Infinity : gap(g) - 0.04 * Math.abs(g - expected[t]!));
    const value: number[][] = [];
    const back: number[][] = [];
    for (let t = 0; t < boundaries; t++) {
      value.push([]);
      back.push([]);
      for (let g = 0; g <= n; g++) {
        if (t === 0) {
          value[t]![g] = score(t, g);
          back[t]![g] = -1;
          continue;
        }
        let best = -Infinity;
        let at = -1;
        for (let prior = 0; prior <= (strict ? g - 1 : g); prior++) {
          if (value[t - 1]![prior]! > best) {
            best = value[t - 1]![prior]!;
            at = prior;
          }
        }
        value[t]![g] = at < 0 ? -Infinity : best + score(t, g);
        back[t]![g] = at;
      }
    }
    let g = low;
    for (let candidate = low + 1; candidate <= high; candidate++) if (value[boundaries - 1]![candidate]! > value[boundaries - 1]![g]!) g = candidate;
    const placed: number[] = [];
    for (let t = boundaries - 1; t >= 0; t--) {
      placed.unshift(g);
      g = back[t]![g]!;
    }
    for (let k = 0; k < n; k++) blockOf[p + 1 + k] = left + placed.filter((at) => at <= k).length;
  }
  return blockOf;
}

export function splitRequest(
  blocks: ReadonlyArray<{ key: string; text: string; sounds?: boolean }>,
  words: readonly TimedWord[],
  seconds: number,
  hashOf: (start: number, end: number) => string,
  audio?: SplitAudio,
  lexicon: ReadonlySet<string> = new Set(),
): SplitCut[] {
  const written: string[] = [];
  const owner: number[] = [];
  blocks.forEach((block, index) => {
    for (const token of tokens(block.text)) {
      written.push(token);
      owner.push(index);
    }
  });
  // The heard words that are speech — not whisper's notes, not empty — and their tokens, each
  // traced to the word it came from.
  const notes = annotations(words.map((word) => word.text));
  const spoken = wordsTokens(words.map((word) => word.text));
  const kept = words.map((_, at) => at).filter((at) => !notes[at] && spoken[at]!.length > 0);
  const heard: string[] = [];
  const wordOf: number[] = [];
  kept.forEach((at, position) => {
    for (const token of spoken[at]!) {
      heard.push(token);
      wordOf.push(position);
    }
  });
  // Matched as the cut is judged (2026-10-03): a name misheard must not move a boundary.
  const matches = alignWords(written, heard, { loose: (at) => lexicon.has(written[at]!), joinable: (at) => owner[at] === owner[at + 1] });
  // Each kept word's written words, where any of its tokens matched: the first and the last.
  const from = kept.map(() => -1);
  const to = kept.map(() => -1);
  for (const match of matches) {
    for (let h = match.h; h < match.h + match.hn; h++) {
      const position = wordOf[h]!;
      if (from[position] === -1) from[position] = match.w;
      to[position] = match.w + match.wn - 1;
    }
  }
  const strong = kept.map((_, position) => (from[position]! >= 0 ? owner[from[position]!]! : -1));
  // Each heard word's block: the one it matched, else the one its place gives it.
  const blockOf = fillUnmatched(strong, from, to, owner, written, (position) => words[kept[position]!]!, seconds);
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
      const gapStart = words[kept[best]!]!.end;
      const gapEnd = words[kept[best + 1]!]!.start;
      // Sound between the two words is a stretch whisper heard as nothing. Its middle may be that
      // sound, so the cut goes in one of the gap's pauses: the first when the next block's opening
      // words went unheard and this block's last was heard — it is the next block's "Ehn-ehn.",
      // which the gap's middle left on the end of Ade's cut (2026-10-05) — the last in the
      // opposite case, else the widest.
      const pauses = (audio?.pauses ?? []).map((pause) => ({ start: Math.max(pause.start, gapStart), end: Math.min(pause.end, gapEnd) })).filter((pause) => pause.end > pause.start);
      if (pauses.length > 1) {
        const opening = owner.findIndex((block) => block > boundary);
        const headUnheard = from[first]! > opening;
        const tailUnheard = to[last]! >= 0 && to[last]! < opening - 1;
        let pause = pauses.reduce((wide, candidate) => (candidate.end - candidate.start > wide.end - wide.start ? candidate : wide));
        if (headUnheard && !tailUnheard) pause = pauses[0]!;
        else if (tailUnheard && !headUnheard) pause = pauses.at(-1)!;
        cuts.push(Math.max(floor, (pause.start + pause.end) / 2));
        continue;
      }
      cuts.push(Math.max(floor, (gapStart + gapEnd) / 2));
      continue;
    }
    // Nothing heard to place it by: where the written characters put it, between the cuts known.
    const before = blocks.slice(0, boundary + 1).reduce((sum, block) => sum + block.text.length, 0);
    const total = blocks.reduce((sum, block) => sum + block.text.length, 0);
    cuts.push(Math.max(floor, (seconds * before) / Math.max(1, total)));
  }
  const judged = (index: number, start: number, end: number): SplitCut => {
    const block = blocks[index]!;
    const inside = words.filter((word) => (word.start + word.end) / 2 >= start && (word.start + word.end) / 2 < end).map((word) => word.text).join(" ");
    const context: SplitContext = {
      lexicon,
      ...(index > 0 ? { before: blocks[index - 1]!.text } : {}),
      ...(index + 1 < blocks.length ? { after: blocks[index + 1]!.text } : {}),
      ...(block.sounds === true ? { sounds: true } : {}),
    };
    const judgement = end > start ? judgeSplit(block.text, inside, hashOf(start, end), context) : { matched: false, comparison: compareAudioTranscript({ audioHash: hashOf(start, start), authoredText: block.text, observedText: "", transcriber: { id: "voxa-whisper", version: "runtime-unreported" } }) };
    return { key: block.key, start, end, heard: inside, matched: judgement.matched && end > start, comparison: judgement.comparison };
  };
  const reached = Math.max(-1, ...to);
  const split = blocks.map((_, index) => {
    const start = index === 0 ? 0 : cuts[index - 1]!;
    if (index < blocks.length - 1) return judged(index, start, cuts[index]!);
    if (audio === undefined) return judged(index, start, seconds);
    // The last block ends after its last word heard, not at the end of the audio. A written word
    // after that one may have been heard as something else, so the heard words after it are tried
    // too — as many as there are written words left — and the first end whose words match is
    // kept, else the furthest: a cut is never shortened past what might be its own last word.
    // That last word is one that matched where one did: a word given to the block by its place
    // may be whatever whisper made of a runaway tail.
    let lastAt = -1;
    strong.forEach((owned, at) => {
      if (owned === index) lastAt = at;
    });
    if (lastAt < 0) {
      blockOf.forEach((owned, at) => {
        if (owned === index && (audio.tailAt === null || words[kept[at]!]!.start < audio.tailAt)) lastAt = at;
      });
    }
    if (lastAt < 0) return judged(index, start, Math.max(start, audio.tailAt !== null && audio.tailAt > start ? Math.min(seconds, audio.tailAt) : seconds));
    const left = written.length - 1 - (to[lastAt]! >= 0 ? to[lastAt]! : reached);
    let furthest: SplitCut | null = null;
    for (let at = lastAt; at <= Math.min(kept.length - 1, lastAt + left); at++) {
      // Whatever whisper made of a runaway tail is not the block's last word.
      if (at > lastAt && audio.tailAt !== null && words[kept[at]!]!.start >= audio.tailAt) break;
      const end = Math.max(start, endAfter(words[kept[at]!]!.end, audio, seconds));
      if (furthest !== null && end <= furthest.end) continue;
      const candidate = judged(index, start, end);
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
