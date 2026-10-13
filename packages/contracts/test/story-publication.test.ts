import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emDashSuggestions, publicationTextProblems, StoryPublicationSettingsSchema } from "../src/story-publication.js";

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
});
