import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProseReadSourceSchema, changedSpan, chapterParagraphs, countWords, overviewMoved, passageOf, targetWords } from "../src/prose.js";
import { ChapterContinuitySchema, ChapterFrontmatterSchema, ChapterImpliesWriteSchema, ChapterSummarySchema, ChapterVoicesSchema, ProseStyleSchema, summariseContinuity, summariseVoices } from "../src/world.js";
import { occurrencesOf, voicedBlocks } from "../src/prose.js";
import { ClientMessageSchema } from "../src/frames.js";

/**
 * The craft loop (design turn 128, issue 896): the passage a revision changed is drawn from the
 * two texts, never carried twice, and the style is a record beside the overview.
 */
describe("the passage a revision changed (turn 128)", () => {
  const body = "Maren counted the bells.\n\nIt did not decide. The seventh bell rang again, not the echo of the sixth. Nobody had called it.\n\nThat is not how it works.";

  it("is the one span two texts differ in, pulled back to word boundaries", () => {
    const after = body.replace("rang again, not the echo of the sixth", "rang again, its own note this time");
    const span = changedSpan(body, after);
    assert.ok(span);
    assert.equal(span.before, "not the echo of the sixth.");
    assert.equal(span.after, "its own note this time.");
    assert.equal(body.slice(0, span.start) + span.after + body.slice(span.start + span.before.length), after, "the span reassembles the after text");
    assert.equal(changedSpan(body, body), null, "the same text has no span");
  });

  it("tells a passage from a draft: one span inside an untouched chapter is a passage, a body replaced whole is not", () => {
    const after = body.replace("Nobody had called it.", "Nobody called it.");
    const passage = passageOf(body, after);
    assert.ok(passage);
    // The span is the words that differ, whole: `had` went, and `called` is the word it sat in
    // front of, so both sides carry it rather than beginning a span at a word's edge.
    assert.equal(passage.before, "had called");
    assert.equal(passage.after, "called");
    assert.equal(passageOf(body, "Drafted anew.\n\nFrom the seventh bell."), null, "a body replaced whole is a draft");
    assert.equal(passageOf("", body), null, "a body drafted from nothing is a draft");
    assert.equal(passageOf(null, body), null, "and so is one whose before the review does not carry");
    assert.equal(passageOf(body, body), null);
  });

  it("the style record parses and its two readable pieces are addressable", () => {
    assert.ok(ProseStyleSchema.safeParse({ version: 2, pov: "close third", tense: "past", voice: "Short declaratives.", samples: ["Six, and the tide not yet called."] }).success);
    assert.ok(ProseStyleSchema.safeParse({ version: 1 }).success, "a record with nothing settled yet still parses");
    assert.equal(ProseStyleSchema.safeParse({ version: 1, mood: "dark" }).success, false, "nothing outside the record");
    for (const field of ["voice", "samples"]) {
      assert.ok(ProseReadSourceSchema.safeParse({ of: "story", productionId: "inkbound", field }).success, `${field} reads aloud`);
    }
    assert.equal(ProseReadSourceSchema.safeParse({ of: "story", productionId: "inkbound", field: "pov" }).success, false, "point of view is a label, not a listen");
    assert.ok(ProseReadSourceSchema.safeParse({ of: "story", productionId: "inkbound", field: "samples", sample: 2 }).success, "one sample is its own block");
    assert.equal(ProseReadSourceSchema.safeParse({ of: "story", productionId: "inkbound", field: "samples", sample: -1 }).success, false);
  });
});

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

describe("continuity after a chapter (turn 129, SPEC-012 §2.4.1)", () => {
  it("the record parses with its counts, the summary carries the stamp and the placings, and an unreadable record is its own state", () => {
    const record = {
      version: 4,
      hash: "sha256:x",
      derivedAt: "2026-09-06T12:00:00.000Z",
      passes: 2,
      dropped: 1,
      omitted: 0,
      cut: 0,
      characters: [{ character: "Maren Kest", sheet: "maren-kest", present: true, where: "the-vigil", placed: "Maren stood on the Vigil", knows: ["a line of the chapter"] }],
    };
    assert.ok(ChapterContinuitySchema.safeParse(record).success);
    assert.equal(ChapterContinuitySchema.safeParse({ ...record, characters: [{ character: "x", present: true, knows: [], mood: "dark" }] }).success, false, "nothing outside the record");
    assert.equal(ChapterContinuitySchema.safeParse({ ...record, characters: [{ character: "x", present: true, where: "somewhere", knows: [] }] }).success, false, "a place with no span behind it is no record (codex on PR 907)");
    assert.equal(ChapterContinuitySchema.safeParse({ ...record, characters: [{ character: "x", present: false, knows: [] }] }).success, false, "nor is a departure");
    assert.ok(ChapterContinuitySchema.safeParse({ ...record, characters: [{ character: "x", present: false, placed: "she left", knows: [] }] }).success);
    assert.equal(ChapterContinuitySchema.safeParse({ ...record, characters: [{ character: "x", present: false, where: "the-vigil", placed: "she left", knows: [] }] }).success, false, "a departure has no place (codex on PR 907)");
    const unsure = { ...record, characters: [{ character: "x", present: true, unsure: true as const, knows: [] }] };
    assert.ok(ChapterContinuitySchema.safeParse(unsure).success, "a dropped claim leaves them unsure, with no place (round seven)");
    assert.equal(ChapterContinuitySchema.safeParse({ ...record, characters: [{ character: "x", present: true, unsure: true, where: "the-vigil", placed: "there", knows: [] }] }).success, false, "unsure and placed at once is no record (codex on PR 907)");
    assert.deepEqual(summariseContinuity(unsure).placed, [{ character: "x", present: true, unsure: true }], "and the summary says so, for the table");
    assert.deepEqual(summariseContinuity(record), {
      version: 4,
      hash: "sha256:x",
      derivedAt: "2026-09-06T12:00:00.000Z",
      passes: 2,
      dropped: 1,
      omitted: 0,
      cut: 0,
      placed: [{ character: "Maren Kest", sheet: "maren-kest", present: true, where: "the-vigil" }],
    });
    const summary = { id: "neap", file: "01-neap", order: 1, title: "Neap", status: "drafted", version: 4 };
    assert.ok(ChapterSummarySchema.safeParse({ ...summary, continuity: summariseContinuity(record) }).success, "the stamp and the placings ride on the summary");
    assert.ok(ChapterSummarySchema.safeParse({ ...summary, continuity: { unreadable: true } }).success, "so does the word that a record cannot be read");
    assert.equal(ChapterSummarySchema.safeParse({ ...summary, continuity: record }).success, false, "the lines never do");
  });
});

describe("the cast of lines (turn 130, SPEC-012 §2.4.2)", () => {
  it("the record parses, the summary carries the stamp and the speakers by lines, and the voiced arm is an address with or without a block", () => {
    const record = {
      version: 4,
      hash: "sha256:x",
      derivedAt: "2026-09-06T12:00:00.000Z",
      passes: 1,
      dropped: 0,
      omitted: 0,
      lines: [
        { speaker: "Maren Kest", sheet: "maren-kest", paragraph: 0, occurrence: 0, quote: "“No,”" },
        { speaker: "Odile Sarn", paragraph: 0, occurrence: 1, quote: "“No,”" },
        { speaker: "Maren Kest", sheet: "maren-kest", paragraph: 1, occurrence: 0, quote: "“Six.”" },
      ],
    };
    assert.ok(ChapterVoicesSchema.safeParse(record).success);
    assert.equal(ChapterVoicesSchema.safeParse({ ...record, lines: [{ speaker: "x", paragraph: 0, occurrence: 0, quote: "y", mood: "dark" }] }).success, false, "nothing outside the record");
    assert.deepEqual(summariseVoices(record).speakers, [
      { speaker: "Maren Kest", sheet: "maren-kest", lines: 2 },
      { speaker: "Odile Sarn", lines: 1 },
    ]);
    const summary = { id: "neap", file: "01-neap", order: 1, title: "Neap", status: "drafted", version: 4 };
    assert.ok(ChapterSummarySchema.safeParse({ ...summary, voices: summariseVoices(record) }).success, "the stamp rides on the summary");
    assert.ok(ChapterSummarySchema.safeParse({ ...summary, voices: { unreadable: true } }).success);
    assert.equal(ChapterSummarySchema.safeParse({ ...summary, voices: record }).success, false, "the lines never do");
    assert.ok(ProseReadSourceSchema.safeParse({ of: "chapter-voiced", productionId: "inkbound", chapterId: "neap", block: 3 }).success);
    assert.ok(ProseReadSourceSchema.safeParse({ of: "chapter-voiced", productionId: "inkbound", chapterId: "neap" }).success, "the whole page, expanded by the coordinator");
  });

  it("finds a quote's occurrences with whitespace folded, and splits a paragraph at its lines in order", () => {
    assert.deepEqual(occurrencesOf("No, no,\nno.", "no,"), [{ start: 4, end: 7 }], "matched as words, case and all");
    assert.deepEqual(occurrencesOf("“No,” said Maren. “No,” said Odile.", "“No,”").length, 2);
    const { blocks, ambiguous } = voicedBlocks("Maren looked up. “No,” she said.\n\nOdile went.", {
      lines: [{ speaker: "Maren Kest", sheet: "maren-kest", paragraph: 0, occurrence: 0, quote: "“No,”" }],
    });
    assert.deepEqual(blocks, [
      { paragraph: 0, text: "Maren looked up." },
      { paragraph: 0, text: "“No,”", speaker: "Maren Kest", sheet: "maren-kest" },
      { paragraph: 0, text: "she said." },
      { paragraph: 1, text: "Odile went." },
    ]);
    assert.equal(ambiguous, 0);
  });

  it("a line copied into another paragraph while the original stands is nobody's (codex on PR 914)", () => {
    const record = { lines: [{ speaker: "Maren Kest", sheet: "maren-kest", paragraph: 0, occurrence: 0, quote: "“No,”" }] };
    const copied = voicedBlocks("“No,” she said.\n\n“No,” he said.", record);
    assert.deepEqual(copied.blocks.map((block) => block.speaker ?? null), [null, null], "two spans for one attribution: narration");
    assert.equal(copied.ambiguous, 1);
  });
});
