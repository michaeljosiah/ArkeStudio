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

test("emphasis boundaries do not strand closing punctuation on a new line", async () => {
  const document = manuscript(Array.from({ length: 60 }, (_, i) => "Word ".repeat(i + 1) + "“*A phrase ends in—*” and the sentence continues.").join("\n\n"));
  const result = await renderStoryPdf(document, input(document, { settings: { ...DEFAULT_STORY_PDF_SETTINGS, contents: false } }));
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const parsed = await getDocument({ data: new Uint8Array(result.bytes), disableFontFace: true, useSystemFonts: false }).promise;
  try {
    for (let number = 2; number <= parsed.numPages; number++) {
      const rows = new Map<number, string>();
      for (const item of (await (await parsed.getPage(number)).getTextContent()).items) {
        if ("str" in item) rows.set(item.transform[5], (rows.get(item.transform[5]) ?? "") + item.str);
      }
      assert.ok([...rows.values()].every(row => !row.trimStart().startsWith("”")), "a closing quote stays with its preceding token across an italic boundary");
    }
  } finally { await parsed.destroy(); }
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

test("running headers retain fallback glyphs and chapter links land at the heading", async () => {
  const document = manuscript("The road continues through the rain. ".repeat(180), "A road 😀 home");
  const result = await renderStoryPdf(document, input(document, { settings: { ...DEFAULT_STORY_PDF_SETTINGS, runningHeaders: true } }));
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const parsed = await getDocument({ data: new Uint8Array(result.bytes), disableFontFace: true, useSystemFonts: false }).promise;
  try {
    const chapter = result.chapters[0]!, frame = storyPdfFrame("book");
    const opening = await parsed.getPage(chapter.physicalPage);
    const heading = (await opening.getTextContent()).items.find(item => "str" in item && item.str === "Opening");
    assert.ok(heading && "str" in heading);
    const dest = await parsed.getDestination(chapter.destination);
    const outline = await parsed.getOutline();
    const bookmark = outline![0]!.dest;
    for (const target of [dest, typeof bookmark === "string" ? await parsed.getDestination(bookmark) : bookmark]) {
      assert.equal(target![1].name, "XYZ");
      assert.ok(Math.abs(target![2] - frame.left) < 0.01);
      assert.ok(Math.abs(target![3] - (heading.transform[5] + DEFAULT_STORY_PDF_SETTINGS.bodySize * 1.6)) < 0.01);
    }
    for (let number = chapter.physicalPage + 1; number <= parsed.numPages; number++) {
      const text = (await (await parsed.getPage(number)).getTextContent()).items.filter(item => "str" in item && item.transform[5] > frame.height - frame.top).map(item => "str" in item ? item.str : "").join("");
      assert.equal(text, document.title, "pagination artifacts use the same Unicode fallback as prose");
    }
  } finally { await parsed.destroy(); }
});

test("nonbreaking spaces preserve their glyphs and keep styled phrases on one line", async () => {
  const document = manuscript(Array.from({ length: 32 }, (_, i) => "Word ".repeat(i + 1) + "Dr.\u00a0*Ada* paid 1\u202f000 naira.").join("\n\n"));
  const result = await renderStoryPdf(document, input(document));
  const { getDocument, OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const parsed = await getDocument({ data: new Uint8Array(result.bytes), disableFontFace: true, useSystemFonts: false }).promise;
  let glyphs = "", phrases = 0;
  try {
    for (let number = result.chapters[0]!.physicalPage; number <= parsed.numPages; number++) {
      const page = await parsed.getPage(number), rows = new Map<number, string>();
      for (const item of (await page.getTextContent()).items) if ("str" in item) rows.set(item.transform[5], (rows.get(item.transform[5]) ?? "") + item.str);
      for (const row of rows.values()) if (row.includes("Dr.")) { assert.match(row, /Dr\.\s*Ada/); phrases++; }
      for (const row of rows.values()) if (row.includes("000")) assert.match(row, /1\s*000/);
      const operators = await page.getOperatorList();
      for (const [index, fn] of operators.fnArray.entries()) if (fn === OPS.showText) {
        for (const glyph of operators.argsArray[index][0]) if (typeof glyph === "object") glyphs += glyph.unicode;
      }
    }
    assert.equal(phrases, 32);
    assert.equal([...glyphs].filter(char => char === "\u00a0").length, 32);
    assert.equal([...glyphs].filter(char => char === "\u202f").length, 32);
  } finally { await parsed.destroy(); }
  const tooWide = manuscript(Array.from({ length: 100 }, () => "word").join("\u00a0"));
  await assert.rejects(renderStoryPdf(tooWide, input(tooWide)), /nonbreaking phrase.*wider/);
});

for (const sceneBreak of [false, true]) test(`a three-line paragraph moves whole with its scene break=${sceneBreak}`, async () => {
  const fillers = sceneBreak ? 20 : 23;
  const body = Array.from({ length: fillers }, (_, i) => `Filler ${i + 1}.`).join("\n\n") + (sceneBreak ? "\n\n***" : "") + "\n\n" + "Target passage walks along the river and returns home. ".repeat(2);
  const document = manuscript(body);
  const result = await renderStoryPdf(document, input(document, { settings: { ...DEFAULT_STORY_PDF_SETTINGS, bodySize: 12, lineSpacing: 1.5, contents: false } }));
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const parsed = await getDocument({ data: new Uint8Array(result.bytes), disableFontFace: true, useSystemFonts: false }).promise;
  try {
    const first = (await (await parsed.getPage(2)).getTextContent()).items.map(item => "str" in item ? item.str : "").join(" ");
    assert.ok(first.includes(`Filler ${fillers}.`));
    assert.ok(!first.includes("Target"), "no isolated first line may remain at the page foot");
    if (sceneBreak) assert.ok(!first.includes("* * *"), "the scene marker moves with the paragraph");
    const next = (await (await parsed.getPage(3)).getTextContent()).items.filter(item => "str" in item && item.str.trim() && item.str !== "* * *" && item.transform[5] > 54);
    assert.equal(next.length, 3, "the complete three-line paragraph belongs on the next page");
    assert.match(next.map(item => "str" in item ? item.str : "").join(" "), /Target passage/);
  } finally { await parsed.destroy(); }
});
