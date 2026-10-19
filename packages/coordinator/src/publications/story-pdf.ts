import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import { create, type Font } from "fontkit";
import { type ManuscriptDocument, type ManuscriptRun, type StoryPdfSettings, isManuscriptLanguage } from "@arke-studio/contracts";

/** SPEC-058: this identity is captured before rendering, and checked again on retry. */
export const STORY_PDF_IDENTITY = {
  compiler: "arke-story-pdf", version: 1, layout: 1, pdfkit: "0.20.2", fontkit: "2.0.4", validator: "pdfjs-5.4.624",
  fonts: {
    "DejaVuSans-Bold.ttf": "e6476c1b80502924294eed40894c5b18e06c181444ca953e5334262df9c27724",
    "DejaVuSans-BoldOblique.ttf": "eb436dca0c2594b73d8b603b892e374fdfd8d885d25ffb4f18df4c4c0b49e50f",
    "DejaVuSans-Oblique.ttf": "4af75fa16ee6d3ad43e1ecec41862c24954af26a55c6bb1ebb27bd486a50f5f4",
    "DejaVuSans.ttf": "7da195a74c55bef988d0d48f9508bd5d849425c1770dba5d7bfc6ce9ed848954",
    "DejaVuSerif-Bold.ttf": "c47b5527bcdc8dcf9ea8c77054454c5a884beaca2f44851a2a823ee639cbf07f",
    "DejaVuSerif-BoldItalic.ttf": "8d3dd3d31350309042ed226af82b34539bd773518e6107cb352712853ba80308",
    "DejaVuSerif-Italic.ttf": "2e39b1d50f90b933b00c7bb54a96afd3f86419b3d717c7cf202e36f2d4973e47",
    "DejaVuSerif.ttf": "42d1edeb7952f31b1f96d767ed7030b08a39e0c372b0071641518864e2bffb51",
    "NotoEmoji.ttf": "de6c18832938afc99caf132b39d6a30a19bac7f2e812e28db2535b4608d27551",
  },
} as const;
export interface StoryPdfInput {
  author: string;
  language: string;
  subtitle?: string;
  editionLabel?: string;
  settings: StoryPdfSettings;
  cover?: { bytes: Uint8Array; mediaType: "image/png" | "image/jpeg" };
  chapterIds: string[];
}
export interface StoryPdfControl { signal?: AbortSignal; onPhase?: (phase: "Formatting pages" | "Checking PDF") => void | Promise<void> }
export interface StoryPdfChapter { id: string; title: string; pageNumber: number; physicalPage: number; destination: string }
export interface StoryPdfReceipt {
  version: 1;
  identity: typeof STORY_PDF_IDENTITY;
  sha256: string;
  pageCount: number;
  paragraphCount: number;
  checkedLines: number;
  elapsedMs: number;
  checks: { parsed: true; text: true; geometry: true; navigation: true; fonts: true; structure: true };
  accessibility: string;
}
export interface StoryPdfResult { bytes: Uint8Array; pageCount: number; chapters: StoryPdfChapter[]; pageLabels: string[]; receipt: StoryPdfReceipt }
const LIMITS = { characters: 2_000_000, pages: 5000, bytes: 100 * 1024 ** 2, coverBytes: 20 * 1024 ** 2, coverPixels: 40_000_000, elapsedMs: 120_000 } as const;
type Face = keyof typeof STORY_PDF_IDENTITY.fonts;
type Fonts = Map<Face, { bytes: Buffer; font: Font }>;
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const normalized = (text: string) => text.normalize("NFC").replace(/\s+/gu, " ").trim();
const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
const fontNames: Record<"serif" | "sans", [Face, Face, Face, Face]> = {
  serif: ["DejaVuSerif.ttf", "DejaVuSerif-Italic.ttf", "DejaVuSerif-Bold.ttf", "DejaVuSerif-BoldItalic.ttf"],
  sans: ["DejaVuSans.ttf", "DejaVuSans-Oblique.ttf", "DejaVuSans-Bold.ttf", "DejaVuSans-BoldOblique.ttf"],
};
async function loadFonts(): Promise<Fonts> {
  const fonts: Fonts = new Map();
  for (const [name, expected] of Object.entries(STORY_PDF_IDENTITY.fonts)) {
    let bytes: Buffer;
    try { bytes = await readFile(new URL("./fonts/" + name, import.meta.url)); }
    catch { throw new Error("The bundled PDF fonts are unavailable. Repair the Arke installation."); }
    if (digest(bytes) !== expected) throw new Error("A bundled PDF font changed. Repair the Arke installation.");
    fonts.set(name as Face, { bytes, font: create(bytes) as Font });
  }
  return fonts;
}
export async function storyPdfIdentity(): Promise<typeof STORY_PDF_IDENTITY> { await loadFonts(); return STORY_PDF_IDENTITY; }

type Piece = { text: string; face: Face; width: number };
type Line = { pieces: Piece[]; width: number; indent: number };
type DrawLine = Line & { x: number; y: number; size: number; key: string; role: "H1" | "P" | "TOCI" | "Artifact"; context: string; goTo?: string };
type Page = { lines: DrawLine[]; cover?: true; chapter?: number; opening?: true; label: string };
type Plan = { pages: Page[]; chapters: StoryPdfChapter[]; paragraphCount: number; contentsPasses: number };

/** Fixed portrait frames, in PDF points. Furniture has its own reserved band. */
export function storyPdfFrame(preset: StoryPdfSettings["preset"]) {
  const [width, height] = preset === "book" ? [432, 648] : preset === "a4" ? [595.2756, 841.8898] : [612, 792];
  const left = preset === "book" ? 50.4 : 61.2;
  const top = preset === "book" ? 54 : 57.6;
  return { width, height, left, top, textWidth: width - left * 2, bottom: height - top };
}

class Typesetter {
  private readonly widths = new Map<string, number>();
  constructor(private readonly fonts: Fonts, private readonly input: StoryPdfInput) {}
  width(text: string, face: Face, size: number): number {
    const key = face + "\0" + text;
    let em = this.widths.get(key);
    if (em === undefined) {
      const font = this.fonts.get(face)!.font;
      em = font.layout(text).advanceWidth / font.unitsPerEm;
      // A bounded cache is important for manuscripts made of unique long tokens.
      if (this.widths.size < 50_000) this.widths.set(key, em);
    }
    return em * size;
  }
  pieces(runs: ManuscriptRun[], size: number, context: string): Piece[] {
    const result: Piece[] = [];
    for (const run of runs) {
      const style = (run.bold ? 2 : 0) + (run.italic ? 1 : 0);
      const preferred = fontNames[this.input.settings.font][style]!;
      const fallback = fontNames.sans[style]!;
      for (const token of run.text.match(/\s+|\S+/gu) ?? []) {
        let text = ""; let face: Face | undefined;
        const flush = () => { if (text && face) result.push({ text, face, width: this.width(text, face, size) }); text = ""; };
        for (const { segment } of segmenter.segment(token)) {
          for (const char of segment) {
            if (/\p{Letter}/u.test(char) && !/\p{Script_Extensions=Latin}/u.test(char)) throw new Error(`${context}: PDF v1 supports Latin prose; unsupported text U+${char.codePointAt(0)!.toString(16).toUpperCase()}.`);
            if (/\p{Control}/u.test(char) && !/\s/u.test(char)) throw new Error(`${context}: remove the unsupported control character.`);
          }
          const supports = (name: Face) => [...segment].every(char => /\s/u.test(char) || this.fonts.get(name)!.font.hasGlyphForCodePoint(char.codePointAt(0)!));
          const next = supports(preferred) ? preferred : supports(fallback) ? fallback : supports("NotoEmoji.ttf") ? "NotoEmoji.ttf" : null;
          if (next === null) throw new Error(`${context}: the bundled PDF fonts cannot display ${[...segment].map(c => "U+" + c.codePointAt(0)!.toString(16).toUpperCase()).join(" ")}. Replace this character or exclude the chapter.`);
          if (face && face !== next) flush();
          face = next; text += segment;
        }
        flush();
      }
    }
    return result;
  }
  wrap(runs: ManuscriptRun[], width: number, size: number, indent: number, context: string): Line[] {
    const lines: Line[] = []; let current: Piece[] = []; let used = 0;
    const currentIndent = () => lines.length === 0 ? indent : 0;
    const flush = () => { while (current.length && /^\s+$/u.test(current.at(-1)!.text)) used -= current.pop()!.width; lines.push({ pieces: current, width: used, indent: currentIndent() }); current = []; used = 0; };
    for (const piece of this.pieces(runs, size, context)) {
      if (/^\s+$/u.test(piece.text)) { if (current.length) { current.push(piece); used += piece.width; } continue; }
      if (used + piece.width > width - currentIndent() + 0.01 && current.length) flush();
      if (piece.width <= width - currentIndent() + 0.01) { current.push(piece); used += piece.width; continue; }
      // No inserted hyphen or replacement glyph: split only at grapheme boundaries.
      for (const { segment } of segmenter.segment(piece.text)) {
        const part = { text: segment, face: piece.face, width: this.width(segment, piece.face, size) };
        if (part.width > width - currentIndent()) throw new Error(`${context}: a character is wider than the PDF text frame.`);
        if (used + part.width > width - currentIndent() + 0.01 && current.length) flush();
        current.push(part); used += part.width;
      }
    }
    if (current.length) flush();
    return lines;
  }
}

function validateInput(doc: ManuscriptDocument, input: StoryPdfInput): void {
  const s = input.settings;
  if (s.version !== 1 || !["book", "a4", "letter"].includes(s.preset) || !["serif", "sans"].includes(s.font) || !Number.isFinite(s.bodySize) || s.bodySize < 10 || s.bodySize > 14 || !Number.isFinite(s.lineSpacing) || s.lineSpacing < 1.25 || s.lineSpacing > 1.6 || typeof s.contents !== "boolean" || typeof s.runningHeaders !== "boolean") throw new Error("The PDF formatting settings are invalid.");
  if (!doc.title.trim() || !isManuscriptLanguage(input.language)) throw new Error("Set a title and valid language before preparing PDF.");
  if (doc.chapters.length === 0 || doc.chapters.length > 200 || input.chapterIds.length !== doc.chapters.length || new Set(input.chapterIds).size !== input.chapterIds.length) throw new Error("The PDF chapter selection is invalid.");
  let characters = [...doc.title, ...(input.subtitle ?? ""), ...input.author, ...(input.editionLabel ?? "")].length;
  for (const chapter of doc.chapters) {
    if (!chapter.blocks.some(b => b.kind === "paragraph" && b.runs.some(r => r.text.trim()))) throw new Error(`${chapter.title}: the chapter has no prose. Write it or exclude it.`);
    characters += [...chapter.title].length;
    for (const block of chapter.blocks) if (block.kind === "paragraph") for (const run of block.runs) characters += [...run.text].length;
  }
  if (characters > LIMITS.characters) throw new Error("The PDF exceeds the limit of two million text characters.");
  if (input.cover && (!input.cover.bytes.byteLength || input.cover.bytes.byteLength > LIMITS.coverBytes)) throw new Error("The PDF cover exceeds the 20 MiB limit or is empty.");
}

async function makePlan(doc: ManuscriptDocument, input: StoryPdfInput, typesetter: Typesetter, checkpoint: () => Promise<void>): Promise<Plan> {
  const frame = storyPdfFrame(input.settings.preset);
  const size = input.settings.bodySize; const leading = size * input.settings.lineSpacing;
  const pages: Page[] = []; const chapters: StoryPdfChapter[] = [];
  let page: Page; let y = frame.top; let paragraphCount = 0;
  const addPage = (chapter?: number, opening?: true) => {
    if (pages.length >= LIMITS.pages) throw new Error("The PDF exceeds the 5,000-page limit.");
    page = { lines: [], label: "", ...(chapter !== undefined ? { chapter } : {}), ...(opening ? { opening } : {}) }; pages.push(page); y = frame.top;
  };
  const place = (line: Line, fontSize: number, key: string, role: DrawLine["role"], context: string, centered = false, goTo?: string) => {
    const x = centered ? frame.left + (frame.textWidth - line.width) / 2 : frame.left + line.indent;
    page.lines.push({ ...line, x, y, size: fontSize, key, role, context, ...(goTo ? { goTo } : {}) });
    y += fontSize * input.settings.lineSpacing;
  };
  if (input.cover) { addPage(); page!.cover = true; }
  addPage();
  const titleParts = [
    { text: doc.title, size: size * 2, bold: true, role: "H1" as const },
    { text: input.subtitle ?? "", size: size * 1.2, bold: false, role: "P" as const },
    { text: input.author, size: size * 1.1, bold: false, role: "P" as const },
    { text: input.editionLabel ?? "", size, bold: false, role: "P" as const },
  ].filter(part => part.text.trim());
  const titleRows = titleParts.map(part => ({ ...part, lines: typesetter.wrap([{ text: part.text, ...(part.bold ? { bold: true as const } : {}) }], frame.textWidth, part.size, 0, "Title page") }));
  const titleHeight = titleRows.reduce((n, row) => n + row.lines.length * row.size * input.settings.lineSpacing + size * 2, -size * 2);
  if (titleHeight > frame.bottom - frame.top) throw new Error("The title-page text does not fit. Shorten the title, subtitle or edition label.");
  y = frame.top + Math.max(0, (frame.bottom - frame.top - titleHeight) * 0.35);
  for (const [index, row] of titleRows.entries()) { for (const line of row.lines) place(line, row.size, `title-${index}`, row.role, "Title page", true); y += size * 2; }
  const frontPages = pages.length;
  // Body pagination is independent of front matter: printed numbering always starts at one.
  for (const [chapterIndex, chapter] of doc.chapters.entries()) {
    await checkpoint(); addPage(chapterIndex, true);
    const start = pages.length - frontPages;
    chapters.push({ id: input.chapterIds[chapterIndex]!, title: chapter.title, pageNumber: start, physicalPage: 0, destination: `chapter-${chapterIndex + 1}` });
    const heading = typesetter.wrap([{ text: chapter.title, bold: true }], frame.textWidth, size * 1.6, 0, chapter.title);
    const available = frame.bottom - frame.top;
    if (heading.length * size * 1.6 * input.settings.lineSpacing + leading * 5 > available) throw new Error(`${chapter.title}: the chapter heading leaves no room for its opening. Shorten the heading.`);
    y += leading * 1.5;
    for (const line of heading) place(line, size * 1.6, `chapter-${chapterIndex}-heading`, "H1", chapter.title, true);
    y += leading * 1.5;
    let first = true;
    for (const [blockIndex, block] of chapter.blocks.entries()) {
      await checkpoint();
      const context = `${chapter.title}, paragraph ${blockIndex + 1}`;
      if (block.kind === "break") {
        if (y + leading * 5 > frame.bottom) addPage(chapterIndex);
        y += leading;
        for (const line of typesetter.wrap([{ text: "* * *" }], frame.textWidth, size, 0, context)) place(line, size, `break-${chapterIndex}-${blockIndex}`, "P", context, true);
        y += leading; first = true; continue;
      }
      paragraphCount++;
      const lines = typesetter.wrap(block.runs, frame.textWidth, size, first ? 0 : size, context); first = false;
      let cursor = 0;
      while (cursor < lines.length) {
        let availableLines = Math.floor((frame.bottom - y + 0.01) / leading);
        const remaining = lines.length - cursor;
        if (availableLines < Math.min(2, remaining)) { addPage(chapterIndex); availableLines = Math.floor((frame.bottom - y) / leading); }
        let take = Math.min(availableLines, remaining);
        if (remaining > take && remaining - take === 1) take--;
        if (take < 1) throw new Error(`${context}: the paragraph cannot fit the PDF frame.`);
        for (const line of lines.slice(cursor, cursor + take)) place(line, size, `p-${chapterIndex}-${blockIndex}`, "P", context);
        cursor += take;
        if (cursor < lines.length) addPage(chapterIndex);
      }
    }
  }
  const bodyPages = pages.splice(frontPages);
  let contents: Page[] = []; let prior = ""; let passes = 0;
  if (input.settings.contents) {
    for (; passes < 6; passes++) {
      pages.length = frontPages; addPage();
      for (const line of typesetter.wrap([{ text: "Contents", bold: true }], frame.textWidth, size * 1.6, 0, "Contents")) place(line, size * 1.6, "contents-heading", "H1", "Contents");
      y += leading;
      for (const [index, chapter] of chapters.entries()) {
        await checkpoint();
        const numberWidth = typesetter.width(String(chapter.pageNumber), fontNames[input.settings.font][0], size);
        const entry = typesetter.wrap([{ text: chapter.title }], frame.textWidth - 40, size, 0, "Contents: " + chapter.title);
        if (entry.length * leading + leading / 2 > frame.bottom - frame.top) throw new Error(`${chapter.title}: its contents entry is too long.`);
        if (y + entry.length * leading > frame.bottom) addPage();
        const firstY = y;
        for (const line of entry) place(line, size, `contents-${index}`, "TOCI", "Contents: " + chapter.title, false, chapter.destination);
        page!.lines.push({ pieces: [{ text: String(chapter.pageNumber), face: fontNames[input.settings.font][0], width: numberWidth }], width: numberWidth, indent: 0, x: frame.width - frame.left - numberWidth, y: firstY, size, key: `contents-number-${index}`, role: "TOCI", context: "Contents page number", goTo: chapter.destination });
        y += leading / 2;
      }
      contents = pages.slice(frontPages);
      const signature = JSON.stringify([contents.length, chapters.map(chapter => chapter.pageNumber)]);
      if (signature === prior) break;
      prior = signature;
    }
    if (passes === 6) throw new Error("PDF contents pagination did not converge. Change formatting and prepare again.");
  }
  pages.length = frontPages; pages.push(...contents, ...bodyPages);
  if (pages.length > LIMITS.pages) throw new Error("The PDF exceeds the 5,000-page limit.");
  for (const [index, current] of pages.entries()) {
    current.label = index < frontPages + contents.length ? `Front matter ${index + 1}` : String(index - frontPages - contents.length + 1);
    if (current.opening && current.chapter !== undefined) chapters[current.chapter]!.physicalPage = index + 1;
  }
  return { pages, chapters, paragraphCount, contentsPasses: passes + 1 };
}

/** The core is run in the bounded publication worker; it never reads a world or a network URL. */
export async function renderStoryPdf(document: ManuscriptDocument, input: StoryPdfInput, control: StoryPdfControl = {}): Promise<StoryPdfResult> {
  const started = Date.now();
  const checkpoint = async () => {
    if (control.signal?.aborted) throw new Error("PDF preparation was cancelled.");
    if (Date.now() - started > LIMITS.elapsedMs) throw new Error("PDF preparation exceeded the two-minute limit. Select fewer chapters.");
    await setImmediate();
  };
  validateInput(document, input);
  const fonts = await loadFonts();
  await control.onPhase?.("Formatting pages");
  const plan = await makePlan(document, input, new Typesetter(fonts, input), checkpoint);
  verifyPlanSource(document, plan);
  const frame = storyPdfFrame(input.settings.preset);
  const pdf = new PDFDocument({ font: fileURLToPath(new URL("./fonts/" + fontNames[input.settings.font][0], import.meta.url)), autoFirstPage: false, pdfVersion: "1.7", tagged: true, lang: input.language, displayTitle: true, compress: true,
    info: { Title: document.title, ...(input.author.trim() ? { Author: input.author } : {}), Creator: "Arke Studio", Producer: "Arke Studio story PDF v1" } });
  for (const [name, font] of fonts) pdf.registerFont(name, font.bytes);
  const chunks: Buffer[] = []; let byteLength = 0;
  const complete = new Promise<Buffer>((resolve, reject) => {
    pdf.on("data", (chunk: Buffer) => { byteLength += chunk.length; if (byteLength > LIMITS.bytes) { pdf.destroy(new Error("The PDF exceeds the 100 MiB limit.")); } else chunks.push(chunk); });
    pdf.on("error", reject); pdf.on("end", () => resolve(Buffer.concat(chunks)));
  });
  // Always observe stream rejection, including failures before end() is reached.
  void complete.catch(() => {});
  const root = pdf.struct("Document"); pdf.addStructure(root);
  const structures = new Map<string, PDFKit.PDFStructureElement>();
  try {
    let image: { width: number; height: number } | undefined;
    if (input.cover) {
      try { image = (pdf as unknown as { openImage(bytes: Buffer): { width: number; height: number } }).openImage(Buffer.from(input.cover.bytes)); }
      catch { throw new Error("The PDF cover could not be decoded. Choose a PNG or JPEG image."); }
      if (!Number.isFinite(image.width) || !Number.isFinite(image.height) || image.width <= 0 || image.height <= 0 || image.width * image.height > LIMITS.coverPixels) throw new Error("The PDF cover exceeds the 40-megapixel decoded image limit.");
    }
    for (const [index, page] of plan.pages.entries()) {
      await checkpoint();
      pdf.addPage({ size: [frame.width, frame.height], margin: 0 });
      if (page.cover && image) {
        const scale = Math.min(frame.textWidth / image.width, (frame.bottom - frame.top) / image.height);
        const w = image.width * scale; const h = image.height * scale;
        const figureOptions = { alt: "Book cover", bbox: [frame.left, frame.top, frame.width - frame.left, frame.bottom] };
        const figure = pdf.struct("Figure", figureOptions); root.add(figure);
        figure.add(pdf.markStructureContent("Figure"));
        pdf.image(Buffer.from(input.cover!.bytes), (frame.width - w) / 2, (frame.height - h) / 2, { width: w, height: h }); pdf.endMarkedContent(); figure.end();
      }
      if (page.opening && page.chapter !== undefined) {
        const chapter = plan.chapters[page.chapter]!;
        pdf.addNamedDestination(chapter.destination, "XYZ", frame.left, frame.height - page.lines[0]!.y, null);
        pdf.outline.addItem(chapter.title, { expanded: false });
      }
      for (const line of page.lines) {
        let structure = structures.get(line.key);
        if (!structure) { structure = pdf.struct(line.role); root.add(structure); structures.set(line.key, structure); }
        structure.add(pdf.markStructureContent(line.role));
        let x = line.x;
        // A text operation per word needlessly multiplies PDF operators and font shaping
        // work on a novel. Coalesce the planned same-face runs without altering their text.
        const runs: Piece[] = [];
        for (const piece of line.pieces) {
          const previous = runs.at(-1);
          if (previous?.face === piece.face) { previous.text += piece.text; previous.width += piece.width; }
          else runs.push({ ...piece });
        }
        for (const run of runs) {
          pdf.font(run.face).fontSize(line.size).fillColor("#202020").text(run.text, x, line.y + line.size, { lineBreak: false, baseline: "alphabetic" });
          x += run.width;
        }
        pdf.endMarkedContent();
        if (line.goTo) pdf.goTo(line.x, line.y, line.width, line.size * 1.2, line.goTo);
      }
      if (page.chapter !== undefined) {
        pdf.markContent("Artifact", { type: "Pagination", attached: ["Bottom"] });
        pdf.font(fontNames[input.settings.font][0]).fontSize(9).text(page.label, frame.left, frame.height - frame.top / 2, { width: frame.textWidth, align: "center", lineBreak: false }); pdf.endMarkedContent();
        if (input.settings.runningHeaders && !page.opening) {
          let header = document.title; const type = new Typesetter(fonts, input);
          while (type.width(header, fontNames[input.settings.font][0], 8) > frame.textWidth && header.length) header = [...header].slice(0, -2).join("") + "…";
          pdf.markContent("Artifact", { type: "Pagination", attached: ["Top"] });
          pdf.font(fontNames[input.settings.font][0]).fontSize(8).text(header, frame.left, frame.top / 2, { width: frame.textWidth, align: "center", lineBreak: false }); pdf.endMarkedContent();
        }
      }
      if (!page.cover && !page.lines.length) throw new Error(`PDF page ${index + 1} is unexpectedly empty.`);
    }
    for (const structure of structures.values()) structure.end();
    root.end();
    // PDFKit exposes refs for PDF number trees; these labels are distinct from physical pages.
    const labels = pdf.ref({ Nums: [0, { P: new String("Front matter "), S: "D", St: 1 }, plan.chapters[0]!.physicalPage - 1, { S: "D", St: 1 }] }); labels.end(undefined);
    (pdf as unknown as { _root: { data: Record<string, unknown> } })._root.data.PageLabels = labels;
    pdf.end();
    const bytes = await complete;
    await checkpoint(); await control.onPhase?.("Checking PDF");
    const checkedLines = await validatePdf(bytes, plan, frame, checkpoint);
    return { bytes, pageCount: plan.pages.length, chapters: plan.chapters, pageLabels: plan.pages.map(page => page.label), receipt: {
      version: 1, identity: STORY_PDF_IDENTITY, sha256: digest(bytes), pageCount: plan.pages.length, paragraphCount: plan.paragraphCount, checkedLines, elapsedMs: Date.now() - started,
      checks: { parsed: true, text: true, geometry: true, navigation: true, fonts: true, structure: true },
      accessibility: "Tagged headings, paragraphs, contents and cover; pagination marked as artifacts. Link annotations are not tagged by PDFKit. Not PDF/UA certified.",
    } };
  } catch (error) { pdf.destroy(); throw error; }
}

function verifyPlanSource(document: ManuscriptDocument, plan: Plan): void {
  const expected: Array<{ key: string; text: string; context: string }> = [];
  for (const [chapterIndex, chapter] of document.chapters.entries()) {
    expected.push({ key: `chapter-${chapterIndex}-heading`, text: chapter.title, context: chapter.title });
    for (const [blockIndex, block] of chapter.blocks.entries()) expected.push({
      key: block.kind === "break" ? `break-${chapterIndex}-${blockIndex}` : `p-${chapterIndex}-${blockIndex}`,
      text: block.kind === "break" ? "* * *" : block.runs.map(run => run.text).join(""), context: `${chapter.title}, paragraph ${blockIndex + 1}`,
    });
  }
  const groups: Array<{ key: string; lines: string[] }> = [];
  for (const page of plan.pages) {
    if (page.chapter === undefined) continue;
    for (const line of page.lines) {
      if (groups.at(-1)?.key !== line.key) groups.push({ key: line.key, lines: [] });
      groups.at(-1)!.lines.push(normalized(line.pieces.map(piece => piece.text).join("")));
    }
  }
  const nonempty = expected.filter(row => normalized(row.text));
  if (groups.length !== nonempty.length) throw new Error("PDF planning changed the manuscript paragraph inventory.");
  for (const [index, group] of groups.entries()) {
    const source = nonempty[index]!;
    if (group.key !== source.key) throw new Error(`${source.context}: PDF planning changed the reading order.`);
    const text = normalized(source.text); let position = 0;
    for (const line of group.lines) {
      // A wrap can consume a source space, or split an unbreakable token without one.
      if (text[position] === " ") position++;
      if (!text.startsWith(line, position)) throw new Error(`${source.context}: PDF planning changed the manuscript text.`);
      position += line.length;
    }
    if (position !== text.length) throw new Error(`${source.context}: PDF planning omitted manuscript text.`);
  }
}

async function validatePdf(bytes: Uint8Array, plan: Plan, frame: ReturnType<typeof storyPdfFrame>, checkpoint: () => Promise<void>): Promise<number> {
  // Independent parsing, not the renderer's own in-memory text ledger. No remote URLs/fonts.
  // PDF.js eagerly constructs an identity matrix for its unused canvas renderer. The parser
  // needs no canvas. Fail closed if a future version starts requiring actual drawing here.
  if (!("DOMMatrix" in globalThis)) Object.defineProperty(globalThis, "DOMMatrix", { configurable: true, value: function ExtractionOnlyMatrix(...args: unknown[]) {
    if (args.length) throw new Error("PDF canvas rendering is unavailable in the validation worker.");
  } });
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loading = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, disableFontFace: true, isEvalSupported: false, useWorkerFetch: false });
  const parsed = await loading.promise;
  let checked = 0;
  try {
    if (parsed.numPages !== plan.pages.length || parsed.numPages === 0) throw new Error("The generated PDF page inventory is damaged.");
    if (await parsed.getAttachments() || await parsed.getJSActions()) throw new Error("The generated PDF contains unexpected active content.");
    const labels = await parsed.getPageLabels();
    if (JSON.stringify(labels) !== JSON.stringify(plan.pages.map(page => page.label))) throw new Error("The generated PDF page labels are damaged.");
    const outline = await parsed.getOutline();
    if (!outline || outline.length !== plan.chapters.length) throw new Error("The generated PDF chapter bookmarks are incomplete.");
    for (const [index, chapter] of plan.chapters.entries()) {
      const dest = await parsed.getDestination(chapter.destination);
      const bookmark = outline[index]!;
      const bookmarkDest = typeof bookmark.dest === "string" ? await parsed.getDestination(bookmark.dest) : bookmark.dest;
      if (!dest || await parsed.getPageIndex(dest[0]) !== chapter.physicalPage - 1 || bookmark.title !== chapter.title || !bookmarkDest || await parsed.getPageIndex(bookmarkDest[0]) !== chapter.physicalPage - 1) throw new Error("The generated PDF chapter navigation is damaged.");
    }
    for (let number = 1; number <= parsed.numPages; number++) {
      await checkpoint();
      const page = await parsed.getPage(number);
      const expected = plan.pages[number - 1]!;
      const content = await page.getTextContent({ disableNormalization: true });
      const items = content.items.filter((item): item is import("pdfjs-dist/types/src/display/api.js").TextItem => "str" in item && !!item.str.trim());
      const used = new Set<number>();
      for (const line of expected.lines) {
        const baseline = frame.height - line.y - line.size;
        const selected = items.map((item, i) => ({ item, i })).filter(({ item }) => Math.abs(item.transform[5]! - baseline) < 0.7 && item.transform[4]! >= line.x - 0.7 && item.transform[4]! < line.x + line.width + 0.7).sort((a, b) => a.item.transform[4]! - b.item.transform[4]!);
        const actual = selected.map(({ item }) => item.str).join("");
        // PDF.js may separate a space-only item. Preserve word boundaries using measured gaps.
        let spaced = ""; let right = line.x;
        for (const { item, i } of selected) {
          if (spaced && item.transform[4]! - right > line.size * 0.15 && !/\s$/u.test(spaced) && !/^\s/u.test(item.str)) spaced += " ";
          spaced += item.str; right = item.transform[4]! + item.width; used.add(i);
          if (item.transform[4]! < frame.left - 0.7 || right > frame.width - frame.left + 0.7 || baseline < frame.height - frame.bottom - 0.7 || baseline + item.height > frame.height - frame.top + line.size * 0.3) throw new Error(`${line.context}: text lies outside the PDF page frame.`);
        }
        const wanted = normalized(line.pieces.map(piece => piece.text).join(""));
        if (normalized(actual) !== wanted && normalized(spaced) !== wanted) throw new Error(`${line.context}: PDF text verification failed. Prepare again or change the unsupported text.`);
        checked++;
      }
      for (const [i, item] of items.entries()) {
        const y = frame.height - item.transform[5]!;
        if (!used.has(i) && y >= frame.top && y <= frame.bottom) throw new Error(`PDF page ${number} contains unexpected or duplicate text.`);
      }
      if (!expected.cover && !await page.getStructTree()) throw new Error(`PDF page ${number} lost its reading structure.`);
      const annotations = await page.getAnnotations();
      for (const annotation of annotations) {
        if (annotation.subtype !== "Link" || annotation.url || annotation.unsafeUrl) throw new Error("The PDF contains an unexpected external annotation.");
        const entry = expected.lines.find(line => line.goTo && annotation.rect[0] >= line.x - 0.7 && annotation.rect[0] <= line.x + line.width + 0.7 && Math.abs(annotation.rect[1] - (frame.height - line.y - line.size)) < line.size);
        if (!entry || annotation.dest !== entry.goTo) throw new Error("A PDF contents link points to the wrong chapter.");
      }
      for (const line of expected.lines.filter(line => line.goTo)) if (!annotations.some(annotation => annotation.dest === line.goTo)) throw new Error("A PDF contents destination is missing.");
      page.cleanup();
    }
    const usedFonts = new Set(plan.pages.flatMap(page => page.lines.flatMap(line => line.pieces.map(piece => piece.face))));
    const embeddedFonts = Buffer.from(bytes).toString("latin1").match(/\/FontFile2\b/g)?.length ?? 0;
    if (embeddedFonts < usedFonts.size) throw new Error("The PDF did not embed all its bundled fonts.");
    return checked;
  } finally { await parsed.destroy(); }
}
