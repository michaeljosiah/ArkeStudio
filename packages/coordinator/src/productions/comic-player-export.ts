import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  COMIC_FORMAT, COMIC_MEDIA_TYPE, COMIC_VERSION, DEFAULT_COMIC_SETTINGS, WORLD_PACKAGE_FORMAT, arkePlayerPictureEdge, comicBook, packageSlug, productionShape,
  type ComicDocument, type WorldAsset,
} from "@arke-studio/contracts";
import { fitReadingImage, pngHasAlpha, webpHasAlpha } from "../references/reading-image.js";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import type { WorldStore } from "../world/store.js";
import type { ArkePlayerExportOptions, ArkePlayerExportResult, ArkePlayerListed } from "./arke-player-export.js";
import { comicExportBlockers, comicPageAlt } from "./comic-export.js";
import { packagedAsset } from "./story-export.js";
import { checkWorldPackageZip, editionFingerprint, writeWorldPackageZip } from "./world-package.js";

/**
 * Export → Arke Player for a graphic novel (SPEC-064 R-50, R-51; Player P20): a production package
 * of its own, world package schema 7 and alone, holding one comic document — the chapters and their
 * pages in reading order, the book's direction, shape and language, each page's alt text — and each
 * page's accepted picture fitted for a phone. Read back by the shared reader before it is named, and
 * refused while the book is, as the Export sheet refuses it.
 */
const pad = (value: number, width: number) => String(value).padStart(width, "0");
const transparent = (bytes: Uint8Array) => pngHasAlpha(bytes) || webpHasAlpha(bytes);

export async function exportComicPlayer(store: WorldStore, productionId: string, options: ArkePlayerExportOptions): Promise<ArkePlayerExportResult> {
  const ffmpeg = options.ffmpeg;
  if (ffmpeg === undefined) return { ok: false, blockers: ["Needs ffmpeg"] };
  const signal = options.signal ?? new AbortController().signal;
  const cancelled = (): ArkePlayerExportResult => ({ ok: false, blockers: ["the export was cancelled"] });
  const step = options.onStep ?? (() => {});
  const bundle = store.getBundle();
  const production = bundle.productions.find((entry) => entry.meta.id === productionId);
  if (production === undefined || !productionShape(production.meta).hasPages) return { ok: false, blockers: ["that production is not a graphic novel"] };
  const blockers = comicExportBlockers(production);
  if (blockers.length > 0) return { ok: false, blockers: blockers.slice(0, 500) };
  const settings = production.comic ?? DEFAULT_COMIC_SETTINGS;
  const book = comicBook(production);
  const before = JSON.stringify([production.comic ?? null, production.comicScripts ?? null, production.comicPages ?? null]);
  const names = (sheet: string) => bundle.sheets.find((candidate) => candidate.id === sheet)?.name ?? sheet;
  const title = (options.publish?.title ?? production.meta.title).trim() || production.meta.title;
  const own = packageSlug(productionId);
  const edge = arkePlayerPictureEdge(options.pictureSize);

  const staging = join(store.dir, ".staging", "arke-player-export", options.exportId);
  const files = join(staging, "files");
  const at = (path: string) => join(files, ...path.split("/"));
  try {
    await mkdir(toExtendedLength(join(files, "pages")), { recursive: true });
    const assets: Record<string, WorldAsset> = {};
    const sources = new Map<string, string>();
    const add = async (assetId: string, path: string, mediaType: string) => {
      assets[assetId] = await packagedAsset(at(path), path, mediaType);
      sources.set(path, at(path));
    };
    const chapters: ComicDocument["chapters"] = [];
    for (const [index, entry] of book.entries()) {
      if (signal.aborted) return cancelled();
      step(`Fitting pages · ${index + 1} of ${book.length}`, (index / book.length) * 85);
      const artifact = bundle.artifacts.find((candidate) => candidate.id === entry.take!.artifact);
      if (artifact === undefined) return { ok: false, blockers: [`page ${entry.number} · its picture is not in the world`] };
      const source = join(store.dir, "artifacts", fromPortable(artifact.file));
      const keepsAlpha = transparent(await readFile(toExtendedLength(source)));
      const assetId = `p${pad(index + 1, 4)}`;
      const path = `pages/${assetId}.${keepsAlpha ? "png" : "jpg"}`;
      try {
        await fitReadingImage(source, at(path), keepsAlpha, ffmpeg, signal, edge);
      } catch {
        if (signal.aborted) return cancelled();
        return { ok: false, blockers: [`page ${entry.number} · its picture could not be fitted for a phone`] };
      }
      await add(assetId, path, keepsAlpha ? "image/png" : "image/jpeg");
      const chapterTitle = production.chapters.find((chapter) => chapter.id === entry.chapter)?.title ?? entry.chapter;
      const last = chapters.at(-1);
      const page = { picture: assetId, alt: comicPageAlt(entry, names).slice(0, 4000) || `Page ${entry.number}` };
      if (last !== undefined && book[index - 1]?.chapter === entry.chapter) last.pages.push(page);
      else chapters.push({ title: chapterTitle.slice(0, 200), pages: [page] });
    }
    // The first page is the production's picture: a book's cover is its first page.
    const document: ComicDocument = { format: COMIC_FORMAT, version: COMIC_VERSION, reading: settings.reading, aspect: settings.aspect, language: settings.language, chapters };
    step("Writing the book", 88);
    await writeFile(toExtendedLength(at("comic.json")), `${JSON.stringify(document, null, 2)}\n`, "utf8");
    await add("comic", "comic.json", COMIC_MEDIA_TYPE);

    const stamp = options.clock();
    const day = stamp.slice(0, 10);
    await mkdir(toExtendedLength(join(store.dir, "exports")), { recursive: true });
    const taken = new Set(await readdir(toExtendedLength(join(store.dir, "exports"))).catch(() => [] as string[]));
    let edition = day;
    for (let counter = 2; taken.has(`${own}-comic-${edition}.zip`) || taken.has(`${own}-comic-${edition}.zip.json`); counter++) edition = `${day}-${counter}`;
    const name = `${own}-comic-${edition}.zip`;
    const author = options.publish?.author?.trim() || undefined;
    const manifest = {
      format: WORLD_PACKAGE_FORMAT,
      // A graphic novel's package is schema 7, and the only thing schema 7 is (SPEC-064 R-50).
      schemaVersion: 7,
      alone: true,
      id: packageSlug(bundle.meta.slug),
      edition,
      name: bundle.meta.name.slice(0, 200),
      ...(bundle.meta.logline !== undefined && bundle.meta.logline.trim() !== "" ? { logline: bundle.meta.logline.slice(0, 400) } : {}),
      productions: [{ id: own, title: title.slice(0, 200), ...(author !== undefined ? { author: author.slice(0, 200) } : {}), picture: chapters[0]!.pages[0]!.picture, comic: "comic" }],
      assets,
      provenance: { studio: options.studioVersion, exportId: options.exportId, exportedAt: stamp, pages: book.length },
    };

    step("Checking the package", 92);
    const zip = join(staging, name);
    await writeWorldPackageZip(`${JSON.stringify(manifest, null, 2)}\n`, sources, zip, signal);
    const checked = await checkWorldPackageZip(zip, signal);
    if (!checked.ok) return { ok: false, blockers: checked.problems };
    const release = { edition, fingerprint: editionFingerprint({ edition, assets }), chapters: [] };
    const holds = `${chapters.length} chapter${chapters.length === 1 ? "" : "s"} · ${book.length} page${book.length === 1 ? "" : "s"}`;

    // Under the gate, the book is read again: a page made, accepted or edited meanwhile refuses the
    // package rather than shipping the book as it was.
    return await store.gateOp(async () => {
      const now = store.getBundle().productions.find((entry) => entry.meta.id === productionId);
      if (now === undefined || JSON.stringify([now.comic ?? null, now.comicScripts ?? null, now.comicPages ?? null]) !== before) {
        return { ok: false as const, blockers: ["the book changed while the package was made · make it again"] };
      }
      const destination = join(store.dir, "exports", name);
      const exists = (path: string) => stat(toExtendedLength(path)).then(() => true, () => false);
      if ((await exists(destination)) || (await exists(`${destination}.json`))) return { ok: false as const, blockers: [`exports/${name} already exists · make it again`] };
      const listed: ArkePlayerListed = {
        kind: "arke-player", exportId: options.exportId, exportedAt: stamp, productionId,
        title: `${bundle.meta.name} · ${title}`.slice(0, 400), bytes: checked.bytes, sha256: checked.sha256, holds,
        chapters: chapters.length, pictures: book.length, book: false, guide: false, release,
      };
      await writeFile(toExtendedLength(`${destination}.json`), `${JSON.stringify(listed, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      try {
        await rename(toExtendedLength(zip), toExtendedLength(destination));
      } catch (error) {
        await rm(toExtendedLength(`${destination}.json`), { force: true }).catch(() => {});
        throw error;
      }
      step("Done", 100);
      return { ok: true as const, file: `exports/${name}`, bytes: checked.bytes, sha256: checked.sha256, edition, chapters: chapters.length, pictures: book.length, book: false, guide: false };
    });
  } finally {
    await rm(toExtendedLength(staging), { recursive: true, force: true }).catch(() => {});
  }
}
