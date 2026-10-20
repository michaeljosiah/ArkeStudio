import assert from "node:assert/strict";
import { test } from "node:test";
import { storyPublicationFileFilter } from "../src/story-publication-file.js";

test("PDF save and Locate select a PDF book while retaining EPUB and audiobook filters", () => {
  assert.deepEqual(storyPublicationFileFilter("story.pdf"), { name: "PDF book", extensions: ["pdf"] });
  assert.deepEqual(storyPublicationFileFilter("story.epub")?.extensions, ["epub"]);
  assert.deepEqual(storyPublicationFileFilter("story.m4b")?.extensions, ["m4b"]);
  for (const name of ["../story.pdf", "story.pdf.exe", "story.PDF", "other.pdf", "C:/private/story.pdf"]) assert.equal(storyPublicationFileFilter(name), null);
});
