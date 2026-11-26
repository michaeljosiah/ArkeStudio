import { readFile } from "node:fs/promises";
import {
  orderedShots, referenceAudioMediaPath, sceneUnderLook, takeCheckSource, takeIsCheckable, TakeChecksRecordSchema,
  type AcousticWord, type AgentMediaInventory, type CharacterAudioPlan, type ProductionBundle, type SceneRecord,
  type Shot, type Take, type TakeCheck, type TakeCheckSkip, type TakeChecksRecord,
} from "@arke-studio/contracts";
import type { AgentMediaTools } from "../media/agent-media-tools.js";
import { findCuts } from "../media/contact-sheet.js";
import { frameMotion, measureSoundtrackSync } from "../media/measure-sync.js";
import { recognizeAgentSpeech, type AgentSpeechReader } from "../media/agent-speech.js";
import { audioWorldPath } from "../audio/storage.js";
import { appendFlushed } from "../flushed-append.js";
import { withContainedProductionMedia } from "../world/reference-files.js";
import type { WorldStore } from "../world/store.js";

/*
 * The checks after a take comes back (design turns 287 and 288c). Gold on Gold's first Wan pass
 * was watched shot by shot and still went out with a dissolve inside take 69, voices nobody wrote
 * near the ends of 69 and 72, and fifty takes that drifted and never breathed in a film meant to
 * be handheld. Each of those is a number. Here they are measured the same way every time a take
 * lands: once, from one decode of its picture and one of its sound, with nothing sent anywhere
 * (speech is the local Voxa seam Arke's transcribe_audio uses, and nothing else).
 */

type Stream = AgentMediaInventory["streams"][number];
const round1 = (value: number) => Math.round(value * 10) / 10;
const sec = (value: number) => `${round1(value).toFixed(1)} s`;

/** The picture is read ten times a second; a take longer than a minute is read for its first minute. */
const FPS = 10, EDGE = 256, MAX_SEC = 60;

// ---------- Words ----------

/** Words as compared: one case, apostrophes kept inside a word, everything that is not a letter or a digit dropped. */
export function spokenWords(text: string): string[] {
  return text.normalize("NFKC").toLowerCase().replace(/[’‘]/g, "'").split(/[^\p{L}\p{N}']+/u)
    .map(word => word.replace(/^'+|'+$/g, "")).filter(Boolean);
}

/** The longest in-order run of the line's words in what was heard, as pairs of indices (line, heard). */
export function matchedHeard(line: readonly string[], heard: readonly string[]): Array<{ line: number; heard: number }> {
  const width = heard.length + 1, dp = new Uint16Array((line.length + 1) * width);
  for (let i = line.length - 1; i >= 0; i--) for (let j = heard.length - 1; j >= 0; j--) {
    dp[i * width + j] = line[i] === heard[j] ? 1 + dp[(i + 1) * width + j + 1]! : Math.max(dp[(i + 1) * width + j]!, dp[i * width + j + 1]!);
  }
  const used: Array<{ line: number; heard: number }> = [];
  for (let i = 0, j = 0; i < line.length && j < heard.length;) {
    if (line[i] === heard[j]) { used.push({ line: i, heard: j }); i++; j++; }
    else if (dp[(i + 1) * width + j]! >= dp[i * width + j + 1]!) i++;
    else j++;
  }
  return used;
}

/** A word the recogniser is this sure of is a voice; below it, a breath or the room can read as one. */
const SURE = .5;
/**
 * One word alone has to be surer than two together. Two was the rule, and it let a take's single
 * invented word through: a "Hmm?" after a line, the stub of a word begun before a cut. One unsure
 * word is still a breath.
 */
const SURE_ALONE = .8;
/**
 * A line's one unmatched word and the little heard in its place are one sound when their
 * spellings are this alike: "boot" and "boat", "Oya" and "Oh yeah".
 */
const ALIKE = .5;
/**
 * A word looked for inside a longer run of heard letters has to be more alike than that, or it is
 * found by chance: "Tunde" in "Tundi", "Adeyemi" in "the Yemi", never "Tunde" in "fortune".
 */
const ALIKE_IN_A_RUN = .65;
/** A word shorter than this has no sound of its own to find: an "a" is inside every "bag". */
const SHORTEST_BY_SOUND = 3;
/** A word this short is found in a run only one letter off and about its own length: two letters of four are everywhere. */
const SHORT_WORD = 4;
/** How many letters past the word before it a word is looked for: a few misheard or invented words' worth. */
const SOUND_REACH = 80;

/** The edits (a letter added, dropped or changed) that turn one run of letters into another. */
function edits(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length]!;
}

/** How alike two runs of letters are, 0 to 1: one less their edits over the longer's length. */
export function alike(a: string, b: string): number {
  return a.length === 0 || b.length === 0 ? 0 : 1 - edits(a, b) / Math.max(a.length, b.length);
}

/**
 * The line's words the recogniser spelled another way. It knows English words, so a name or a word
 * of another language comes back as the English it sounds like, split where it likes: "Adeyemi
 * Akinola" as "the Yemi Aki Nola". Word for word nothing matches, and a line passed or failed on
 * its other words alone: a take that said the name wrong passed at thirteen words of sixteen.
 * So where the line's words went unmatched, the heard words in the same gap are read as one run
 * of letters. One unmatched word with little heard in its place is set against all of it. In a
 * longer gap each of the line's words is looked for in the run, in order: a stretch of letters
 * about the word's length and alike enough is the word, and the heard words those letters came
 * from are the line's. A word with no such stretch was not heard.
 *
 * Each word has to be found for itself. Setting a whole gap against a whole run let one long word
 * carry a name that was never said: "Tunde, congratulations!" heard as "congratulation" was alike
 * enough, and the name passed (codex on PR 3327). And each word is looked for only a little way
 * past the one before it, so a long take whose words match nothing costs a little, not the
 * fourteen seconds a hundred such words took when every run was tried against every run.
 */
export function heardBySound(line: readonly string[], heard: readonly string[], used: ReadonlyArray<{ line: number; heard: number }>): { line: Set<number>; heard: Set<number>; at: Map<number, number> } {
  // `at` is where each word found by sound begins: the first heard word it was found in, for a caller that needs its time.
  const found = { line: new Set<number>(), heard: new Set<number>(), at: new Map<number, number>() };
  const edges = [{ line: -1, heard: -1 }, ...used, { line: line.length, heard: heard.length }];
  for (let e = 1; e < edges.length; e++) {
    const from = edges[e - 1]!, to = edges[e]!;
    if (to.line - from.line < 2 || to.heard - from.heard < 2) continue;
    // The gap's heard words as letters, each remembering the word it came from.
    let text = ""; const owner: number[] = [];
    for (let j = from.heard + 1; j < to.heard; j++) { text += heard[j]!; for (let k = 0; k < heard[j]!.length; k++) owner.push(j); }
    const alone = to.line - from.line === 2 ? line[from.line + 1]! : null;
    if (alone !== null && text.length <= alone.length * 2 + 3) {
      /*
       * The run of whole heard words most like the word is the word, and only that run: the rest
       * of the gap is still what the take said beside it. Crediting the whole gap took a "thank
       * you" after "Congratulations!" for part of the line, and the voice nobody wrote went
       * unheard (codex on PR 3327).
       */
      let best: { start: number; end: number; score: number } | null = null;
      for (let start = from.heard + 1; start < to.heard && alone.length >= SHORTEST_BY_SOUND; start++) {
        let run = "";
        for (let end = start; end < to.heard; end++) {
          run += heard[end]!;
          const score = alike(alone, run);
          if (score >= ALIKE && (!best || score > best.score)) best = { start, end, score };
        }
      }
      if (best) { found.line.add(from.line + 1); found.at.set(from.line + 1, best.start); for (let j = best.start; j <= best.end; j++) found.heard.add(j); }
      continue;
    }
    let at = 0;
    for (let i = from.line + 1; i < to.line; i++) {
      const word = line[i]!;
      if (word.length < SHORTEST_BY_SOUND) continue;
      const short = word.length <= SHORT_WORD;
      /*
       * The first place the word will do, at its best length there, not its best fit anywhere in
       * reach: "John Johnson" heard as "Jon Johnsen" has a perfect "john" inside the surname, and
       * taking it left "Jon" a voice nobody wrote and the surname unheard (codex on PR 3327). A
       * word is where the line puts it, straight after the one before.
       */
      let best: { start: number; end: number; score: number } | null = null;
      for (let start = at; start < text.length && start <= at + SOUND_REACH && best === null; start++) {
        for (let length = Math.max(1, word.length - (short ? 1 : 2)); length <= word.length + (short ? 1 : 3) && start + length <= text.length; length++) {
          const piece = text.slice(start, start + length), score = alike(word, piece);
          if ((short ? edits(word, piece) <= 1 : score >= ALIKE_IN_A_RUN) && (!best || score > best.score)) best = { start, end: start + length, score };
        }
      }
      if (!best) continue;
      found.line.add(i); found.at.set(i, owner[best.start]!);
      for (let k = best.start; k < best.end; k++) found.heard.add(owner[k]!);
      at = best.end;
    }
  }
  return found;
}

/**
 * The words heard against the line, and any voice nobody wrote: words outside the line's run,
 * which is what 69 and 72 did after their lines ended. A voice after the line says where the take
 * could end. A shot with no line has no words to compare; any voice in it is one nobody wrote.
 * Words heard without times (the recogniser's text alone, when it could not place a word) still
 * judge the line; a voice nobody wrote then says where it is, not when.
 *
 * `names` are the words of the cast's names. A line can lose a few words to the recogniser and
 * pass; it cannot lose a name. Gold on Gold's "Adeyemi Akinola, abeg" came back with the name said
 * wrong, the check passed it on the rest of the line, and it was found by a friend of the owner's
 * after the scene was cut. The recogniser cannot say a name was said right, only that it heard
 * nothing like it, so the item says which name to listen for.
 */
export type HeardWord = { text: string; startSec: number | null; probability: number };
export function judgeWords(line: string | null, heard: readonly HeardWord[], names: ReadonlySet<string> = new Set()): { words: TakeCheck | null; voice: TakeCheck } {
  const spoken = heard.flatMap(word => spokenWords(word.text).map(text => ({ text, startSec: word.startSec, probability: word.probability })));
  const voiceAt = (words: typeof spoken, trimmable: boolean, where: string): TakeCheck => {
    const sure = words.filter(word => word.probability >= SURE);
    if (sure.length === 0 || sure.length === 1 && sure[0]!.probability < SURE_ALONE) return { id: "unwritten-voice", result: "pass", says: "none" };
    const at = sure[0]!.startSec;
    if (at === null) return { id: "unwritten-voice", result: "fix", says: where };
    return { id: "unwritten-voice", result: "fix", says: `at ${sec(at)}`, ...(trimmable && at - .15 >= .5 ? { endAtSec: round1(at - .15) } : {}) };
  };
  const lineWords = line === null ? [] : spokenWords(line);
  if (lineWords.length === 0) return { words: null, voice: voiceAt(spoken, true, "heard") };
  if (spoken.length === 0) return { words: { id: "words", result: "fix", says: "nothing heard" }, voice: { id: "unwritten-voice", result: "pass", says: "none" } };
  const texts = spoken.map(word => word.text);
  const used = matchedHeard(lineWords, texts), sound = heardBySound(lineWords, texts, used);
  const said = new Set([...used.map(pair => pair.line), ...sound.line]);
  const missing = lineWords.filter((_, i) => !said.has(i)), unclear = [...new Set(missing.filter(word => names.has(word)))];
  const share = said.size / lineWords.length;
  const short = (text: string, most: number) => (text.length > most ? `${text.slice(0, most - 1)}…` : text);
  const words: TakeCheck = share < .6 ? { id: "words", result: "fix", says: `heard “${short(texts.join(" "), 48)}”` }
    : unclear.length > 0 ? { id: "words", result: "fix", says: short(`name unclear: ${unclear.join(" ")}`, 80) }
    : share < 1 ? { id: "words", result: "pass", says: short(`${said.size} of ${lineWords.length} words · not heard: ${missing.join(" ")}`, 80) }
    : { id: "words", result: "pass", says: sound.line.size === 0 ? "as written" : sound.line.size === lineWords.length ? "by sound" : `as written, ${sound.line.size} by sound` };
  if (said.size === 0) return { words, voice: voiceAt(spoken, false, "heard") };
  /*
   * Words outside the line's run are a voice nobody wrote only past the line's own words that
   * were not heard on that side: a recogniser spells "Ehn-ehn" as "Eh, eh", and on 0.5.138 the
   * two misheard words that open shot 4's line read as a voice before it. Words the line was
   * heard in by sound are the line's; of the rest, as many as the line still misses on that side
   * are left to it, nearest the line first.
   */
  const lineHeard = [...used.map(pair => pair.heard), ...sound.heard], firstHeard = Math.min(...lineHeard), lastHeard = Math.max(...lineHeard);
  const firstSaid = Math.min(...said), lastSaid = Math.max(...said);
  const before = spoken.slice(0, firstHeard), after = spoken.slice(lastHeard + 1);
  const trailing = voiceAt(after.slice(lineWords.length - 1 - lastSaid), true, "after the line");
  return { words, voice: trailing.result === "fix" ? trailing : voiceAt(before.slice(0, Math.max(0, before.length - firstSaid)), false, "before the line") };
}

// ---------- Cuts inside ----------

/** A cut inside the take; one late in it says where the take could end before it. */
export function judgeCuts(cuts: readonly number[], durationSec: number): TakeCheck {
  if (cuts.length === 0) return { id: "cuts-inside", result: "pass", says: "none" };
  const first = cuts[0]!;
  return { id: "cuts-inside", result: "fix", says: cuts.length === 1 ? `at ${sec(first)}` : `${cuts.length} · first at ${sec(first)}`,
    ...(cuts.length === 1 && first >= durationSec / 2 && first - .1 >= .5 ? { endAtSec: round1(first - .1) } : {}) };
}

// ---------- Camera ----------

/** Mean absolute difference of `b` shifted by (dx, dy) against `a`, over the frame less a margin. */
function shiftCost(a: Uint8Array, b: Uint8Array, width: number, height: number, dx: number, dy: number, margin: number, step: number): number {
  let sum = 0, count = 0;
  for (let y = margin; y < height - margin; y += step) {
    const row = y * width, shifted = (y + dy) * width + dx;
    for (let x = margin; x < width - margin; x += step) { sum += Math.abs(a[row + x]! - b[shifted + x]!); count++; }
  }
  return count ? sum / count : Infinity;
}

/** Below this spread of grey levels a frame is flat: there is nothing in it to lay one frame on the next by. */
const FLAT = 3;

/** How far a frame's grey levels spread about their mean, from every fourth pixel. */
function spread(frame: Uint8Array): number {
  let sum = 0, squares = 0, count = 0;
  for (let i = 0; i < frame.length; i += 4) { const value = frame[i]!; sum += value; squares += value * value; count++; }
  if (count === 0) return 0;
  const mean = sum / count;
  return Math.sqrt(Math.max(0, squares / count - mean * mean));
}

/** Half the picture each way, box-averaged, for the coarse search. */
function half(frame: Uint8Array, width: number, height: number): { frame: Uint8Array; width: number; height: number } {
  const w = width >> 1, h = height >> 1, out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = 2 * y * width + 2 * x;
    out[y * w + x] = (frame[i]! + frame[i + 1]! + frame[i + width]! + frame[i + width + 1]!) >> 2;
  }
  return { frame: out, width: w, height: h };
}

/**
 * How the picture moved from one frame to the next, in pixels of the frames given: the shift that
 * best lays the second on the first, found on a half-size picture, refined at full size and to a
 * fraction of a pixel. A person moving in the frame pulls on it; the room behind them, which is
 * most of a frame, holds it. Advice, not proof, which is why the camera is not a hard check.
 */
export function cameraPath(frames: readonly Uint8Array[], width: number, height: number): Array<{ dx: number; dy: number }> {
  const steps: Array<{ dx: number; dy: number }> = [];
  const COARSE = 6, coarseMargin = COARSE + 2, fineMargin = 2 * COARSE + 4;
  if (width < 4 * fineMargin || height < 4 * fineMargin) return frames.slice(1).map(() => ({ dx: 0, dy: 0 }));
  /*
   * A shift that costs no more than a smaller one is not taken: on a black hold or a fade every
   * shift costs the same, and keeping the first one tried read a still shot as a 8,464 px move
   * (codex on PR 3306). Nearer wins a tie, so a picture with nothing to match stays put.
   */
  const better = (cost: number, dx: number, dy: number, best: { dx: number; dy: number; cost: number }) =>
    cost < best.cost - 1e-9 || (Math.abs(cost - best.cost) <= 1e-9 && Math.abs(dx) + Math.abs(dy) < Math.abs(best.dx) + Math.abs(best.dy));
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1]!, b = frames[i]!;
    // A frame with no texture to match (black, a flat wall in shadow) says nothing of the camera.
    if (spread(a) < FLAT || spread(b) < FLAT) { steps.push({ dx: 0, dy: 0 }); continue; }
    const ha = half(a, width, height), hb = half(b, width, height);
    let best = { dx: 0, dy: 0, cost: shiftCost(ha.frame, hb.frame, ha.width, ha.height, 0, 0, coarseMargin, 1) };
    for (let dy = -COARSE; dy <= COARSE; dy++) for (let dx = -COARSE; dx <= COARSE; dx++) {
      const cost = shiftCost(ha.frame, hb.frame, ha.width, ha.height, dx, dy, coarseMargin, 1);
      if (better(cost, dx, dy, best)) best = { dx, dy, cost };
    }
    const costs = new Map<string, number>(), at = (dx: number, dy: number) => {
      const key = `${dx},${dy}`; let cost = costs.get(key);
      if (cost === undefined) { cost = shiftCost(a, b, width, height, dx, dy, fineMargin, 2); costs.set(key, cost); }
      return cost;
    };
    let fine = { dx: 2 * best.dx, dy: 2 * best.dy, cost: at(2 * best.dx, 2 * best.dy) };
    for (let dy = 2 * best.dy - 2; dy <= 2 * best.dy + 2; dy++) for (let dx = 2 * best.dx - 2; dx <= 2 * best.dx + 2; dx++) {
      const cost = at(dx, dy);
      if (better(cost, dx, dy, fine)) fine = { dx, dy, cost };
    }
    // A parabola through the best cost and its neighbours places the minimum between pixels.
    const vertex = (left: number, middle: number, right: number) => { const curve = left - 2 * middle + right; return curve > 1e-9 ? Math.max(-.5, Math.min(.5, (left - right) / (2 * curve))) : 0; };
    steps.push({ dx: fine.dx + vertex(at(fine.dx - 1, fine.dy), fine.cost, at(fine.dx + 1, fine.dy)),
      dy: fine.dy + vertex(at(fine.dx, fine.dy - 1), fine.cost, at(fine.dx, fine.dy + 1)) });
  }
  return steps;
}

/** What the shot asked of the camera, from its movement words: to hold still, to move as a hand holds it, or something a measure cannot judge (a push, a pan). */
export function askedCamera(movement: string | undefined): "still" | "handheld" | null {
  if (!movement) return null;
  if (/hand-?held|shak|breath|wobbl/i.test(movement)) return "handheld";
  if (/locked|static|tripod|does not move|no movement|holds still/i.test(movement)) return "still";
  return null;
}

/** Pixels are reported as a 1920-wide frame's, whatever size the take is, so 7 px means the same everywhere. */
const REPORT_WIDTH = 1920;
/** Below these the camera is still: drift across the take, and the breath left after a half-second average. */
const STILL_DRIFT = 6, BREATH = 1.5;

export function judgeCamera(steps: ReadonlyArray<{ dx: number; dy: number }>, frameWidth: number, asked: "still" | "handheld" | null): TakeCheck {
  const scale = REPORT_WIDTH / frameWidth, x = [0], y = [0];
  for (const step of steps) { x.push(x[x.length - 1]! + step.dx * scale); y.push(y[y.length - 1]! + step.dy * scale); }
  const smooth = (values: number[]) => values.map((_, i) => {
    const from = Math.max(0, i - 2), to = Math.min(values.length - 1, i + 2);
    let sum = 0; for (let j = from; j <= to; j++) sum += values[j]!; return sum / (to - from + 1);
  });
  const sx = smooth(x), sy = smooth(y);
  let drift = 0, breath = 0;
  for (let i = 0; i < x.length; i++) {
    drift = Math.max(drift, Math.hypot(sx[i]! - sx[0]!, sy[i]! - sy[0]!));
    breath += (x[i]! - sx[i]!) ** 2 + (y[i]! - sy[i]!) ** 2;
  }
  breath = Math.sqrt(breath / x.length);
  const px = Math.round(drift), breathes = breath >= BREATH, moves = breathes || drift >= STILL_DRIFT;
  const says = !moves ? "still" : breathes ? `handheld · ${px} px` : `drifts ${px} px`;
  if (asked === "handheld" && !breathes) return { id: "camera", result: "fix", says: moves ? `${says}, no breath` : "still · asked handheld" };
  if (asked === "still" && moves) return { id: "camera", result: "fix", says: `moves ${px} px · asked still` };
  return { id: "camera", result: "pass", says };
}

// ---------- Light ----------

export function meanLevel(frame: Uint8Array): number {
  let sum = 0; for (let i = 0; i < frame.length; i++) sum += frame[i]!; return frame.length ? sum / frame.length : 0;
}

/** A tenth of the grey scale between one shot's last frame and the next one's first is a jump a viewer sees. */
const LIGHT_STEP = 26;

/** The take's first frame against the shot before's last, and its last against the next shot's first, where those shots have takes in the film. */
export function judgeLight(own: { first: number; last: number }, before: { number: number; last: number } | null, after: { number: number; first: number } | null): TakeCheck | null {
  const sides = [before && { number: before.number, step: own.first - before.last }, after && { number: after.number, step: own.last - after.first }]
    .filter((side): side is { number: number; step: number } => side !== null);
  if (sides.length === 0) return null;
  const worst = sides.reduce((a, b) => (Math.abs(b.step) > Math.abs(a.step) ? b : a));
  if (Math.abs(worst.step) >= LIGHT_STEP) return { id: "light", result: "fix", says: `${worst.step < 0 ? "darker" : "brighter"} than shot ${worst.number}` };
  return { id: "light", result: "pass", says: sides.length === 2 ? `as shots ${sides[0]!.number} and ${sides[1]!.number}` : `as shot ${sides[0]!.number}` };
}

// ---------- Lip sync ----------

/** Within this, the take's voice follows the read it was sent; the laid lines of Gold on Gold that read as off sat 60 to 120 ms away. */
const SYNC_MS = 60;

export function judgeSync(result: { lagSec: number | null; follows: boolean }): TakeCheck {
  if (result.lagSec === null || !result.follows) return { id: "lip-sync", result: "fix", says: "does not follow the read" };
  const ms = Math.round(result.lagSec * 100) * 10;
  if (Math.abs(ms) <= SYNC_MS) return { id: "lip-sync", result: "pass", says: `${Math.abs(ms)} ms` };
  return { id: "lip-sync", result: "fix", says: `${ms > 0 ? "late" : "early"} ${Math.abs(ms)} ms` };
}

/**
 * The read a take was sent to follow in time: a performance or a slice of the song, not a voice to
 * sound like. A segment of a pass carries the whole pass's reads, and only the one sent for its
 * own shot is its: held against the pass's first read, every segment but that read's own was
 * measured against another shot's line, from that line's start, and read as not following it.
 */
function syncReference(take: Take): CharacterAudioPlan["references"][number] | null {
  const plan = take.params["audioReferences"] as CharacterAudioPlan | undefined;
  if (!plan || plan.disabled || !Array.isArray(plan.references)) return null;
  const reads = plan.references.filter(ref => ref.intent === "performance-sync");
  const shotOf = (ref: (typeof reads)[number]) => ("master" in ref ? ref.master.shotId : "performance" in ref ? ref.performance.target.shotId : undefined);
  return reads.find(ref => shotOf(ref) === take.coversShots[0]) ?? (take.segment === undefined ? reads[0] ?? null : null);
}

/** The hash a sent read is fenced on: its prepared file's name says it; an unprepared performance carries it. */
function syncReferenceHash(ref: CharacterAudioPlan["references"][number]): string | null {
  const prepared = "prepared" in ref ? ref.prepared?.file.match(/sha256-([a-f0-9]{64})\.wav$/)?.[1] : undefined;
  if (prepared) return `sha256:${prepared}`;
  return "performance" in ref ? ref.performance.provenance.outputHash : null;
}

// ---------- The take, measured ----------

export interface TakeCheckPorts {
  tools: AgentMediaTools;
  speech?: AgentSpeechReader;
  speechReady?: (signal: AbortSignal) => Promise<boolean>;
  /** The same local recogniser's text alone, for a take whose words it cannot place in time. */
  transcribe?: (wav: Uint8Array, signal: AbortSignal) => Promise<string>;
  now: () => string;
}

interface Neighbours { before: { number: number; take: Take } | null; after: { number: number; take: Take } | null }

/** The shot, its scene and the shots either side that have a chosen take, in the scene's order. */
function placeOf(production: ProductionBundle, shotId: string): { scene: SceneRecord; shot: Shot; neighbours: Neighbours } | null {
  for (const scene of production.scenes) {
    let shots: Shot[];
    try { shots = orderedShots(scene); } catch { continue; }
    const index = shots.findIndex(shot => shot.id === shotId);
    if (index < 0) continue;
    const chosen = (at: number) => {
      const shot = shots[at], id = shot ? production.selections[shot.id]?.acceptedTakeId : undefined;
      const take = id ? production.takes.find(candidate => candidate.id === id && takeIsCheckable(production.takes, candidate)) : undefined;
      return take ? { number: at + 1, take } : null;
    };
    return { scene, shot: shots[index]!, neighbours: { before: chosen(index - 1), after: chosen(index + 1) } };
  }
  return null;
}

/** Words a sheet's name can hold that are not the name: "The Driver", "Old Tunde", "Mrs Akinola". */
const NOT_A_NAME = new Set(["the", "a", "an", "of", "and", "mr", "mrs", "ms", "miss", "dr", "sir", "old", "young", "big", "little"]);

/** The cast's names and aliases as the words a line would say them in. */
export function castNames(sheets: ReadonlyArray<{ type: string; name: string; aliases?: readonly string[] }>): Set<string> {
  return new Set(sheets.filter(sheet => sheet.type === "character").flatMap(sheet => [sheet.name, ...(sheet.aliases ?? [])])
    .flatMap(spokenWords).filter(word => !NOT_A_NAME.has(word)));
}

const SPOKEN_KINDS = new Set(["dialogue", "vo", "voice", "voice-over", "voiceover", "line", "speech"]);

/** The line the shot is meant to carry, when its sound is a spoken one. */
export function lineOf(shot: Shot): string | null {
  const audio = shot.audio;
  if (!audio?.line?.trim() || !SPOKEN_KINDS.has(audio.kind.trim().toLowerCase())) return null;
  return audio.line;
}

/**
 * Whether the shot's sound is the song: its words are lyrics, not a line, and a voice in it is
 * the point (codex on PR 3306). The song kinds `shotSingsToSong` reads, whether or not anyone in
 * the shot sings it, since the song's own voice can be in the take either way.
 */
function singsTheSong(shot: Shot): boolean {
  return shot.audio !== undefined && /^(music|song|sung|singing|sings|lip-?sync)$/i.test(shot.audio.kind.trim());
}

/** A take's picture as the checks read it: the clip's world path and hash, and the window of it that is this take. */
interface Source { path: string; hash: string; startSec: number; endSec: number | null }
function sourceOf(production: ProductionBundle, take: Take): Source | null {
  const found = takeCheckSource(production.takes, take);
  return found && { path: `productions/${production.meta.id}/takes/${found.mediaTakeId}/${found.media}`, hash: found.hash, startSec: found.startSec, endSec: found.endSec };
}

async function streamsOf(tools: AgentMediaTools, path: string, signal: AbortSignal): Promise<{ video: Stream | null; audio: Stream | null; durationSec: number | null }> {
  const inventory = await tools.probe(path, signal);
  return { video: inventory.streams.find(stream => stream.kind === "video") ?? null,
    audio: inventory.streams.find(stream => stream.kind === "audio") ?? null, durationSec: inventory.durationSec };
}

/** A neighbour's frame at its start or end, as one grey level. */
async function edgeLevel(store: WorldStore, tools: AgentMediaTools, source: Source, edge: "first" | "last", signal: AbortSignal): Promise<number | null> {
  return withContainedProductionMedia(store.dir, source.path, source.hash, signal, async snapshot => {
    const { video, durationSec } = await streamsOf(tools, snapshot.path, signal);
    if (!video || durationSec === null) return null;
    const start = source.startSec, end = Math.min(durationSec, source.endSec ?? durationSec);
    if (end - start <= .1) return null;
    const from = edge === "first" ? start : Math.max(start, end - .3), read = await tools.grayFrames!(snapshot.path, video, from, Math.min(end, from + .3), { fps: FPS, edge: 64 }, signal);
    const frame = edge === "first" ? read.frames[0] : read.frames[read.frames.length - 1];
    return frame ? meanLevel(frame) : null;
  }).catch(() => null);
}

/**
 * Measure one take. Null when it is not one the checks measure (a still, a voice, a pass covering
 * several shots) or the host has no picture tools; otherwise every item measured or skipped with a
 * reason. A segment of a pass is measured over its own range of the pass's clip, and every time
 * it reports is from the segment's start.
 */
export async function measureTake(store: WorldStore, productionId: string, takeId: string, ports: TakeCheckPorts, signal: AbortSignal): Promise<TakeChecksRecord | null> {
  const { tools } = ports;
  const production = store.getBundle().productions.find(p => p.meta.id === productionId);
  const take = production?.takes.find(candidate => candidate.id === takeId);
  const source = production && take ? sourceOf(production, take) : null;
  if (!production || !take || !source || !tools.grayFrames) return null;
  const place = placeOf(production, take.coversShots[0]!);
  if (!place) return null;
  const items: TakeCheck[] = [], skipped: TakeCheckSkip[] = [];
  const line = lineOf(place.shot);
  const names = castNames(store.getBundle().sheets);
  const sync = syncReference(take);
  // Set inside the read below; cast so the checker does not keep them at their first null.
  let level = null as { first: number; last: number } | null;
  let takeSound = null as Float32Array | null;
  await withContainedProductionMedia(store.dir, source.path, source.hash, signal, async snapshot => {
    const { video, audio, durationSec } = await streamsOf(tools, snapshot.path, signal);
    if (!video || durationSec === null || durationSec <= 0) throw new Error("The take has no picture to measure.");
    const start = Math.min(source.startSec, durationSec), stop = Math.min(durationSec, source.endSec ?? durationSec, start + MAX_SEC);
    if (stop - start <= .2) throw new Error("The take's range of its clip is too short to measure.");
    const end = stop - start;
    const picture = await tools.grayFrames!(snapshot.path, video, start, stop, { fps: FPS, edge: EDGE }, signal);
    const cuts = findCuts([...frameMotion(picture.frames)], FPS);
    items.push(judgeCuts(cuts, end));
    const movement = place.shot.framing?.movement ?? sceneUnderLook(place.scene, production.meta.look).defaults?.movement;
    // Across a cut there is no move to find, only another picture: that step is left out of the camera's path.
    const across = new Set(cuts.map(at => Math.round(at * FPS) - 1));
    const steps = cameraPath(picture.frames, picture.width, picture.height).map((step, i) => (across.has(i) ? { dx: 0, dy: 0 } : step));
    items.push(judgeCamera(steps, picture.width, askedCamera(movement)));
    const first = picture.frames[0], last = picture.frames[picture.frames.length - 1];
    if (first && last) level = { first: meanLevel(first), last: meanLevel(last) };
    // The sound is read only as far as it runs: a clip with six seconds of picture and four of
    // sound had its reads refused, and the refusal took the picture's checks with it (codex on
    // PR 3306). A read of the sound that fails leaves those checks as they are, the sound's skipped.
    // Times from here are the take's own: from the segment's start, as the picture's are.
    const soundStop = audio ? Math.min(stop, audio.durationSec ?? stop) : start, soundEnd = soundStop - start;
    const quietly = <T,>(read: Promise<T>) => read.catch((error: unknown) => { if (signal.aborted) throw error; return null; });
    if (singsTheSong(place.shot)) {
      skipped.push({ id: "words", reason: "sung" }, { id: "unwritten-voice", reason: "sung" });
    } else if (!audio || soundEnd < .5) {
      skipped.push({ id: "unwritten-voice", reason: "no-sound" });
      if (line !== null) skipped.push({ id: "words", reason: "no-sound" });
    } else if (!ports.speech || !tools.speechAudio || (ports.speechReady && !await ports.speechReady(signal))) {
      skipped.push({ id: "unwritten-voice", reason: "unavailable" });
      if (line !== null) skipped.push({ id: "words", reason: "unavailable" });
    } else {
      /*
       * A take nobody speaks in comes back from the recogniser with no words, which the speech
       * profile (a transcript of at least one word) refuses. On 0.5.136 that read three silent
       * Gold on Gold takes as "unavailable" when the answer was "nothing heard": a pass for a
       * voice nobody wrote, a fix for a line that was never said. The empty answer is kept as such.
       */
      let silent = false;
      const speech = ports.speech;
      const read: AgentSpeechReader = async (bytes, readSignal) => {
        const answer = await speech(bytes, readSignal);
        if (Array.isArray(answer?.words) && answer.words.length === 0) silent = true;
        return answer;
      };
      const derivative = await quietly(tools.speechAudio(snapshot.path, audio, start, soundStop, signal));
      let heard: HeardWord[] | null = derivative === null ? null : await quietly(recognizeAgentSpeech({ bytes: derivative.bytes, durationSec: derivative.durationSec,
        streamIndex: audio.index, sourceStartSec: 0, viewStartSec: 0, read, signal }).then(transcript => transcript.words as AcousticWord[]))
        .then(words => (words === null && silent ? [] : words));
      /*
       * The recogniser refuses a take when it cannot place a word in time ("a word has no usable
       * timing or an unresolved pause"): on 0.5.137 that was shot 4 of Gold on Gold, a Pidgin line
       * with a beat in it, and its words read "unavailable". Its text alone still says whether the
       * line was spoken, so the words are judged from it; a voice nobody wrote then says where.
       */
      if (heard === null && derivative !== null && ports.transcribe) {
        const text = await quietly(ports.transcribe(derivative.bytes, signal));
        if (text !== null) heard = spokenWords(text).map(word => ({ text: word, startSec: null, probability: 1 }));
      }
      if (heard === null) {
        skipped.push({ id: "unwritten-voice", reason: "unavailable" });
        if (line !== null) skipped.push({ id: "words", reason: "unavailable" });
      } else {
        const judged = judgeWords(line, heard, names);
        if (judged.words) items.push(judged.words);
        items.push(judged.voice);
      }
    }
    if (line === null && !items.some(item => item.id === "words") && !skipped.some(item => item.id === "words")) skipped.push({ id: "words", reason: "no-line" });
    if (sync && audio && soundEnd >= .5 && tools.monoAudio) takeSound = await quietly(tools.monoAudio(snapshot.path, audio, start, soundStop, 16_000, signal));
  });
  if (!sync) skipped.push({ id: "lip-sync", reason: "no-voice-sent" });
  else {
    const expected = syncReferenceHash(sync);
    const reference = expected && takeSound && tools.monoAudio ? await withContainedProductionMedia(store.dir, referenceAudioMediaPath(sync), expected, signal, async snapshot => {
      const { audio, durationSec } = await streamsOf(tools, snapshot.path, signal);
      return audio && durationSec ? tools.monoAudio!(snapshot.path, audio, 0, Math.min(durationSec, MAX_SEC), 16_000, signal) : null;
    }).catch(() => null) : null;
    if (!reference || !takeSound) skipped.push({ id: "lip-sync", reason: "unavailable" });
    else items.push(judgeSync(measureSoundtrackSync(takeSound, reference, 16_000, .6)));
  }
  const beforeSource = place.neighbours.before ? sourceOf(production, place.neighbours.before.take) : null;
  const afterSource = place.neighbours.after ? sourceOf(production, place.neighbours.after.take) : null;
  const [before, after] = await Promise.all([
    beforeSource ? edgeLevel(store, tools, beforeSource, "last", signal) : null,
    afterSource ? edgeLevel(store, tools, afterSource, "first", signal) : null,
  ]);
  const light = level === null ? null : judgeLight(level, before === null ? null : { number: place.neighbours.before!.number, last: before },
    after === null ? null : { number: place.neighbours.after!.number, first: after });
  if (light) items.push(light);
  else skipped.push({ id: "light", reason: "no-neighbour" });
  const order = ["lip-sync", "words", "unwritten-voice", "cuts-inside", "camera", "light"];
  items.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  return TakeChecksRecordSchema.parse({ schemaVersion: 1, kind: "after-take", ts: ports.now(), takeId: take.id, shotId: take.coversShots[0],
    sourceHash: source.hash, items, skipped });
}

const queues = new WeakMap<WorldStore, Promise<unknown>>();

/**
 * Measure a take and record what was found, one take at a time in a world: each is a decode of a
 * clip's picture and sound, and a scene's takes landing together must not decode at once.
 */
export function checkTake(store: WorldStore, productionId: string, takeId: string, ports: TakeCheckPorts, signal: AbortSignal): Promise<"checked" | "not-checkable" | "changed"> {
  const run = (queues.get(store) ?? Promise.resolve()).then(async () => {
    signal.throwIfAborted();
    const record = await measureTake(store, productionId, takeId, ports, signal);
    if (record === null) return "not-checkable" as const;
    signal.throwIfAborted();
    return await recordTakeChecks(store, productionId, record) ? "checked" as const : "changed" as const;
  });
  queues.set(store, run.catch(() => {}));
  return run;
}

/**
 * Add a take's checks to the production's record of them, if the take is still what was measured.
 * Appended, as dialogue feedback is: the newest line for a take is its checks.
 */
export async function recordTakeChecks(store: WorldStore, productionId: string, record: TakeChecksRecord): Promise<boolean> {
  return store.ownedWrite(async () => {
    const production = store.getBundle().productions.find(p => p.meta.id === productionId);
    const take = production?.takes.find(candidate => candidate.id === record.takeId);
    if (!production || !take || takeCheckSource(production.takes, take)?.hash !== record.sourceHash) return false;
    const path = await audioWorldPath(store.dir, `productions/${productionId}/take-checks.jsonl`, true);
    const raw = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return ""; throw error; });
    // A torn last line is left for repair rather than glued to the next record.
    if (raw && !raw.endsWith("\n")) throw new Error("The take checks need repair before more are added.");
    await appendFlushed(path, `${JSON.stringify(TakeChecksRecordSchema.parse(record))}\n`);
    return true;
  });
}
