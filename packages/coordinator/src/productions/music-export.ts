import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  MUSIC_COVER_EDGE,
  MUSIC_FORMAT,
  MUSIC_MEDIA_TYPE,
  MUSIC_VERSION,
  STORY_EPUB_READING_PROFILE,
  WORLD_PACKAGE_FORMAT,
  musicKindOf,
  packageSlug,
  productionShape,
  type ArkePlayerRelease,
  type MusicDocument,
  type MusicRecord,
  type WorldAsset,
} from "@arke-studio/contracts";
import { toExtendedLength } from "../world/paths.js";
import type { WorldStore } from "../world/store.js";
import type { ArkePlayerExportOptions, ArkePlayerExportResult, ArkePlayerListed } from "./arke-player-export.js";
import { containedWorldFile } from "./interactive.js";
import { readMusicRecord } from "./music.js";
import { musicHeardIn } from "./music-heard.js";
import { musicRenderPlan, MusicRenderRefusal, renderMusicTrack, type MusicRenderTrack } from "./music-render.js";
import { checkWorldPackageZip, editionFingerprint, writeWorldPackageZip } from "./world-package.js";
import { pngHasAlpha } from "../references/reading-image.js";

/**
 * Export → Arke Player for a music production (design turn 238h, SPEC-060 R-15 – R-17): a
 * production package (SPEC-058 R-68), the world's package with this production alone, beside the
 * world's edition, so an album added to a world never makes a phone download its audiobook again.
 *
 * It is made as the world's package is (SPEC-058 R-4, R-5): in a staging folder, each track the
 * render Play all plays (R-8, R-16), the 1:1 cover fitted to 1024, the music document beside them,
 * read back by the shared reader, and the record read again under the world's gate before the
 * package is named `exports/<world-slug>-<production-id>-<date>.zip`. An album is exported whole
 * (call 2): every track, or a blocker saying which one stands in the way.
 */

const COMPILER = "arke-studio/arke-player-music-export";
const COMPILER_VERSION = 1;

const pad = (value: number, width: number) => String(value).padStart(width, "0");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** What the package is made from: the record as written, and every source's bytes by hash. */
const madeFromOf = (raw: string | null, plan: readonly MusicRenderTrack[], cover: string | null) =>
  sha256(new TextEncoder().encode(JSON.stringify({ raw, sources: plan.map((track) => track.hash), cover })));

/**
 * A track's sections on the rendered track's own clock (R-17): its trim moves them, one cut
 * away is left out, and two at one moment are one, as the reader asks them strictly in order.
 */
export function musicDocumentSections(track: MusicRecord["tracks"][number], playsMs: number): Array<{ label: string; at: number }> {
  const start = track.trim?.startMs ?? 0;
  const out: Array<{ label: string; at: number }> = [];
  for (const section of [...(track.sections ?? [])].sort((a, b) => a.atMs - b.atMs)) {
    const at = section.atMs - start;
    if (at < 0 || at >= playsMs) continue;
    if (out.length > 0 && out[out.length - 1]!.at >= at) continue;
    out.push({ label: section.label, at });
  }
  return out;
}

export async function exportMusicPlayer(store: WorldStore, productionId: string, options: ArkePlayerExportOptions): Promise<ArkePlayerExportResult> {
  const ffmpeg = options.ffmpeg;
  if (ffmpeg === undefined) return { ok: false, blockers: ["Needs ffmpeg"] };
  const signal = options.signal ?? new AbortController().signal;
  const cancelled = (): ArkePlayerExportResult => ({ ok: false, blockers: ["the export was cancelled"] });
  const step = options.onStep ?? (() => {});
  const bundle = store.getBundle();
  const production = bundle.productions.find((entry) => entry.meta.id === productionId);
  if (production === undefined || !productionShape(production.meta).isMusic) return { ok: false, blockers: ["that production is no longer music in this world"] };
  const kind = musicKindOf(production.meta);

  const { record, raw } = await readMusicRecord(store, productionId);
  if (record.tracks.length === 0) return { ok: false, blockers: ["Add a track first"] };
  if (kind === "single" && record.tracks.length !== 1) return { ok: false, blockers: ["a single holds one track · make it an album"] };
  if (kind === "soundtrack" && record.for === undefined) return { ok: false, blockers: ["Choose the production this is a soundtrack for"] };
  const plan = musicRenderPlan(record, bundle.artifacts);
  if (!plan.ok) return plan;
  // A retired cover is still this album's cover: retirement is the shelf's, not the album's.
  const coverArtifact = record.cover === undefined ? undefined : bundle.artifacts.find((artifact) => artifact.id === record.cover);
  if (record.cover !== undefined && coverArtifact === undefined) return { ok: false, blockers: ["the cover is no longer on the shelf · make or choose another"] };
  const coverFile = coverArtifact !== undefined ? `artifacts/${coverArtifact.file}` : null;
  const coverReal = coverFile !== null ? await containedWorldFile(store.dir, coverFile) : null;
  if (coverFile !== null && coverReal === null) return { ok: false, blockers: ["the cover is outside this world"] };
  const madeFrom = madeFromOf(raw, plan.tracks, coverArtifact?.hash ?? null);
  // Heard in is read now, never kept (R-14): the document carries where each track is placed today.
  const heard = await musicHeardIn(store, productionId, record);
  if (signal.aborted) return cancelled();

  const staging = join(store.dir, ".staging", "arke-player-export", options.exportId);
  const files = join(staging, "files");
  const at = (path: string) => join(files, ...path.split("/"));
  try {
    await mkdir(toExtendedLength(join(files, "music")), { recursive: true });
    const assets: Record<string, WorldAsset> = {};
    const sources = new Map<string, string>();
    const originals: Record<string, string> = {};
    const add = async (assetId: string, path: string, mediaType: string) => {
      const bytes = await readFile(toExtendedLength(at(path)));
      assets[assetId] = { path, mediaType, byteLength: bytes.byteLength, sha256: sha256(bytes) };
      sources.set(path, at(path));
    };

    const tracks: MusicDocument["tracks"] = [];
    let totalMs = 0;
    let lyrics = 0;
    for (const [index, track] of plan.tracks.entries()) {
      if (signal.aborted) return cancelled();
      step(`Rendering tracks · ${index + 1} of ${plan.tracks.length}`, (index / plan.tracks.length) * 80);
      let rendered: Awaited<ReturnType<typeof renderMusicTrack>>;
      try {
        rendered = await renderMusicTrack(store.dir, track, record.loudness, { ffmpeg, signal });
      } catch (error) {
        if (signal.aborted) return cancelled();
        return { ok: false, blockers: [error instanceof MusicRenderRefusal ? error.message : `Track ${index + 1} · ${track.title} · could not be rendered`] };
      }
      const assetId = `t${pad(index + 1, 2)}`;
      const path = `music/${assetId}.m4a`;
      await copyFile(toExtendedLength(rendered.path), toExtendedLength(at(path)));
      await add(assetId, path, "audio/mp4");
      originals[assetId] = track.hash.replace(/^sha256:/, "");
      const source = record.tracks[index]!;
      const playsMs = rendered.durationMs - track.gapMs;
      const sections = musicDocumentSections(source, playsMs);
      const words = source.lyrics?.trim() ? source.lyrics : undefined;
      if (words !== undefined) lyrics++;
      const rows = heard[source.id] ?? [];
      tracks.push({
        id: source.id,
        title: source.title.slice(0, 200),
        audio: assetId,
        duration: Math.max(1, rendered.durationMs),
        ...(words !== undefined ? { lyrics: { text: words.slice(0, 20_000), ...(sections.length > 0 ? { sections } : {}) } } : {}),
        ...(rows.length > 0 ? { heardIn: rows.slice(0, 200).map((row) => ({ production: packageSlug(row.production), chapter: row.chapter, at: row.at })) } : {}),
      });
      totalMs += rendered.durationMs;
    }

    // The cover (R-5, R-17): square, as album art is everywhere, at most 1024 on a side. A picture
    // that is not square is cut to its middle square rather than shipped as some other shape.
    let picture: string | undefined;
    if (coverReal !== null) {
      if (signal.aborted) return cancelled();
      step("Fitting the cover", 82);
      const original = await readFile(toExtendedLength(coverReal));
      const keepsAlpha = pngHasAlpha(original);
      const path = `cover.${keepsAlpha ? "png" : "jpg"}`;
      const fit = `crop='min(iw,ih)':'min(iw,ih)',scale='min(${MUSIC_COVER_EDGE},iw)':'min(${MUSIC_COVER_EDGE},ih)'`;
      try {
        await ffmpeg.run(["-y", "-i", coverReal, "-vf", fit, "-frames:v", "1", "-update", "1", ...(keepsAlpha ? [] : ["-q:v", String(STORY_EPUB_READING_PROFILE.jpegQuality)]), at(path)], () => {}, signal);
      } catch {
        if (signal.aborted) return cancelled();
        return { ok: false, blockers: ["the cover could not be fitted for a phone"] };
      }
      await add("cover", path, keepsAlpha ? "image/png" : "image/jpeg");
      originals["cover"] = sha256(original);
      picture = "cover";
    }

    const document: MusicDocument = {
      format: MUSIC_FORMAT,
      version: MUSIC_VERSION,
      kind,
      ...(kind === "soundtrack" && record.for !== undefined ? { for: packageSlug(record.for) } : {}),
      tracks,
    };
    await writeFile(toExtendedLength(at("music.json")), `${JSON.stringify(document, null, 2)}\n`, "utf8");
    await add("music", "music.json", MUSIC_MEDIA_TYPE);

    const stamp = options.clock();
    const day = stamp.slice(0, 10);
    const slug = packageSlug(bundle.meta.slug);
    const own = packageSlug(productionId);
    await mkdir(toExtendedLength(join(store.dir, "exports")), { recursive: true });
    const taken = new Set(await readdir(toExtendedLength(join(store.dir, "exports"))).catch(() => [] as string[]));
    let edition = day;
    for (let counter = 2; taken.has(`${slug}-${own}-${edition}.zip`) || taken.has(`${slug}-${own}-${edition}.zip.json`); counter++) edition = `${day}-${counter}`;
    const name = `${slug}-${own}-${edition}.zip`;
    const title = production.meta.title.trim() || production.meta.id;
    const manifest = {
      format: WORLD_PACKAGE_FORMAT,
      // A production package is schema 5, and the only thing schema 5 is (SPEC-058 R-68).
      schemaVersion: 5,
      alone: true,
      id: slug,
      edition,
      name: bundle.meta.name.slice(0, 200),
      ...(bundle.meta.logline !== undefined && bundle.meta.logline.trim() !== "" ? { logline: bundle.meta.logline.slice(0, 400) } : {}),
      productions: [{ id: own, title: title.slice(0, 200), ...(picture !== undefined ? { picture } : {}), music: "music" }],
      assets,
      provenance: { compiler: COMPILER, compilerVersion: COMPILER_VERSION, studio: options.studioVersion, exportId: options.exportId, exportedAt: stamp, music: madeFrom, originals },
    };

    step("Checking the package", 90);
    const zip = join(staging, name);
    await writeWorldPackageZip(`${JSON.stringify(manifest, null, 2)}\n`, sources, zip, signal);
    const checked = await checkWorldPackageZip(zip, signal);
    if (!checked.ok) return { ok: false, blockers: checked.problems };
    const holds = [`${tracks.length} track${tracks.length === 1 ? "" : "s"}`, picture !== undefined ? "the cover" : null, lyrics > 0 ? `${lyrics} with lyrics` : null].filter((part) => part !== null).join(" · ");
    const release: ArkePlayerRelease = { edition, fingerprint: editionFingerprint({ edition, assets }), chapters: [] };

    // Under the gate, the record and its sources are read again: a track added, reordered, retitled
    // or edited meanwhile refuses the package rather than shipping the album as it was (R-4).
    return await store.gateOp(async () => {
      const again = await readMusicRecord(store, productionId);
      const replan = musicRenderPlan(again.record, store.getBundle().artifacts);
      const cover = again.record.cover === undefined ? null : store.getBundle().artifacts.find((artifact) => artifact.id === again.record.cover)?.hash ?? "gone";
      if (!replan.ok || madeFromOf(again.raw, replan.tracks, cover) !== madeFrom) return { ok: false as const, blockers: ["the album changed while the package was made · make it again"] };
      const destination = join(store.dir, "exports", name);
      // Never over an earlier export (SPEC-048 R-10).
      const exists = (path: string) => stat(toExtendedLength(path)).then(() => true, () => false);
      if ((await exists(destination)) || (await exists(`${destination}.json`))) return { ok: false as const, blockers: [`exports/${name} already exists · make it again`] };
      const listed: ArkePlayerListed = {
        kind: "arke-player",
        exportId: options.exportId,
        exportedAt: stamp,
        productionId,
        title: `${bundle.meta.name} · ${title}`.slice(0, 400),
        bytes: checked.bytes,
        sha256: checked.sha256,
        holds,
        chapters: 0,
        pictures: picture !== undefined ? 1 : 0,
        book: false,
        guide: false,
        tracks: tracks.length,
        durationMs: totalMs,
        release,
      };
      await writeFile(toExtendedLength(`${destination}.json`), `${JSON.stringify(listed, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      try {
        await rename(toExtendedLength(zip), toExtendedLength(destination));
      } catch (error) {
        await rm(toExtendedLength(`${destination}.json`), { force: true }).catch(() => {});
        throw error;
      }
      step("Done", 100);
      return { ok: true as const, file: `exports/${name}`, bytes: checked.bytes, sha256: checked.sha256, edition, chapters: 0, pictures: picture !== undefined ? 1 : 0, book: false, guide: false, tracks: tracks.length };
    });
  } finally {
    await rm(toExtendedLength(staging), { recursive: true, force: true }).catch(() => {});
  }
}
