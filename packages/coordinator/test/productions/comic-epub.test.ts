import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { comicEpubEntries, imageSize } from "../../src/productions/comic-epub.js";
import { encodePng, solidImage } from "../../src/references/png.js";

/** The EPUB's parts (SPEC-064 R-47): every picture's size, and text that stays well-formed XML. */
describe("a graphic novel's EPUB parts", () => {
  it("reads a WebP's size, lossy and lossless, as it reads a PNG's", () => {
    assert.deepEqual(imageSize(Buffer.from(encodePng(solidImage(40, 60, [0, 0, 0, 255])))), { width: 40, height: 60 });
    // RIFF....WEBPVP8L + chunk length + signature 0x2f, then 14-bit width-1 and height-1.
    const lossless = Buffer.alloc(32);
    lossless.write("RIFF", 0, "ascii"); lossless.write("WEBP", 8, "ascii"); lossless.write("VP8L", 12, "ascii");
    lossless[20] = 0x2f;
    lossless.writeUInt32LE((39 & 0x3fff) | ((59 & 0x3fff) << 14), 21);
    assert.deepEqual(imageSize(lossless), { width: 40, height: 60 });
  });

  it("drops the control characters XML forbids from authored text", () => {
    const entries = comicEpubEntries({
      id: "low-water-drawn", title: "Low\u000bWater", language: "en", rtl: false, modified: "2026-10-29T10:00:00Z",
      chapterTitle: () => "The tide",
      pages: [{ entry: { id: "p", chapter: "c", number: 1 } as never, bytes: Buffer.alloc(1), extension: "png", width: 40, height: 60, alt: "Before\u000bafter & <then>" }],
    });
    const page = entries.find(([path]) => path === "OEBPS/pages/0001.xhtml")![1].toString("utf8");
    assert.match(page, /alt="Beforeafter &amp; &lt;then&gt;"/);
    assert.match(entries.find(([path]) => path === "OEBPS/content.opf")![1].toString("utf8"), /<dc:title>LowWater<\/dc:title>/);
  });
});
