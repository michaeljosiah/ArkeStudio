import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { filmWordFindings, filmWordsAgainstScript, type FilmLine } from "../../src/media/film-words.js";

/*
 * A finished film's words against its script (2026-11-26). Gold on Gold's scene was shown with
 * lines over the wrong shots, words a take invented, a name said wrong and lines never filmed;
 * every take had passed alone.
 */

const say = (text: string, from: number, step = .3, probability = .9) => text.split(" ").map((word, i) => ({ text: word, startSec: from + i * step, probability }));
const LINES: FilmLine[] = [
  { number: 1, shot: 1, text: "It is not possible." },
  { number: 2, shot: 2, text: "Ade, I am telling you. The goat looked at me like this." },
  { number: 3, shot: 3, text: "The goat was in the boot, Tunde." },
  { number: 4, shot: 4, text: "Adeyemi Akinola, abeg, go and greet her." },
];
const NAMES = new Set(["ade", "adeyemi", "akinola", "tunde"]);
// Shot 1 to 2 s, shot 2 to 8 s, shot 3 to 12 s, shot 4 to the end.
const shotAt = (seconds: number) => (seconds < 2 ? 1 : seconds < 8 ? 2 : seconds < 12 ? 3 : 4);
const film = (...parts: Array<ReturnType<typeof say>>) => parts.flat();

describe("a film's words against its script", () => {
  it("hears every line as written, in order, each under its own shot, and has nothing to say", () => {
    const heard = film(say("It is not possible", .2), say("Ade I am telling you the goat looked at me like this", 2.4), say("The goat was in the boot Tunde", 8.5), say("the Yemi Aki Nola abeg go and greet her", 12.5));
    const words = filmWordsAgainstScript(LINES, heard, NAMES)!;
    assert.deepEqual(words.lines.map((line) => line.said), ["as-written", "as-written", "as-written", "by-sound"], "the name is heard in the recogniser's own spelling");
    assert.deepEqual([words.unwritten, words.misplaced], [[], []]);
    assert.deepEqual(filmWordFindings(LINES, words, shotAt), []);
    assert.deepEqual([words.lines[1]!.startSec, words.lines[1]!.endSec], [2.4, 5.7]);
  });

  it("names a line that is not heard, a name nothing like which is heard, and words nobody wrote", () => {
    const heard = film(say("It is not possible", .2), say("oh no", 1.5), say("Ade I am telling you the goat looked at me like this", 2.4), say("I do it in a bag go and greet her", 12.5));
    const words = filmWordsAgainstScript(LINES, heard, NAMES)!;
    assert.deepEqual(words.lines.map((line) => line.said), ["as-written", "as-written", "not-heard", "partly"]);
    assert.deepEqual(words.lines[3]!.unclearNames, ["adeyemi", "akinola"]);
    assert.deepEqual(words.unwritten, [{ atSec: 1.5, text: "oh no" }]);
    assert.deepEqual(filmWordFindings(LINES, words, shotAt), [
      "Line 3 \"The goat was in the boot, Tunde.\" is not heard.",
      // The line starts where its first heard word does, and "abeg" is heard there by sound, as "a bag".
      "Line 4: nothing like the name adeyemi akinola is heard (the line is at 0:13.7); listen to it.",
      "Words nobody wrote at 0:01.5: \"oh no\".",
    ]);
  });

  it("finds a line the mix moved: not heard in its place, heard elsewhere", () => {
    // The first line lost its delay and plays at the end, over another shot.
    const heard = film(say("Ade I am telling you the goat looked at me like this", 2.4), say("The goat was in the boot Tunde", 8.5), say("the Yemi Aki Nola abeg go and greet her", 12.5), say("It is not possible", 17));
    const words = filmWordsAgainstScript(LINES, heard, NAMES)!;
    assert.equal(words.lines[0]!.said, "not-heard");
    assert.deepEqual(words.misplaced, [{ number: 1, atSec: 17 }]);
    assert.deepEqual(words.unwritten, [], "the words are the line's, not a voice nobody wrote");
    assert.deepEqual(filmWordFindings(LINES, words, shotAt), ["Line 1 \"It is not possible.\" is not heard in its place; words like it are heard at 0:17.0."]);
  });

  it("finds a line heard in order but wholly under another shot, and lets a split cut be", () => {
    const late = film(say("It is not possible", .2), say("Ade I am telling you the goat looked at me like this", 2.4), say("The goat was in the boot Tunde", 12.4, .2), say("the Yemi Aki Nola abeg go and greet her", 15));
    assert.deepEqual(filmWordFindings(LINES, filmWordsAgainstScript(LINES, late, NAMES)!, shotAt), ["Line 3 is heard at 0:12.4 under shot 4, not its own shot 3."]);
    // Starting under the shot before and ending on its own is a split cut.
    const split = film(say("It is not possible", .2), say("Ade I am telling you the goat looked at me like this", 2.4), say("The goat was in the boot Tunde", 7.4), say("the Yemi Aki Nola abeg go and greet her", 12.5));
    assert.deepEqual(filmWordFindings(LINES, filmWordsAgainstScript(LINES, split, NAMES)!, shotAt), []);
    // With no cut to hold the lines to, nothing is said about shots.
    assert.deepEqual(filmWordFindings(LINES, filmWordsAgainstScript(LINES, late, NAMES)!), []);
  });

  it("says a run of lines the film never reached once, and calls a line the recogniser mostly missed barely heard, not missing", () => {
    // A film of the first half of a scene, held to the whole scene's script; its second line is said, and half its words are caught.
    const scene: FilmLine[] = [...LINES.map((line) => ({ ...line, shot: null })), { number: 5, shot: null, text: "Good evening." },
      { number: 6, shot: null, text: "Sit, if you are going to stand there." }, { number: 7, shot: null, text: "I am Ade." }, { number: 8, shot: null, text: "Goodnight, palm tree." }];
    const heard = film(say("It is not possible", .2), say("I am telling you they cannot see that way like this", 2.4), say("The goat was in the boot Tunde", 8.5), say("the Yemi Aki Nola abeg go and greet her", 12.5));
    const words = filmWordsAgainstScript(scene, heard, NAMES)!;
    assert.deepEqual(words.lines.map((line) => line.said), ["as-written", "not-heard", "as-written", "by-sound", "not-heard", "not-heard", "not-heard", "not-heard"]);
    assert.deepEqual([words.lines[1]!.heardWords, words.lines[1]!.words, words.lines[4]!.heardWords], [7, 12, 0]);
    assert.deepEqual(filmWordFindings(scene, words), [
      "Line 2 \"Ade, I am telling you. The goat looked at me li…\" is barely heard at 0:02.4: 7 of its 12 words; listen to it.",
      "Lines 5 to 8 are not heard (4 lines).",
    ]);
    // Two lines in a row with nothing heard are still named each.
    const short = scene.slice(0, 6), two = filmWordFindings(short, filmWordsAgainstScript(short, heard, NAMES)!);
    assert.deepEqual(two.slice(1), ["Line 5 \"Good evening.\" is not heard.", "Line 6 \"Sit, if you are going to stand there.\" is not heard."]);
  });

  it("a line heard only where no word could be timed is said without a time", () => {
    // A stretch read as text alone: its words have no times, and are never sure enough to be words nobody wrote.
    const untimed = [{ text: "The goat was in the boat today la la la", startSec: null, probability: 0 }];
    const heard = [...say("It is not possible", .2), ...say("Ade I am telling you the goat looked at me like this", 2.4), ...untimed, ...say("the Yemi Aki Nola abeg go and greet her", 12.5)];
    const words = filmWordsAgainstScript(LINES, heard, NAMES)!;
    assert.deepEqual([words.lines[2]!.said, words.lines[2]!.startSec, words.unwritten], ["partly", null, []]);
    assert.deepEqual(filmWordFindings(LINES, words, shotAt), ["Line 3: nothing like the name tunde is heard; listen to it."]);
  });

  it("a word found by sound has a time: a name heard under the line's own shot keeps a split cut from reading as a lost line", () => {
    // The name is heard in the recogniser's spelling under shot 3, and the rest of the line under shot 4.
    const name: FilmLine[] = [...LINES.slice(0, 2), { number: 3, shot: 3, text: "Adeyemi Akinola, go and greet her." }];
    const heard = film(say("It is not possible", .2), say("Ade I am telling you the goat looked at me like this", 2.4), say("the Yemi Aki Nola", 11), say("go and greet her", 12.3));
    const words = filmWordsAgainstScript(name, heard, NAMES)!;
    assert.deepEqual([words.lines[2]!.said, words.lines[2]!.startSec, words.lines[2]!.endSec], ["by-sound", 11, 13.2]);
    assert.deepEqual(filmWordFindings(name, words, shotAt), []);
  });

  it("places a line's end at the middle of its last word, when the reader measured where the word stops", () => {
    const lines: FilmLine[] = [{ number: 1, shot: 1, text: "It is not possible." }, { number: 2, shot: 2, text: "Stop." }];
    const at = (seconds: number) => (seconds < 2 ? 1 : 2);
    const found = (startSec: number, endSec: number) => filmWordFindings(lines, filmWordsAgainstScript(lines, [...say("It is not possible", .2, .2), { text: "Stop", startSec, endSec, probability: .9 }], NAMES)!, at);
    // Held to the word's start alone, a word begun a fifth of a second before its own shot read as wholly under the shot before (codex on PR 3333).
    assert.deepEqual(found(1.8, 2.3), [], "begun under the shot before, said under its own");
    assert.deepEqual(found(1.2, 1.5), ["Line 2 is heard at 0:01.2 under shot 1, not its own shot 2."]);
    // A read's last word can be given an end later than its own: its middle still falls before the cut.
    assert.deepEqual(found(1.2, 2.4), ["Line 2 is heard at 0:01.2 under shot 1, not its own shot 2."]);
  });

  it("a shot shown in two clips of the cut says its line once, under either of them or over the insert between", () => {
    // Shot 2 of the cut is split round an insert: the line belongs to shots 2 and 4, with shot 3 between them.
    const split: FilmLine[] = [LINES[0]!, { ...LINES[1]!, shots: [2, 4] }];
    const at = (seconds: number) => (seconds < 2 ? 1 : seconds < 4 ? 2 : seconds < 6 ? 3 : seconds < 10 ? 4 : 5);
    const under = (from: number) => filmWordFindings(split, filmWordsAgainstScript(split, film(say("It is not possible", .2), say("Ade I am telling you the goat looked at me like this", from, .1)), NAMES)!, at);
    assert.deepEqual(under(6.5), [], "wholly under its second clip");
    assert.deepEqual(under(4.5), [], "over the insert between its two clips");
    assert.deepEqual(under(10.5), ["Line 2 is heard at 0:10.5 under shot 5, not its own shot 2."]);
  });

  it("a long line half heard names a few of its missing words, and no finding outgrows a receipt", () => {
    const long = Array.from({ length: 100 }, (_, i) => `word${String(i).padStart(3, "0")}x`);
    const line: FilmLine[] = [{ number: 1, shot: null, text: long.join(" ") }];
    const words = filmWordsAgainstScript(line, say(long.slice(0, 60).join(" "), 0, .1), NAMES)!;
    assert.equal(words.lines[0]!.said, "partly"); assert.equal(words.lines[0]!.missing.length, 40);
    const [finding] = filmWordFindings(line, words);
    assert.equal(finding, `Line 1 is partly heard at 0:00.0: not heard, ${long.slice(60, 68).join(" ")} and 32 more.`);
    // Whatever a word is, a finding is held to the 300 characters a receipt takes.
    const wide: FilmLine[] = [{ number: 1, shot: null, text: `heard ${"w".repeat(80)} ${"x".repeat(80)} ${"y".repeat(80)} ${"z".repeat(80)} one two three four five six` }];
    const held = filmWordFindings(wide, filmWordsAgainstScript(wide, say("heard one two three four five six", 0), NAMES)!);
    assert.ok(held.length === 1 && held[0]!.length === 300 && held[0]!.endsWith("…"), `${held[0]!.length}`);
  });

  it("does not take a lone short word for a voice, and does take a lone word that is one", () => {
    const lone = (text: string) => filmWordsAgainstScript(LINES, film(say("It is not possible", .2), [{ text, startSec: 1.6, probability: .95 }],
      say("Ade I am telling you the goat looked at me like this", 2.4), say("The goat was in the boot Tunde", 8.5), say("the Yemi Aki Nola abeg go and greet her", 12.5)), NAMES)!.unwritten;
    assert.deepEqual(lone("I"), []);
    assert.deepEqual(lone("stop"), [{ atSec: 1.6, text: "stop" }]);
  });

  it("does not take a breath for a voice, and refuses a film too long to set beside its script", () => {
    const heard = film(say("It is not possible", .2), [{ text: "mm", startSec: 1.6, probability: .3 }], say("Ade I am telling you the goat looked at me like this", 2.4), say("The goat was in the boot Tunde", 8.5), say("the Yemi Aki Nola abeg go and greet her", 12.5));
    assert.deepEqual(filmWordsAgainstScript(LINES, heard, NAMES)!.unwritten, []);
    const long = Array.from({ length: 5000 }, (_, i) => ({ number: i + 1, shot: null, text: "one two three four five" }));
    assert.equal(filmWordsAgainstScript(long, say(Array.from({ length: 5000 }, () => "word").join(" "), 0), NAMES), null);
  });
});
