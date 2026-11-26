import { alike, heardBySound, matchedHeard, spokenWords, type HeardWord } from "../takes/checks.js";

/*
 * A finished film's words against the lines it was cut to say (2026-11-26).
 *
 * Gold on Gold's scene was shown to the owner with three lines playing over other shots while
 * their own shots' mouths moved in silence, with words a take had invented between two lines,
 * and with twenty-four of the book's lines never filmed. Each take had passed alone: a line is
 * right in its take and wrong in the film when the mix puts it somewhere else. What finds that is
 * reading the whole film once and setting it beside the script in the script's order: every line
 * heard, where, and nothing heard that nobody wrote.
 *
 * It is the take's own comparison (`judgeWords`) stretched over a film: the longest run of the
 * script's words in what was heard, then the words the recogniser spelled its own way found by
 * sound, each for itself. A line is then as written, heard by sound, partly heard or not heard,
 * with the time its words were heard at; a line not heard where the script has it but alike to
 * words heard elsewhere is out of place; and sure words that are no line's are a voice nobody
 * wrote. Words heard where a line's own words are missing stand in for them, as they do in a
 * take: the line says it was only partly heard, and they are not counted twice.
 */

export interface FilmLine {
  /** What the finding calls the line: its number in the scene's script. */
  number: number;
  /** The shot the line belongs to, by its number in the cut, when the cut says. */
  shot: number | null;
  /**
   * Every shot of the cut that shows the line's own story shot, `shot` first, when there is more
   * than one. A clip split round an insert is two shots of the cut and one line: counted for each,
   * a line said once read as said and then not heard (codex on PR 3333).
   */
  shots?: number[];
  text: string;
}

export interface FilmLineHeard {
  number: number;
  shot: number | null;
  said: "as-written" | "by-sound" | "partly" | "not-heard";
  /**
   * When its first heard word starts and where its last one is, as written or by sound; null when
   * none was heard with a time. The last word is placed at its middle when the reader measured its
   * end: a word that begins a fifth of a second before its own shot is still said under it, and a
   * read's last word can be given an end later than its own (codex on PR 3333).
   */
  startSec: number | null;
  endSec: number | null;
  /** How many words the line has, and how many of them were heard, as written or by sound. */
  words: number;
  heardWords: number;
  /** The line's words that were not heard, in order. */
  missing: string[];
  /** Those of them that are cast names: nothing like the name was heard. */
  unclearNames: string[];
}

export interface FilmWords {
  lines: FilmLineHeard[];
  /** Sure words that are no line's, where they were heard. */
  unwritten: Array<{ atSec: number | null; text: string }>;
  /** Lines not heard where the script has them, but heard elsewhere. */
  misplaced: Array<{ number: number; atSec: number | null }>;
}

/** A word the recogniser is this sure of is a voice; one word alone has to be surer (as the take's check holds). */
const SURE = .5, SURE_ALONE = .8;
/** One word alone is words nobody wrote only at this many letters: a lone "I" or "a" between two lines is the recogniser, not a voice. */
const LONE_WORD_LETTERS = 3;
/** A line under this share of its words heard was not heard; at it or over, short of a line partly heard, it was barely heard and is worth a listen. */
const BARELY = .25;
/** This many lines in a row with nothing heard are said once: a film of part of a scene leaves the rest of its script unheard. */
const UNHEARD_RUN = 3;
/** Words this far apart are not one run of speech. */
const RUN_GAP_SEC = 1.5;
/** A line not heard in its place is the run heard elsewhere when their letters are this alike. */
const SAME_LINE = .6;
/** The script's words by what was heard is this many cells of comparison at most: a quarter hour of talk, not a feature. */
const MOST_CELLS = 24_000_000;

const milli = (seconds: number) => Math.round(seconds * 1000) / 1000;

/** Null when the film and the script are together too long to set side by side in one read; name a shorter window. */
export function filmWordsAgainstScript(lines: readonly FilmLine[], heard: readonly HeardWord[], names: ReadonlySet<string> = new Set()): FilmWords | null {
  const script = lines.flatMap((line, at) => spokenWords(line.text).map((text) => ({ text, at })));
  const spoken = heard.flatMap((word) => spokenWords(word.text).map((text) => ({ text, startSec: word.startSec, endSec: word.endSec ?? null, probability: word.probability })));
  if ((script.length + 1) * (spoken.length + 1) > MOST_CELLS) return null;
  const scriptTexts = script.map((word) => word.text), heardTexts = spoken.map((word) => word.text);
  const used = matchedHeard(scriptTexts, heardTexts), sound = heardBySound(scriptTexts, heardTexts, used);
  const exact = new Map(used.map((pair) => [pair.line, pair.heard])), said = new Set([...exact.keys(), ...sound.line]);

  const result: FilmLineHeard[] = lines.map((line, at) => {
    const own = script.flatMap((word, i) => (word.at === at ? [i] : []));
    /*
     * A word found by sound has a time too: where the heard words it was found in begin. Left out,
     * a name heard in the recogniser's spelling under the line's own shot dropped from the line's
     * span, and a split cut read as a line wholly under the next shot (codex on PR 3333).
     */
    const heardAt = own.flatMap((i) => (exact.has(i) ? [spoken[exact.get(i)!]!] : sound.at.has(i) ? [spoken[sound.at.get(i)!]!] : []))
      .flatMap((word) => (word.startSec === null ? [] : [{ startSec: word.startSec, endSec: word.endSec }]));
    const last = heardAt.reduce<{ startSec: number; endSec: number | null } | null>((latest, word) => (latest === null || word.startSec > latest.startSec ? word : latest), null);
    const missing = own.filter((i) => !said.has(i)).map((i) => script[i]!.text);
    const share = own.length === 0 ? 1 : (own.length - missing.length) / own.length;
    return { number: line.number, shot: line.shot,
      said: share === 1 ? (own.some((i) => sound.line.has(i)) ? "by-sound" : "as-written") : share >= .6 ? "partly" : "not-heard",
      startSec: last ? milli(Math.min(...heardAt.map((word) => word.startSec))) : null,
      endSec: last ? milli(last.endSec === null || last.endSec < last.startSec ? last.startSec : (last.startSec + last.endSec) / 2) : null,
      words: own.length, heardWords: own.length - missing.length, missing, unclearNames: [...new Set(missing.filter((word) => names.has(word)))] };
  });

  // What was heard and is no line's, gap by gap between the words heard as written.
  const consumed = new Set([...exact.values(), ...sound.heard]);
  const runs: Array<{ atSec: number | null; text: string }> = [];
  const edges = [{ line: -1, heard: -1 }, ...used, { line: script.length, heard: spoken.length }];
  for (let e = 1; e < edges.length; e++) {
    const from = edges[e - 1]!, to = edges[e]!;
    let missing = 0;
    for (let i = from.line + 1; i < to.line; i++) if (!said.has(i)) missing++;
    const spare = [];
    for (let j = from.heard + 1; j < to.heard; j++) if (!consumed.has(j) && spoken[j]!.probability >= SURE) spare.push(spoken[j]!);
    // Where the line's own words are missing, what was heard there stands in for them, unless far more was said than was missing.
    if (spare.length === 0 || missing > 0 && spare.length <= missing * 2) continue;
    let run: typeof spare = [];
    const close = () => {
      if (run.length >= 2 || run.length === 1 && run[0]!.probability >= SURE_ALONE && run[0]!.text.length >= LONE_WORD_LETTERS) runs.push({ atSec: run[0]!.startSec, text: run.map((word) => word.text).join(" ") });
      run = [];
    };
    for (const word of spare) {
      const last = run[run.length - 1];
      if (last && word.startSec !== null && last.startSec !== null && word.startSec - last.startSec > RUN_GAP_SEC) close();
      run.push(word);
    }
    close();
  }

  // A line not heard where the script has it, and a run heard elsewhere that is its words: the line, out of place.
  const misplaced: FilmWords["misplaced"] = [];
  for (const [at, line] of result.entries()) {
    if (line.said !== "not-heard") continue;
    const letters = spokenWords(lines[at]!.text).join("");
    if (letters.length < 6) continue;
    const found = runs.findIndex((run) => alike(letters, spokenWords(run.text).join("")) >= SAME_LINE);
    if (found < 0) continue;
    misplaced.push({ number: line.number, atSec: runs[found]!.atSec });
    runs.splice(found, 1);
  }
  return { lines: result, unwritten: runs, misplaced };
}

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${(seconds % 60 < 10 ? "0" : "")}${(seconds % 60).toFixed(1)}`;
/** Where something was heard, when its words had times: a stretch read as text alone has none, and the sentence goes without. */
const at = (seconds: number | null) => (seconds === null ? "" : ` at ${clock(seconds)}`);
const quoted = (text: string, most = 48) => `"${text.length > most ? `${text.slice(0, most - 1).trimEnd()}…` : text}"`;
/** The first few of a line's words that were not heard, and how many more: a long line half heard would list fifty. */
const some = (words: readonly string[], most = 8) => (words.length > most ? `${words.slice(0, most).join(" ")} and ${words.length - most} more` : words.join(" "));
/** A receipt holds a finding of at most this many characters, and one over it refuses the whole review (codex on PR 3333). */
const FINDING_MOST = 300;

/**
 * The film's words as findings, plain sentences each naming its line or its time, in the script's
 * order. `shotAt` says which shot of the cut is on screen at a time, when the cut is known: a line
 * heard wholly under another shot than its own has lost its place in the mix.
 *
 * Tried on a real two-minute cut of the first half of a 46-line scene, the first version said
 * "is not heard" twenty-nine times: once for each of the twenty-five lines the film never
 * reached, and once for a line that was said, of which the recogniser caught eight words in
 * nineteen. So a run of lines with nothing heard is one finding, and a line heard in a quarter
 * of its words or more is barely heard, which is a thing to listen to, not a missing line.
 */
export function filmWordFindings(lines: readonly FilmLine[], words: FilmWords, shotAt?: (seconds: number) => number | null): string[] {
  const findings: string[] = [], text = new Map(lines.map((line) => [line.number, line.text])), moved = new Set(words.misplaced.map((line) => line.number));
  const shots = new Map(lines.map((line) => [line.number, line.shots ?? (line.shot === null ? [] : [line.shot])]));
  const unheard = (line: FilmLineHeard | undefined) => line !== undefined && line.said === "not-heard" && !moved.has(line.number) && line.heardWords < line.words * BARELY;
  for (const line of words.misplaced) findings.push(`Line ${line.number} ${quoted(text.get(line.number) ?? "")} is not heard in its place; words like it are heard${at(line.atSec)}.`);
  for (let i = 0; i < words.lines.length; i++) {
    const line = words.lines[i]!;
    if (unheard(line)) {
      let last = i;
      while (unheard(words.lines[last + 1])) last++;
      if (last - i + 1 >= UNHEARD_RUN) { findings.push(`Lines ${line.number} to ${words.lines[last]!.number} are not heard (${last - i + 1} lines).`); i = last; }
      else findings.push(`Line ${line.number} ${quoted(text.get(line.number) ?? "")} is not heard.`);
      continue;
    }
    if (line.said === "not-heard" && !moved.has(line.number)) findings.push(`Line ${line.number} ${quoted(text.get(line.number) ?? "")} is barely heard${at(line.startSec)}: ${line.heardWords} of its ${line.words} words; listen to it.`);
    else if (line.unclearNames.length > 0) findings.push(`Line ${line.number}: nothing like the name ${some(line.unclearNames)} is heard${line.startSec === null ? "" : ` (the line is at ${clock(line.startSec)})`}; listen to it.`);
    else if (line.said === "partly") findings.push(`Line ${line.number} is partly heard${at(line.startSec)}: not heard, ${some(line.missing)}.`);
    const own = shots.get(line.number) ?? [];
    if (shotAt && own.length > 0 && line.startSec !== null && line.endSec !== null && line.said !== "not-heard") {
      const first = shotAt(line.startSec), last = shotAt(line.endSec);
      // Starting or ending under any of its own shots, or lying between two of them over an insert, is its place.
      if (first !== null && last !== null && !own.includes(first) && !own.includes(last) && (first > Math.max(...own) || last < Math.min(...own))) {
        findings.push(`Line ${line.number} is heard at ${clock(line.startSec)} under shot ${first}, not its own shot ${own[0]}.`);
      }
    }
  }
  for (const run of words.unwritten) findings.push(`Words nobody wrote${at(run.atSec)}: ${quoted(run.text)}.`);
  return findings.map((finding) => (finding.length > FINDING_MOST ? `${finding.slice(0, FINDING_MOST - 1)}…` : finding));
}
