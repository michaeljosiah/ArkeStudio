import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * pdfkit loads its default Helvetica through its own package's `#standard-fonts` import, which the
 * desktop's CommonJS bundle cannot resolve: "Cannot find module '#standard-fonts/Helvetica'". Tests
 * run the source, where it resolves, so the graphic novel's PDF passed here and failed in every
 * installed app (2026-10-29). Every document names its font — a file it ships, or none — so nothing
 * here falls back to the default.
 */
describe("pdfkit documents never fall back to the bundled-away default font", () => {
  it("passes a font to every new PDFDocument", async () => {
    const src = fileURLToPath(new URL("../src", import.meta.url));
    const files = (await readdir(src, { recursive: true })).filter((file) => file.endsWith(".ts"));
    let documents = 0;
    for (const file of files) {
      const text = await readFile(join(src, file), "utf8");
      for (const match of text.matchAll(/new PDFDocument\(\{([^}]*)/g)) {
        documents += 1;
        assert.match(match[1]!, /\bfont:/, `${file}: a PDFDocument without a font loads pdfkit's Helvetica, which the desktop bundle cannot`);
      }
    }
    assert.ok(documents >= 3, "the story PDF, the illustration reader and the comic PDF are all found");
  });
});
