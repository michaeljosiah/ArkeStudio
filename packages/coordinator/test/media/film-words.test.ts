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
      "Line 4: nothing like the name adeyemi akinola is heard (the line is at 0:14.3); listen to it.",
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
