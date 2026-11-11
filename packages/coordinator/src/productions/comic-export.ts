import { createWriteStream } from "node:fs";
import { access, mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import PDFDocument from "pdfkit";
import { ZipFile } from "yazl";
import { DEFAULT_COMIC_SETTINGS, comicBook, letteringInOrder, productionShape, type ComicBookPage, type ProductionBundle, type WebPackagesListed } from "@arke-studio/contracts";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import { comicEpubEntries, imageSize, writeComicEpub } from "./comic-epub.js";
import type { WorldStore } from "../world/store.js";

/**
 * A graphic novel as a book (SPEC-064 R-47, R-49): CBZ for comic readers and PDF for print, each
 * made from the accepted takes in reading order, the reading direction carried in the format's own
 * field. Refused while any page has no accepted, current take or its lettering is neither passed
 * nor accepted anyway — the same projection readiness reads, so the two never disagree.
 */
export const COMIC_EXPORT_FORMATS = ["cbz", "pdf", "epub"] as const;
export type ComicExportFormat = (typeof COMIC_EXPORT_FORMATS)[number];

export class ComicExportBlocked extends Error {
  constructor(readonly blockers: readonly string[]) {
    super(blockers[0] ?? "the book is not ready");
  }
}

/** What holds the export, one clause per page (R-49): the page's number and the one thing missing. */
export function comicExportBlockers(production: ProductionBundle, chapter?: string): string[] {
  const book = comicBook(production).filter((entry) => chapter === undefined || entry.chapter === chapter);
  if (book.length === 0) return [chapter === undefined ? "the book has no pages" : "the chapter has no pages"];
  return book.flatMap((entry) => entry.take === undefined ? [`page ${entry.number} · no accepted take`]
    : entry.outOfDate ? [`page ${entry.number} · the script changed since its take`]
    : !entry.cleared ? [`page ${entry.number} · lettering not cleared`] : []);
}

const xml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** The page's words in reading order, as alt text when the author wrote none (R-53). */
export function comicPageAlt(entry: ComicBookPage, names: (sheet: string) => string): string {
  if (entry.page.alt) return entry.page.alt;
  const panels = entry.page.panels.map((panel) => panel.description.replace(/\s+/g, " ").trim());
  const words = letteringInOrder([entry.page]).map(({ item }) => `${item.speaker ? `${names(item.speaker)}: ` : ""}${item.text}`);
  return [...panels, ...words].join(" ");
}

interface Picture { entry: ComicBookPage; bytes: Buffer; extension: string }

async function pictures(store: WorldStore, book: readonly ComicBookPage[]): Promise<Picture[]> {
  const artifacts = store.getBundle().artifacts;
  // One at a time: a book of a thousand pages read at once runs out of file handles (codex on PR 2225).
  const read: Picture[] = [];
  for (const entry of book) {
    const artifact = artifacts.find((candidate) => candidate.id === entry.take!.artifact);
    if (!artifact) throw new ComicExportBlocked([`page ${entry.number} · its picture is not in the world`]);
    const bytes = await readFile(toExtendedLength(join(store.dir, "artifacts", fromPortable(artifact.file))));
    read.push({ entry, bytes, extension: (artifact.file.split(".").at(-1) ?? "png").toLowerCase() });
  }
  return read;
}

function comicInfo(input: { title: string; author: string; language: string; pages: number; rtl: boolean; summary?: string }): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<ComicInfo xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    `  <Title>${xml(input.title)}</Title>`,
    ...(input.author ? [`  <Writer>${xml(input.author)}</Writer>`] : []),
    ...(input.summary ? [`  <Summary>${xml(input.summary)}</Summary>`] : []),
    `  <PageCount>${input.pages}</PageCount>`,
    `  <LanguageISO>${xml(input.language)}</LanguageISO>`,
    // ComicInfo's own word for a right-to-left book (R-47).
    `  <Manga>${input.rtl ? "YesAndRightToLeft" : "No"}</Manga>`,
    "  <Notes>Pictures and lettering generated with AI models in Arke Studio.</Notes>",
    "</ComicInfo>",
    "",
  ].join("\n");
}

async function writeCbz(target: string, pages: readonly Picture[], info: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const zip = new ZipFile();
  const width = String(pages.length).length < 4 ? 4 : String(pages.length).length;
  // Stored, not deflated: the pictures are already compressed, and readers page faster through it.
  pages.forEach((page, index) => zip.addBuffer(page.bytes, `${String(index + 1).padStart(width, "0")}.${page.extension}`, { compress: false }));
  zip.addBuffer(Buffer.from(info, "utf8"), "ComicInfo.xml");
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(toExtendedLength(target)), { signal });
}

async function writePdf(target: string, pages: readonly Picture[], input: { title: string; author: string; language: string; rtl: boolean; alt: (entry: ComicBookPage) => string; chapterTitle: (id: string) => string }, signal: AbortSignal): Promise<void> {
  // No default font: the book is pictures only, and pdfkit loads Helvetica through its own package's
  // `#standard-fonts` import, which the desktop bundle cannot resolve ("Cannot find module
  // '#standard-fonts/Helvetica'"). Every comic PDF from the installed app failed with "Something went
  // wrong" while these tests, run from source, passed. test/pdfkit-fonts.test.ts holds every document to it.
  const pdf = new PDFDocument({ font: "", autoFirstPage: false, pdfVersion: "1.7", tagged: true, lang: input.language, displayTitle: true, compress: true,
    info: { Title: input.title, ...(input.author ? { Author: input.author } : {}), Creator: "Arke Studio", Producer: "Arke Studio comic PDF v1" } });
  // The reading direction in the PDF's own field (R-47): pdfkit writes a plain string as a name.
  if (input.rtl) (pdf as unknown as { _root: { data: { ViewerPreferences: { data: Record<string, unknown> } } } })._root.data.ViewerPreferences.data["Direction"] = "R2L";
  const done = pipeline(pdf, createWriteStream(toExtendedLength(target)), { signal });
  // A page that fails tears the stream down and waits for it, so no handle is left on the partial
  // file to stop its removal (codex on PR 2225).
  try {
    await addPages();
  } catch (err) {
    pdf.destroy(err instanceof Error ? err : new Error(String(err)));
    await done.catch(() => {});
    throw err;
  }
  pdf.end();
  await done;

  async function addPages() {
  const WIDTH = 468; // 6.5 in: a trade comic's page, the picture's own shape setting the height
  let chapter: string | null = null;
  for (const page of pages) {
    signal.throwIfAborted();
    if (page.extension !== "png" && page.extension !== "jpg" && page.extension !== "jpeg") throw new ComicExportBlocked([`page ${page.entry.number} · its picture is ${page.extension}, which a PDF cannot hold`]);
    // openImage is pdfkit's own; its typings omit it.
    const image = (pdf as unknown as { openImage(bytes: Buffer): { width: number; height: number } }).openImage(page.bytes);
    const height = Math.round(WIDTH * (image.height / image.width));
    pdf.addPage({ size: [WIDTH, height], margin: 0 });
    if (page.entry.chapter !== chapter) {
      chapter = page.entry.chapter;
      pdf.outline.addItem(input.chapterTitle(chapter));
    }
    // The picture's marked content belongs to the Figure that carries its alt text (codex on PR 2225).
    const figure = pdf.struct("Figure", { alt: input.alt(page.entry) });
    pdf.addStructure(figure);
    figure.add(pdf.markStructureContent("Figure"));
    pdf.image(image as unknown as Buffer, 0, 0, { width: WIDTH, height });
    pdf.endMarkedContent();
    figure.end();
  }
  }
}

/**
 * Makes the book's files and publishes each under its real name. The world's claim is checked before
 * any work and again, under the store's write gate, as each file is published, and a world that
 * closes cancels the export: nothing lands in a world this window no longer owns (codex on PR 2225).
 * Partial files are named for the request, so two exports never write into one.
 */
export async function exportComic(store: WorldStore, productionId: string, formats: readonly ComicExportFormat[], at: Date, signal: AbortSignal, requestId: string, chapter?: string): Promise<Array<{ format: ComicExportFormat; file: string }>> {
  await store.assertOwnership();
  const production = store.getBundle().productions.find((candidate) => candidate.meta.id === productionId);
  if (!production) throw new Error(`production ${productionId} is not in this world`);
  if (!productionShape(production.meta).hasPages) throw new Error(`${production.meta.title} is not a graphic novel.`);
  if (formats.length === 0) throw new Error("choose a format");
  const blockers = comicExportBlockers(production, chapter);
  if (blockers.length) throw new ComicExportBlocked(blockers);
  const settings = production.comic ?? DEFAULT_COMIC_SETTINGS;
  const book = comicBook(production).filter((entry) => chapter === undefined || entry.chapter === chapter);
  const pages = await pictures(store, book);
  const rtl = settings.reading === "rtl";
  const sheets = store.getBundle().sheets;
  const names = (sheet: string) => sheets.find((candidate) => candidate.id === sheet)?.name ?? sheet;
  const title = production.meta.title;
  const author = "";
  const date = at.toISOString().slice(0, 10);
  const dir = join(store.dir, "exports");
  await mkdir(toExtendedLength(dir), { recursive: true });
  const made: Array<{ format: ComicExportFormat; file: string }> = [];
  for (const format of formats) {
    // A second export the same day keeps the first file, as the Player package does.
    let file = `exports/${productionId}-comic-${date}.${format}`;
    for (let n = 2; await access(toExtendedLength(join(store.dir, fromPortable(file)))).then(() => true, () => false); n++) file = `exports/${productionId}-comic-${date}-${n}.${format}`;
    const target = join(store.dir, fromPortable(file));
    const partial = `${target}.${requestId}.partial`;
    try {
      if (format === "cbz") await writeCbz(partial, pages, comicInfo({ title, author, language: settings.language, pages: pages.length, rtl, ...(production.meta.logline ? { summary: production.meta.logline } : {}) }), signal);
      else if (format === "pdf") await writePdf(partial, pages, { title, author, language: settings.language, rtl, alt: (entry) => comicPageAlt(entry, names),
        chapterTitle: (id) => production.chapters.find((chapter) => chapter.id === id)?.title ?? id }, signal);
      else await writeComicEpub(partial, comicEpubEntries({
        id: `${productionId}-${date}`, title, language: settings.language, rtl, modified: `${at.toISOString().slice(0, 19)}Z`,
        chapterTitle: (id) => production.chapters.find((chapter) => chapter.id === id)?.title ?? id,
        pages: pages.map((page) => {
          const size = imageSize(page.bytes);
          if (size === null) throw new ComicExportBlocked([`page ${page.entry.number} · its picture's size cannot be read`]);
          return { ...page, ...size, alt: comicPageAlt(page.entry, names) };
        }),
      }), signal);
      // A finished file only: a reader never opens half a book under the real name.
      await store.ownedWrite(async () => {
        signal.throwIfAborted();
        await rename(toExtendedLength(partial), toExtendedLength(target));
      });
    } catch (err) {
      await rm(toExtendedLength(partial), { force: true }).catch(() => {});
      throw err;
    }
    made.push({ format, file });
  }
  return made;
}

/**
 * A graphic novel's files in `exports/`, found by the names exportComic gives them, so Publish's
 * Made and Publications list them once the dialog closes (design turn 276 rule 6). They were listed
 * nowhere before; the name is their record, as no receipt is written beside them.
 */
export async function listComicExports(store: WorldStore): Promise<WebPackagesListed["packages"]> {
  const comics = store.getBundle().productions.filter((production) => productionShape(production.meta).hasPages);
  if (comics.length === 0) return [];
  const names = await readdir(toExtendedLength(join(store.dir, "exports"))).catch(() => [] as string[]);
  const listed: WebPackagesListed["packages"] = [];
  for (const production of comics) {
    const named = new RegExp(`^${production.meta.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-comic-\\d{4}-\\d{2}-\\d{2}(?:-\\d+)?\\.(cbz|pdf|epub)$`);
    for (const name of names) {
      const format = named.exec(name)?.[1];
      if (format === undefined) continue;
      const info = await stat(toExtendedLength(join(store.dir, "exports", name))).catch(() => null);
      if (!info?.isFile()) continue;
      listed.push({ kind: "comic", productionId: production.meta.id, title: production.meta.title, dir: `exports/${name}`, file: `exports/${name}`, exportedAt: info.mtime.toISOString(), bytes: info.size, holds: format.toUpperCase() });
    }
  }
  return listed;
}
