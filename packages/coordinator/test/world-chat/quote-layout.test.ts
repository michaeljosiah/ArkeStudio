import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { locateQuote } from "../../src/world-chat/evidence.js";

/**
 * A quotation claims "these words, in this order, are in this entity" — not "these bytes".
 *
 * Found by driving on 2026-08-21: canon bodies are markdown wrapped at about ninety-five
 * columns, so any sentence quoted across a wrap arrived with a space where the file had a
 * newline, and a byte-exact match refused it. Two well-grounded season answers died in a row,
 * and the harder the model tried to quote real canon the more certainly it failed.
 */

const WRAPPED = [
  "Beneath the harbour lies a drowned god, and it is still singing. The song is slow",
  "— one verse a season — and the town has learned to live beside it.",
].join("\n");

describe("a quotation is matched by its words, not its layout", () => {
  it("finds a quote that crosses a line wrap", () => {
    const span = locateQuote(WRAPPED, "The song is slow — one verse a season");
    assert.ok(span, "the words are all there, in order");
    assert.equal(
      WRAPPED.slice(span.start, span.end).replace(/\s+/g, " "),
      "The song is slow — one verse a season",
    );
  });

  it("forgives the typographic forms of quotes and dashes", () => {
    const curly = "She said “the ledger is never wrong” and meant it — twice.";
    assert.ok(locateQuote(curly, '"the ledger is never wrong"'), "straight quotes find curly ones");
    assert.ok(locateQuote(curly, "meant it - twice"), "a hyphen finds an em dash");
  });

  it("still refuses words that are not there", () => {
    assert.equal(locateQuote(WRAPPED, "the god was never singing"), null);
    assert.equal(locateQuote(WRAPPED, "singing slow song the"), null, "order is part of the claim");
    assert.equal(locateQuote(WRAPPED, "a drowned god, and it is still humming"), null);
  });

  it("returns a span in the original text, so stored offsets point at the real words", () => {
    const span = locateQuote(WRAPPED, "one verse a season");
    assert.ok(span);
    assert.equal(WRAPPED.slice(span.start, span.end), "one verse a season");
  });

  it("an empty or whitespace-only quotation is not a citation", () => {
    assert.equal(locateQuote(WRAPPED, ""), null);
    assert.equal(locateQuote(WRAPPED, "   \n  "), null);
  });
});
