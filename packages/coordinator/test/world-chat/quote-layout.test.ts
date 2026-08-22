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

/**
 * The forgiveness has an edge, and the edge is the paragraph (review 2026-08-22). Folding every
 * whitespace run to one space let a "quotation" stitch the end of one paragraph to the start of
 * another — two claims the source makes separately, presented as one continuous sentence it
 * never makes. A blank line is authored structure, not layout.
 */
describe("a paragraph break is a hard boundary", () => {
  const TWO_PARAS = "The god sleeps under the harbour.\n\nThe ledger is kept in saltlight ink.";

  it("refuses a quotation stitched across a paragraph break", () => {
    assert.equal(locateQuote(TWO_PARAS, "under the harbour. The ledger is kept"), null);
  });

  it("still finds whole words inside one paragraph", () => {
    assert.ok(locateQuote(TWO_PARAS, "kept in saltlight ink"));
    assert.ok(locateQuote(TWO_PARAS, "The god sleeps under the harbour."));
  });

  it("a single newline is a wrap, not a boundary", () => {
    assert.ok(locateQuote("kept in\nsaltlight ink", "kept in saltlight ink"));
  });

  it("three newlines are also a boundary", () => {
    assert.equal(locateQuote("one end.\n\n\nanother start", "one end. another start"), null);
  });

  it("a blank line with stray spaces on it is still a boundary", () => {
    assert.equal(locateQuote("one end.\n  \nanother start", "one end. another start"), null);
  });

  it("the seam quotableText leaves between sheet fields refuses a cross-field stitch", () => {
    // Sheet fields are joined "title\n\nbody" for exactly this reason: the join is a boundary,
    // so a quote spanning two fields cannot verify as one continuous claim.
    const joined = ["Appearance: silver scales.", "Voice: low and patient."].join("\n\n");
    assert.equal(locateQuote(joined, "silver scales. Voice: low"), null);
  });
});

describe("the fold table covers the marks writers actually type", () => {
  it("a non-breaking hyphen (U+2011) matches a plain hyphen", () => {
    assert.ok(locateQuote("a well‑kept secret", "a well-kept secret"));
  });

  it("low-9 and guillemet quotes match plain ones", () => {
    assert.ok(locateQuote("„so it goes”, she wrote", '"so it goes"'));
    assert.ok(locateQuote("«so it goes», she wrote", '"so it goes"'));
  });

  it("figure dash and horizontal bar match a hyphen", () => {
    assert.ok(locateQuote("pages 3‒4", "pages 3-4"));
    assert.ok(locateQuote("said ― twice", "said - twice"));
  });
});
