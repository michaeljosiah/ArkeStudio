import { inflateRawSync, inflateSync } from "node:zlib";
import { extname } from "node:path";

/**
 * Text out of PDF and Word files (#70 §13.2, §23.2).
 *
 * World Chat may only be handed what it can honestly read, and until now that meant Markdown and
 * plain text: a PDF was a document by extension and unreadable in fact, so it was refused at the
 * door. What was missing was not permission but an extraction step — the thing the refusal
 * message named. This is that step.
 *
 * It is written here rather than pulled in, for the same reason `readableText` is: a quotation is
 * verified against stored text, so the transformation that produces that text has to be one
 * somebody can read and reason about a year from now. It is also the safer choice for what this
 * app is — a parser that reads `import.meta.url` at module scope survives every test and kills
 * the packaged build.
 *
 * The honesty rule outlives the format. Extraction that finds nothing does not produce an empty
 * attachment; it refuses, and says which of the three things went wrong. A scanned page has no
 * text in it, a protected file cannot be opened at all, and a damaged one is neither.
 */

/** What the extractors will produce for one file, before anything is written. */
export type Extraction =
  { ok: true; text: string } | { ok: false; reason: "no-text" | "protected" | "damaged" };

/**
 * The formats this reads by extracting rather than by decoding.
 *
 * Legacy `.doc` is not here and should not be: it is a compound binary document, and a partial
 * reading of one would be the failure this module exists to avoid rather than a lesser version
 * of success.
 */
export const EXTRACTED_EXTENSIONS: readonly string[] = ["pdf", "docx"];

export function isExtractable(fileName: string): boolean {
  return EXTRACTED_EXTENSIONS.includes(extname(fileName).slice(1).toLowerCase());
}

/**
 * Enough text for any window a model will be given, and a stop on a file built to be endless.
 *
 * What actually reaches a prompt is the run's text budget, decided against the model's window.
 * This is the ceiling on how much work one attachment may cost before that decision is made.
 */
export const MAX_EXTRACTED_CHARS = 1_000_000;

/** Text out of one file, or the reason there is none. `null` when this is not a format it reads. */
export function extractDocumentText(fileName: string, bytes: Uint8Array): Extraction | null {
  const ext = extname(fileName).slice(1).toLowerCase();
  if (ext === "pdf") return extractPdfText(bytes);
  if (ext === "docx") return extractDocxText(bytes);
  return null;
}

/**
 * The sentence a refusal carries, in the words the person reading it needs.
 *
 * Named here beside the reasons so the three stay in step: a reason with no sentence is a silent
 * refusal, which is the one outcome worse than a spoken one.
 */
export function extractionRefusal(
  fileName: string,
  reason: Exclude<Extraction, { ok: true }>["reason"],
): string {
  if (reason === "protected") return `${fileName} is protected, and this cannot open it.`;
  if (reason === "damaged") return `${fileName} could not be opened.`;
  return `${fileName} has no text in it to read — it may be a scan.`;
}

/**
 * The last gate, and the one that catches what a parser cannot.
 *
 * Extraction can succeed structurally and still produce nothing worth reading: a font with no
 * `ToUnicode` map hands back glyph numbers, and glyph numbers decoded as characters are not
 * words, they are noise that a model will quote as though it were prose. So what comes out is
 * looked at once more as text — mostly letters and the marks that go with them, and enough of
 * them to be a document — before it is called readable.
 */
function finish(result: Extraction): Extraction {
  if (!result.ok) return result;
  const text = result.text.slice(0, MAX_EXTRACTED_CHARS).trim();
  // A page number salvaged off a scan is not a document. Two or three characters is the whole of
  // the claim here: below it there is nothing a conversation could be said to have read.
  const letters = text.replace(/[^\p{L}\p{N}]/gu, "").length;
  if (letters < 3) return { ok: false, reason: "no-text" };
  const noise = text.replace(/[\p{L}\p{N}\p{P}\p{S}\p{Zs}\n\r\t]/gu, "").length;
  if (noise / text.length > 0.05) return { ok: false, reason: "no-text" };
  return { ok: true, text };
}

function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
}

/**
 * Blank space as a document means it, without the runs a layout engine leaves behind.
 *
 * Trailing spaces and triple blank lines are artefacts of how the text was positioned on a page,
 * not of what was written, and they would sit inside every quotation taken from the file.
 */
function tidy(text: string): string {
  return (
    text
      .replace(/\r\n?/g, "\n")
      // Typographic ligatures are one character in a font and two letters in a word. Left as they
      // are, "specification" is not findable in a document that plainly contains it, and a
      // quotation of it fails to verify against the file it was taken from.
      .replace(/ﬀ/g, "ff")
      .replace(/ﬁ/g, "fi")
      .replace(/ﬂ/g, "fl")
      .replace(/ﬃ/g, "ffi")
      .replace(/ﬄ/g, "ffl")
      .replace(/[ﬅﬆ]/g, "st")
      .replace(/[^\S\n]+/g, " ")
      .replace(/ *\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

// ---------------------------------------------------------------------------
// Word (.docx)
// ---------------------------------------------------------------------------

/**
 * A .docx is a zip, and the words are in one entry of it.
 *
 * `word/document.xml` is the body. Headers, footers and footnotes are separate entries and are
 * deliberately left out: they are page furniture, they repeat on every page, and folding them
 * into the body would put a running header between two sentences that follow each other.
 */
export function extractDocxText(bytes: Uint8Array): Extraction {
  return finish(readDocx(bytes));
}

function readDocx(bytes: Uint8Array): Extraction {
  let entry: Uint8Array | null;
  try {
    entry = zipEntry(bytes, "word/document.xml");
  } catch {
    return { ok: false, reason: "damaged" };
  }
  if (entry === null) {
    // A password-protected .docx is not a zip at all — it is an OLE container with the zip
    // encrypted inside it, so its first bytes say so plainly.
    if (bytes.length >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf)
      return { ok: false, reason: "protected" };
    return { ok: false, reason: "damaged" };
  }
  return { ok: true, text: tidy(wordXmlToText(new TextDecoder("utf-8").decode(entry))) };
}

/**
 * The document body as text.
 *
 * Only `w:t` is words. Everything else in that file is how the words look, except for the four
 * elements that carry structure a reader would notice if it went missing: paragraphs, line
 * breaks and tabs. Tracked deletions (`w:delText`) and field codes (`w:instrText`) are text in
 * the XML and are not text in the document, and they are skipped by naming what is read rather
 * than what is not.
 */
export function wordXmlToText(xml: string): string {
  const tag = /<(\/?)([A-Za-z0-9_:.-]+)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let out = "";
  let readAt = 0;
  let reading = false;
  for (const match of xml.matchAll(tag)) {
    const index = match.index;
    if (reading && index > readAt) out += decodeXmlEntities(xml.slice(readAt, index));
    readAt = index + match[0].length;
    const closing = match[1] === "/";
    const selfClosing = match[4] === "/";
    const name = match[2] ?? "";
    const local = name.slice(name.indexOf(":") + 1);
    switch (local) {
      case "t":
        // `<w:t/>` is an empty run, not the start of one.
        if (!selfClosing) reading = !closing;
        break;
      case "tab":
        if (!closing) out += "\t";
        break;
      case "br":
      case "cr":
        if (!closing) out += "\n";
        break;
      case "p":
        if (closing) out += "\n";
        break;
      default:
        break;
    }
  }
  return out;
}

function decodeXmlEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x?[0-9A-Fa-f]+|[a-z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    return named[body] ?? whole;
  });
}

/** One entry out of a zip, by name. Stored and deflated only — a .docx uses nothing else. */
function zipEntry(zip: Uint8Array, wanted: string): Uint8Array | null {
  if (zip.byteLength < 22) return null;
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  // The comment at the end of a zip may be 64 KB long, so the record is found by searching back
  // through it rather than by assuming it is the last twenty-two bytes.
  const floor = Math.max(0, zip.byteLength - 22 - 65_535);
  for (let i = zip.byteLength - 22; i >= floor; i--) {
    if (dv.getUint32(i, true) === 0x0605_4b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const count = dv.getUint16(eocd + 10, true);
  let at = dv.getUint32(eocd + 16, true);
  for (let i = 0; i < count; i++) {
    if (at + 46 > zip.byteLength || dv.getUint32(at, true) !== 0x0201_4b50) return null;
    const method = dv.getUint16(at + 10, true);
    const compressedSize = dv.getUint32(at + 20, true);
    const nameLength = dv.getUint16(at + 28, true);
    const extraLength = dv.getUint16(at + 30, true);
    const commentLength = dv.getUint16(at + 32, true);
    const localAt = dv.getUint32(at + 42, true);
    const name = latin1(zip.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    if (name !== wanted) continue;

    if (localAt + 30 > zip.byteLength || dv.getUint32(localAt, true) !== 0x0403_4b50) return null;
    // The local header's own name and extra lengths, which need not match the directory's.
    const dataAt = localAt + 30 + dv.getUint16(localAt + 26, true) + dv.getUint16(localAt + 28, true);
    const data = zip.subarray(dataAt, dataAt + compressedSize);
    if (method === 0) return data;
    if (method !== 8) return null;
    return new Uint8Array(inflateRawSync(Buffer.from(data.buffer, data.byteOffset, data.byteLength)));
  }
  return null;
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

interface PdfObject {
  dict: string;
  /** The stream's bytes as the file stores them — still compressed, and only if it has one. */
  raw: Uint8Array | null;
  decoded?: Uint8Array | null;
}

/**
 * What a stream holds, decompressed, decoded once and remembered.
 *
 * Lazy because most of a PDF is not words. A design deck is fifty megabytes of pictures with a
 * caption on each page, and inflating every image to find that out took seven seconds — for a
 * file whose honest answer was that it has no text in it at all.
 */
function streamOf(object: PdfObject): Uint8Array | null {
  if (object.decoded !== undefined) return object.decoded;
  object.decoded = object.raw === null ? null : decodeStream(object.dict, object.raw);
  return object.decoded;
}

/**
 * Streams that cannot be words, skipped before they are ever inflated.
 *
 * Pictures, font programs and the XMP packet are all large and all certain not to be page
 * content. Naming them is cheaper than reading them, and it is the difference between reading a
 * picture book and unpacking one.
 */
const NOT_TEXT_STREAM =
  /\/Subtype\s*\/(Image|Type1C|CIDFontType0C|OpenType)\b|\/Type\s*\/(Metadata|XRef)\b|\/Length1\b/;

interface PdfFont {
  /** One byte per character, or two — a Type0 font addresses glyphs, not letters. */
  codeBytes: 1 | 2;
  /** Codes to characters, when the file says what its glyphs mean. */
  toUnicode: Map<number, string> | null;
}

/**
 * Words out of a PDF.
 *
 * A PDF does not contain text so much as instructions for putting marks where text would be, so
 * this reads the instructions: every object in the file, the streams inside them decompressed,
 * the page tree walked so pages come out in the order they are read, and each page's content
 * interpreted for the operators that show a string. Fonts matter because a subset font addresses
 * its own glyphs by number, and only its `ToUnicode` map says which letters those are.
 *
 * Where the structure cannot be walked — a damaged file, a cross-reference table this does not
 * follow — it falls back to every stream that looks like page content, in the order the file
 * stores them. That is worse and it is honest: what comes back is still text that is in the
 * document, possibly out of order.
 */
export function extractPdfText(bytes: Uint8Array): Extraction {
  return finish(readPdf(bytes));
}

function readPdf(bytes: Uint8Array): Extraction {
  const src = latin1(bytes);
  if (!src.startsWith("%PDF-") && !src.slice(0, 1024).includes("%PDF-")) {
    return { ok: false, reason: "damaged" };
  }
  // An encrypted PDF has strings and streams enciphered under a key this does not derive. Every
  // stream would inflate to nothing and the file would read as a scan, which is the wrong answer
  // to give somebody who knows their document has words in it.
  if (/trailer[\s\S]{0,2048}?\/Encrypt\b/.test(src) || /\/Encrypt\s+\d+\s+\d+\s+R/.test(src)) {
    return { ok: false, reason: "protected" };
  }

  let objects: Map<number, PdfObject>;
  try {
    objects = scanObjects(bytes, src);
    expandObjectStreams(objects);
  } catch {
    return { ok: false, reason: "damaged" };
  }
  if (objects.size === 0) return { ok: false, reason: "damaged" };

  const pages = pageOrder(objects);
  const out: string[] = [];
  /**
   * Which streams were already read as a page's content.
   *
   * The fallback below must not read them again. A page whose fonts say its glyphs have no
   * meaning correctly produces nothing, and re-reading that same stream without the fonts
   * produces glyph numbers dressed as letters — a second, worse answer to a question already
   * answered properly.
   */
  const asPageContent = new Set<number>();
  /**
   * Fonts, read once each.
   *
   * A page names the fonts it uses and a document uses the same ones on every page, so without
   * this a hundred-page report parses the same character map a hundred times — which is most of
   * what made reading a long one slow.
   */
  const fontCache = new Map<number, PdfFont>();
  let budget = MAX_EXTRACTED_CHARS;

  for (const pageNum of pages) {
    if (budget <= 0) break;
    const page = objects.get(pageNum);
    if (!page) continue;
    const content = pageContent(objects, page.dict, asPageContent);
    if (content === "") continue;
    const text = renderContent(content, pageFonts(objects, page.dict, fontCache));
    if (text.trim() === "") continue;
    budget -= text.length;
    out.push(text);
  }

  if (out.length === 0) {
    const loose = looseContent(objects, budget, asPageContent);
    if (loose !== "") out.push(loose);
  }
  if (out.length === 0) return { ok: false, reason: "no-text" };
  return { ok: true, text: tidy(out.join("\n\n")) };
}

/**
 * Every `N 0 obj … endobj` in the file, with its stream bytes decompressed.
 *
 * Scanned rather than read through the cross-reference table on purpose: the table is the part
 * of a PDF most likely to be wrong in a file somebody had trouble with, and a scan finds the
 * objects whether or not anything points at them.
 */
function scanObjects(bytes: Uint8Array, src: string): Map<number, PdfObject> {
  const objects = new Map<number, PdfObject>();
  const header = /(\d+)\s+(\d+)\s+obj\b/g;
  for (const match of src.matchAll(header)) {
    const num = Number(match[1]);
    const from = match.index + match[0].length;
    const end = src.indexOf("endobj", from);
    const body = src.slice(from, end < 0 ? src.length : end);

    // "endstream" ends in "stream" too, so the keyword is only the keyword when what precedes it
    // is not "end".
    const opener = /(?<!end)stream(\r\n|\n|\r)/.exec(body);
    if (!opener) {
      objects.set(num, { dict: body, raw: null });
      continue;
    }
    const dict = body.slice(0, opener.index);
    const dataAt = from + opener.index + opener[0].length;
    const declared = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
    let length = declared ? Number(declared[1]) : -1;
    if (
      length < 0 ||
      dataAt + length > src.length ||
      !/^\s*endstream/.test(src.slice(dataAt + length, dataAt + length + 20))
    ) {
      // Either the length is an indirect reference or it is wrong; the terminator is the truth.
      const terminator = src.indexOf("endstream", dataAt);
      length = terminator < 0 ? 0 : terminator - dataAt;
    }
    objects.set(num, {
      dict,
      raw: bytes.subarray(dataAt, dataAt + Math.max(0, length)),
      ...(NOT_TEXT_STREAM.test(dict) ? { decoded: null } : {}),
    });
  }
  return objects;
}

/** A stream's bytes, decompressed, or null when its filters are not ones this reads. */
function decodeStream(dict: string, raw: Uint8Array): Uint8Array | null {
  const filter = valueFor(dict, "Filter");
  if (filter === null) return raw;
  if (/LZWDecode|DCTDecode|JPXDecode|CCITTFaxDecode|RunLengthDecode|JBIG2Decode|Crypt/.test(filter))
    return null;

  let data = raw;
  if (filter.includes("ASCIIHexDecode")) {
    data = new Uint8Array(hexBytes(latin1(data).replace(/>[\s\S]*$/, "")));
  }
  if (!filter.includes("FlateDecode")) return data;
  const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  try {
    return new Uint8Array(inflateSync(buffer));
  } catch {
    try {
      // Some writers emit a raw deflate stream without the two-byte zlib header.
      return new Uint8Array(inflateRawSync(buffer));
    } catch {
      return null;
    }
  }
}

/**
 * Objects stored inside other objects (PDF 1.5), unpacked in place.
 *
 * Everything structural in a modern PDF — the page tree, the font dictionaries — is usually in
 * one of these, compressed. Without unpacking them a scan finds content streams and nothing that
 * explains them, which is exactly the case where the text comes out as glyph numbers.
 */
function expandObjectStreams(objects: Map<number, PdfObject>): void {
  // A snapshot, because the loop adds to the map it is walking: iterating live would hand the
  // loop the objects it has just unpacked and ask whether each of those is a container too.
  for (const object of Array.from(objects.values())) {
    if (object.raw === null || !/\/Type\s*\/ObjStm\b/.test(object.dict)) continue;
    const count = Number(valueFor(object.dict, "N") ?? 0);
    const first = Number(valueFor(object.dict, "First") ?? 0);
    if (!Number.isFinite(count) || !Number.isFinite(first) || count <= 0) continue;
    const unpacked = streamOf(object);
    if (!unpacked) continue;
    const body = latin1(unpacked);
    const pairs = [...body.slice(0, first).matchAll(/(\d+)\s+(\d+)/g)].slice(0, count);
    for (let i = 0; i < pairs.length; i++) {
      const pair = pairs[i];
      const next = pairs[i + 1];
      if (!pair) continue;
      const num = Number(pair[1]);
      const start = first + Number(pair[2]);
      const end = next ? first + Number(next[2]) : body.length;
      // A scanned object of the same number is the uncompressed one and wins: it is what a
      // reader following the file's own cross-references would have found.
      if (objects.has(num)) continue;
      objects.set(num, { dict: body.slice(start, end), raw: null });
    }
  }
}

/** The page objects, in reading order. */
function pageOrder(objects: Map<number, PdfObject>): number[] {
  const order: number[] = [];
  const seen = new Set<number>();

  const walk = (num: number, depth: number): void => {
    if (depth > 64 || seen.has(num)) return;
    seen.add(num);
    const object = objects.get(num);
    if (!object) return;
    if (/\/Type\s*\/Page\b/.test(object.dict)) {
      order.push(num);
      return;
    }
    const kids = valueFor(object.dict, "Kids");
    if (kids === null) return;
    for (const kid of kids.matchAll(/(\d+)\s+\d+\s+R/g)) walk(Number(kid[1]), depth + 1);
  };

  for (const [num, object] of objects) {
    if (/\/Type\s*\/Pages\b/.test(object.dict) && valueFor(object.dict, "Parent") === null) walk(num, 0);
  }
  if (order.length > 0) return order;

  // No tree to walk. Page objects in the order the file stores them is the next best claim to
  // reading order there is.
  const loose = [...objects.entries()]
    .filter(([, object]) => /\/Type\s*\/Page\b/.test(object.dict))
    .map(([num]) => num);
  loose.sort((a, b) => a - b);
  return loose;
}

/** One page's content streams, joined as the operators they are. */
function pageContent(objects: Map<number, PdfObject>, pageDict: string, read: Set<number>): string {
  const contents = valueFor(pageDict, "Contents");
  if (contents === null) return "";
  const parts: string[] = [];
  for (const ref of contents.matchAll(/(\d+)\s+\d+\s+R/g)) {
    const num = Number(ref[1]);
    const object = objects.get(num);
    const stream = object ? streamOf(object) : null;
    if (!stream) continue;
    read.add(num);
    parts.push(latin1(stream));
  }
  return parts.join("\n");
}

/** The fonts a page's operators can name, by the name they use for them. */
function pageFonts(
  objects: Map<number, PdfObject>,
  pageDict: string,
  cache: Map<number, PdfFont>,
): Map<string, PdfFont> {
  const fonts = new Map<string, PdfFont>();
  const resources = resolveDict(objects, valueFor(pageDict, "Resources"));
  if (resources === null) return fonts;
  const table = resolveDict(objects, valueFor(resources, "Font"));
  if (table === null) return fonts;
  for (const entry of table.matchAll(/\/([^\s/[\]<>(){}%]+)\s+(\d+)\s+\d+\s+R/g)) {
    const name = entry[1];
    const num = Number(entry[2]);
    const object = objects.get(num);
    if (name === undefined || !object) continue;
    const font = cache.get(num) ?? readFont(objects, object.dict);
    cache.set(num, font);
    fonts.set(name, font);
  }
  return fonts;
}

function readFont(objects: Map<number, PdfObject>, fontDict: string): PdfFont {
  const wide = /\/Subtype\s*\/Type0\b/.test(fontDict) || /\/Encoding\s*\/Identity-[HV]\b/.test(fontDict);
  const ref = valueFor(fontDict, "ToUnicode");
  const num = ref === null ? null : refNumber(ref);
  const object = num === null ? undefined : objects.get(num);
  const stream = object ? streamOf(object) : null;
  if (!stream) return { codeBytes: wide ? 2 : 1, toUnicode: null };
  const parsed = parseToUnicode(latin1(stream));
  return { codeBytes: parsed.codeBytes ?? (wide ? 2 : 1), toUnicode: parsed.map };
}

/**
 * A font's `ToUnicode` CMap: which characters its glyph codes stand for.
 *
 * Both forms are read. `bfchar` names codes one at a time; `bfrange` names a run of them, either
 * against a list of destinations or against a first destination that counts up with the code.
 */
export function parseToUnicode(cmap: string): { map: Map<number, string>; codeBytes: 1 | 2 | null } {
  const map = new Map<number, string>();
  let codeBytes: 1 | 2 | null = null;
  const widen = (hex: string): void => {
    if (hex.length > 2) codeBytes = 2;
    else if (codeBytes === null) codeBytes = 1;
  };

  const space = /begincodespacerange([\s\S]*?)endcodespacerange/.exec(cmap);
  if (space) {
    const first = /<([0-9A-Fa-f]+)>/.exec(space[1] ?? "");
    if (first?.[1]) widen(first[1]);
  }

  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of (block[1] ?? "").matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g)) {
      const code = pair[1];
      if (code === undefined) continue;
      widen(code);
      map.set(Number.parseInt(code, 16), fromUtf16Hex(pair[2] ?? ""));
    }
  }

  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const rows = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(\[[\s\S]*?\]|<[0-9A-Fa-f]*>)/g;
    for (const row of (block[1] ?? "").matchAll(rows)) {
      const lowHex = row[1];
      const highHex = row[2];
      const destination = row[3];
      if (lowHex === undefined || highHex === undefined || destination === undefined) continue;
      widen(lowHex);
      const low = Number.parseInt(lowHex, 16);
      const high = Math.min(Number.parseInt(highHex, 16), low + 65_535);
      if (destination.startsWith("[")) {
        let code = low;
        for (const one of destination.matchAll(/<([0-9A-Fa-f]*)>/g)) {
          if (code > high) break;
          map.set(code++, fromUtf16Hex(one[1] ?? ""));
        }
        continue;
      }
      const base = destination.slice(1, -1);
      for (let code = low; code <= high; code++) map.set(code, fromUtf16Hex(base, code - low));
    }
  }
  return { map, codeBytes };
}

/** Big-endian UTF-16 as a PDF writes it, optionally counting on from the value given. */
function fromUtf16Hex(hex: string, add = 0): string {
  const padded = hex.length % 4 === 0 ? hex : hex.padStart(Math.ceil(hex.length / 4) * 4, "0");
  const units: number[] = [];
  for (let i = 0; i + 4 <= padded.length; i += 4) units.push(Number.parseInt(padded.slice(i, i + 4), 16));
  if (units.length === 0) return "";
  units[units.length - 1] = (units[units.length - 1] ?? 0) + add;
  return String.fromCharCode(...units);
}

/**
 * Every stream that looks like page content, for a file whose structure could not be walked.
 *
 * No fonts, because without the page tree there is nothing that says which font a name refers
 * to, and the wrong map is worse than none: single-byte text still reads, and a wide font with
 * no map produces nothing rather than numbers dressed as letters. Streams already read as a
 * page's content are left alone for the same reason — see `asPageContent`.
 */
function looseContent(objects: Map<number, PdfObject>, budget: number, skip: ReadonlySet<number>): string {
  const parts: string[] = [];
  let left = budget;
  for (const [num, object] of objects) {
    if (left <= 0) break;
    if (skip.has(num)) continue;
    const stream = streamOf(object);
    if (!stream) continue;
    const content = latin1(stream);
    if (!content.includes("BT") || !/\b(Tj|TJ)\b/.test(content)) continue;
    const text = renderContent(content, new Map());
    if (text.trim() === "") continue;
    left -= text.length;
    parts.push(text);
  }
  return parts.join("\n\n");
}

type Operand =
  | { kind: "num"; value: number }
  | { kind: "str"; bytes: number[] }
  | { kind: "name"; value: string }
  | { kind: "array"; items: Operand[] };

type Item = Operand | { kind: "op"; value: string };

const WHITESPACE = new Set([" ", "\n", "\r", "\t", "\f", "\0"]);
const NAME_TOKEN = /\/[^\s/[\]<>(){}%]*/y;
const NUMBER_TOKEN = /[-+]?(?:\d+\.?\d*|\.\d+)/y;
const OPERATOR_TOKEN = /[A-Za-z'"*][A-Za-z0-9'"*]*/y;

/**
 * A content stream as operands and operators.
 *
 * Sticky patterns rather than slicing: a content stream is megabytes, and re-slicing it at every
 * token turns reading one page into quadratic work.
 */
function tokenizeContent(source: string): Item[] {
  const items: Item[] = [];
  const open: Operand[][] = [];
  const push = (operand: Operand): void => {
    const array = open[open.length - 1];
    if (array) array.push(operand);
    else items.push(operand);
  };

  let i = 0;
  while (i < source.length) {
    const c = source[i] ?? "";
    if (WHITESPACE.has(c)) {
      i++;
      continue;
    }
    if (c === "%") {
      while (i < source.length && source[i] !== "\n" && source[i] !== "\r") i++;
      continue;
    }
    if (c === "(") {
      const literal = readLiteralString(source, i);
      push({ kind: "str", bytes: literal.bytes });
      i = literal.end;
      continue;
    }
    if (c === "<") {
      if (source[i + 1] === "<") {
        // An inline dictionary is an operand to a marked-content operator and carries no words.
        const end = skipDictionary(source, i);
        i = end < 0 ? source.length : end;
        continue;
      }
      const end = source.indexOf(">", i);
      if (end < 0) break;
      push({ kind: "str", bytes: hexBytes(source.slice(i + 1, end)) });
      i = end + 1;
      continue;
    }
    if (c === "[") {
      const items_: Operand[] = [];
      push({ kind: "array", items: items_ });
      open.push(items_);
      i++;
      continue;
    }
    if (c === "]") {
      open.pop();
      i++;
      continue;
    }
    if (c === "/") {
      NAME_TOKEN.lastIndex = i;
      const name = NAME_TOKEN.exec(source);
      if (!name) break;
      push({ kind: "name", value: name[0].slice(1) });
      i = NAME_TOKEN.lastIndex;
      continue;
    }
    NUMBER_TOKEN.lastIndex = i;
    const number = NUMBER_TOKEN.exec(source);
    if (number) {
      push({ kind: "num", value: Number(number[0]) || 0 });
      i = NUMBER_TOKEN.lastIndex;
      continue;
    }
    OPERATOR_TOKEN.lastIndex = i;
    const operator = OPERATOR_TOKEN.exec(source);
    if (operator) {
      items.push({ kind: "op", value: operator[0] });
      i = OPERATOR_TOKEN.lastIndex;
      continue;
    }
    i++;
  }
  return items;
}

/** `( … )` with its escapes, as bytes: what the escape means depends on the font, not on us. */
function readLiteralString(source: string, at: number): { bytes: number[]; end: number } {
  const bytes: number[] = [];
  let depth = 0;
  let i = at;
  while (i < source.length) {
    const c = source[i] ?? "";
    if (c === "\\") {
      const next = source[i + 1] ?? "";
      const octal = /^[0-7]{1,3}/.exec(source.slice(i + 1, i + 4));
      if (octal) {
        bytes.push(Number.parseInt(octal[0], 8) & 0xff);
        i += 1 + octal[0].length;
        continue;
      }
      const escapes: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12 };
      const mapped = escapes[next];
      if (mapped !== undefined) bytes.push(mapped);
      // A backslash before a newline continues the line and contributes nothing.
      else if (next !== "\n" && next !== "\r") bytes.push(next.charCodeAt(0));
      i += 2;
      continue;
    }
    if (c === "(") {
      depth++;
      if (depth > 1) bytes.push(40);
      i++;
      continue;
    }
    if (c === ")") {
      depth--;
      if (depth === 0) return { bytes, end: i + 1 };
      bytes.push(41);
      i++;
      continue;
    }
    if (depth > 0) bytes.push(c.charCodeAt(0) & 0xff);
    i++;
  }
  return { bytes, end: source.length };
}

function hexBytes(hex: string): number[] {
  const digits = hex.replace(/[^0-9A-Fa-f]/g, "");
  const padded = digits.length % 2 === 0 ? digits : `${digits}0`;
  const bytes: number[] = [];
  for (let i = 0; i + 2 <= padded.length; i += 2) bytes.push(Number.parseInt(padded.slice(i, i + 2), 16));
  return bytes;
}

/**
 * The text a page's operators show, in the order they show it.
 *
 * Lines come from where the text was put rather than from any character in the stream: PDF has
 * no newline, it has a text matrix, so a fresh line is a page that moved down. Wide gaps inside
 * one line — the negative numbers in a `TJ` array — are how a writer spaces words apart when the
 * font's own space is not used, and without them a whole paragraph arrives as one word.
 */
function renderContent(content: string, fonts: ReadonlyMap<string, PdfFont>): string {
  const items = tokenizeContent(content);
  const out: string[] = [];
  let font: PdfFont | null = null;
  let leading = 0;
  let y = 0;
  let lastY: number | null = null;
  let fresh = false;
  let operands: Operand[] = [];

  const numberAt = (from: number): number => {
    const operand = operands[operands.length - from];
    return operand?.kind === "num" ? operand.value : 0;
  };
  const show = (bytes: number[]): void => {
    if (lastY !== null && Math.abs(y - lastY) > 0.5) out.push("\n");
    /**
     * A new text object on the same line is a new word.
     *
     * Some writers place every word with its own `BT … Tm … Tj … ET`, and without this they all
     * runtogetherlikethis. The gap is only assumed across that boundary, never between two
     * strings inside one text object — inside one, moving the cursor is how a writer kerns a
     * pair of letters, and a space between every letter would be worse than none between words.
     */
    else if (fresh && lastY !== null && !/\s$/.test(out[out.length - 1] ?? " ")) out.push(" ");
    lastY = y;
    fresh = false;
    out.push(decodeShown(bytes, font));
  };

  for (const item of items) {
    if (item.kind !== "op") {
      operands.push(item);
      if (operands.length > 8) operands.shift();
      continue;
    }
    switch (item.value) {
      case "BT":
        y = 0;
        fresh = true;
        break;
      case "Tf": {
        const name = operands[operands.length - 2];
        font = name?.kind === "name" ? (fonts.get(name.value) ?? null) : null;
        break;
      }
      case "TL":
        leading = numberAt(1);
        break;
      case "Td":
        y += numberAt(1);
        break;
      case "TD":
        leading = -numberAt(1);
        y += numberAt(1);
        break;
      case "Tm":
        y = numberAt(1);
        break;
      case "T*":
        y -= leading;
        break;
      case "Tj": {
        const operand = operands[operands.length - 1];
        if (operand?.kind === "str") show(operand.bytes);
        break;
      }
      case "'": {
        y -= leading;
        const operand = operands[operands.length - 1];
        if (operand?.kind === "str") show(operand.bytes);
        break;
      }
      case '"': {
        y -= leading;
        const operand = operands[operands.length - 1];
        if (operand?.kind === "str") show(operand.bytes);
        break;
      }
      case "TJ": {
        const array = operands[operands.length - 1];
        if (array?.kind !== "array") break;
        for (const part of array.items) {
          if (part.kind === "str") show(part.bytes);
          // Thousandths of an em, subtracted from the position: a big one is a gap, and a gap
          // between two glyphs is where a word ends.
          else if (part.kind === "num" && part.value <= -120 && !out[out.length - 1]?.endsWith(" "))
            out.push(" ");
        }
        break;
      }
      default:
        break;
    }
    operands = [];
  }
  return out.join("");
}

/**
 * Bytes as characters, according to what the font says it is.
 *
 * A wide font with no `ToUnicode` map contributes nothing on purpose. Its codes are glyph
 * numbers in a subset nobody else has, and reading them as characters produces text that looks
 * like a document and says something no one wrote.
 */
function decodeShown(bytes: readonly number[], font: PdfFont | null): string {
  const codeBytes = font?.codeBytes ?? 1;
  const map = font?.toUnicode ?? null;
  if (map === null && codeBytes === 2) return "";
  if (map === null) return fromWinAnsi(bytes);

  let out = "";
  for (let i = 0; i + codeBytes <= bytes.length; i += codeBytes) {
    const code = codeBytes === 2 ? ((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0) : (bytes[i] ?? 0);
    const mapped = map.get(code);
    if (mapped !== undefined) out += mapped;
    else if (codeBytes === 1) out += fromWinAnsi([code]);
  }
  return out;
}

/**
 * The one place a byte is not its own code point.
 *
 * 0x80–0x9F is control space in Latin-1 and is where WinAnsi — what a word processor's PDF
 * export uses — keeps the marks prose is full of. Left alone, every curly quote and em dash in
 * an ordinary document arrives as a control character, and the whole file then fails the noise
 * check for being exactly what it is not.
 */
const WIN_ANSI_HIGH = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";

function fromWinAnsi(bytes: readonly number[]): string {
  let out = "";
  for (const byte of bytes) {
    out += byte >= 0x80 && byte <= 0x9f ? (WIN_ANSI_HIGH[byte - 0x80] ?? "") : String.fromCharCode(byte);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Small readers for PDF dictionaries
// ---------------------------------------------------------------------------

/** The raw value written against `/Key`, whatever shape it has. */
function valueFor(dict: string, key: string): string | null {
  const at = new RegExp(`/${key}\\b`, "g");
  for (const match of dict.matchAll(at)) {
    const token = tokenAt(dict, match.index + match[0].length);
    if (token !== null) return token;
  }
  return null;
}

function tokenAt(source: string, from: number): string | null {
  let i = from;
  while (i < source.length && WHITESPACE.has(source[i] ?? "")) i++;
  if (i >= source.length) return null;
  const c = source[i];
  if (c === "<" && source[i + 1] === "<") {
    const end = skipDictionary(source, i);
    return end < 0 ? null : source.slice(i, end);
  }
  if (c === "[") {
    const end = skipArray(source, i);
    return end < 0 ? null : source.slice(i, end);
  }
  if (c === "/") {
    NAME_TOKEN.lastIndex = i;
    return NAME_TOKEN.exec(source)?.[0] ?? null;
  }
  const reference = /^(\d+)\s+(\d+)\s+R\b/.exec(source.slice(i, i + 48));
  if (reference) return reference[0];
  const token = /^[^\s/[\]<>(){}%]+/.exec(source.slice(i, i + 128));
  return token?.[0] ?? null;
}

function skipDictionary(source: string, at: number): number {
  let depth = 0;
  let i = at;
  while (i < source.length) {
    if (source[i] === "<" && source[i + 1] === "<") {
      depth++;
      i += 2;
      continue;
    }
    if (source[i] === ">" && source[i + 1] === ">") {
      depth--;
      i += 2;
      if (depth === 0) return i;
      continue;
    }
    i++;
  }
  return -1;
}

function skipArray(source: string, at: number): number {
  let depth = 0;
  let i = at;
  while (i < source.length) {
    const c = source[i];
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return -1;
}

function refNumber(token: string): number | null {
  const match = /^(\d+)\s+\d+\s+R$/.exec(token.trim());
  return match?.[1] === undefined ? null : Number(match[1]);
}

/** A dictionary written in place, or the one the reference points at. */
function resolveDict(objects: Map<number, PdfObject>, token: string | null): string | null {
  if (token === null) return null;
  if (token.startsWith("<<")) return token;
  const num = refNumber(token);
  return num === null ? null : (objects.get(num)?.dict ?? null);
}
