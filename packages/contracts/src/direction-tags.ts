import { cueStart, isPointCue, normalizeSpeechText, type CadenceCue, type Sound } from "./cadence.js";
import type { Delivery } from "./voice.js";

/**
 * Typed and pasted tags become markers (design turn 181, SPEC-049 R-22). A line pasted from
 * another tool carries its reader's syntax — `[whispers]` for ElevenLabs, `<sigh>` for Gemini,
 * `(laugh)` for Breeze — and every one of them would be spoken as words by a reader that does
 * not read it. So no bracket a person types is ever passed through: a word in this vocabulary,
 * in any reader's spelling, becomes the marker it names at the place it stood, and the brackets
 * go; a square or angle bracket that is not one stays in the words and is named, for the person
 * to make the note or keep as words. Parentheses that are not a marker are prose — a
 * parenthetical is not a mistake — and are left alone without a word.
 */

export type DirectionWord =
  | { kind: "delivery"; delivery: Delivery }
  | { kind: "pause"; length: "short" | "long" }
  | { kind: "breath"; action: "inhale" | "exhale" }
  | { kind: "sound"; sound: Sound }
  | { kind: "emphasis" };

const DELIVERY_WORDS: Record<Delivery, readonly string[]> = {
  measured: ["measured", "calm", "calmly", "evenly", "calm and even", "calm and even, at a steady pace"],
  whispered: ["whispered", "whisper", "whispers", "whispering", "whispered softly"],
  breaking: ["breaking", "voice breaking", "crying", "through tears", "voice breaking, through tears"],
  cold: ["cold", "coldly", "cold and flat", "cold and flat, without warmth"],
  warm: ["warm", "warmly", "warm and gentle"],
  urgent: ["urgent", "urgently", "urgent, fast and pressing"],
};

const SOUND_WORDS: Record<Sound, readonly string[]> = {
  laughs: ["laughs", "laugh", "laughing", "laughter"],
  chuckles: ["chuckles", "chuckle", "chuckling"],
  sighs: ["sighs", "sigh", "sighing"],
  gasps: ["gasps", "gasp", "gasping"],
  sobs: ["sobs", "sob", "sobbing"],
  "clears throat": ["clears throat", "clear throat", "clearing throat", "throat-clearing", "throat clearing", "clears her throat", "clears his throat"],
  coughs: ["coughs", "cough", "coughing"],
  groans: ["groans", "groan", "groaning"],
  yawns: ["yawns", "yawn", "yawning"],
};

const ALIASES: ReadonlyMap<string, DirectionWord> = (() => {
  const map = new Map<string, DirectionWord>();
  for (const [delivery, words] of Object.entries(DELIVERY_WORDS) as Array<[Delivery, readonly string[]]>) {
    for (const word of words) map.set(word, { kind: "delivery", delivery });
  }
  for (const [sound, words] of Object.entries(SOUND_WORDS) as Array<[Sound, readonly string[]]>) {
    for (const word of words) map.set(word, { kind: "sound", sound });
  }
  for (const word of ["pause", "short pause", "brief pause", "beat"]) map.set(word, { kind: "pause", length: "short" });
  for (const word of ["long pause", "longer pause"]) map.set(word, { kind: "pause", length: "long" });
  for (const word of ["inhale", "inhales", "inhales deeply", "breath", "breathes in", "breath in", "breathe in"]) map.set(word, { kind: "breath", action: "inhale" });
  for (const word of ["exhale", "exhales", "breathes out", "breath out", "breathe out"]) map.set(word, { kind: "breath", action: "exhale" });
  map.set("emphasis", { kind: "emphasis" });
  return map;
})();

/** The marker a bracketed word names, in any reader's spelling, or null when it names none. */
export function directionWord(word: string): DirectionWord | null {
  const key = word.trim().toLocaleLowerCase().replace(/\s+/g, " ");
  const known = ALIASES.get(key);
  if (known !== undefined) return known;
  // Eleven Multilingual v2's SSML break, the one tag it reads: a second or more is a long pause.
  const pause = /^break\s+time\s*=\s*"?(\d+(?:\.\d+)?)\s*(ms|s)"?\s*\/?$/.exec(key);
  if (pause !== null) {
    const seconds = Number(pause[1]) / (pause[2] === "ms" ? 1000 : 1);
    return { kind: "pause", length: seconds >= 1 ? "long" : "short" };
  }
  return null;
}

export interface RecognisedDirection {
  /** The words with every recognised tag taken out, whitespace folded (`normalizeSpeechText`). */
  text: string;
  /** The markers the tags named, at their places in `text`, in position order. */
  cues: CadenceCue[];
  /** Square or angle brackets that name no marker, at their places in `text`: kept as words, and named. */
  unknown: Array<{ from: number; to: number; text: string }>;
}

const TAG = /\[([^[\]\n]{1,80})\]|<([^<>\n]{1,80})>|\(([^()\n]{1,80})\)/g;

/**
 * Read the tags out of typed or pasted words (design turn 181): each tag whose word is in the
 * vocabulary becomes its marker at its place and its brackets go, and the brackets that are not
 * a marker are returned, in place, to be named. A point marker sits after the last word before
 * the tag (`Ade.|` for `Ade. [long pause] Not`), or at the start. A delivery runs from the tag to
 * the end of its sentence, or to the next delivery, as the menu's delivery from a caret does
 * (SPEC-047 R-42). `[emphasis]` is the word after it. What would break the plan's rules — the
 * same pause twice at a place, a span across another — is dropped, and at most 40 survive.
 */
export function recogniseDirection(raw: string): RecognisedDirection {
  type Found = { word: DirectionWord; at: number };
  let stripped = "";
  const found: Found[] = [];
  const unknownRaw: Array<{ from: number; to: number }> = [];
  let last = 0;
  for (const match of raw.matchAll(TAG)) {
    const inner = match[1] ?? match[2] ?? match[3] ?? "";
    const word = directionWord(inner);
    const start = match.index ?? 0;
    stripped += raw.slice(last, start);
    if (word !== null) {
      found.push({ word, at: stripped.length });
      // `word[pause]word` keeps its two words apart once the tag is gone.
      const next = start + match[0].length;
      if (stripped !== "" && !/\s$/.test(stripped) && next < raw.length && !/\s/.test(raw[next]!)) stripped += " ";
    } else {
      // A parenthesis that names nothing is prose; the other two are a reader's syntax.
      if (match[3] === undefined) unknownRaw.push({ from: stripped.length, to: stripped.length + match[0].length });
      stripped += match[0];
    }
    last = start + match[0].length;
  }
  stripped += raw.slice(last);
  // Fold whitespace as `normalizeSpeechText` does, keeping a map from each stripped position to
  // its place in the folded text.
  const map: number[] = Array.from({ length: stripped.length + 1 }, () => 0);
  let text = "";
  let pendingSpace = false;
  for (let index = 0; index < stripped.length; index++) {
    const ch = stripped[index]!;
    if (/\s/.test(ch)) {
      map[index] = text.length;
      if (text.length > 0) pendingSpace = true;
      continue;
    }
    if (pendingSpace) {
      text += " ";
      pendingSpace = false;
    }
    map[index] = text.length;
    text += ch;
  }
  map[stripped.length] = text.length;
  text = normalizeSpeechText(text);
  const place = (at: number) => Math.min(text.length, map[at] ?? text.length);
  // A point sits after the last word before it; with no word before, at the start.
  const point = (at: number) => {
    let index = place(at);
    while (index > 0 && text[index - 1] === " ") index--;
    return index;
  };
  const startOfWords = (at: number) => {
    let index = place(at);
    while (index < text.length && text[index] === " ") index++;
    return index;
  };
  const sentenceEnd = (from: number, limit: number) => {
    const rest = text.slice(from, limit);
    const end = /[.!?…]+["'”’)]*(?=\s|$)/.exec(rest);
    let to = end === null ? limit : from + end.index + end[0].length;
    while (to > from && text[to - 1] === " ") to--;
    return to;
  };
  const cues: CadenceCue[] = [];
  const deliveries = found.filter((entry) => entry.word.kind === "delivery");
  for (const entry of found) {
    const word = entry.word;
    if (word.kind === "delivery") {
      const from = startOfWords(entry.at);
      const next = deliveries.find((other) => other.at > entry.at);
      const limit = next === undefined ? text.length : point(next.at);
      const to = sentenceEnd(from, Math.max(from, limit));
      if (to > from) cues.push({ kind: "delivery", span: { from, to, text: text.slice(from, to) }, delivery: word.delivery });
    } else if (word.kind === "emphasis") {
      const from = startOfWords(entry.at);
      const match = /^[\p{L}\p{N}'’-]+/u.exec(text.slice(from));
      if (match !== null) cues.push({ kind: "emphasis", span: { from, to: from + match[0].length, text: match[0] }, level: "strong" });
    } else if (word.kind === "pause") {
      cues.push({ kind: "pause", at: point(entry.at), length: word.length });
    } else if (word.kind === "breath") {
      cues.push({ kind: "breath", at: point(entry.at), action: word.action });
    } else {
      cues.push({ kind: "sound", at: point(entry.at), sound: word.sound });
    }
  }
  const unknown = unknownRaw.map((span) => {
    const from = place(span.from);
    const to = Math.max(from, place(span.to - 1) + 1);
    return { from, to, text: text.slice(from, to) };
  });
  return { text, cues: orderCues(cues).slice(0, 40), unknown };
}

/**
 * Cues in position order with what would break the plan's rules dropped (SPEC-047 R-43): the
 * same point cue twice at one place, two spans of a kind overlapping, an emphasis across a
 * marker's edge. The first placed wins, so merging new cues after old ones keeps the old.
 */
export function orderCues(cues: readonly CadenceCue[]): CadenceCue[] {
  const kept: CadenceCue[] = [];
  const clashes = (cue: CadenceCue): boolean =>
    kept.some((other) => {
      if (isPointCue(cue)) return other.kind === cue.kind && other.at === cue.at && (cue.kind !== "sound" || (other.kind === "sound" && other.sound === cue.sound));
      if (isPointCue(other)) return false;
      const overlaps = cue.span.from < other.span.to && cue.span.to > other.span.from;
      if (!overlaps) return false;
      if (cue.kind === other.kind) return true;
      const [marker, emphasis] = cue.kind === "delivery" ? [cue, other] : [other, cue];
      return emphasis.span.from < marker.span.from || emphasis.span.to > marker.span.to;
    });
  for (const cue of cues) if (!clashes(cue)) kept.push(cue);
  return kept.sort((a, b) => cueStart(a) - cueStart(b));
}

/** The note an unknown bracket would make (`Make it the note`): its words, without the brackets. */
export function bracketNote(bracket: string): string {
  return bracket.replace(/^[[<(]\s*|\s*[\]>)]$/g, "").trim();
}
