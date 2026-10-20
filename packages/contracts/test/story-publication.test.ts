import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emDashSuggestions, publicationTextProblems, StoryPublicationSettingsSchema, StoryPdfMetadataSchema, DEFAULT_STORY_PDF_SETTINGS } from "../src/story-publication.js";

describe("private publication formatting review", () => {
  it("finds em dashes without treating hyphens or en dashes as errors", () => {
    const body = "A well-lit room, 2–3 doors.\n\nMaren turned—she knew the voice.\n\n“Ilo—”";
    const suggestions = emDashSuggestions(body);
    assert.equal(suggestions.length, 2);
    assert.equal(suggestions[0]!.paragraph, 1);
    for (const suggestion of suggestions) assert.equal(body.slice(suggestion.start, suggestion.end), suggestion.before);
    assert.equal(suggestions[1]!.suggestion, suggestions[1]!.before, "an interruption is never silently rewritten");
    assert.deepEqual(publicationTextProblems(body), []);
  });
  it("preserves paragraph offsets with CRLF, indentation and repeated blank lines", () => {
    const body = "\r\n  One—two.\r\nWrapped text.\r\n\r\n\r\nNext—last.\r\n";
    const suggestions = emDashSuggestions(body);
    assert.equal(suggestions.length, 2);
    assert.equal(suggestions[1]!.paragraph, 1);
    for (const suggestion of suggestions) assert.equal(body.slice(suggestion.start, suggestion.end), suggestion.before);
  });
  it("refuses lossy XML and unsupported prose constructs, while keeping emphasis and scene breaks", () => {
    assert.equal(publicationTextProblems("bad\u0000text").length, 1);
    assert.equal(publicationTextProblems("bad\ud800text").length, 1);
    assert.equal(publicationTextProblems("# Heading\n\n[link](https://example.com)").length, 1);
    assert.deepEqual(publicationTextProblems("*Soft* and **strong**.\n\n***\n\nLast scene."), []);
  });
  it("requires explicit nonempty unique chapter and output choices", () => {
    const base = { title: "Story", author: "", language: "en", description: "", label: "", cover: null, chapterIds: ["one"], outputs: ["epub"], avoidEmDashes: false };
    assert.ok(StoryPublicationSettingsSchema.safeParse(base).success);
    assert.equal(StoryPublicationSettingsSchema.safeParse({ ...base, chapterIds: [] }).success, false);
    assert.equal(StoryPublicationSettingsSchema.safeParse({ ...base, chapterIds: ["one", "one"] }).success, false);
    assert.equal(StoryPublicationSettingsSchema.safeParse({ ...base, language: "English" }).success, false);
  });
  it("keeps legacy settings unchanged and requires resolved PDF settings without lossy defaults", () => {
    const legacy = { title: "Story", author: "", language: "en", description: "", label: "", cover: null, chapterIds: ["one"], outputs: ["epub"], avoidEmDashes: false };
    assert.deepEqual(StoryPublicationSettingsSchema.parse(legacy), legacy);
    assert.equal(StoryPublicationSettingsSchema.safeParse({ ...legacy, outputs: ["pdf"] }).success, false);
    const pdf = { ...legacy, outputs: ["pdf", "epub", "m4b"], pdf: DEFAULT_STORY_PDF_SETTINGS, subtitle: "A story", editionLabel: "Second draft" };
    assert.ok(StoryPublicationSettingsSchema.safeParse(pdf).success);
    for (const changes of [{ bodySize: 9 }, { lineSpacing: Infinity }, { lineSpacing: 1.7 }, { preset: "screen" }, { version: 2 }, { font: "C:/private/font.ttf" }])
      assert.equal(StoryPublicationSettingsSchema.safeParse({ ...pdf, pdf: { ...pdf.pdf, ...changes } }).success, false);
    assert.equal(StoryPublicationSettingsSchema.safeParse({ ...pdf, outputs: ["pdf", "pdf"] }).success, false);
  });
  it("refuses navigation outside PDF pages and duplicated chapter destinations", () => {
    const chapter = { id: "one", title: "One", pageNumber: 1, physicalPage: 3, destination: "chapter-1" };
    const base = { pageCount: 3, pageLabels: ["Title", "Contents", "1"], chapters: [chapter] };
    assert.ok(StoryPdfMetadataSchema.safeParse(base).success);
    assert.equal(StoryPdfMetadataSchema.safeParse({ ...base, pageLabels: ["1"] }).success, false);
    assert.equal(StoryPdfMetadataSchema.safeParse({ ...base, chapters: [{ ...chapter, physicalPage: 4 }] }).success, false);
    assert.equal(StoryPdfMetadataSchema.safeParse({ ...base, chapters: [chapter, { ...chapter, id: "two" }] }).success, false);
  });
});
