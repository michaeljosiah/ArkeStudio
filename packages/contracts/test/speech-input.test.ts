import assert from "node:assert/strict";
import { it } from "node:test";
import { speechInputFits, speechUtf8Bytes, splitSpeechInput } from "../src/index.js";

it("packs Unicode words and separate style under the same byte bound with exact source offsets", () => {
  const text = "船が来た。 😀 Wait here. 船が来た。 😀 Wait here.";
  const style = "穏やかに";
  const limits = { maxSpeechUtf8Bytes: 35 };
  const parts = splitSpeechInput(text, limits, style);
  assert.ok(parts.length > 1);
  assert.equal(parts.map(part => part.text).join(" "), text);
  let previous = 0;
  for (const part of parts) {
    assert.equal(part.text, text.slice(part.from, part.to));
    assert.match(text.slice(previous, part.from), /^\s*$/);
    assert.ok(speechInputFits(part.text, limits, style));
    assert.ok(!/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/u.test(part.text));
    previous = part.to;
  }
  assert.equal(speechUtf8Bytes("😀船"), 7);
});

it("preserves every code point in long unbroken text and respects a simultaneous character cap", () => {
  const text = "😀海".repeat(33);
  const parts = splitSpeechInput(text, { maxPromptChars: 8, maxSpeechUtf8Bytes: 13 }, "warm");
  assert.equal(parts.map(part => part.text).join(""), text);
  assert.ok(parts.every(part => speechInputFits(part.text, { maxPromptChars: 8, maxSpeechUtf8Bytes: 13 }, "warm")));
});

it("prefers sentence and word seams without dropping punctuation or repeated words", () => {
  assert.deepEqual(splitSpeechInput("One two. Three four. Five six.", { maxSpeechUtf8Bytes: 20 }).map(p => p.text), ["One two. Three four.", "Five six."]);
  assert.deepEqual(splitSpeechInput("one two three four", { maxSpeechUtf8Bytes: 10 }).map(p => p.text), ["one two", "three four"]);
});

it("refuses impossible style and single-code-point budgets instead of truncating or exceeding them", () => {
  assert.throws(() => splitSpeechInput("word", { maxSpeechUtf8Bytes: 4 }, "style"), /no room/);
  assert.throws(() => splitSpeechInput("😀", { maxSpeechUtf8Bytes: 3 }), /cannot fit/);
  assert.throws(() => splitSpeechInput("😀", { maxPromptChars: 1 }), /cannot fit/);
  assert.equal(speechInputFits("船", { maxSpeechUtf8Bytes: 5 }, "calm"), false);
  assert.deepEqual(splitSpeechInput("   ", { maxSpeechUtf8Bytes: 8 }), []);
});
