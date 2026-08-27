import assert from "node:assert/strict";
import { deflateRawSync, deflateSync } from "node:zlib";
import { describe, it } from "node:test";
import { ascii, concat, docx, onePage, paragraph, pdf, zip } from "./build-documents.js";
import {
  extractDocumentText,
  extractDocxText,
  extractPdfText,
  isExtractable,
  parseToUnicode,
  wordXmlToText,
} from "../../src/world-chat/document-text.js";

/**
 * Getting words out of PDF and Word files (#70 §13.2).
 *
 * The files here are built rather than committed, because what is being tested is the reading of
 * a format and a format is a specification, not a sample. A hand-built file can be made to hold
 * exactly the one thing under test — a two-byte font with a `ToUnicode` map, a page whose objects
 * are inside another object — where a real document holds everything at once and proves whichever
 * of them happens to fail last.
 *
 * The one rule underneath all of it is the old one: this app does not claim to have read what it
 * has not read. Every refusal below is a case where extraction ran and came back with nothing
 * worth showing, and said so instead of attaching an empty document.
 */

/** The text an extraction produced, or the reason it did not — as one comparable value. */
function textOf(result: ReturnType<typeof extractPdfText>): string {
  return result.ok ? result.text : `refused: ${result.reason}`;
}

// ---------------------------------------------------------------------------

describe("which files are read by extraction", () => {
  it("names the two formats and nothing else", () => {
    assert.equal(isExtractable("brief.pdf"), true);
    assert.equal(isExtractable("Treatment.DOCX"), true, "the extension is the file's, not the writer's");
    // Plain text is read by decoding it; a .doc is a different format wearing a similar name.
    assert.equal(isExtractable("notes.txt"), false);
    assert.equal(isExtractable("old-treatment.doc"), false);
  });

  it("has nothing to say about a format it does not read", () => {
    assert.equal(extractDocumentText("notes.txt", ascii("the bells again")), null);
  });
});

describe("Word", () => {
  it("reads the words and keeps the paragraphs apart", () => {
    const result = extractDocxText(docx(paragraph("The bells again.") + paragraph("Maren did not answer.")));
    assert.deepEqual(result, { ok: true, text: "The bells again.\nMaren did not answer." });
  });

  it("joins the runs a word processor split a sentence into", () => {
    // Word breaks a sentence at every formatting change, so "the *harbour*" is three runs of one
    // paragraph. Treating each as a line would put a break inside the sentence.
    const result = extractDocxText(docx(paragraph("She hears it under the ", "harbour", ", most nights.")));
    assert.equal(result.ok && result.text, "She hears it under the harbour, most nights.");
  });

  it("reads a stored entry as readily as a deflated one", () => {
    const document = `<w:document><w:body>${paragraph("Stored, not squeezed.")}</w:body></w:document>`;
    const file = zip([{ name: "word/document.xml", bytes: ascii(document), store: true }]);
    assert.equal(extractDocxText(file).ok, true);
  });

  it("leaves out what is in the file and not in the document", () => {
    const text = wordXmlToText(
      `${paragraph("Kept.")}<w:p><w:r><w:delText>Deleted.</w:delText><w:instrText>PAGE \\* MERGEFORMAT</w:instrText></w:r></w:p>`,
    );
    // A tracked deletion and a field code are both text in the XML and neither is text in the
    // document — quoting either back would be quoting something nobody can see on the page.
    assert.match(text, /Kept\./);
    assert.doesNotMatch(text, /Deleted/);
    assert.doesNotMatch(text, /MERGEFORMAT/);
  });

  it("keeps line breaks, tabs and the marks entities stand for", () => {
    const text = wordXmlToText(
      `<w:p><w:r><w:t>one</w:t><w:br/><w:t>two</w:t><w:tab/><w:t>caf&#233; &amp; b&#xE8;te</w:t></w:r></w:p>`,
    );
    assert.equal(text, "one\ntwo\tcafé & bète\n");
  });

  it("says a protected file is protected rather than empty", () => {
    // A password-protected .docx is an OLE container with the zip encrypted inside it, so it
    // never reaches the point of having no words: it cannot be opened at all.
    const ole = concat([
      new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      ascii("x".repeat(64)),
    ]);
    assert.deepEqual(extractDocxText(ole), { ok: false, reason: "protected" });
  });

  it("says a file that is not a zip is damaged", () => {
    assert.deepEqual(extractDocxText(ascii("this was never a document")), { ok: false, reason: "damaged" });
  });

  it("refuses a document with nothing written in it", () => {
    assert.deepEqual(extractDocxText(docx(paragraph("  "))), { ok: false, reason: "no-text" });
  });
});

describe("PDF", () => {
  it("reads text out of an uncompressed page", () => {
    const result = extractPdfText(onePage("BT /F1 12 Tf (The bells again.) Tj ET"));
    assert.equal(result.ok && result.text, "The bells again.");
  });

  it("reads a compressed one, whichever way the writer wrapped it", () => {
    const content = "BT (Squeezed, and still legible.) Tj ET";
    const zlibbed = pdf([
      { dict: "<</Type/Catalog/Pages 2 0 R>>" },
      { dict: "<</Type/Pages/Kids[3 0 R]/Count 1>>" },
      { dict: "<</Type/Page/Parent 2 0 R/Contents 4 0 R>>" },
      { dict: "<</Filter/FlateDecode>>", stream: new Uint8Array(deflateSync(Buffer.from(content))) },
    ]);
    assert.equal(textOf(extractPdfText(zlibbed)), "Squeezed, and still legible.");

    // Some writers leave off the two-byte zlib header. It is the same stream and reads the same.
    const raw = pdf([
      { dict: "<</Type/Catalog/Pages 2 0 R>>" },
      { dict: "<</Type/Pages/Kids[3 0 R]/Count 1>>" },
      { dict: "<</Type/Page/Parent 2 0 R/Contents 4 0 R>>" },
      { dict: "<</Filter/FlateDecode>>", stream: new Uint8Array(deflateRawSync(Buffer.from(content))) },
    ]);
    assert.equal(extractPdfText(raw).ok, true);
  });

  /**
   * A PDF has no newline. It has a text matrix, and a new line is a page that moved down — so
   * the lines a reader sees have to be inferred from where each string was put.
   */
  it("breaks a line where the page moved down, and not where it did not", () => {
    const result = extractPdfText(
      onePage(
        "BT 1 0 0 1 72 700 Tm (First line.) Tj 1 0 0 1 72 680 Tm (Second line.) Tj 1 0 0 1 200 680 Tm (Still second.) Tj ET",
      ),
    );
    assert.equal(result.ok && result.text, "First line.\nSecond line.Still second.");
  });

  it("spaces words a writer set apart rather than typed apart", () => {
    // The negative numbers in a TJ array are how a writer pushes glyphs apart; a big one is
    // where a word ends, and without them a paragraph arrives as one word.
    const result = extractPdfText(onePage("BT [(under) -400 (the) -400 (harbour)] TJ ET"));
    assert.equal(result.ok && result.text, "under the harbour");
  });

  it("joins words that each got their own text object", () => {
    // Some writers place one word at a time. Every word would run into the next without this,
    // and every one would be its own line if a text object were assumed to be a line.
    const content = [
      "BT 1 0 0 1 72 700 Tm (MIND) Tj ET",
      "BT 1 0 0 1 120 700 Tm (REVOLUTION) Tj ET",
      "BT 1 0 0 1 72 680 Tm (below) Tj ET",
    ].join("\n");
    assert.equal(textOf(extractPdfText(onePage(content))), "MIND REVOLUTION\nbelow");
  });

  it("reads the escapes a literal string is allowed to carry", () => {
    const result = extractPdfText(onePage(String.raw`BT (a\(b\) c\\d \110ere) Tj ET`));
    assert.equal(result.ok && result.text, "a(b) c\\d Here");
  });

  it("reads WinAnsi's marks as the marks they are", () => {
    // 0x92 and 0x97 are control characters in Latin-1 and are a right quote and an em dash in
    // what a word processor actually writes. Left alone they make ordinary prose look like noise.
    const result = extractPdfText(onePage("BT (Maren\x92s bells \x97 again) Tj ET"));
    assert.equal(result.ok && result.text, "Maren’s bells — again");
  });

  it("reads a two-byte font through the map that says what its glyphs are", () => {
    // A subset font addresses its own glyphs by number and only ToUnicode says which letters
    // those are. This is what a browser's print-to-PDF produces.
    const cmap = [
      "/CIDInit /ProcSet findresource begin 12 dict begin begincmap",
      "1 begincodespacerange <0000> <FFFF> endcodespacerange",
      "2 beginbfchar <0003> <0020> <0024> <0041> endbfchar",
      "1 beginbfrange <0045> <0047> <0062> endbfrange",
      "endcmap end end",
    ].join("\n");
    const file = onePage("BT /F1 12 Tf <00240003004500460047> Tj ET", {
      fonts: "/F1 5 0 R",
      extra: [
        { dict: "<</Type/Font/Subtype/Type0/BaseFont/AAAAAA+Georgia/ToUnicode 6 0 R>>" },
        { dict: "<<>>", stream: ascii(cmap) },
      ],
    });
    assert.equal(textOf(extractPdfText(file)), "A bcd");
  });

  it("says nothing rather than numbers when a two-byte font brought no map", () => {
    // Glyph numbers read as characters are text that looks like a document and says something
    // nobody wrote. Refusing is the honest answer; printing the numbers is not.
    const file = onePage("BT /F1 12 Tf <00240003004500460047> Tj ET", {
      fonts: "/F1 5 0 R",
      extra: [{ dict: "<</Type/Font/Subtype/Type0/BaseFont/AAAAAA+Georgia>>" }],
    });
    assert.deepEqual(extractPdfText(file), { ok: false, reason: "no-text" });
  });

  it("finds a page that was stored inside another object", () => {
    // Everything structural in a modern PDF is packed into an object stream and compressed.
    // Without unpacking them there is a content stream and nothing that explains it — which is
    // the case where the text comes back as glyph numbers or not at all.
    const packed =
      "<</Type/Catalog/Pages 11 0 R>> <</Type/Pages/Kids[12 0 R]/Count 1>> <</Type/Page/Contents 2 0 R>>";
    const header = `10 ${packed.indexOf("<</Type/Catalog")} 11 ${packed.indexOf("<</Type/Pages")} 12 ${packed.indexOf("<</Type/Page/")} `;
    const file = pdf([
      {
        dict: `<</Type/ObjStm/N 3/First ${header.length}>>`,
        stream: new Uint8Array(deflateSync(Buffer.from(header + packed))),
      },
      { dict: "<<>>", stream: ascii("BT (Packed away.) Tj ET") },
    ]);
    assert.equal(textOf(extractPdfText(file)), "Packed away.");
  });

  it("reads the pages in the order the tree puts them", () => {
    const file = pdf([
      { dict: "<</Type/Catalog/Pages 2 0 R>>" },
      { dict: "<</Type/Pages/Kids[4 0 R 3 0 R]/Count 2>>" },
      { dict: "<</Type/Page/Parent 2 0 R/Contents 6 0 R>>" },
      { dict: "<</Type/Page/Parent 2 0 R/Contents 5 0 R>>" },
      { dict: "<<>>", stream: ascii("BT (First, though stored second.) Tj ET") },
      { dict: "<<>>", stream: ascii("BT (Second.) Tj ET") },
    ]);
    assert.equal(textOf(extractPdfText(file)), "First, though stored second.\n\nSecond.");
  });

  it("refuses a page that is only a picture", () => {
    // A scan, or a deck exported as one image per page. There is nothing to read and saying so
    // is the whole point — an empty attachment would let the conversation talk about it as read.
    const file = onePage("q 612 0 0 792 0 0 cm /X1 Do Q", {
      extra: [{ dict: "<</Type/XObject/Subtype/Image/Width 8>>", stream: ascii("\x00\x01\x02") }],
    });
    assert.deepEqual(extractPdfText(file), { ok: false, reason: "no-text" });
  });

  it("says a protected file is protected rather than empty", () => {
    // Every stream is enciphered under a key this does not derive, so the file would read as a
    // scan — the wrong answer to give somebody who knows their document has words in it.
    const file = concat([
      onePage("BT (unreachable) Tj ET"),
      ascii("\ntrailer<</Root 1 0 R/Encrypt 9 0 R>>\n%%EOF"),
    ]);
    assert.deepEqual(extractPdfText(file), { ok: false, reason: "protected" });
  });

  it("says a file that is not a PDF is damaged", () => {
    assert.deepEqual(extractPdfText(ascii("Dear Maren, this is a letter.")), {
      ok: false,
      reason: "damaged",
    });
  });

  it("reads a stream nothing points at, rather than giving up on the file", () => {
    // No catalogue, no page tree — a file whose structure cannot be walked. What is left is
    // still text that is in the document, and coming back with it beats coming back empty.
    const file = pdf([{ dict: "<<>>", stream: ascii("BT (Orphaned, and still words.) Tj ET") }]);
    assert.equal(textOf(extractPdfText(file)), "Orphaned, and still words.");
  });
});

describe("what a ToUnicode map says", () => {
  it("reads codes named one at a time and codes named in runs", () => {
    const { map, codeBytes } = parseToUnicode(
      [
        "1 begincodespacerange <0000> <FFFF> endcodespacerange",
        "1 beginbfchar <0041> <0061> endbfchar",
        "2 beginbfrange <0050> <0052> <0078> <0060> <0061> [<0031> <0032>] endbfrange",
      ].join("\n"),
    );
    assert.equal(codeBytes, 2);
    assert.equal(map.get(0x41), "a");
    // A run against one destination counts up with the code.
    assert.equal(map.get(0x50), "x");
    assert.equal(map.get(0x52), "z");
    // A run against a list takes them in order and stops where the list stops.
    assert.equal(map.get(0x60), "1");
    assert.equal(map.get(0x61), "2");
  });

  it("reads a destination that is more than one character", () => {
    const { map } = parseToUnicode("1 beginbfchar <01> <00660069> endbfchar");
    assert.equal(map.get(1), "fi", "a ligature is one glyph and two letters");
  });
});

describe("the last gate", () => {
  it("normalises the ligatures a font kept as single glyphs", () => {
    // "specification" has to be findable in a document that plainly contains it, or a quotation
    // of it cannot be verified against the file it came from.
    const result = extractDocxText(docx(paragraph("A speciﬁcation, brieﬂy, and a ﬀ too.")));
    assert.equal(result.ok && result.text, "A specification, briefly, and a ff too.");
  });

  it("does not let a page's spacing into what gets quoted", () => {
    const result = extractPdfText(
      onePage("BT 1 0 0 1 72 700 Tm (Trailing   space   ) Tj 1 0 0 1 72 600 Tm (after a gap.) Tj ET"),
    );
    assert.equal(result.ok && result.text, "Trailing space\nafter a gap.");
  });
});
