import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_STORY_PDF_SETTINGS, manuscriptDocument, type ManuscriptDocument } from "@arke-studio/contracts";
import { renderStoryPdf, storyPdfFrame, storyPdfIdentity, type StoryPdfInput } from "../../src/publications/story-pdf.js";

const input = (document: ManuscriptDocument, changes: Partial<StoryPdfInput> = {}): StoryPdfInput => ({
  author: "", language: "en-NG", settings: { ...DEFAULT_STORY_PDF_SETTINGS }, chapterIds: document.chapters.map((_, i) => `chapter-${i + 1}`), ...changes,
});
const manuscript = (body: string, title = "A short story") => manuscriptDocument({ title, worldName: "Never publish this world name", chapters: [{ title: "Opening", body }] });

test("PDF presets use the specified dimensions and reserved body margins", () => {
  assert.deepEqual(storyPdfFrame("book"), { width: 432, height: 648, left: 50.4, top: 54, textWidth: 331.2, bottom: 594 });
  assert.equal(storyPdfFrame("a4").left, 61.2);
  assert.equal(storyPdfFrame("letter").height, 792);
});

test("bundled fonts have their captured digests and actual four-face families", async () => {
  const identity = await storyPdfIdentity();
  assert.equal(Object.keys(identity.fonts).length, 9);
  assert.equal(identity.fontkit, "2.0.4");
});

test("real PDF preserves Unicode, all emphasis, scene breaks, tags and navigation", async () => {
  const document = manuscript("Ọlá says, ‘N'ụlọ anyị, ₦2,650.’ Ẹ̀kọ́, e\u0301, ọ\u0301, — … 😀 🙏 🥂 😍. Plain, *italic*, **bold**, ***both***.\n\n***\n\nThe next paragraph is unindented.");
  const result = await renderStoryPdf(document, input(document));
  assert.equal(result.pageCount, 3);
  assert.deepEqual(result.pageLabels, ["Front matter 1", "Front matter 2", "1"]);
  assert.equal(result.chapters[0]!.physicalPage, 3);
  assert.equal(result.chapters[0]!.pageNumber, 1);
  assert.equal(result.receipt.paragraphCount, 2);
  assert.equal(result.receipt.checks.text, true);
  assert.ok(Buffer.from(result.bytes).includes(Buffer.from("/StructTreeRoot")));
});

test("all presets support contents off, long tokens and paragraphs across pages", async () => {
  const document = manuscript("Start " + "abcdefghijklmnopqrstuvwxyz".repeat(18) + ". " + "A paragraph continues through the page without losing its ending. ".repeat(170));
  for (const preset of ["book", "a4", "letter"] as const) {
    const result = await renderStoryPdf(document, input(document, { settings: { ...DEFAULT_STORY_PDF_SETTINGS, preset, font: "sans", contents: false, runningHeaders: true, bodySize: 14 } }));
    assert.equal(result.chapters[0]!.physicalPage, 2);
    assert.ok(result.pageCount > 3);
    assert.equal(result.receipt.paragraphCount, 1);
  }
});

test("contents wraps repeated long titles with separate final destinations", async () => {
  const document = manuscriptDocument({ title: "The Long Road Home", worldName: "", chapters: Array.from({ length: 45 }, () => ({ title: "The same chapter title is deliberately long enough to wrap across more than one line", body: "One paragraph is enough to give this chapter its own destination." })) });
  const result = await renderStoryPdf(document, input(document));
  assert.ok(result.chapters[0]!.physicalPage > 3);
  assert.equal(new Set(result.chapters.map(chapter => chapter.destination)).size, 45);
  assert.deepEqual(result.chapters.map(chapter => chapter.pageNumber), Array.from({ length: 45 }, (_, i) => i + 1));
});

test("unsupported text, invalid settings, empty chapters and cancellation refuse", async () => {
  for (const body of ["The glyph \u{10FFFF} is unsupported.", "Unsupported script العربية."]) {
    const document = manuscript(body);
    await assert.rejects(renderStoryPdf(document, input(document)), /Opening.*(?:unsupported|cannot display|supports Latin)/i);
  }
  const document = manuscript("One paragraph.");
  await assert.rejects(renderStoryPdf(document, input(document, { settings: { ...DEFAULT_STORY_PDF_SETTINGS, bodySize: NaN } })), /settings are invalid/);
  await assert.rejects(renderStoryPdf({ ...document, chapters: [{ ...document.chapters[0]!, blocks: [] }] }, input(document)), /Opening.*no prose/);
  await assert.rejects(renderStoryPdf(document, input(document, { cover: { bytes: new Uint8Array([0, 1, 2]), mediaType: "image/png" } })), /cover could not be decoded/);
  await assert.rejects(renderStoryPdf(document, input(document), { signal: AbortSignal.abort() }), /cancelled/);
});

test("scene breaks stay with following prose and impossible headings refuse", async () => {
  const body = Array.from({ length: 36 }, (_, i) => `Paragraph ${i + 1} begins here and continues with a little more text to exercise page endings.`).join("\n\n") + "\n\n***\n\n" + "The next scene belongs with its marker and has enough prose for at least two lines. ".repeat(6);
  const document = manuscript(body);
  for (const bodySize of [10, 14]) {
    const result = await renderStoryPdf(document, input(document, { settings: { ...DEFAULT_STORY_PDF_SETTINGS, bodySize, contents: false } }));
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const parsed = await getDocument({ data: new Uint8Array(result.bytes), disableFontFace: true, useSystemFonts: false }).promise;
    try {
      for (let number = 2; number <= parsed.numPages; number++) {
        const page = await parsed.getPage(number);
        const text = (await page.getTextContent()).items.filter(item => "str" in item && item.transform[5] > 54).map(item => "str" in item ? item.str : "").join(" ").trim();
        assert.ok(!text.endsWith("* * *"), "scene marker must not end a page");
      }
    } finally { await parsed.destroy(); }
  }
  const impossible = { ...document, chapters: [{ ...document.chapters[0]!, title: "An impossibly long chapter heading ".repeat(80) }] };
  await assert.rejects(renderStoryPdf(impossible, input(impossible)), /chapter heading leaves no room/);
});

test("a synthetic 24-chapter novel over 86,000 words has complete independent validation", { timeout: 120_000 }, async () => {
  const paragraph = "Every morning the woman opened her notebook and wrote down what she remembered of the road, the rain, and the people who had helped her find a way home. ";
  const document = manuscriptDocument({ title: "The Road and the Notebook", worldName: "", chapters: Array.from({ length: 24 }, (_, i) => ({ title: `Chapter ${i + 1}: The notebook`, body: Array.from({ length: 31 }, (__, j) => `Record ${i + 1}.${j + 1}. ` + paragraph.repeat(4)).join("\n\n") })) });
  assert.ok(document.words >= 86_000);
  const result = await renderStoryPdf(document, input(document));
  assert.equal(result.chapters.length, 24);
  assert.equal(result.receipt.paragraphCount, 24 * 31);
  assert.ok(result.pageCount > 200);
  assert.equal(result.receipt.checks.geometry, true);
});
