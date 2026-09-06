import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isManuscriptLanguage, MANUSCRIPT_CAPS, manuscriptChapters, manuscriptDocument, paragraphRuns, runsToMarkdown, type StructuredDocument } from "../src/manuscript.js";

/**
 * A manuscript out and in (design turn 131, issue 915, SPEC-012 R-49, R-50): the little
 * Markdown a novelist types becomes runs and comes back as the same Markdown; chapters are
 * found by the heading level the document uses, and what is above it is left out.
 */

describe("the manuscript a production exports (R-49)", () => {
  it("takes the chapters with prose in order, leaves the planned ones out and counts them, and splits paragraphs into runs", () => {
    const doc = manuscriptDocument({
      title: "The ledger of nights",
      worldName: "The Undersong",
      chapters: [
        { title: "Neap", body: "Maren counted the *bells* the way her mother had\ntaught her.\n\n***\n\nSix, and the **tide** not called." },
        { title: "Her own hand", body: "" },
        { title: "Only breaks", body: "***\n\n* * *" },
        { title: "The same ink", body: "Odile's hand and the correction's are one hand." },
      ],
    });
    assert.equal(doc.title, "The ledger of nights");
    assert.equal(doc.subtitle, "The Undersong");
    assert.equal(doc.leftOut, 2, "a chapter with no words, and one of only scene breaks (codex on PR 924)");
    assert.deepEqual(doc.chapters.map((chapter) => chapter.title), ["Neap", "The same ink"]);
    assert.deepEqual(doc.chapters[0]!.blocks, [
      { kind: "paragraph", runs: [{ text: "Maren counted the " }, { text: "bells", italic: true }, { text: " the way her mother had taught her." }] },
      { kind: "break" },
      { kind: "paragraph", runs: [{ text: "Six, and the " }, { text: "tide", bold: true }, { text: " not called." }] },
    ]);
    assert.equal(doc.words, doc.chapters.reduce((sum, chapter) => sum + chapter.words, 0));
  });

  it("reads emphasis the way a novelist types it, and nothing else", () => {
    assert.deepEqual(paragraphRuns("_quiet_ and __loud__"), [{ text: "quiet", italic: true }, { text: " and " }, { text: "loud", bold: true }]);
    assert.deepEqual(paragraphRuns("snake_case stays, café_au too, and a * alone"), [{ text: "snake_case stays, café_au too, and a * alone" }], "an underscore in a word is a letter; a lone star is a star");
    assert.deepEqual(paragraphRuns("# not a heading"), [{ text: "# not a heading" }], "a # line is a line");
    assert.deepEqual(paragraphRuns("say \\*required\\* aloud"), [{ text: "say *required* aloud" }], "a backslash keeps a star a star (codex on PR 916)");
  });

  it("writes runs back as the Markdown the chapter keeps, with literal marks escaped", () => {
    assert.equal(runsToMarkdown([{ text: "Maren said " }, { text: "no", italic: true }, { text: "." }]), "Maren said *no*.");
    assert.equal(runsToMarkdown([{ text: " spaced ", bold: true }]), " **spaced** ", "the edges' spaces stay outside the marks");
    assert.equal(runsToMarkdown([{ text: "a *star* and an under_score" }]), "a \\*star\\* and an under\\_score");
    assert.deepEqual(paragraphRuns(runsToMarkdown([{ text: "both", bold: true, italic: true }, { text: " ways" }])), [{ text: "both", bold: true, italic: true }, { text: " ways" }], "bold and italic together round-trip (codex on PR 924)");
    assert.deepEqual(paragraphRuns(runsToMarkdown([{ text: "a *star*" }, { text: "loud", bold: true }])), [{ text: "a *star*" }, { text: "loud", bold: true }], "and reads back as it was");
  });
});

const heading = (style: string, text: string) => ({ style, runs: [{ text }] });
const para = (text: string, flags: { italic?: true; bold?: true } = {}) => ({ runs: [{ text, ...flags }] });

describe("the language an EPUB is marked with (R-52)", () => {
  it("is the subtitles' tag rule, with no subtag said twice (codex on PR 924)", () => {
    for (const tag of ["en", "en-GB", "pt-BR", "sr-Latn-RS", "zh-yue-Hant-HK", "en-GB-oed"]) assert.ok(isManuscriptLanguage(tag), tag);
    for (const tag of ["English", "en-US-US", "e", ""]) assert.equal(isManuscriptLanguage(tag), false, tag);
  });
});

describe("the chapters an import finds (R-50)", () => {
  it("one Title over Heading 1 chapters: the title is the book's, the chapters are the headings (codex on PR 916)", () => {
    const document: StructuredDocument = {
      paragraphs: [heading("Title", "The ledger of nights"), heading("Heading1", "Neap"), para("Maren counted the bells."), heading("Heading1", "The same ink"), para("One ", { italic: true }), para("hand.")],
    };
    const read = manuscriptChapters(document, "Draft 3.docx");
    assert.ok(read.ok);
    assert.equal(read.headingLevel, "Heading 1");
    assert.equal(read.leftOut, 1, "the book's name is left out and counted");
    assert.deepEqual(read.chapters.map((chapter) => chapter.title), ["Neap", "The same ink"]);
    assert.equal(read.chapters[1]!.body, "*One*\n\nhand.");
  });

  it("Heading 1 parts over Heading 2 chapters: the deepest level used twice is the chapter level", () => {
    const document: StructuredDocument = {
      paragraphs: [
        heading("Heading1", "Part one"),
        heading("Heading2", "Neap"),
        para("Six bells."),
        heading("Heading2", "Slack water"),
        para("Cold stone."),
        heading("Heading1", "Part two"),
        heading("Heading2", "The same ink"),
        para("One hand."),
        heading("Heading3", "A subheading inside the chapter"),
      ],
    };
    const read = manuscriptChapters(document, "parts.docx");
    assert.ok(read.ok);
    assert.equal(read.headingLevel, "Heading 2");
    assert.equal(read.leftOut, 2, "both part headings");
    assert.deepEqual(read.chapters.map((chapter) => chapter.title), ["Neap", "Slack water", "The same ink"]);
    assert.match(read.chapters[2]!.body, /A subheading inside the chapter/, "a heading below the chapter level is text");
  });

  it("no headings is one chapter titled by the file; one heading titles the one chapter; a page break or a line of stars is a scene break", () => {
    const plain = manuscriptChapters({ paragraphs: [para("Just words."), { runs: [{ text: "More words." }], pageBreak: true }, para("* * *"), para("After.")] }, "Draft 3.docx");
    assert.ok(plain.ok);
    assert.equal(plain.headingLevel, null);
    assert.deepEqual(plain.chapters.map((chapter) => chapter.title), ["Draft 3"]);
    assert.equal(plain.chapters[0]!.body, "Just words.\n\nMore words.\n\n***\n\nAfter.", "one break where the page break and the stars stood together");
    const libre = manuscriptChapters({ paragraphs: [heading("Heading_20_1", "Neap"), para("A."), heading("Heading_20_1", "Slack water"), para("B.")] }, "libre.docx");
    assert.ok(libre.ok);
    assert.deepEqual(libre.chapters.map((chapter) => chapter.title), ["Neap", "Slack water"], "LibreOffice's spelling of Heading 1 (codex on PR 924)");
    const subtitles = manuscriptChapters({ paragraphs: [heading("Subtitle", "One"), para("A."), heading("Subtitle", "Two"), para("B.")] }, "subs.docx");
    assert.ok(subtitles.ok);
    assert.deepEqual(subtitles.chapters.map((chapter) => chapter.title), ["subs"], "a subtitle is never guessed as the chapter level");
    const one = manuscriptChapters({ paragraphs: [heading("Title", "The book"), heading("Heading1", "Only chapter"), para("Words.")] }, "one.docx");
    assert.ok(one.ok);
    assert.deepEqual(one.chapters.map((chapter) => chapter.title), ["Only chapter"]);
    assert.equal(one.leftOut, 1);
  });

  it("prose after a part heading, before its first chapter, is a chapter titled by the part (codex on PR 916)", () => {
    const document: StructuredDocument = {
      paragraphs: [heading("Heading1", "Part one"), para("An epigraph for the part."), heading("Heading2", "Neap"), para("Bells."), heading("Heading1", "Part two"), heading("Heading2", "Slack water"), para("Cold.")],
    };
    const read = manuscriptChapters(document, "parts.docx");
    assert.ok(read.ok);
    assert.deepEqual(read.chapters.map((chapter) => [chapter.title, chapter.body]), [["Part one", "An epigraph for the part."], ["Neap", "Bells."], ["Slack water", "Cold."]]);
    assert.equal(read.leftOut, 1, "the bare part heading only");
  });

  it("escapes the stars and underscores a Word file holds as characters, and refuses by the count", () => {
    const words = manuscriptChapters({ paragraphs: [para("*required*, and a_b"), para("~~gone~~"), para("==="), para("2. not a list")] }, "w.docx");
    assert.ok(words.ok);
    assert.equal(words.chapters[0]!.body, "\\*required\\*, and a\\_b\n\n\\~\\~gone\\~\\~\n\n\\===\n\n2\\. not a list");
    // An empty heading starts nothing; the whole document is a choice of its own (codex on PR 916).
    const blanks = manuscriptChapters({ paragraphs: [heading("Heading1", ""), heading("Heading1", "  "), para("Only words.")] }, "blank.docx");
    assert.ok(blanks.ok);
    assert.deepEqual(blanks.chapters.map((chapter) => chapter.title), ["blank"]);
    const scenes = manuscriptChapters({ paragraphs: [heading("Heading1", "Scene one"), para("A."), heading("Heading1", "Scene two"), para("B.")] }, "scenes.docx", "document");
    assert.ok(scenes.ok);
    assert.deepEqual(scenes.chapters.map((chapter) => [chapter.title, chapter.body]), [["scenes", "Scene one\n\nA.\n\nScene two\n\nB."]]);
    assert.ok(scenes.levels.some((entry) => entry.level === "document" && entry.chosen));
    const many = manuscriptChapters({ paragraphs: Array.from({ length: MANUSCRIPT_CAPS.chapters + 1 }, (_, i) => [heading("Heading1", `Chapter ${i}`), para("Words.")]).flat() }, "many.docx");
    assert.equal(many.ok, false);
    assert.match((many as { reason: string }).reason, /past the 200/);
    const empty = manuscriptChapters({ paragraphs: [heading("Heading1", "Nothing"), para("   ")] }, "empty.docx");
    assert.equal(empty.ok, false);
    assert.match((empty as { reason: string }).reason, /no text/);
  });
});
