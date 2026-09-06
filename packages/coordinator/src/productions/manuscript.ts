import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  countWords,
  manuscriptChapters,
  manuscriptDocument,
  productionShape,
  type ChapterLevel,
  type ManuscriptDocument,
  type ManuscriptRead,
  type ManuscriptRun,
  type StructuredDocument,
  type StructuredParagraph,
} from "@arke-studio/contracts";
import { decodeXmlEntities, extractionRefusal, zipEntry } from "../world-chat/document-text.js";
import { CHAPTER_SOURCE_SCHEMA_VERSION } from "../world/commit.js";
import { toExtendedLength } from "../world/paths.js";
import { slugify, uniqueSlug } from "../world/slug.js";
import type { WorldStore } from "../world/store.js";
import { MarkdownFile } from "../world/text-files.js";
import { highestChapterRank, openChapter } from "./ops.js";
import { writeZip } from "./zip.js";

/**
 * A manuscript out and a manuscript in (design turn 131, issue 915, SPEC-012 §2.4.3).
 *
 * Out: the chapters with prose, built whole into a `.docx` or a reflowable EPUB and landed
 * under `exports/` through the staging path a cut export uses (R-49, R-52). In: a `.docx` read
 * structured — paragraphs with their style, runs with their emphasis — shown before anything
 * is written, then appended as chapters after the last in one commit (R-50). Both containers
 * are zips written by hand, as the reader in `document-text.ts` reads them.
 */

/**
 * The one way an authored string meets XML (R-52, codex on PR 916): the five entities, and the
 * control characters XML forbids dropped — a title with an ampersand is a title, and a stray
 * byte from a paste is not a file no reader will open.
 */
const xml = (text: string) =>
  [...text]
    .filter((char) => {
      const code = char.codePointAt(0)!;
      return (code >= 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) && code !== 0xfffe && code !== 0xffff;
    })
    .join("")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

// ---------------------------------------------------------------------------
// Word (.docx)
// ---------------------------------------------------------------------------

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const CONTENT_TYPES =
  XML_HEAD +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
  "</Types>";

const ROOT_RELS =
  XML_HEAD +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  "</Relationships>";

const DOCUMENT_RELS =
  XML_HEAD +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
  "</Relationships>";

/**
 * The styles a manuscript is set in: the conventional submission page — a serif, double-spaced,
 * a first-line indent — with the title page centred and each chapter opening on a new page.
 * Named as Word names them, so a reader's own Heading 1 is this file's Heading 1.
 */
const STYLES =
  XML_HEAD +
  `<w:styles xmlns:w="${W_NS}">` +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/>' +
  '<w:pPr><w:spacing w:after="0" w:line="480" w:lineRule="auto"/><w:ind w:firstLine="720"/></w:pPr>' +
  '<w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/>' +
  '<w:pPr><w:jc w:val="center"/><w:ind w:firstLine="0"/><w:spacing w:before="4800" w:after="240"/></w:pPr><w:rPr><w:sz w:val="48"/><w:szCs w:val="48"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/>' +
  '<w:pPr><w:jc w:val="center"/><w:ind w:firstLine="0"/></w:pPr><w:rPr><w:i/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>' +
  '<w:pPr><w:pageBreakBefore/><w:jc w:val="center"/><w:ind w:firstLine="0"/><w:spacing w:before="2400" w:after="480"/><w:outlineLvl w:val="0"/></w:pPr>' +
  '<w:rPr><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="SceneBreak"><w:name w:val="Scene Break"/><w:basedOn w:val="Normal"/>' +
  '<w:pPr><w:jc w:val="center"/><w:ind w:firstLine="0"/></w:pPr></w:style>' +
  "</w:styles>";

function docxParagraph(style: string | null, runs: readonly ManuscriptRun[]): string {
  const props = style === null ? "" : `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>`;
  const body = runs
    .map((run) => {
      const flags = `${run.bold ? "<w:b/>" : ""}${run.italic ? "<w:i/>" : ""}`;
      return `<w:r>${flags === "" ? "" : `<w:rPr>${flags}</w:rPr>`}<w:t xml:space="preserve">${xml(run.text)}</w:t></w:r>`;
    })
    .join("");
  return `<w:p>${props}${body}</w:p>`;
}

/** The manuscript as a `.docx`: one document part, one styles part, and the parts that name them (R-49, R-52). */
export function writeDocx(doc: ManuscriptDocument): Uint8Array {
  const paragraphs: string[] = [docxParagraph("Title", [{ text: doc.title }]), docxParagraph("Subtitle", [{ text: doc.subtitle }])];
  for (const chapter of doc.chapters) {
    paragraphs.push(docxParagraph("Heading1", [{ text: chapter.title }]));
    for (const block of chapter.blocks) {
      paragraphs.push(block.kind === "break" ? docxParagraph("SceneBreak", [{ text: "* * *" }]) : docxParagraph(null, block.runs));
    }
  }
  const document =
    XML_HEAD +
    `<w:document xmlns:w="${W_NS}"><w:body>` +
    paragraphs.join("") +
    '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>' +
    "</w:body></w:document>";
  const utf8 = (text: string) => new TextEncoder().encode(text);
  return writeZip([
    { name: "[Content_Types].xml", data: utf8(CONTENT_TYPES) },
    { name: "_rels/.rels", data: utf8(ROOT_RELS) },
    { name: "word/_rels/document.xml.rels", data: utf8(DOCUMENT_RELS) },
    { name: "word/document.xml", data: utf8(document) },
    { name: "word/styles.xml", data: utf8(STYLES) },
  ]);
}

// ---------------------------------------------------------------------------
// EPUB
// ---------------------------------------------------------------------------

const EPUB_CSS = [
  "body { font-family: Georgia, 'Times New Roman', serif; line-height: 1.5; }",
  "h1 { text-align: center; font-size: 1.4em; margin: 3em 0 2em; page-break-before: always; }",
  "p { margin: 0; text-indent: 1.5em; }",
  "p.first { text-indent: 0; }",
  "hr.break { border: 0; text-align: center; margin: 1.5em 0; }",
  "hr.break::after { content: '* * *'; }",
  ".title { text-align: center; margin-top: 30%; font-size: 2em; }",
  ".subtitle { text-align: center; font-style: italic; text-indent: 0; }",
].join("\n");

function xhtml(title: string, body: string, language: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n' +
    `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${xml(language)}" lang="${xml(language)}">` +
    `<head><meta charset="utf-8"/><title>${xml(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>` +
    `<body>${body}</body></html>`
  );
}

function html(runs: readonly ManuscriptRun[]): string {
  return runs
    .map((run) => {
      let text = xml(run.text);
      if (run.italic) text = `<em>${text}</em>`;
      if (run.bold) text = `<strong>${text}</strong>`;
      return text;
    })
    .join("");
}

/**
 * The manuscript as a reflowable EPUB 3 (R-49, R-52): `mimetype` first and stored, the
 * container, the package with title, language and identifier, a navigation document, one XHTML
 * file a chapter, and a stylesheet of a few lines.
 */
export function writeEpub(doc: ManuscriptDocument, opts: { identifier: string; language: string; modified: string }): Uint8Array {
  const utf8 = (text: string) => new TextEncoder().encode(text);
  const chapterFile = (index: number) => `chapter-${index + 1}.xhtml`;
  const chapters = doc.chapters.map((chapter, index) => {
    let first = true;
    const blocks = chapter.blocks
      .map((block) => {
        if (block.kind === "break") {
          first = true;
          return '<hr class="break"/>';
        }
        const paragraph = `<p${first ? ' class="first"' : ""}>${html(block.runs)}</p>`;
        first = false;
        return paragraph;
      })
      .join("\n");
    return { name: `OEBPS/${chapterFile(index)}`, data: utf8(xhtml(chapter.title, `<section epub:type="chapter"><h1>${xml(chapter.title)}</h1>\n${blocks}</section>`, opts.language)) };
  });
  const title = xhtml(doc.title, `<section epub:type="titlepage"><h1 class="title">${xml(doc.title)}</h1><p class="subtitle">${xml(doc.subtitle)}</p></section>`, opts.language);
  const nav = xhtml(
    "Contents",
    `<nav epub:type="toc" id="toc"><h1>Contents</h1><ol><li><a href="title.xhtml">${xml(doc.title)}</a></li>` +
      doc.chapters.map((chapter, index) => `<li><a href="${chapterFile(index)}">${xml(chapter.title)}</a></li>`).join("") +
      "</ol></nav>",
    opts.language,
  );
  const modified = opts.modified.replace(/\.\d{3}Z$/, "Z");
  const manifest =
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>' +
    '<item id="css" href="style.css" media-type="text/css"/>' +
    '<item id="title" href="title.xhtml" media-type="application/xhtml+xml"/>' +
    doc.chapters.map((_, index) => `<item id="c${index + 1}" href="${chapterFile(index)}" media-type="application/xhtml+xml"/>`).join("");
  const spine = '<itemref idref="title"/>' + doc.chapters.map((_, index) => `<itemref idref="c${index + 1}"/>`).join("");
  const opf =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<package version="3.0" unique-identifier="pub-id" xmlns="http://www.idpf.org/2007/opf">' +
    '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">' +
    `<dc:identifier id="pub-id">${xml(opts.identifier)}</dc:identifier>` +
    `<dc:title>${xml(doc.title)}</dc:title>` +
    `<dc:language>${xml(opts.language)}</dc:language>` +
    `<meta property="dcterms:modified">${xml(modified)}</meta>` +
    "</metadata>" +
    `<manifest>${manifest}</manifest><spine>${spine}</spine></package>`;
  const container =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
    '<rootfiles><rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>';
  return writeZip([
    { name: "mimetype", data: utf8("application/epub+zip"), stored: true },
    { name: "META-INF/container.xml", data: utf8(container) },
    { name: "OEBPS/package.opf", data: utf8(opf) },
    { name: "OEBPS/nav.xhtml", data: utf8(nav) },
    { name: "OEBPS/style.css", data: utf8(EPUB_CSS) },
    { name: "OEBPS/title.xhtml", data: utf8(title) },
    ...chapters,
  ]);
}

// ---------------------------------------------------------------------------
// The structured read of a .docx
// ---------------------------------------------------------------------------

const TAG = /<(\/?)([A-Za-z0-9_:.-]+)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
// Either quote XML allows (codex on PR 924): a serializer that writes `w:val='Heading1'` is as valid as one that writes double quotes.
const attribute = (attrs: string, name: string): string | undefined => {
  const match = new RegExp(`(?:^|\\s)${name}=(?:"([^"]*)"|'([^']*)')`).exec(attrs);
  return match?.[1] ?? match?.[2];
};

/**
 * The italic and bold a character style carries (codex on PR 924): Word's `Emphasis` and
 * `Strong`, or anything a person named, applied through `w:rStyle` rather than as `w:i` and
 * `w:b` on the run. Read from the styles part, with `basedOn` followed so a style that only
 * renames another still says what it inherits.
 */
function characterStyles(bytes: Uint8Array): (id: string | undefined) => { italic: boolean; bold: boolean } {
  const none = { italic: false, bold: false };
  let entry: Uint8Array | null = null;
  try {
    entry = zipEntry(bytes, "word/styles.xml");
  } catch {
    entry = null;
  }
  if (entry === null) return () => none;
  const source = new TextDecoder("utf-8").decode(entry);
  const styles = new Map<string, { basedOn?: string; italic?: boolean; bold?: boolean }>();
  let current: { id: string; basedOn?: string; italic?: boolean; bold?: boolean } | null = null;
  let inRunProps = false;
  for (const match of source.matchAll(TAG)) {
    const closing = match[1] === "/";
    const selfClosing = match[4] === "/";
    const name = match[2] ?? "";
    const local = name.slice(name.indexOf(":") + 1);
    const attrs = match[3] ?? "";
    switch (local) {
      case "style":
        if (!closing && !selfClosing) {
          const id = attribute(attrs, "w:styleId");
          current = attribute(attrs, "w:type") === "character" && id !== undefined ? { id } : null;
        } else if (closing && current !== null) {
          styles.set(current.id, current);
          current = null;
        }
        break;
      case "basedOn":
        if (current !== null) current.basedOn = attribute(attrs, "w:val");
        break;
      case "rPr":
        inRunProps = current !== null && !closing && !selfClosing;
        break;
      case "i":
      case "b":
        if (current !== null && inRunProps) {
          const on = !OFF.has((attribute(attrs, "w:val") ?? "true").toLowerCase());
          if (local === "i") current.italic = on;
          else current.bold = on;
        }
        break;
      default:
        break;
    }
  }
  const resolved = new Map<string, { italic: boolean; bold: boolean }>();
  const resolve = (id: string, depth: number): { italic: boolean; bold: boolean } => {
    const known = resolved.get(id);
    if (known !== undefined) return known;
    const style = styles.get(id);
    if (style === undefined || depth > 8) return none;
    const parent = style.basedOn !== undefined ? resolve(style.basedOn, depth + 1) : none;
    // Bold and italic are toggles down a style chain (codex on PR 927): a child that says `w:b`
    // over a bold parent turns bold off, and one that says it off leaves the parent's word.
    const toggle = (own: boolean | undefined, inherited: boolean) => (own === undefined || own === false ? inherited : !inherited);
    const flags = { italic: toggle(style.italic, parent.italic), bold: toggle(style.bold, parent.bold) };
    resolved.set(id, flags);
    return flags;
  };
  return (id) => (id === undefined ? none : resolve(id, 0));
}
const OFF = new Set(["0", "false", "off"]);

/**
 * A `.docx` read structured (R-50): every paragraph with its style id, its runs with their
 * emphasis, and whether a page break fell in it. Only `w:t` is words, as in the flat read;
 * tracked deletions and field codes stay out by not being `w:t`. Nothing here truncates — the
 * flat extraction's ceiling guards a prompt, and this read's count is what the import's cap is
 * judged on (codex on PR 916).
 */
export function readDocxDocument(bytes: Uint8Array): { ok: true; document: StructuredDocument } | { ok: false; reason: "protected" | "damaged" | "no-text" } {
  let entry: Uint8Array | null;
  try {
    entry = zipEntry(bytes, "word/document.xml");
  } catch {
    return { ok: false, reason: "damaged" };
  }
  if (entry === null) {
    if (bytes.length >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf) return { ok: false, reason: "protected" };
    return { ok: false, reason: "damaged" };
  }
  const source = new TextDecoder("utf-8").decode(entry);
  const styleFlags = characterStyles(bytes);
  const paragraphs: StructuredParagraph[] = [];
  let paragraph: StructuredParagraph | null = null;
  let inParagraphProps = false;
  let inRun = false;
  let inRunProps = false;
  let italic = false;
  let bold = false;
  let reading = false;
  let readAt = 0;
  let notes = 0;
  let links = 0;
  const say = (text: string) => {
    if (paragraph === null || text === "") return;
    paragraph.runs.push({ text, ...(italic ? { italic: true as const } : {}), ...(bold ? { bold: true as const } : {}) });
  };
  try {
  for (const match of source.matchAll(TAG)) {
    const index = match.index;
    if (reading && index > readAt) say(decodeXmlEntities(source.slice(readAt, index)));
    readAt = index + match[0].length;
    const closing = match[1] === "/";
    const selfClosing = match[4] === "/";
    const name = match[2] ?? "";
    const local = name.slice(name.indexOf(":") + 1);
    const attrs = match[3] ?? "";
    switch (local) {
      case "p":
        if (closing) {
          if (paragraph !== null) paragraphs.push(paragraph);
          paragraph = null;
        } else if (!selfClosing) {
          paragraph = { runs: [] };
        } else {
          paragraphs.push({ runs: [] });
        }
        break;
      case "pPr":
        inParagraphProps = !closing && !selfClosing;
        break;
      case "pStyle": {
        const value = attribute(attrs, "w:val");
        if (inParagraphProps && paragraph !== null && value !== undefined) paragraph.style = value;
        break;
      }
      case "r":
        if (!closing && !selfClosing) {
          inRun = true;
          italic = false;
          bold = false;
        } else if (closing) {
          inRun = false;
        }
        break;
      case "rPr":
        inRunProps = inRun && !inParagraphProps && !closing && !selfClosing;
        break;
      case "rStyle": {
        // The style's own italic and bold first; an explicit w:i or w:b after it still wins.
        if (!inRunProps) break;
        const flags = styleFlags(attribute(attrs, "w:val"));
        if (flags.italic) italic = true;
        if (flags.bold) bold = true;
        break;
      }
      case "i":
      case "b":
        if (inRunProps) {
          const on = !OFF.has((attribute(attrs, "w:val") ?? "true").toLowerCase());
          if (local === "i") italic = on;
          else bold = on;
        }
        break;
      case "t":
        if (!selfClosing) reading = !closing;
        break;
      case "tab":
        if (!closing) say("\t");
        break;
      case "footnoteReference":
      case "endnoteReference":
        // The note's text lives in another part the read leaves alone: counted, and said.
        if (!closing) notes += 1;
        break;
      case "hyperlink":
        // The label is words in the body; the target lives in the relationships part: counted, and said.
        if (!closing && !selfClosing) links += 1;
        break;
      case "br":
      case "cr":
        if (closing) break;
        if (attribute(attrs, "w:type") === "page") {
          // The break keeps its place (codex on PR 924): words after it in the same paragraph
          // are a paragraph of their own, so the scene break falls between them, not after both.
          if (paragraph !== null) {
            if (paragraph.runs.some((run) => run.text.trim() !== "")) {
              paragraph.pageBreak = true;
              paragraphs.push(paragraph);
              paragraph = { runs: [] };
            } else {
              // Before any words (codex on PR 924): a break of its own, so what follows comes after it.
              paragraphs.push({ runs: [], pageBreak: true });
            }
          }
        } else {
          say("\n");
        }
        break;
      default:
        break;
    }
  }
  } catch {
    // An entity no code point can hold, or any other thing the walk cannot read: damaged, said
    // so, rather than an exception the sheet never hears of (codex on PR 924).
    return { ok: false, reason: "damaged" };
  }
  if (paragraph !== null) paragraphs.push(paragraph);
  const said = paragraphs.some((entry) => entry.runs.some((run) => run.text.trim() !== ""));
  if (!said) return { ok: false, reason: "no-text" };
  return { ok: true, document: { paragraphs, notes, links } };
}

/** A manuscript out of a file's bytes, or the reason there is none — the extractor's own sentence. */
export function readManuscript(bytes: Uint8Array, fileName: string, level?: ChapterLevel): { document: StructuredDocument | null; read: ManuscriptRead } {
  const read = readDocxDocument(bytes);
  if (!read.ok) return { document: null, read: { ok: false, fileName, reason: extractionRefusal(fileName, read.reason) } };
  return { document: read.document, read: manuscriptChapters(read.document, fileName, level) };
}

// ---------------------------------------------------------------------------
// Out of the world, and into it
// ---------------------------------------------------------------------------

/** The production's manuscript as it stands: every chapter's saved body, in order (R-49). */
export async function manuscriptOf(store: WorldStore, productionId: string): Promise<ManuscriptDocument> {
  const bundle = store.getBundle();
  const production = bundle.productions.find((entry) => entry.meta.id === productionId);
  if (!production) throw new Error("That production is not in this world.");
  const ordered = [...production.chapters].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const chapters: Array<{ title: string; body: string }> = [];
  for (const chapter of ordered) {
    const opened = await openChapter(store, productionId, chapter.id);
    chapters.push({ title: opened.title, body: opened.body });
  }
  return manuscriptDocument({ title: production.meta.title, worldName: bundle.meta.name, chapters });
}

export interface ManuscriptExport {
  /** World-relative, under `exports/`. */
  output: string;
  chapters: number;
  leftOut: number;
  words: number;
}

/**
 * The manuscript written under `exports/` (R-49): built whole, staged under `.cache/exports/`
 * and renamed into place through the store's ownership-checked write, so a failure part-way
 * leaves nothing named as a manuscript (SPEC-013 R-21) and a coordinator whose claim was lost
 * mid-build writes nothing into a folder a successor now owns (codex on PR 916). The export's
 * id is in the file name: two exports in one second are two files.
 */
export async function exportManuscript(
  store: WorldStore,
  productionId: string,
  format: "docx" | "epub",
  opts: { exportId: string; language: string; now: () => string; signal?: AbortSignal },
): Promise<ManuscriptExport> {
  const doc = await manuscriptOf(store, productionId);
  if (doc.chapters.length === 0) throw new Error("nothing to export · no chapter has prose yet");
  const bytes =
    format === "docx"
      ? writeDocx(doc)
      : writeEpub(doc, { identifier: `urn:arke:${store.worldId}:${productionId}`, language: opts.language, modified: opts.now() });
  if (opts.signal?.aborted) throw new Error("cancelled");
  const stamp = opts.now().replace(/[-:TZ.]/g, "").slice(0, 14);
  // The id's last six characters are its random ones (codex on PR 924); its first six are the
  // clock, which the stamp already says, and two exports in one second would share them.
  const name = `${productionId}-${stamp}-${opts.exportId.replace(/^ms_/, "").slice(-6).toLowerCase()}.${format}`;
  const stageDir = join(store.dir, ".cache", "exports");
  const stage = join(stageDir, `${opts.exportId}.${format}`);
  const finalDir = join(store.dir, "exports");
  await mkdir(toExtendedLength(stageDir), { recursive: true });
  await mkdir(toExtendedLength(finalDir), { recursive: true });
  try {
    await writeFile(toExtendedLength(stage), bytes);
    if (opts.signal?.aborted) throw new Error("cancelled");
    await store.ownedWrite(async () => {
      if (opts.signal?.aborted) throw new Error("cancelled");
      await rename(toExtendedLength(stage), toExtendedLength(join(finalDir, name)));
    });
  } catch (error) {
    await rm(toExtendedLength(stage), { force: true }).catch(() => {});
    throw error;
  }
  return { output: `exports/${name}`, chapters: doc.chapters.length, leftOut: doc.leftOut, words: doc.words };
}

/**
 * The chapters a read found, appended after the last in one commit (R-50): every file made and
 * written together, so a crash or a lost claim part-way leaves none of them, never a prefix.
 * Each is a draft at version 1 with `source` naming the file, and nothing existing moves. The
 * commit raises the schema boundary the new field needs (SPEC-023 R-23).
 */
export async function importManuscript(
  store: WorldStore,
  productionId: string,
  read: Extract<ManuscriptRead, { ok: true }>,
  now: () => string,
): Promise<{ created: string[]; after: number }> {
  const bundle = store.getBundle();
  const production = bundle.productions.find((entry) => entry.meta.id === productionId);
  if (!production) throw new Error("That production is not in this world.");
  if (!productionShape(production.meta).hasChapters) throw new Error("That production has no chapters to add to.");
  const existing = production.chapters;
  // Every file in the chapters folder reserves its stem (codex on PR 924), not only the chapters
  // the scanner could read: a malformed or newer file there would otherwise be written over.
  const onDisk = await readdir(toExtendedLength(join(store.dir, "productions", productionId, "chapters"))).catch(() => [] as string[]);
  const claimed = new RegExp(`^productions/${productionId}/chapters/([^/]+)\\.md$`);
  const staged = bundle.proposals.flatMap((entry) =>
    entry.proposal.targets.flatMap((target) => {
      const match = claimed.exec(target.path);
      return match ? [match[1]!] : [];
    }),
  );
  const taken = [...existing.flatMap((chapter) => [chapter.file, chapter.id]), ...staged, ...onDisk.filter((name) => name.endsWith(".md")).map((name) => name.slice(0, -3))];
  const after = await highestChapterRank(store, productionId, existing.map((chapter) => chapter.file));
  const day = now().slice(0, 10);
  const created: string[] = [];
  const files = read.chapters.map((chapter, index) => {
    const order = after + index + 1;
    const slug = uniqueSlug(slugify(chapter.title) || `chapter-${order}`, "chapter", taken);
    taken.push(slug);
    created.push(slug);
    const doc = MarkdownFile.create(
      { id: slug, title: chapter.title, order, status: "draft", version: 1, words: countWords(chapter.body), source: read.fileName, created: day, updated: day },
      chapter.body,
    );
    return { path: `productions/${productionId}/chapters/${slug}.md`, action: "create" as const, content: doc.serialize(), baseHash: null };
  });
  await store.commit({ kind: "chapter-import", raiseSchemaVersion: CHAPTER_SOURCE_SCHEMA_VERSION, source: "import", files });
  return { created, after };
}
