import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProseReadSourceSchema, chapterParagraphs, countWords, targetWords } from "../src/prose.js";

/**
 * The chapter arm and its helpers (design turn 126, issue 874). The helpers are shared by the
 * editor and the coordinator on purpose: a page read names paragraphs by index, so both ends
 * must split the same way or the position would name one paragraph and the voice read another.
 */
describe("a chapter is prose the read-aloud can address", () => {
  it("is addressed by id, whole or one paragraph at a time", () => {
    assert.ok(ProseReadSourceSchema.safeParse({ of: "chapter", productionId: "inkbound", chapterId: "neap" }).success);
    assert.ok(
      ProseReadSourceSchema.safeParse({ of: "chapter", productionId: "inkbound", chapterId: "neap", paragraph: 3 }).success,
    );
    assert.equal(
      ProseReadSourceSchema.safeParse({ of: "chapter", productionId: "inkbound", chapterId: "neap", paragraph: -1 }).success,
      false,
      "a paragraph is counted from zero, never below it",
    );
    assert.equal(
      ProseReadSourceSchema.safeParse({ of: "chapter", productionId: "inkbound", chapterId: "neap", body: "words" }).success,
      false,
      "the words never travel: an address carries no body",
    );
  });

  it("paragraphs split on blank lines, trim, and drop the empties", () => {
    assert.deepEqual(chapterParagraphs("One.\n\nTwo\nstill two.\r\n\r\n\n  \n\nThree.\n"), ["One.", "Two\nstill two.", "Three."]);
    assert.deepEqual(chapterParagraphs(""), []);
    assert.deepEqual(chapterParagraphs("\n\n   \n"), []);
  });

  it("counts words the way every surface shows them", () => {
    assert.equal(countWords(""), 0);
    assert.equal(countWords("   \n "), 0);
    assert.equal(countWords("Six, and the tide not yet called."), 7);
  });

  it("the target band draws only when the target says how many words", () => {
    assert.equal(targetWords("80,000 words"), 80_000);
    assert.equal(targetWords("about 90k"), 90_000);
    assert.equal(targetWords("80k words"), 80_000);
    assert.equal(targetWords("one book, 75000 words, no more"), 75_000);
    assert.equal(targetWords("three acts, a short novel"), null);
    assert.equal(targetWords(undefined), null);
    assert.equal(targetWords(""), null);
    // A bare figure or a page count says nothing about words, so nothing is drawn (codex, PR 879).
    assert.equal(targetWords("75000"), null);
    assert.equal(targetWords("300 pages"), null);
    assert.equal(targetWords("24 chapters"), null);
    // A figure too small to be a book's length is a number in a sentence.
    assert.equal(targetWords("12 words"), null);
  });
});
