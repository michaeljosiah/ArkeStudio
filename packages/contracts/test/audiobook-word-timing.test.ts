import assert from "node:assert/strict";
import { it } from "node:test";
import { MEASURED_WORD_TIMING_ENGINE, validateAcousticWords, type AcousticWords } from "../src/audiobook-word-timing.js";

const heard = (text: string): AcousticWords => ({ text, seconds: 10,
  engine: { id: MEASURED_WORD_TIMING_ENGINE, version: "fixture", model: "fixture" },
  words: text.split(" ").map((word, index) => ({ text: word, startSec: index * 0.25, endSec: (index + 1) * 0.25, probability: 0.9 })),
});

it("uses adjoining acoustic intervals for an explicit hyphenated compound without changing its words", () => {
  const input = heard("The well lit door opened.");
  const result = validateAcousticWords("The well-lit door opened.", input);
  assert.ok(result.ok);
  assert.deepEqual(result.words[1], { text: "well-lit", startSec: 0.25, endSec: 0.75, probability: 0.9 });
  assert.equal(result.words.length, 4);
  assert.equal(input.words.length, 5);
  assert.ok(validateAcousticWords("The well-lit door opened.", { ...input, words: result.words }).ok, "saved timing validates on reread");
});

it("keeps real errors and ambiguous or missing acoustic evidence unready", () => {
  for (const [authored, transcript] of [
    ["The well-lit door opened.", "The well door opened."],
    ["The well-lit door opened.", "The well lit lit door opened."],
    ["The well-lit door opened.", "The lit well door opened."],
    ["The well-lit door opened.", "The well lit door"],
    ["The well-lit door opened.", "whisper The well lit door opened."],
    ["The well-lit door did not open.", "The well lit door did open."],
    ["The tide-mark stayed.", "The tied mark stayed."],
    ["The therapist left.", "The the rapist left."],
    ["a-b", "ab extra"],
  ]) assert.equal(validateAcousticWords(authored!, heard(transcript!)).ok, false, transcript);
  for (const patch of [{ probability: 0.49 }, { startSec: 0.6 }, { startSec: 0.4 }, { endSec: 11 }]) {
    const input = heard("The well lit door opened.");
    Object.assign(input.words[2]!, patch);
    assert.equal(validateAcousticWords("The well-lit door opened.", input).ok, false, JSON.stringify(patch));
  }
});
