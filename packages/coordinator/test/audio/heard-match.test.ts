import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { alignWords, annotations, matchToken, phoneticFold, textTokens, tokenSimilarity, SIMILAR, SIMILAR_LOOSE } from "../../src/audio/heard-match.js";

/**
 * Heard words against written ones (2026-10-03): how an English whisper's mishearing of a
 * Nigerian name, a Yoruba word or a Pidgin phrase reads on the page, and the matching that lets
 * the grouped split see through it.
 */
describe("heard words against written ones (2026-10-03)", () => {
  it("sets aside case, punctuation, accents and the digits whisper writes for numbers", () => {
    assert.equal(matchToken("“Ọlọ́run,"), "olorun");
    assert.deepEqual(textTokens("Lekki Phase One"), textTokens("Lekki Phase 1"));
    assert.deepEqual(textTokens("in 2004"), ["in", "two", "thousand", "four"]);
    assert.deepEqual(textTokens("the Lekki-Ikoyi link"), ["the", "lekki", "ikoyi", "link"]);
  });

  it("finds a name heard as an English word close in spelling or in sound, and not an unrelated word", () => {
    for (const [written, heard] of [["tunde", "sunday"], ["goat", "good"], ["ade", "addy"], ["ilesha", "elesha"], ["tunde", "tundi"], ["olorun", "oloroon"]] as const) {
      assert.ok(tokenSimilarity(written, heard) >= SIMILAR, `${written} as ${heard}: ${tokenSimilarity(written, heard)}`);
    }
    assert.equal(phoneticFold("goat"), phoneticFold("good"));
    // A name may be further off ("Ade" as "at"), never anything at all.
    assert.ok(tokenSimilarity("ade", "at") >= SIMILAR_LOOSE);
    assert.ok(tokenSimilarity("ade", "to") < SIMILAR_LOOSE);
    assert.ok(tokenSimilarity("both", "dead") < SIMILAR);
    assert.ok(tokenSimilarity("glass", "window") < SIMILAR_LOOSE);
  });

  it("aligns a word heard as two and two heard as one, and prefers an exact word to a joined one", () => {
    const show = (written: string, heard: string, loose: string[] = []) => {
      const w = textTokens(written);
      const h = textTokens(heard);
      return alignWords(w, h, { loose: (at) => loose.includes(w[at]!) }).map((match) => `${w.slice(match.w, match.w + match.wn).join("+")}=${h.slice(match.h, match.h + match.hn).join("+")}`);
    };
    assert.deepEqual(show("Goodnight, palm tree.", "Good night, palm tree."), ["goodnight=good+night", "palm=palm", "tree=tree"]);
    assert.deepEqual(show("said Tunde.", "Saitundi.", ["tunde"]), ["said+tunde=saitundi"]);
    assert.deepEqual(show("It is not possible.", "it's not possible"), ["it+is=its", "not=not", "possible=possible"]);
    assert.ok(show("picked up his glass", "pick top is glass").includes("glass=glass"), "“is glass” is not “glass”");
  });

  it("marks whisper's notes, and leaves a book's italics alone", () => {
    assert.deepEqual(annotations("*laughs* Fine.".split(" ")), [true, false]);
    assert.deepEqual(annotations("the quiet (speaking in foreign language) streets".split(" ")), [false, false, true, true, true, true, false]);
    assert.deepEqual(annotations("[laughs] <chuckle> ok".split(" ")), [true, true, false]);
    assert.deepEqual(annotations("*It was a pleasure to meet you tonight.*".split(" ")).every((marked) => !marked), true);
  });
});
