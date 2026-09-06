import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProseReadSourceSchema, chapterParagraphs, countWords, overviewMoved, targetWords } from "../src/prose.js";
import { ChapterFrontmatterSchema, ChapterImpliesWriteSchema, ChapterSummarySchema } from "../src/world.js";
import { ClientMessageSchema } from "../src/frames.js";

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

  it("the overview moved only for a drafted chapter stamped below the current version (turn 127)", () => {
    assert.equal(overviewMoved({ words: 1900, draftedAgainst: 2 }, { version: 3 }), true);
    assert.equal(overviewMoved({ words: 1900, draftedAgainst: 3 }, { version: 3 }), false);
    assert.equal(overviewMoved({ words: 0, draftedAgainst: 2 }, { version: 3 }), false, "a planned chapter is against nothing yet");
    assert.equal(overviewMoved({ words: 1900 }, { version: 3 }), false, "typing never stamps, so an unstamped chapter is never stale");
    assert.equal(overviewMoved({ words: 1900, draftedAgainst: 2 }, null), false);
  });

  it("the plan reads unbounded and writes bounded (turn 127)", () => {
    const long = "x".repeat(700);
    assert.ok(ChapterFrontmatterSchema.safeParse({ id: "neap", title: "Neap", version: 1, synopsis: long, implies: [{ kind: "canon", what: long }] }).success, "a long synopsis never drops a chapter from the scan");
    assert.ok(ChapterSummarySchema.safeParse({ id: "neap", file: "01-neap", order: 1, title: "Neap", status: "planned", version: 1, synopsis: long, pov: "maren-kest", when: "Neap", implies: [], draftedAgainst: 2 }).success);
    assert.equal(ChapterImpliesWriteSchema.safeParse([{ kind: "canon", what: long }]).success, false, "a fact is at most 300 characters");
    assert.equal(ChapterImpliesWriteSchema.safeParse(Array.from({ length: 13 }, () => ({ kind: "canon", what: "x" }))).success, false, "at most twelve facts");
    const plan = { kind: "edit-chapter-plan", worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC", productionId: "inkbound", chapterFile: "01-neap" };
    assert.ok(ClientMessageSchema.safeParse({ ...plan, changes: { synopsis: "What this chapter is for.", pov: null } }).success);
    assert.equal(ClientMessageSchema.safeParse({ ...plan, changes: {} }).success, false, "a plan edit changes something");
    assert.equal(ClientMessageSchema.safeParse({ ...plan, changes: { synopsis: long } }).success, false, "a synopsis is at most 600 characters");
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
