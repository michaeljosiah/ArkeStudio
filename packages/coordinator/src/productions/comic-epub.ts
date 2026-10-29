import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { ZipFile } from "yazl";
import type { ComicBookPage } from "@arke-studio/contracts";
import { toExtendedLength } from "../world/paths.js";

/**
 * A graphic novel as a fixed-layout EPUB (SPEC-064 R-47): one picture a page at the page's own size,
 * pre-paginated, reading in the book's direction through the spine's page-progression-direction,
 * each page's alt text on its image (R-53). EPUB 3; the mimetype entry is first and stored, as the
 * container format requires.
 */
export interface ComicEpubPage { entry: ComicBookPage; bytes: Buffer; extension: string; width: number; height: number; alt: string }

const xml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const MEDIA: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };

export function comicEpubEntries(input: { id: string; title: string; language: string; rtl: boolean; modified: string; pages: readonly ComicEpubPage[]; chapterTitle: (id: string) => string }): Array<[string, Buffer]> {
  const pad = (n: number) => String(n).padStart(4, "0");
  const files: Array<[string, Buffer]> = [];
  const items: string[] = [];
  const spine: string[] = [];
  const nav: string[] = [];
  let chapter: string | null = null;
  input.pages.forEach((page, index) => {
    const n = pad(index + 1);
    const media = MEDIA[page.extension];
    if (media === undefined) throw new Error(`page ${page.entry.number} · its picture is ${page.extension}, which an EPUB cannot hold`);
    files.push([`OEBPS/images/${n}.${page.extension}`, page.bytes]);
    files.push([`OEBPS/pages/${n}.xhtml`, Buffer.from([
      '<?xml version="1.0" encoding="utf-8"?>',
      `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${xml(input.language)}" lang="${xml(input.language)}">`,
      `<head><meta charset="utf-8"/><meta name="viewport" content="width=${page.width}, height=${page.height}"/><title>${xml(input.title)} · ${index + 1}</title>`,
      "<style>html,body{margin:0;padding:0}img{display:block;width:100%;height:100%}</style></head>",
      `<body><img src="../images/${n}.${page.extension}" alt="${xml(page.alt)}" width="${page.width}" height="${page.height}"/></body>`,
      "</html>",
    ].join("\n"), "utf8")]);
    items.push(`<item id="img${n}" href="images/${n}.${page.extension}" media-type="${media}"/>`);
    items.push(`<item id="p${n}" href="pages/${n}.xhtml" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="p${n}"/>`);
    if (page.entry.chapter !== chapter) {
      chapter = page.entry.chapter;
      nav.push(`<li><a href="pages/${n}.xhtml">${xml(input.chapterTitle(chapter))}</a></li>`);
    }
  });
  const opf = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" prefix="rendition: http://www.idpf.org/vocab/rendition/#">',
    '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">',
    `<dc:identifier id="uid">urn:arke:${xml(input.id)}</dc:identifier>`,
    `<dc:title>${xml(input.title)}</dc:title>`,
    `<dc:language>${xml(input.language)}</dc:language>`,
    `<meta property="dcterms:modified">${input.modified}</meta>`,
    '<meta property="rendition:layout">pre-paginated</meta>',
    '<meta property="rendition:spread">none</meta>',
    "<dc:description>Pictures and lettering generated with AI models in Arke Studio.</dc:description>",
    "</metadata>",
    "<manifest>",
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    ...items,
    "</manifest>",
    `<spine page-progression-direction="${input.rtl ? "rtl" : "ltr"}">`,
    ...spine,
    "</spine>",
    "</package>",
  ].join("\n");
  const navigation = [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${xml(input.language)}" lang="${xml(input.language)}">`,
    `<head><meta charset="utf-8"/><title>${xml(input.title)}</title></head>`,
    `<body><nav epub:type="toc"><ol>${nav.join("")}</ol></nav></body>`,
    "</html>",
  ].join("\n");
  return [
    ["META-INF/container.xml", Buffer.from('<?xml version="1.0" encoding="utf-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>\n', "utf8")],
    ["OEBPS/content.opf", Buffer.from(opf, "utf8")],
    ["OEBPS/nav.xhtml", Buffer.from(navigation, "utf8")],
    ...files,
  ];
}

export async function writeComicEpub(target: string, entries: ReadonlyArray<[string, Buffer]>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const zip = new ZipFile();
  // The container format's first entry, stored and uncompressed.
  zip.addBuffer(Buffer.from("application/epub+zip", "ascii"), "mimetype", { compress: false });
  for (const [path, bytes] of entries) zip.addBuffer(bytes, path, { compress: !/\.(png|jpe?g|webp)$/.test(path) });
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(toExtendedLength(target)), { signal });
}

/** A PNG's or JPEG's pixel size from its header, so each page's viewport is the picture's own. */
export function imageSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length > 24 && bytes.readUInt32BE(0) === 0x89504e47) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) { at += 1; continue; }
      const marker = bytes[at + 1]!;
      const length = bytes.readUInt16BE(at + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) };
      at += 2 + length;
    }
  }
  return null;
}
