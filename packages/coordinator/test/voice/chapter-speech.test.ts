import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chapterProseSpeech } from "../../src/voice/service.js";

/**
 * A chapter as speech (design turn 126, issue 874): whole, or one paragraph named by index.
 * The chapter arrives already read — the arm is resolved off disk by the coordinator, because
 * the body is not in the bundle — so this stays the pure function the other resolvers are.
 */
const CHAPTER = {
  title: "Neap",
  version: 4,
  body: "Maren counted the bells.\n\nSix, and the tide not yet called.\n\n\nShe let the seventh go by.\n",
};

describe("a chapter reads whole or a paragraph at a time", () => {
  it("the whole chapter is one block named by its title", () => {
    const spoken = chapterProseSpeech(CHAPTER, { of: "chapter", productionId: "inkbound", chapterId: "neap" });
    assert.equal(spoken.heading, "Neap");
    assert.equal(spoken.version, 4);
    assert.equal(spoken.subjectId, "inkbound/chapters/neap");
    assert.match(spoken.text, /Maren counted the bells/);
    assert.match(spoken.text, /seventh go by/);
  });

  it("a paragraph is its own block, positioned in the chapter", () => {
    const second = chapterProseSpeech(CHAPTER, { of: "chapter", productionId: "inkbound", chapterId: "neap", paragraph: 1 });
    assert.equal(second.text, "Six, and the tide not yet called.");
    assert.equal(second.heading, "Neap · 2 of 3");
    // Two paragraphs of one chapter must not share a queue row or a cache target.
    assert.equal(second.subjectId, "inkbound/chapters/neap#1");
    const third = chapterProseSpeech(CHAPTER, { of: "chapter", productionId: "inkbound", chapterId: "neap", paragraph: 2 });
    assert.notEqual(third.subjectId, second.subjectId);
  });

  it("refuses a paragraph the saved chapter does not have, by name", () => {
    assert.throws(
      () => chapterProseSpeech(CHAPTER, { of: "chapter", productionId: "inkbound", chapterId: "neap", paragraph: 3 }),
      /not in the saved chapter/,
    );
  });

  it("an empty chapter has nothing to read", () => {
    assert.throws(
      () => chapterProseSpeech({ ...CHAPTER, body: "\n\n" }, { of: "chapter", productionId: "inkbound", chapterId: "neap" }),
      /Nothing to read yet/,
    );
  });
});
