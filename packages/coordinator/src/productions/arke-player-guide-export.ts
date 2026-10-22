import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { packageSlug, WORLD_PACKAGE_FORMAT, type WorldAsset } from "@arke-studio/contracts";
import { fitReadingImage, pngHasAlpha } from "../references/reading-image.js";
import type { FfmpegRunner } from "../takes/export.js";
import { toExtendedLength } from "../world/paths.js";
import type { WorldStore } from "../world/store.js";
import { ARKE_PLAYER_EXPORT_ID, webpHasAlpha } from "./arke-player-export.js";
import { containedWorldFile } from "./interactive.js";
import { guideDraft, packGuide } from "./world-guide.js";
import { checkWorldPackageZip, writeWorldPackageZip } from "./world-package.js";

/**
 * A world's guide alone (SPEC-059 R-10): a schema 3 package with the world's name, logline and key
 * art, its guide and the guide's pictures and voice lines, and no production. Arke Player pins it
 * beside the world's full package, so the world can be explored before it is installed; installing
 * the full package supersedes it. Made as the full export is — in staging, read back by the shared
 * reader, the guide drafted again under the gate — and named `exports/<slug>-guide-<date>.zip`.
 * It has no record beside it: Publications lists what a reader installs, and this is published
 * only as a world's `guide` pin in the Player's list.
 */

const COMPILER = "arke-studio/arke-player-guide-export";
const COMPILER_VERSION = 1;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export interface GuideAloneOptions {
  clock: () => string;
  ffmpeg?: FfmpegRunner;
  exportId: string;
  signal?: AbortSignal;
  studioVersion: string;
  onStep?: (step: string, percent: number) => void;
}

export type GuideAloneResult =
  | { ok: true; file: string; bytes: number; sha256: string; edition: string; characters: number; places: number; lore: number }
  | { ok: false; blockers: string[] };

export async function exportGuideAlone(store: WorldStore, options: GuideAloneOptions): Promise<GuideAloneResult> {
  if (!ARKE_PLAYER_EXPORT_ID.test(options.exportId)) throw new Error("invalid Arke Player export id");
  const ffmpeg = options.ffmpeg;
  if (ffmpeg === undefined) return { ok: false, blockers: ["Needs ffmpeg"] };
  const signal = options.signal ?? new AbortController().signal;
  const cancelled = (): GuideAloneResult => ({ ok: false, blockers: ["the export was cancelled"] });
  const step = options.onStep ?? (() => {});
  const bundle = store.getBundle();

  step("Reading the guide", 5);
  const drafted = await guideDraft(store, undefined, signal);
  if (drafted === null) return { ok: false, blockers: ["nothing in the Guide is public"] };
  const keyArt = bundle.keyArt ?? null;
  const madeFrom = () => JSON.stringify({ guide: drafted.document, world: [bundle.meta.name, bundle.meta.logline ?? null, keyArt] });
  const keyArtFile = keyArt !== null ? await containedWorldFile(store.dir, keyArt) : null;
  if (signal.aborted) return cancelled();

  const staging = join(store.dir, ".staging", "arke-player-guide", options.exportId);
  const files = join(staging, "files");
  const at = (path: string) => join(files, ...path.split("/"));
  try {
    await mkdir(toExtendedLength(files), { recursive: true });
    const assets: Record<string, WorldAsset> = {};
    const sources = new Map<string, string>();
    const originals: Record<string, string> = {};
    const add = async (assetId: string, path: string, mediaType: string) => {
      const bytes = await readFile(toExtendedLength(at(path)));
      assets[assetId] = { path, mediaType, byteLength: bytes.byteLength, sha256: sha256(bytes) };
      sources.set(path, at(path));
    };

    // The world's key art, as the full package carries it (SPEC-058 R-6).
    if (keyArtFile !== null) {
      step("Fitting the key art", 15);
      const original = await readFile(toExtendedLength(keyArtFile));
      const keepsAlpha = pngHasAlpha(original) || webpHasAlpha(original);
      const path = `key-art.${keepsAlpha ? "png" : "jpg"}`;
      try {
        await fitReadingImage(keyArtFile, at(path), keepsAlpha, ffmpeg, signal);
      } catch {
        if (signal.aborted) return cancelled();
        return { ok: false, blockers: ["the key art could not be fitted for a phone"] };
      }
      await add("key-art", path, keepsAlpha ? "image/png" : "image/jpeg");
      originals["key-art"] = sha256(original);
    }

    step("Fitting the guide", 30);
    let packed: Awaited<ReturnType<typeof packGuide>>;
    try {
      packed = await packGuide(drafted.document, drafted.lines, store, { ffmpeg, signal, at, add, original: async (assetId, file) => { originals[assetId] = sha256(await readFile(toExtendedLength(file))); } });
    } catch (error) {
      if (signal.aborted) return cancelled();
      throw error;
    }
    if (!packed.ok) return { ok: false, blockers: [packed.blocker] };

    const stamp = options.clock();
    const day = stamp.slice(0, 10);
    const slug = packageSlug(bundle.meta.slug);
    await mkdir(toExtendedLength(join(store.dir, "exports")), { recursive: true });
    const taken = new Set(await readdir(toExtendedLength(join(store.dir, "exports"))).catch(() => [] as string[]));
    let edition = day;
    for (let counter = 2; taken.has(`${slug}-guide-${edition}.zip`); counter++) edition = `${day}-${counter}`;
    const name = `${slug}-guide-${edition}.zip`;
    const manifest = {
      format: WORLD_PACKAGE_FORMAT,
      schemaVersion: 3,
      id: slug,
      edition,
      name: bundle.meta.name.slice(0, 200),
      ...(bundle.meta.logline !== undefined && bundle.meta.logline.trim() !== "" ? { logline: bundle.meta.logline.slice(0, 400) } : {}),
      ...(assets["key-art"] !== undefined ? { keyArt: "key-art" } : {}),
      productions: [],
      guide: "guide",
      assets,
      provenance: { compiler: COMPILER, compilerVersion: COMPILER_VERSION, studio: options.studioVersion, exportId: options.exportId, exportedAt: stamp, guide: sha256(new TextEncoder().encode(madeFrom())), originals },
    };

    step("Checking the package", 80);
    const zip = join(staging, name);
    await writeWorldPackageZip(`${JSON.stringify(manifest, null, 2)}\n`, sources, zip, signal);
    const checked = await checkWorldPackageZip(zip, signal);
    if (!checked.ok) return { ok: false, blockers: checked.problems };

    // Under the gate the guide is drafted again: an entry edited meanwhile refuses the package
    // rather than shipping beside what it was made from (SPEC-058 R-4).
    return await store.gateOp(async () => {
      const again = await guideDraft(store, undefined, signal);
      if (again === null || JSON.stringify(again.document) !== JSON.stringify(drafted.document)) return { ok: false as const, blockers: ["the Guide changed while the package was made · make it again"] };
      const destination = join(store.dir, "exports", name);
      if (await stat(toExtendedLength(destination)).then(() => true, () => false)) return { ok: false as const, blockers: [`exports/${name} already exists · make it again`] };
      await rename(toExtendedLength(zip), toExtendedLength(destination));
      step("Done", 100);
      const guide = drafted.document;
      return { ok: true as const, file: `exports/${name}`, bytes: checked.bytes, sha256: checked.sha256, edition, characters: guide.characters.length, places: guide.places.length, lore: guide.lore.length };
    });
  } finally {
    await rm(toExtendedLength(staging), { recursive: true, force: true }).catch(() => {});
  }
}
