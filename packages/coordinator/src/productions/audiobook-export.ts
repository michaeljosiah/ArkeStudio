import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AUDIOBOOK_PLAYER_SOURCE,
  audiobookScopeKey,
  AudiobookScopeSchema,
  ulid,
  type AudiobookListening,
  type AudiobookPlayerChapter,
  type AudiobookScope,
  type ListeningChapter,
} from "@arke-studio/contracts";
import type { FfmpegRunner } from "../takes/export.js";
import { atomicWriteFile } from "../world/atomic.js";
import { toExtendedLength } from "../world/paths.js";
import type { WorldStore } from "../world/store.js";
import { audiobookListening } from "./audiobook-listening.js";
import { containedWorldFile } from "./interactive.js";

/**
 * The audiobook as the player (design turn 186e, SPEC-047 R-72): a web package like the visual
 * novel's (turn 174h) — `player.html` carrying the same player the app mounts, the chapters' audio
 * and their pictures — written under the world's `exports/`. Only chapters read whole go in; a
 * chapter read in part plays in the app, never in a package a listener is given.
 *
 * Each chapter's takes are joined into one file when this machine has ffmpeg — back to back, as
 * the player plays them, nothing added — and shipped as they were made when it has not, which the
 * same player plays as a chapter of pieces. Everything is made in a staging folder and moved into
 * `exports/` whole under the world's gate, after the book is read again: a take made or a picture
 * moved while the package was made refuses it rather than shipping half of each.
 */

export type AudiobookExportResult =
  | { ok: true; id: string; dir: string; file: string; chapters: number; pictures: number; bytes: number; joined: boolean; scope: AudiobookScope; chapterIds: string[] }
  | { ok: false; blockers: string[] };

const EXPORT_ID = /^ab_[0-9A-HJKMNP-TV-Z]{26}$/;

function fullHash(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}`;
}

/** What a package's chapter depends on, to read the book again under the gate and compare. */
function signature(chapters: readonly ListeningChapter[]): string {
  return JSON.stringify(chapters.map((chapter) => [chapter.chapterId, chapter.title, chapter.mix?.file ?? null, chapter.blocks.map((block) => [block.key, block.file, block.seconds]), chapter.pictures.map((picture) => [picture.key, picture.file, picture.at]), chapter.opening]));
}

const extensionOf = (file: string) => {
  const dot = file.lastIndexOf(".");
  return dot > file.lastIndexOf("/") ? file.slice(dot).toLowerCase() : "";
};
const pad = (order: number) => String(order).padStart(2, "0");

/** The package's page: the player inlined as its own text, the manifest embedded so file:// works offline. */
function playerHtml(manifest: { title: string; cover: string | null; chapters: AudiobookPlayerChapter[] }, storageKey: string): string {
  const json = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");
  const player = AUDIOBOOK_PLAYER_SOURCE.replace("export function mountAudiobookPlayer", "function mountAudiobookPlayer").replace(/<\/script/gi, "<\\/script");
  const title = manifest.title.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${title}</title>
<style>html,body{margin:0;height:100%;background:#0a0a0a}#app{position:fixed;inset:0}</style>
</head><body>
<div id="app"></div>
<script>
${player}
// The listener's place, speed and sleep choice are kept on this device, keyed by world and book:
// the place is a block and an offset, so a package exported again after more is read still opens
// in the same words.
const manifest = ${json(manifest)};
mountAudiobookPlayer(document.getElementById("app"), { title: manifest.title, cover: manifest.cover, chapters: manifest.chapters, storageKey: ${json(storageKey)} });
</script></body></html>
`;
}

export async function exportAudiobookPlayer(
  store: WorldStore,
  productionId: string,
  options: { clock: () => string; ffmpeg?: FfmpegRunner; exportId?: string; signal?: AbortSignal; scope?: AudiobookScope } ,
): Promise<AudiobookExportResult> {
  const scope = options.scope ?? { kind: "book" };
  const listeningOptions = { ...(options.ffmpeg !== undefined ? { ffmpeg: options.ffmpeg } : {}), scope };
  const listening: AudiobookListening = await audiobookListening(store, productionId, listeningOptions);
  const whole = listening.chapters.filter((chapter) => chapter.state === "read" && chapter.blocks.length > 0);
  if (whole.length === 0) return { ok: false, blockers: [scope.kind === "chapter" ? "this chapter is not read whole yet" : "no chapter is read whole yet"] };
  const exportId = options.exportId ?? `ab_${ulid()}`;
  if (!EXPORT_ID.test(exportId)) throw new Error("invalid audiobook export id");
  const signal = options.signal ?? new AbortController().signal;
  const staging = join(store.dir, ".staging", "audiobook-export", exportId);
  const outName = `audiobook-${productionId}-${exportId}`;
  try {
    await mkdir(toExtendedLength(join(staging, "media")), { recursive: true });
    // Every source is resolved to the world's own file before anything is copied: one that leaves
    // the world refuses the package whole, as the interactive export does.
    const real = new Map<string, string>();
    const outside: string[] = [];
    const resolve = async (file: string) => {
      if (real.has(file)) return;
      const found = await containedWorldFile(store.dir, file);
      if (found === null) outside.push(file);
      else real.set(file, found);
    };
    for (const chapter of whole) for (const block of chapter.blocks) await resolve(block.file);
    for (const chapter of whole) if (chapter.mix !== undefined) await resolve(chapter.mix.file);
    const pictureFiles = [...new Set([...(listening.cover !== null ? [listening.cover] : []), ...whole.flatMap((chapter) => [...chapter.pictures.map((picture) => picture.file), ...(chapter.opening !== null ? [chapter.opening] : [])])])];
    for (const file of pictureFiles) await resolve(file);
    if (outside.length > 0) return { ok: false, blockers: outside.map((file) => `${file} is not a file inside this world — the package would carry something else`) };

    // Pictures once each, however many chapters show them.
    const pictureName = new Map<string, string>();
    await mkdir(toExtendedLength(join(staging, "media", "pictures")), { recursive: true });
    for (const [index, file] of pictureFiles.entries()) {
      const name = `media/pictures/p${String(index + 1).padStart(3, "0")}${extensionOf(file)}`;
      await copyFile(toExtendedLength(real.get(file)!), toExtendedLength(join(staging, name)));
      pictureName.set(file, name);
    }
    const picture = (file: string | null) => (file === null ? null : (pictureName.get(file) ?? null));

    const chapters: AudiobookPlayerChapter[] = [];
    let joined = options.ffmpeg !== undefined;
    for (const chapter of whole) {
      if (signal.aborted) return { ok: false, blockers: ["the export was cancelled"] };
      const base = {
        id: chapter.chapterId,
        order: chapter.order,
        title: chapter.title,
        state: "read" as const,
        seconds: chapter.seconds,
        gaps: [],
        pictures: chapter.pictures.flatMap((entry) => (pictureName.has(entry.file) ? [{ at: entry.at, src: pictureName.get(entry.file)! }] : [])),
        opening: picture(chapter.opening),
      };
      const blocks = chapter.blocks.map((block) => ({ key: block.key, at: block.at, seconds: block.seconds, sentences: block.sentences }));
      // A chapter with timing ships its one mix (design turn 187, R-85): the same render the
      // chapter's Play and the player in the app hear — overlaps, reactions, beds, one loudness —
      // encoded where this machine can, else the render itself. Never its takes joined anew.
      if (chapter.mix !== undefined) {
        const encoded = `media/chapter-${pad(chapter.order)}.m4a`;
        let name = `media/chapter-${pad(chapter.order)}.wav`;
        if (options.ffmpeg !== undefined) {
          try {
            await options.ffmpeg.run(["-y", "-i", real.get(chapter.mix.file)!, "-vn", "-ac", "1", "-ar", "44100", "-c:a", "aac", "-b:a", "128k", join(staging, encoded)], () => {}, signal);
            name = encoded;
          } catch {
            if (signal.aborted) return { ok: false, blockers: ["the export was cancelled"] };
            await rm(toExtendedLength(join(staging, encoded)), { force: true }).catch(() => {});
          }
        }
        if (name !== encoded) await copyFile(toExtendedLength(real.get(chapter.mix.file)!), toExtendedLength(join(staging, name)));
        chapters.push({ ...base, audio: [{ src: name, at: 0, seconds: chapter.seconds }], blocks });
        continue;
      }
      if (options.ffmpeg !== undefined) {
        // One file a chapter: each take made uniform, then joined back to back with nothing added.
        const name = `media/chapter-${pad(chapter.order)}.m4a`;
        const work = join(staging, "work", chapter.chapterId);
        let made = true;
        await mkdir(toExtendedLength(work), { recursive: true });
        try {
          const pieces: string[] = [];
          for (const [index, block] of chapter.blocks.entries()) {
            const piece = join(work, `${String(index).padStart(4, "0")}.wav`);
            await options.ffmpeg.run(["-y", "-i", real.get(block.file)!, "-vn", "-ac", "1", "-ar", "44100", "-c:a", "pcm_s16le", piece], () => {}, signal);
            pieces.push(piece);
          }
          const list = join(work, "pieces.txt");
          await writeFile(toExtendedLength(list), pieces.map((piece) => `file '${piece.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n") + "\n", "utf8");
          await options.ffmpeg.run(["-y", "-f", "concat", "-safe", "0", "-i", list, "-c:a", "aac", "-b:a", "128k", join(staging, name)], () => {}, signal);
        } catch (err) {
          if (signal.aborted) return { ok: false, blockers: ["the export was cancelled"] };
          // A join that fails ships the takes as they were made: the same player plays them.
          joined = false;
          made = false;
          void err;
          await rm(toExtendedLength(join(staging, name)), { force: true }).catch(() => {});
        } finally {
          await rm(toExtendedLength(work), { recursive: true, force: true }).catch(() => {});
        }
        if (made) {
          chapters.push({ ...base, audio: [{ src: name, at: 0, seconds: chapter.seconds }], blocks });
          continue;
        }
      }
      const folder = `media/chapter-${pad(chapter.order)}`;
      await mkdir(toExtendedLength(join(staging, folder)), { recursive: true });
      const audio: AudiobookPlayerChapter["audio"] = [];
      for (const [index, block] of chapter.blocks.entries()) {
        const name = `${folder}/${String(index + 1).padStart(4, "0")}${extensionOf(block.file)}`;
        await copyFile(toExtendedLength(real.get(block.file)!), toExtendedLength(join(staging, name)));
        audio.push({ src: name, at: block.at, seconds: block.seconds });
      }
      chapters.push({ ...base, audio, blocks });
    }
    await rm(toExtendedLength(join(staging, "work")), { recursive: true, force: true }).catch(() => {});

    // Every file the package carries, hashed as written, then the page and the manifest.
    const files: Array<{ file: string; hash: string }> = [];
    let bytes = 0;
    const walk = async (rel: string): Promise<void> => {
      for (const entry of await readdir(toExtendedLength(join(staging, rel)), { withFileTypes: true })) {
        const child = `${rel}/${entry.name}`;
        if (entry.isDirectory()) await walk(child);
        else {
          const content = await readFile(toExtendedLength(join(staging, child)));
          bytes += content.byteLength;
          files.push({ file: child, hash: fullHash(content) });
        }
      }
    };
    await walk("media");
    files.sort((a, b) => a.file.localeCompare(b.file));
    const manifest = {
      kind: "audiobook" as const,
      version: 1,
      productionId,
      scope,
      chapterIds: chapters.map((chapter) => chapter.id),
      title: listening.title,
      world: store.getBundle().meta.name,
      cover: picture(listening.cover),
      chapters,
      files,
      provenance: { exportId, exportedAt: options.clock() },
    };
    await atomicWriteFile(join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const page = playerHtml({ title: listening.title, cover: manifest.cover, chapters }, `arke-ab-${store.worldId}-${productionId}${scope.kind === "chapter" ? `-${audiobookScopeKey(scope)}` : ""}`);
    await atomicWriteFile(join(staging, "player.html"), page);
    bytes += Buffer.byteLength(page);

    const problems = await packageProblems(staging, exportId);
    if (problems.length > 0) return { ok: false, blockers: problems };

    // Under the gate, the book is read again: a take made or a picture moved meanwhile refuses the
    // package rather than shipping it beside the snapshot's.
    return await store.gateOp(async () => {
      const again = (await audiobookListening(store, productionId, listeningOptions)).chapters.filter((chapter) => chapter.state === "read" && chapter.blocks.length > 0);
      if (signature(again) !== signature(whole)) return { ok: false as const, blockers: ["the book changed while the package was made — export again"] };
      await mkdir(toExtendedLength(join(store.dir, "exports")), { recursive: true });
      await rename(toExtendedLength(staging), toExtendedLength(join(store.dir, "exports", outName)));
      return { ok: true as const, id: exportId, dir: `exports/${outName}`, file: `exports/${outName}/player.html`, chapters: chapters.length, pictures: pictureFiles.length, bytes, joined, scope, chapterIds: manifest.chapterIds };
    });
  } finally {
    await rm(toExtendedLength(staging), { recursive: true, force: true }).catch(() => {});
  }
}

/** The package re-read as a listener's browser would: the page, the manifest, and every file at its hash. */
export async function packageProblems(dir: string, exportId: string): Promise<string[]> {
  let manifest: { kind?: unknown; scope?: unknown; chapterIds?: unknown; provenance?: { exportId?: unknown }; files?: Array<{ file: string; hash: string }>; chapters?: AudiobookPlayerChapter[] } | null = null;
  try {
    manifest = JSON.parse(await readFile(toExtendedLength(join(dir, "manifest.json")), "utf8"));
  } catch {
    // Said below.
  }
  if (manifest === null || manifest.kind !== "audiobook" || !Array.isArray(manifest.files) || !Array.isArray(manifest.chapters)) return ["manifest.json is missing or invalid"];
  const problems: string[] = [];
  if (manifest.scope !== undefined) {
    const scope = AudiobookScopeSchema.safeParse(manifest.scope);
    const ids = manifest.chapters.map((chapter) => chapter.id);
    if (!scope.success || (scope.data.kind === "chapter" && (ids.length !== 1 || ids[0] !== scope.data.chapterId)) || JSON.stringify(manifest.chapterIds) !== JSON.stringify(ids)) problems.push("manifest.json does not match its export scope");
  }
  if (manifest.provenance?.exportId !== exportId) problems.push("manifest.json names another export");
  const listed = new Set(manifest.files.map((entry) => entry.file));
  for (const entry of manifest.files) {
    try {
      if (fullHash(await readFile(toExtendedLength(join(dir, entry.file)))) !== entry.hash) problems.push(`${entry.file} does not match its manifest hash`);
    } catch {
      problems.push(`${entry.file} is missing from the package`);
    }
  }
  for (const chapter of manifest.chapters) {
    for (const piece of chapter.audio ?? []) if (!listed.has(piece.src)) problems.push(`${piece.src} is not in the package`);
    for (const shown of chapter.pictures) if (!listed.has(shown.src)) problems.push(`${shown.src} is not in the package`);
  }
  if (!(await stat(toExtendedLength(join(dir, "player.html"))).then((s) => s.isFile(), () => false))) problems.push("player.html is missing from the package");
  return problems;
}

/** The world's web packages, newest first (turn 186e): the interactive, the visual novel and the audiobook, each by its manifest. */
export async function listWebPackages(store: WorldStore): Promise<Array<{ kind: "interactive" | "visual-novel" | "audiobook"; productionId: string; title: string; dir: string; exportedAt: string }>> {
  const exportsDir = join(store.dir, "exports");
  const entries = await readdir(toExtendedLength(exportsDir), { withFileTypes: true }).catch(() => []);
  const out: Array<{ kind: "interactive" | "visual-novel" | "audiobook"; productionId: string; title: string; dir: string; exportedAt: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^(interactive|audiobook)-/.test(entry.name)) continue;
    try {
      const raw = JSON.parse(await readFile(toExtendedLength(join(exportsDir, entry.name, "manifest.json")), "utf8")) as Record<string, unknown>;
      const provenance = (raw["provenance"] ?? {}) as Record<string, unknown>;
      const productionId = typeof raw["productionId"] === "string" ? raw["productionId"] : typeof provenance["productionId"] === "string" ? provenance["productionId"] : null;
      if (productionId === null || typeof provenance["exportedAt"] !== "string") continue;
      if (!(await stat(toExtendedLength(join(exportsDir, entry.name, "player.html"))).then((s) => s.isFile(), () => false))) continue;
      const kind = raw["kind"] === "audiobook" ? "audiobook" : Array.isArray(raw["beats"]) ? "visual-novel" : "interactive";
      const production = store.getBundle().productions.find((candidate) => candidate.meta.id === productionId);
      out.push({ kind, productionId, title: typeof raw["title"] === "string" ? raw["title"] : (production?.meta.title ?? productionId), dir: `exports/${entry.name}`, exportedAt: provenance["exportedAt"] });
    } catch {
      // A folder with no readable manifest is no package.
    }
  }
  return out.sort((a, b) => (a.exportedAt < b.exportedAt ? 1 : -1));
}
