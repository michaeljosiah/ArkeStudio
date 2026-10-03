/**
 * Words heard against words written, as an English whisper hears a Nigerian novel (2026-10-03).
 *
 * The grouped split (design turn 185) aligned whisper's words to the blocks' words exactly, and
 * on a chapter of Lagos dialogue that was wrong a quarter of the time: 38 of 169 blocks flagged,
 * nearly every one a name or a Yoruba or Pidgin word heard as English — "Tunde" as "Sunday",
 * "Ade" as "Addy", "Ilesha" as "Elesha", "abeg" as "a big". Worse than the flag, a block whose
 * every word was misheard owned no word at all, so every boundary around it fell on the same
 * pause and it was cut to nothing while its neighbour carried its words: "Ehen," said Tunde.
 * came back empty, twice, and the next block heard "Uh-huh. Saitundi. What?".
 *
 * So a word matches when it is close in spelling or in sound, not only when it is the same, and
 * one word may be heard as two ("Goodnight" as "Good night", "said Tunde" as "Saitundi").
 * Nothing here is an acoustic model: it is how far apart two spellings are, on the letters and on
 * a crude fold of them toward their sound, which is what an ASR's mishearing of an unfamiliar
 * word looks like on the page.
 */

/** Combining accents: Yoruba's tone marks and dots are not in what whisper writes. */
const ACCENTS = /[\u0300-\u036f\u1dc0-\u1dff]/gu;

/** A word as matching compares it: case, accents and punctuation set aside. */
export function matchToken(word: string): string {
  return word.normalize("NFKD").replace(ACCENTS, "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** A number as words, so "Phase 1" is "Phase One": whisper writes digits for what a book spells. */
function numberWords(n: number): string[] {
  if (n < 20) return [ONES[n]!];
  if (n < 100) return [TENS[Math.floor(n / 10)]!, ...(n % 10 === 0 ? [] : [ONES[n % 10]!])];
  if (n < 1000) return [ONES[Math.floor(n / 100)]!, "hundred", ...(n % 100 === 0 ? [] : numberWords(n % 100))];
  if (n < 10_000) return [...numberWords(Math.floor(n / 1000)), "thousand", ...(n % 1000 === 0 ? [] : numberWords(n % 1000))];
  return [String(n)];
}

/** One word's tokens: its matching form, or a number's words (an ordinal's too, its suffix dropped). */
export function wordTokens(word: string): string[] {
  const token = matchToken(word);
  const number = /^(\d+)(?:st|nd|rd|th|s)?$/u.exec(token);
  return number !== null ? numberWords(Number(number[1])) : token === "" ? [] : [token];
}

/** A hyphen or a dash joins words a listener hears apart: "Lekki-Ikoyi", "uh-huh", "pick-top". */
const JOINS = /[\s\u2010-\u2015-]+/u;

/** A text's tokens in order. */
export function textTokens(text: string): string[] {
  return text.split(JOINS).flatMap(wordTokens);
}

/** Each whitespace word's tokens, so a token can be traced to the timed word it came from. */
export function wordsTokens(words: readonly string[]): string[][] {
  return words.map((word) => word.split(JOINS).flatMap(wordTokens));
}

/** Each note's closing mark, and how many words it may run to. */
const CLOSES: Record<string, { close: string; words: number }> = {
  "(": { close: ")", words: 8 },
  "[": { close: "]", words: 8 },
  "<": { close: ">", words: 4 },
  // Asterisks also mark a book's italics — a text message, `*Did you get home safely?*` — so
  // only a short run between them is a note: `*laughs*`, `*clears throat*`.
  "*": { close: "*", words: 3 },
  "♪": { close: "♪", words: 12 },
};

/**
 * Which heard words are whisper's notes rather than speech — `*laughs*`, `[laughs]`, `(speaking
 * in foreign language)`, `<laugh>`, `♪` — a mark opened on one word and closed on that word or
 * one of the next few.
 */
export function annotations(words: readonly string[]): boolean[] {
  const marked = words.map(() => false);
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!.trim();
    const open = word[0];
    if (open === undefined || !(open in CLOSES)) continue;
    const { close, words: most } = CLOSES[open]!;
    for (let j = i; j < Math.min(words.length, i + most); j++) {
      const candidate = words[j]!.trim().replace(/[.,!?;:"'“”‘’]+$/u, "");
      if (candidate.length > (j === i ? 1 : 0) && candidate.endsWith(close)) {
        for (let k = i; k <= j; k++) marked[k] = true;
        i = j;
        break;
      }
    }
  }
  return marked;
}

/** What a listener says to fill or to answer, never a word of the book's unless the book makes a sound there. */
export const FILLERS: ReadonlySet<string> = new Set(["uh", "um", "umm", "uhm", "uhhuh", "mhm", "mmhmm", "mm", "mmm", "hmm", "hm", "huh", "ah", "ahh", "oh", "ohh", "er", "erm", "eh", "haha", "hahaha"]);

/** Two rows for `distance`, kept between calls: an alignment measures hundreds of thousands of pairs. */
let rows = [new Int32Array(64), new Int32Array(64)];

/** Edits from one string to the other (Levenshtein), on two rows. */
function distance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  if (rows[0]!.length <= b.length) rows = [new Int32Array(b.length * 2), new Int32Array(b.length * 2)];
  let previous = rows[0]!;
  let current = rows[1]!;
  for (let j = 0; j <= b.length; j++) previous[j] = j;
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    const code = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const replace = previous[j - 1]! + (code === b.charCodeAt(j - 1) ? 0 : 1);
      const remove = previous[j]! + 1;
      const insert = current[j - 1]! + 1;
      current[j] = replace < remove ? (replace < insert ? replace : insert) : remove < insert ? remove : insert;
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length]!;
}

/** One minus the edits over the longer: 1 is the same string, 0 nothing in common. */
export function stringRatio(a: string, b: string): number {
  const longer = Math.max(a.length, b.length);
  return longer === 0 ? 1 : 1 - distance(a, b) / longer;
}

/**
 * A spelling folded toward its sound: voiced and unvoiced stops together (d/t, b/p, g/k), a c, q
 * or ck as k, ph and v as f, z as s, an h after a consonant dropped, every run of vowels one
 * vowel, and doubled letters single. "goat" and "good" fold alike, as do "Ade", "Addy" and
 * "Adi", and "Ilesha" and "Elesha" — which is the mistake whisper makes.
 */
export function phoneticFold(token: string): string {
  return token
    .replace(/ph/g, "f")
    .replace(/ck/g, "k")
    .replace(/[cq]/g, "k")
    .replace(/x/g, "ks")
    .replace(/z/g, "s")
    .replace(/v/g, "f")
    .replace(/d/g, "t")
    .replace(/b/g, "p")
    .replace(/g/g, "k")
    .replace(/([^aeiouy])h/g, "$1")
    .replace(/[aeiouy]+/g, "a")
    .replace(/(.)\1+/g, "$1");
}

/**
 * How alike two tokens are: their letters, or their letters and their sound together, whichever
 * is closer. The sound alone is too coarse for short words — "both" and "dead" fold to "pat" and
 * "tat" — so it only ever lifts a pair half way toward its fold's likeness.
 */
export function tokenSimilarity(a: string, b: string): number {
  return a === b ? 1 : similarityOf(a, b, phoneticFold(a), phoneticFold(b));
}

function similarityOf(a: string, b: string, foldA: string, foldB: string): number {
  const letters = stringRatio(a, b);
  return Math.max(letters, (letters + stringRatio(foldA, foldB)) / 2);
}

/** A word heard as another this close is a mishearing of it; a name or a word not in English (`loose`) is allowed more. */
export const SIMILAR = 0.5;
export const SIMILAR_LOOSE = 0.34;

/** Two letters or fewer are matched only exactly, unless the written word is a name: "a" is not "I". */
function accepts(written: string, heard: string, loose: boolean, similarity: number): boolean {
  if (written === heard) return true;
  if (!loose && Math.min(written.length, heard.length) <= 2) return false;
  return similarity >= (loose ? SIMILAR_LOOSE : SIMILAR);
}

/** The letters of a run of tokens against another's, as one string each: how a split or a joined word is judged. */
export function runSimilarity(written: readonly string[], heard: readonly string[]): number {
  return tokenSimilarity(written.join(""), heard.join(""));
}

/** One written word, or two, heard as one or two. */
export interface WordMatch {
  /** The first written token. */
  w: number;
  wn: 1 | 2;
  /** The first heard token. */
  h: number;
  hn: 1 | 2;
  similarity: number;
}

export interface AlignOptions {
  /** A written token whose mishearing is expected (a name, a word not in English). */
  loose?: (written: number) => boolean;
  /** Whether two written tokens may be heard as one: never across a block's edge. */
  joinable?: (written: number) => boolean;
  /** A heard token that matches nothing (a note of whisper's). */
  blank?: (heard: number) => boolean;
}

/** A token's letters counted into 32 bins: equal letters share a bin, so shared counts never undercount. */
function letterCounts(token: string): Uint8Array {
  const bins = new Uint8Array(32);
  for (let at = 0; at < token.length; at++) {
    const bin = token.charCodeAt(at) & 31;
    bins[bin] = bins[bin]! + 1;
  }
  return bins;
}

function shared(a: Uint8Array, b: Uint8Array): number {
  let sum = 0;
  for (let bin = 0; bin < 32; bin++) sum += a[bin]! < b[bin]! ? a[bin]! : b[bin]!;
  return sum;
}

/** Past this the table is not built and nothing is aligned: a request is about 800 words. */
const ALIGN_CELLS = 6_000_000;

/**
 * Heard tokens matched to written ones in order: the matching that covers the most words, an
 * exact match counting for more than a near one, so the words heard right anchor the rest. A
 * written word may be heard as two, or two as one, when their letters together are close.
 */
export function alignWords(written: readonly string[], heard: readonly string[], options: AlignOptions = {}): WordMatch[] {
  const n = written.length;
  const m = heard.length;
  if (n === 0 || m === 0 || (n + 1) * (m + 1) > ALIGN_CELLS) return [];
  const loose = (i: number) => options.loose?.(i) === true;
  const joinable = (i: number) => i + 1 < n && options.joinable?.(i) !== false;
  const blank = (j: number) => options.blank?.(j) === true;
  // A request is some 800 words a side and the table some 600,000 cells, each trying a word and
  // two joins: every token and join is interned once a side, so a cell compares numbers, and each
  // pair is measured once — or not at all when the letters the two share keep it under the
  // loosest threshold: no spelling is closer than its shared letters over the longer allow.
  const side = () => {
    const ids = new Map<string, number>();
    const strings: string[] = [];
    const folded: string[] = [];
    const counts: Uint8Array[] = [];
    const foldCounts: Uint8Array[] = [];
    const intern = (token: string) => {
      let id = ids.get(token);
      if (id === undefined) {
        id = strings.length;
        ids.set(token, id);
        strings.push(token);
        folded.push(phoneticFold(token));
        counts.push(letterCounts(token));
        foldCounts.push(letterCounts(folded[id]!));
      }
      return id;
    };
    return { strings, folded, counts, foldCounts, intern };
  };
  const ws = side();
  const hs = side();
  const w = written.map((token) => ws.intern(token));
  const h = heard.map((token) => hs.intern(token));
  const wJoined = written.map((token, i) => (joinable(i) ? ws.intern(token + written[i + 1]!) : -1));
  const hJoined = heard.map((token, j) => (j + 1 < m && !blank(j + 1) ? hs.intern(token + heard[j + 1]!) : -1));
  const across = hs.strings.length;
  const dense = ws.strings.length * across <= 4_000_000 ? new Float32Array(ws.strings.length * across).fill(-1) : null;
  const sparse = new Map<number, number>();
  const similarity = (a: number, b: number) => {
    const key = a * across + b;
    let value = dense !== null ? dense[key]! : sparse.get(key) ?? -1;
    if (value < 0) {
      const textA = ws.strings[a]!;
      const textB = hs.strings[b]!;
      if (textA === textB) value = 1;
      else {
        const foldA = ws.folded[a]!;
        const foldB = hs.folded[b]!;
        const letters = shared(ws.counts[a]!, hs.counts[b]!) / Math.max(textA.length, textB.length);
        const sound = shared(ws.foldCounts[a]!, hs.foldCounts[b]!) / Math.max(1, foldA.length, foldB.length);
        value = Math.max(letters, (letters + sound) / 2) < SIMILAR_LOOSE ? 0 : similarityOf(textA, textB, foldA, foldB);
      }
      if (dense !== null) dense[key] = value;
      else sparse.set(key, value);
    }
    return value;
  };
  // A match's worth: an exact word 1, a near one less, so the words heard right anchor the near
  // ones; two words heard as one a tenth more than one of them, never more than an exact word
  // beside one left over ("glass" heard as "is glass" is "glass", and "is" is another word).
  const worth = (a: number, b: number, isLoose: boolean, joined: boolean): number | null => {
    const bonus = joined ? 0.1 : 0;
    // A short word matches only itself unless it is a name (`accepts`): no need to measure it.
    if (!isLoose && (ws.strings[a]!.length <= 2 || hs.strings[b]!.length <= 2)) return ws.strings[a] === hs.strings[b] ? 1 + bonus : null;
    const s = similarity(a, b);
    if (s === 1) return 1 + bonus;
    return s > 0 && accepts(ws.strings[a]!, hs.strings[b]!, isLoose, s) ? 0.4 + 0.5 * s + bonus : null;
  };
  const width = m + 1;
  const best = new Float64Array((n + 1) * width);
  // 0 skip written, 1 skip heard, 2 one to one, 3 two written as one heard, 4 one written as two heard.
  const choice = new Uint8Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    const isLoose = loose(i);
    const pairLoose = wJoined[i]! >= 0 && (isLoose || loose(i + 1));
    for (let j = m - 1; j >= 0; j--) {
      let value = best[(i + 1) * width + j]!;
      let pick = 0;
      if (best[i * width + j + 1]! > value) {
        value = best[i * width + j + 1]!;
        pick = 1;
      }
      if (!blank(j)) {
        const one = worth(w[i]!, h[j]!, isLoose, false);
        if (one !== null && one + best[(i + 1) * width + j + 1]! > value) {
          value = one + best[(i + 1) * width + j + 1]!;
          pick = 2;
        }
        if (wJoined[i]! >= 0) {
          const two = worth(wJoined[i]!, h[j]!, pairLoose, true);
          if (two !== null && two + best[(i + 2) * width + j + 1]! > value) {
            value = two + best[(i + 2) * width + j + 1]!;
            pick = 3;
          }
        }
        if (hJoined[j]! >= 0) {
          const split = worth(w[i]!, hJoined[j]!, isLoose, true);
          if (split !== null && split + best[(i + 1) * width + j + 2]! > value) {
            value = split + best[(i + 1) * width + j + 2]!;
            pick = 4;
          }
        }
      }
      best[i * width + j] = value;
      choice[i * width + j] = pick;
    }
  }
  const matches: WordMatch[] = [];
  for (let i = 0, j = 0; i < n && j < m;) {
    const pick = choice[i * width + j]!;
    if (pick === 0) i += 1;
    else if (pick === 1) j += 1;
    else if (pick === 2) {
      matches.push({ w: i, wn: 1, h: j, hn: 1, similarity: similarity(w[i]!, h[j]!) });
      i += 1;
      j += 1;
    } else if (pick === 3) {
      matches.push({ w: i, wn: 2, h: j, hn: 1, similarity: similarity(wJoined[i]!, h[j]!) });
      i += 2;
      j += 1;
    } else {
      matches.push({ w: i, wn: 1, h: j, hn: 2, similarity: similarity(w[i]!, hJoined[j]!) });
      i += 1;
      j += 2;
    }
  }
  return matches;
}
