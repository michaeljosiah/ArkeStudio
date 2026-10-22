import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { LISTENING_MEDIA_TYPE, manuscriptDocument, SlugSchema, WORLD_PACKAGE_FORMAT, type ListeningChapter, type ListeningDocumentChapter, type WorldAsset } from "@arke-studio/contracts";
import type { FfmpegRunner } from "../takes/export.js";
import { toExtendedLength } from "../world/paths.js";
import type { WorldStore } from "../world/store.js";
import { documentChapter, listeningDocument } from "./arke-player-listening.js";
import { audiobookListening } from "./audiobook-listening.js";
import { containedWorldFile } from "./interactive.js";
import { writeEpub } from "./manuscript.js";
import { openChapter } from "./ops.js";
import { checkWorldPackageZip, writeWorldPackageZip } from "./world-package.js";
import { fitReadingImage, pngHasAlpha } from "../references/reading-image.js";
export { pngHasAlpha } from "../references/reading-image.js";

/**
 * Export → Arke Player (design turn 233, SPEC-058 R-1 – R-8): one world package of a Story
 * production — the book whole, and the illustrated narration of the chapters read whole — that a
 * person adds by hand in Arke Player. A package, not a page (R-5): `world.json` and the files it
 * names, no HTML and no script, so a phone plays it natively and never runs anything in it.
 *
 * It is made as R-72's player package is (R-4): in a staging folder, each chapter's takes joined
 * into one file, each picture copied once, every source a plain file inside the world, and the
 * listening plan read again under the world's gate before the package is moved into `exports/`.
 * The ZIP is read back by the shared reader before it is promoted. Without ffmpeg it is refused:
 * the Player plays one audio file a chapter (R-10), and pictures are fitted for a phone (R-6).
 */

export const ARKE_PLAYER_EXPORT_ID = /^ap_[0-9A-HJKMNP-TV-Z]{26}$/;
const COMPILER = "arke-studio/arke-player-export";
const COMPILER_VERSION = 1;
const MOTION_SIDE = 1080;

export type ArkePlayerExportResult =
  | { ok: true; file: string; bytes: number; sha256: string; edition: string; chapters: number; pictures: number; book: boolean }
  | { ok: false; blockers: string[] };

export interface ArkePlayerExportOptions {
  clock: () => string;
  ffmpeg?: FfmpegRunner;
  exportId: string;
  signal?: AbortSignal;
  /** The book and the pictures' loops are each the author's to leave out (233a). */
  include: { book: boolean; motion: boolean };
  /** Publish's title, author and language for the production, where it has them (R-2). */
  publish?: { title?: string; author?: string; language?: string };
  studioVersion: string;
  /** What is in hand and how far through, for Activity (233b). */
  onStep?: (step: string, percent: number) => void;
}

const pad = (value: number, width: number) => String(value).padStart(width, "0");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A Studio slug as a package id: the same vocabulary, at most 64 long. */
export const packageSlug = (slug: string) => slug.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+/, "").slice(0, 64).replace(/-+$/, "") || "world";

/** Whether a WebP carries alpha: the VP8X alpha flag, or a lossless image's alpha bit (R-6). */
export function webpHasAlpha(bytes: Uint8Array): boolean {
  if (bytes.length < 30) return false;
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.toString("latin1", 0, 4) !== "RIFF" || view.toString("latin1", 8, 12) !== "WEBP") return false;
  const chunk = view.toString("latin1", 12, 16);
  if (chunk === "VP8X") return (view[20]! & 0x10) !== 0;
  if (chunk === "VP8L") return ((view.readUInt32LE(21) >>> 28) & 1) === 1;
  return false;
}

/** Whether a picture must stay PNG to keep its transparency. */
const transparent = (bytes: Uint8Array) => pngHasAlpha(bytes) || webpHasAlpha(bytes);

/**
 * Everything the package is made from, to read it again under the gate and compare (R-4): the
 * plan in full — takes, sentences, words, pictures, focus, loops and how they play — the book's
 * prose, and the world's name, logline and key art.
 */
function fingerprint(whole: readonly ListeningChapter[], cover: string | null, book: readonly BookChapter[], store: WorldStore, productionId: string): string {
  const bundle = store.getBundle();
  const production = bundle.productions.find((entry) => entry.meta.id === productionId);
  return JSON.stringify({ whole, cover, book, world: [bundle.meta.name, bundle.meta.logline ?? null, bundle.keyArt ?? null], title: production?.meta.title ?? null });
}

const readWhole = (chapter: ListeningChapter) => chapter.state === "read" && (chapter.blocks.length > 0 || (chapter.audioStudio !== undefined && chapter.mix !== undefined));

interface BookChapter {
  id: string;
  title: string;
  body: string;
}

/**
 * The book: every chapter still in the manuscript, in its order (R-2), as the story edition
 * compiler writes it. A chapter with no prose is left out of the EPUB, so its place is known only
 * by writing each chapter's document the way the book does.
 */
async function readBook(store: WorldStore, productionId: string): Promise<BookChapter[]> {
  const production = store.getBundle().productions.find((entry) => entry.meta.id === productionId);
  if (production === undefined) return [];
  const chapters: BookChapter[] = [];
  const ordered = production.chapters.filter((chapter) => !chapter.retired).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  for (const chapter of ordered) {
    const opened = await openChapter(store, productionId, chapter.id);
    if (manuscriptDocument({ title: "", worldName: "", chapters: [{ title: opened.title, body: opened.body }] }).chapters.length === 1) chapters.push({ id: chapter.id, title: opened.title, body: opened.body });
  }
  return chapters;
}

export async function exportArkePlayer(store: WorldStore, productionId: string, options: ArkePlayerExportOptions): Promise<ArkePlayerExportResult> {
  if (!ARKE_PLAYER_EXPORT_ID.test(options.exportId)) throw new Error("invalid Arke Player export id");
  const ffmpeg = options.ffmpeg;
  if (ffmpeg === undefined) return { ok: false, blockers: ["Needs ffmpeg"] };
  const signal = options.signal ?? new AbortController().signal;
  const cancelled = (): ArkePlayerExportResult => ({ ok: false, blockers: ["the export was cancelled"] });
  const bundle = store.getBundle();
  const production = bundle.productions.find((entry) => entry.meta.id === productionId);
  if (production === undefined) return { ok: false, blockers: ["that production is no longer in this world"] };
  const step = options.onStep ?? (() => {});

  if (signal.aborted) return cancelled();
  const listeningOptions = { ffmpeg, signal, scope: { kind: "book" as const }, finalAudio: true };
  const listening = await audiobookListening(store, productionId, listeningOptions);
  const whole = listening.chapters.filter(readWhole);
  if (signal.aborted) return cancelled();

  const bookChapters = options.include.book ? await readBook(store, productionId) : [];
  const madeFrom = fingerprint(whole, listening.cover, bookChapters, store, productionId);
  if (whole.length === 0 && bookChapters.length === 0) return { ok: false, blockers: [options.include.book ? "no chapter is read whole and the book has no prose yet" : "no chapter is read whole yet"] };

  // A loop that will not play holds the package back, as R-72's does (R-11) — unless loops are
  // left out, when its still is what ships.
  if (options.include.motion) {
    const problems = whole.flatMap((chapter) => chapter.pictures.filter((picture) => picture.motionProblem !== undefined).map(() => `Chapter ${chapter.order} · ${chapter.title} · its loop won’t play · use its still`));
    if (problems.length > 0) return { ok: false, blockers: [...new Set(problems)] };
  }

  // Every source resolved to the world's own file before anything is made (R-4).
  const real = new Map<string, string>();
  const outside = new Set<string>();
  const resolve = async (file: string, where: string) => {
    if (real.has(file)) return;
    const found = await containedWorldFile(store.dir, file);
    if (found === null) outside.add(where);
    else real.set(file, found);
  };
  for (const chapter of whole) {
    const where = `Chapter ${chapter.order} · a picture outside this world`;
    for (const block of chapter.blocks) await resolve(block.file, `Chapter ${chapter.order} · a take outside this world`);
    if (chapter.mix !== undefined) await resolve(chapter.mix.file, `Chapter ${chapter.order} · its mix outside this world`);
    for (const picture of chapter.pictures) {
      await resolve(picture.file, where);
      if (options.include.motion && picture.motion !== undefined) await resolve(picture.motion.file, where);
    }
    if (chapter.opening !== null) await resolve(chapter.opening, where);
  }
  const cover = whole.length > 0 ? listening.cover : null;
  if (cover !== null) await resolve(cover, "the cover is outside this world");
  const keyArt = bundle.keyArt ?? null;
  if (keyArt !== null) await resolve(keyArt, "the key art is outside this world");
  if (outside.size > 0) return { ok: false, blockers: [...outside] };

  const staging = join(store.dir, ".staging", "arke-player-export", options.exportId);
  const files = join(staging, "files");
  const at = (path: string) => join(files, ...path.split("/"));
  try {
    await mkdir(toExtendedLength(join(files, "audio")), { recursive: true });
    await mkdir(toExtendedLength(join(files, "pictures")), { recursive: true });
    const assets: Record<string, WorldAsset> = {};
    const sources = new Map<string, string>();
    const originals: Record<string, string> = {};
    const add = async (assetId: string, path: string, mediaType: string) => {
      const bytes = await readFile(toExtendedLength(at(path)));
      assets[assetId] = { path, mediaType, byteLength: bytes.byteLength, sha256: sha256(bytes) };
      sources.set(path, at(path));
    };

    // Each chapter's audio, one file a chapter (R-12): its one mix where it has timing, else its
    // takes joined back to back with nothing added — as R-72 makes them.
    const total = whole.length + 1;
    const audioIds = new Map<string, string>();
    for (const [index, chapter] of whole.entries()) {
      if (signal.aborted) return cancelled();
      step(`Joining chapters · ${index + 1} of ${whole.length}`, (index / total) * 50);
      const path = `audio/ch${pad(chapter.order, 2)}.m4a`;
      try {
        if (chapter.mix !== undefined) {
          await ffmpeg.run(["-y", "-i", real.get(chapter.mix.file)!, "-vn", "-ac", chapter.audioStudio ? "2" : "1", "-ar", chapter.audioStudio ? "48000" : "44100", "-c:a", "aac", "-b:a", "128k", at(path)], () => {}, signal);
        } else {
          const work = join(staging, "work", chapter.chapterId);
          await mkdir(toExtendedLength(work), { recursive: true });
          const pieces: string[] = [];
          for (const [blockIndex, block] of chapter.blocks.entries()) {
            const piece = join(work, `${pad(blockIndex, 4)}.wav`);
            await ffmpeg.run(["-y", "-i", real.get(block.file)!, "-vn", "-ac", "1", "-ar", "44100", "-c:a", "pcm_s16le", piece], () => {}, signal);
            pieces.push(piece);
          }
          const list = join(work, "pieces.txt");
          await writeFile(toExtendedLength(list), pieces.map((piece) => `file '${piece.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n") + "\n", "utf8");
          await ffmpeg.run(["-y", "-f", "concat", "-safe", "0", "-i", list, "-c:a", "aac", "-b:a", "128k", at(path)], () => {}, signal);
          await rm(toExtendedLength(work), { recursive: true, force: true });
        }
      } catch {
        if (signal.aborted) return cancelled();
        return { ok: false, blockers: [`Chapter ${chapter.order} · ${chapter.title} · its audio could not be joined`] };
      }
      const assetId = `ch${pad(chapter.order, 2)}`;
      await add(assetId, path, "audio/mp4");
      audioIds.set(chapter.chapterId, assetId);
    }

    // Pictures fitted for a phone (R-6): at most 2048 px, JPEG at quality 85 unless a PNG is
    // transparent, each once however many chapters show it, its original's digest kept.
    const pictureFiles = [...new Set([...(keyArt !== null ? [keyArt] : []), ...(cover !== null ? [cover] : []), ...whole.flatMap((chapter) => [...(chapter.opening !== null ? [chapter.opening] : []), ...chapter.pictures.map((picture) => picture.file)])])];
    const motionFiles = options.include.motion ? [...new Set(whole.flatMap((chapter) => chapter.pictures.flatMap((picture) => (picture.motion !== undefined ? [picture.motion.file] : []))))] : [];
    const pictureIds = new Map<string, string>();
    const motionIds = new Map<string, string>();
    const fitting = pictureFiles.length + motionFiles.length;
    let numbered = 0;
    for (const [index, file] of pictureFiles.entries()) {
      if (signal.aborted) return cancelled();
      step(`Fitting pictures · ${index + 1} of ${fitting}`, 50 + (index / Math.max(1, fitting)) * 35);
      const original = await readFile(toExtendedLength(real.get(file)!));
      const keepsAlpha = transparent(original);
      const assetId = file === keyArt ? "key-art" : `p${pad(++numbered, 3)}`;
      const path = assetId === "key-art" ? `key-art.${keepsAlpha ? "png" : "jpg"}` : `pictures/${assetId}.${keepsAlpha ? "png" : "jpg"}`;
      try {
        await fitReadingImage(real.get(file)!, at(path), keepsAlpha, ffmpeg, signal);
      } catch {
        if (signal.aborted) return cancelled();
        return { ok: false, blockers: [`${file.split("/").pop()} could not be fitted for a phone`] };
      }
      await add(assetId, path, keepsAlpha ? "image/png" : "image/jpeg");
      originals[assetId] = sha256(original);
      pictureIds.set(file, assetId);
    }
    if (motionFiles.length > 0) await mkdir(toExtendedLength(join(files, "motion")), { recursive: true });
    for (const [index, file] of motionFiles.entries()) {
      if (signal.aborted) return cancelled();
      step(`Fitting loops · ${index + 1} of ${motionFiles.length}`, 50 + ((pictureFiles.length + index) / Math.max(1, fitting)) * 35);
      const assetId = `m${pad(index + 1, 3)}`;
      const path = `motion/${assetId}.mp4`;
      const fit = `scale='min(${MOTION_SIDE},iw)':'min(${MOTION_SIDE},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`;
      try {
        await ffmpeg.run(["-y", "-i", real.get(file)!, "-an", "-vf", fit, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", at(path)], () => {}, signal);
      } catch {
        if (signal.aborted) return cancelled();
        return { ok: false, blockers: [`${file.split("/").pop()} · its loop could not be made for a phone`] };
      }
      await add(assetId, path, "video/mp4");
      originals[assetId] = sha256(await readFile(toExtendedLength(real.get(file)!)));
      motionIds.set(file, assetId);
    }

    // The book (R-2), with the key art as its cover where the world has one.
    const title = (options.publish?.title ?? production.meta.title).trim() || production.meta.title;
    const author = options.publish?.author?.trim() || undefined;
    let bookId: string | undefined;
    const bookPlace = new Map<string, string>();
    if (bookChapters.length > 0) {
      step("Writing the book", 86);
      const document = manuscriptDocument({ title, worldName: bundle.meta.name, chapters: bookChapters });
      const art = keyArt !== null ? assets["key-art"] : undefined;
      const epub = writeEpub(document, {
        identifier: `urn:arke:${store.worldId}:${productionId}`,
        language: options.publish?.language ?? "en",
        modified: options.clock(),
        ...(author !== undefined ? { author } : {}),
        ...(art !== undefined ? { cover: { bytes: await readFile(toExtendedLength(at(art.path))), mediaType: art.mediaType as "image/jpeg" | "image/png" } } : {}),
      });
      await writeFile(toExtendedLength(at("book.epub")), epub);
      await add("book", "book.epub", "application/epub+zip");
      bookId = "book";
      bookChapters.forEach((chapter, index) => bookPlace.set(chapter.id, `OEBPS/chapter-${index + 1}.xhtml`));
    }

    // The illustrated narration (R-10, R-11).
    let listeningId: string | undefined;
    if (whole.length > 0) {
      const chapters: ListeningDocumentChapter[] = whole.map((chapter) =>
        documentChapter(chapter, {
          audio: audioIds.get(chapter.chapterId)!,
          picture: (file) => pictureIds.get(file)!,
          motion: (file) => motionIds.get(file),
          ...(bookPlace.has(chapter.chapterId) ? { book: bookPlace.get(chapter.chapterId)! } : {}),
        }),
      );
      const document = listeningDocument(title, cover !== null ? pictureIds.get(cover) : undefined, chapters);
      await writeFile(toExtendedLength(at("listening.json")), `${JSON.stringify(document, null, 2)}\n`, "utf8");
      await add("listening", "listening.json", LISTENING_MEDIA_TYPE);
      listeningId = "listening";
    }

    // world.json (Player ADR 0005, R-8): the world as published, one production, the inventory,
    // and where it came from — no paths, credentials or prompts.
    const stamp = options.clock();
    const day = stamp.slice(0, 10);
    const slug = packageSlug(bundle.meta.slug);
    await mkdir(toExtendedLength(join(store.dir, "exports")), { recursive: true });
    const taken = new Set(await readdir(toExtendedLength(join(store.dir, "exports"))).catch(() => [] as string[]));
    let edition = day;
    for (let counter = 2; taken.has(`${slug}-player-${edition}.zip`) || taken.has(`${slug}-player-${edition}.zip.json`); counter++) edition = `${day}-${counter}`;
    const name = `${slug}-player-${edition}.zip`;
    const manifest = {
      format: WORLD_PACKAGE_FORMAT,
      schemaVersion: listeningId !== undefined ? 2 : 1,
      id: slug,
      edition,
      name: bundle.meta.name.slice(0, 200),
      ...(bundle.meta.logline !== undefined && bundle.meta.logline.trim() !== "" ? { logline: bundle.meta.logline.slice(0, 400) } : {}),
      ...(keyArt !== null ? { keyArt: "key-art" } : {}),
      productions: [{
        id: packageSlug(productionId),
        title: title.slice(0, 200),
        ...(author !== undefined ? { author: author.slice(0, 200) } : {}),
        ...(keyArt !== null ? { picture: "key-art" } : {}),
        ...(bookId !== undefined ? { book: bookId } : {}),
        ...(listeningId !== undefined ? { listening: listeningId } : {}),
      }],
      assets,
      provenance: {
        compiler: COMPILER,
        compilerVersion: COMPILER_VERSION,
        studio: options.studioVersion,
        exportId: options.exportId,
        exportedAt: stamp,
        listening: sha256(new TextEncoder().encode(madeFrom)),
        originals,
      },
    };

    step("Checking the package", 90);
    const zip = join(staging, name);
    await writeWorldPackageZip(`${JSON.stringify(manifest, null, 2)}\n`, sources, zip, signal);
    const checked = await checkWorldPackageZip(zip, signal);
    if (!checked.ok) return { ok: false, blockers: checked.problems };

    // What the narration shows, each picture once: the count the sheet and Publications say.
    const shown = new Set([...(cover !== null ? [cover] : []), ...whole.flatMap((chapter) => [...(chapter.opening !== null ? [chapter.opening] : []), ...chapter.pictures.map((picture) => picture.file)])]).size;
    const holds = [whole.length > 0 ? `${whole.length} chapter${whole.length === 1 ? "" : "s"}` : null, shown > 0 ? `${shown} picture${shown === 1 ? "" : "s"}` : null, bookId !== undefined ? "the book" : null].filter((part) => part !== null).join(" · ");

    // Under the gate, everything the package was made from is read again: a take made, a
    // sentence or a chapter's prose edited, a picture moved, a focus changed or a loop set to
    // hold meanwhile refuses the package rather than shipping it beside the snapshot's (R-4).
    return await store.gateOp(async () => {
      const plan = await audiobookListening(store, productionId, listeningOptions);
      const book = options.include.book ? await readBook(store, productionId) : [];
      if (fingerprint(plan.chapters.filter(readWhole), plan.cover, book, store, productionId) !== madeFrom) return { ok: false as const, blockers: ["the book changed while the package was made · make it again"] };
      const destination = join(store.dir, "exports", name);
      // Never over an earlier export (SPEC-048 R-10).
      const exists = (path: string) => stat(toExtendedLength(path)).then(() => true, () => false);
      if ((await exists(destination)) || (await exists(`${destination}.json`))) return { ok: false as const, blockers: [`exports/${name} already exists · make it again`] };
      // What Publications lists, written before the package is named (233e): a record without
      // its package is never listed, and a package is never left without its record.
      const listed: ArkePlayerListed = { kind: "arke-player", exportId: options.exportId, exportedAt: stamp, productionId, title: bundle.meta.name, bytes: checked.bytes, sha256: checked.sha256, holds, chapters: whole.length, pictures: shown, book: bookId !== undefined };
      await writeFile(toExtendedLength(`${destination}.json`), `${JSON.stringify(listed, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      try {
        await rename(toExtendedLength(zip), toExtendedLength(destination));
      } catch (error) {
        await rm(toExtendedLength(`${destination}.json`), { force: true }).catch(() => {});
        throw error;
      }
      step("Done", 100);
      return { ok: true as const, file: `exports/${name}`, bytes: checked.bytes, sha256: checked.sha256, edition, chapters: whole.length, pictures: shown, book: bookId !== undefined };
    });
  } finally {
    await rm(toExtendedLength(staging), { recursive: true, force: true }).catch(() => {});
  }
}

/** The record beside a package (233e), read whole: one that is not, by hand or by a fault, is not listed. */
const ArkePlayerListedSchema = z.object({
  kind: z.literal("arke-player"),
  exportId: z.string().regex(ARKE_PLAYER_EXPORT_ID),
  exportedAt: z.string().min(1),
  productionId: SlugSchema,
  title: z.string(),
  bytes: z.number().int().min(0),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  holds: z.string(),
  /** What it holds as numbers, so a window that lost the answer shows the same package (233c). */
  chapters: z.number().int().min(0),
  pictures: z.number().int().min(0),
  book: z.boolean(),
}).strict();
type ArkePlayerListed = z.infer<typeof ArkePlayerListedSchema>;

/**
 * The world's Arke Player packages for Publications (233e), newest first: each by the record
 * written beside it, and only while the package is there at the length it records.
 */
export async function listArkePlayerPackages(store: WorldStore): Promise<Array<ArkePlayerListed & { dir: string; file: string }>> {
  const exportsDir = join(store.dir, "exports");
  const names = (await readdir(toExtendedLength(exportsDir)).catch(() => [] as string[])).filter((name) => /-player-\d{4}-\d{2}-\d{2}(?:-\d+)?\.zip$/.test(name));
  const out: Array<ArkePlayerListed & { dir: string; file: string }> = [];
  for (const name of names) {
    try {
      const parsed = ArkePlayerListedSchema.safeParse(JSON.parse(await readFile(toExtendedLength(join(exportsDir, `${name}.json`)), "utf8")));
      if (!parsed.success) continue;
      const listed = parsed.data;
      if ((await stat(toExtendedLength(join(exportsDir, name)))).size !== listed.bytes) continue;
      out.push({ ...listed, dir: `exports/${name}`, file: `exports/${name}` });
    } catch {
      // A package with no readable record is not listed.
    }
  }
  return out.sort((a, b) => (a.exportedAt < b.exportedAt ? 1 : -1));
}
