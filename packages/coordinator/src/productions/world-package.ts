import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, type ReadStream } from "node:fs";
import { open, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { openPromise, type Entry } from "yauzl";
import { ZipFile } from "yazl";
import { guideAssetIds, listeningAssetIds, musicAssetIds, readGuide, readListening, readMusic, readStory, readWorldManifest, storyAssetIds, WORLD_MANIFEST_FILE, type WorldManifest } from "@arke-studio/contracts";
import { toExtendedLength } from "../world/paths.js";

/**
 * Arke Player's world package on disk (Player ADR 0005; SPEC-058 R-5): `world.json` first, then
 * every file it inventories, each stored rather than compressed — media is compressed already, and a
 * stored entry is exactly as long as its directory says, so a package can never unpack to more than
 * it declared on a phone.
 */

/** Writes [files] (package path → host path) after `world.json` to [destination], which must not exist. */
export async function writeWorldPackageZip(manifestText: string, files: ReadonlyMap<string, string>, destination: string, signal?: AbortSignal): Promise<void> {
  const zip = new ZipFile();
  const output = zip.outputStream as Readable;
  const streams = new Set<ReadStream>();
  zip.on("error", (error) => output.destroy(error));
  const handle = await open(toExtendedLength(destination), "wx");
  let complete = false;
  try {
    const stamp = { compress: false, mtime: new Date("2000-01-01T00:00:00Z"), mode: 0o100644 };
    zip.addBuffer(Buffer.from(manifestText, "utf8"), WORLD_MANIFEST_FILE, stamp);
    for (const [path, source] of [...files.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      zip.addReadStreamLazy(path, stamp, (callback) => {
        const stream = createReadStream(toExtendedLength(source), signal ? { signal } : {});
        streams.add(stream);
        stream.once("close", () => streams.delete(stream));
        callback(null, stream);
      });
    }
    zip.end();
    await pipeline(output, createWriteStream(toExtendedLength(destination), { fd: handle.fd, autoClose: false, emitClose: false }), ...(signal ? [{ signal }] : []));
    await handle.sync();
    signal?.throwIfAborted();
    complete = true;
  } finally {
    output.destroy();
    await Promise.all([...streams].map((stream) => new Promise<void>((resolve) => {
      if (stream.closed) { resolve(); return; }
      stream.once("close", resolve);
      stream.destroy();
    })));
    await handle.close();
    if (!complete) await rm(toExtendedLength(destination), { force: true });
  }
}

/**
 * Arke Player's edition fingerprint (P10 rule 2, SPEC-058 R-30): two packages are one edition when
 * their labels and every file's SHA-256 agree, as one digest. It must be the Player's to the byte —
 * a part names its edition by it (R-46) and a phone compares — so it is `editionFingerprint` in
 * arke_world: the label, then each `path sha256` sorted, joined by newlines.
 */
export function editionFingerprint(manifest: Pick<WorldManifest, "edition" | "assets">): string {
  const lines = [manifest.edition, ...Object.values(manifest.assets).map((asset) => `${asset.path} ${asset.sha256}`).sort()];
  return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}

/** What a written package released (SPEC-058 R-43): its manifest, and its one production's chapters as the listening document has them. */
export async function readWorldPackageRelease(file: string): Promise<{ manifest: WorldManifest; chapters: Array<{ id: string; order: number; title: string }> } | null> {
  const zip = await openPromise(toExtendedLength(file), { autoClose: false, strictFileNames: true, validateEntrySizes: true });
  try {
    const entries = new Map<string, Entry>();
    for await (const entry of zip.eachEntry()) entries.set(entry.fileName.toLowerCase(), entry);
    const text = async (name: string) => {
      const entry = entries.get(name.toLowerCase());
      if (entry === undefined) return null;
      const chunks: Buffer[] = [];
      for await (const chunk of await zip.openReadStreamPromise(entry)) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks).toString("utf8");
    };
    const manifestText = await text(WORLD_MANIFEST_FILE);
    const read = manifestText === null ? null : readWorldManifest(manifestText);
    if (read === null || !read.ok) return null;
    const chapters: Array<{ id: string; order: number; title: string }> = [];
    for (const production of read.manifest.productions) {
      if (production.listening === undefined) continue;
      const source = await text(read.manifest.assets[production.listening]!.path);
      const listening = source === null ? null : readListening(source, read.manifest.assets);
      if (listening?.ok) chapters.push(...listening.document.chapters.map((chapter) => ({ id: chapter.id, order: chapter.order, title: chapter.title })));
    }
    return { manifest: read.manifest, chapters };
  } finally {
    await new Promise<void>((resolve, reject) => { zip.once("close", resolve); zip.once("error", reject); zip.close(); });
  }
}

export type WorldPackageCheck = { ok: true; manifest: WorldManifest; sha256: string; bytes: number } | { ok: false; problems: string[] };

/**
 * Reads a written package back as Arke Player will (SPEC-058 R-5, R-13, R-70, R-80; SPEC-059 R-14): world.json,
 * each listening, music or story document and the guide through the shared readers, nothing in the ZIP the manifest does not name,
 * nothing compressed, every file at its declared length and digest, and every file used.
 */
export async function checkWorldPackageZip(file: string, signal?: AbortSignal): Promise<WorldPackageCheck> {
  const zip = await openPromise(toExtendedLength(file), { autoClose: false, strictFileNames: true, validateEntrySizes: true });
  const problems: string[] = [];
  let checked: WorldManifest;
  try {
    const entries = new Map<string, Entry>();
    for await (const entry of zip.eachEntry()) {
      if (entries.has(entry.fileName.toLowerCase())) problems.push(`${entry.fileName} appears twice`);
      entries.set(entry.fileName.toLowerCase(), entry);
    }
    const bytesOf = async (entry: Entry): Promise<Buffer> => {
      const chunks: Buffer[] = [];
      for await (const chunk of await zip.openReadStreamPromise(entry)) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks);
    };
    const manifestEntry = entries.get(WORLD_MANIFEST_FILE);
    if (manifestEntry === undefined) return { ok: false, problems: ["world.json is missing"] };
    const read = readWorldManifest((await bytesOf(manifestEntry)).toString("utf8"));
    if (!read.ok) return { ok: false, problems: [`world.json: ${read.reason}`] };
    const manifest = read.manifest;
    const named = new Set(Object.values(manifest.assets).map((asset) => asset.path.toLowerCase()));
    for (const [name, entry] of entries) {
      if (name !== WORLD_MANIFEST_FILE && !named.has(name)) problems.push(`${entry.fileName} is not in world.json`);
      if (entry.compressionMethod !== 0) problems.push(`${entry.fileName} is compressed`);
    }
    const used = new Set<string>([manifest.keyArt, manifest.guide].filter((assetId) => assetId !== undefined));
    const guideEntry = manifest.guide !== undefined ? entries.get(manifest.assets[manifest.guide]!.path.toLowerCase()) : undefined;
    if (guideEntry !== undefined) {
      const guide = readGuide((await bytesOf(guideEntry)).toString("utf8"), manifest.assets);
      if (!guide.ok) problems.push(`guide: ${guide.reason}`);
      else for (const assetId of guideAssetIds(guide.guide)) used.add(assetId);
    }
    for (const production of manifest.productions) {
      for (const assetId of [production.picture, production.tall, production.book, production.narration, production.listening, production.music, production.story]) if (assetId !== undefined) used.add(assetId);
      if (production.story !== undefined) {
        const entry = entries.get(manifest.assets[production.story]!.path.toLowerCase());
        if (entry === undefined) continue;
        const story = readStory((await bytesOf(entry)).toString("utf8"), manifest.assets);
        if (!story.ok) problems.push(`${production.id} story: ${story.reason}`);
        else for (const assetId of storyAssetIds(story.document)) used.add(assetId);
        continue;
      }
      if (production.music !== undefined) {
        const entry = entries.get(manifest.assets[production.music]!.path.toLowerCase());
        if (entry === undefined) continue;
        const music = readMusic((await bytesOf(entry)).toString("utf8"), manifest.assets);
        if (!music.ok) problems.push(`${production.id} music: ${music.reason}`);
        else for (const assetId of musicAssetIds(music.document)) used.add(assetId);
        continue;
      }
      if (production.listening === undefined) continue;
      const entry = entries.get(manifest.assets[production.listening]!.path.toLowerCase());
      if (entry === undefined) continue;
      const listening = readListening((await bytesOf(entry)).toString("utf8"), manifest.assets);
      if (!listening.ok) problems.push(`${production.id} listening: ${listening.reason}`);
      else for (const assetId of listeningAssetIds(listening.document)) used.add(assetId);
    }
    for (const [assetId, asset] of Object.entries(manifest.assets)) {
      signal?.throwIfAborted();
      if (!used.has(assetId)) problems.push(`${asset.path} is used by nothing`);
      const entry = entries.get(asset.path.toLowerCase());
      if (entry === undefined) { problems.push(`${asset.path} is missing`); continue; }
      if (entry.uncompressedSize !== asset.byteLength) { problems.push(`${asset.path} is ${entry.uncompressedSize} bytes, not ${asset.byteLength}`); continue; }
      const hash = createHash("sha256");
      for await (const chunk of await zip.openReadStreamPromise(entry)) hash.update(chunk as Buffer);
      if (hash.digest("hex") !== asset.sha256) problems.push(`${asset.path} does not match its digest`);
    }
    if (problems.length > 0) return { ok: false, problems };
    checked = manifest;
  } finally {
    await new Promise<void>((resolve, reject) => { zip.once("close", resolve); zip.once("error", reject); zip.close(); });
  }
  // The package's own digest and length, which a catalogue pins and Publications shows (R-7).
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(toExtendedLength(file))) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  return { ok: true, manifest: checked, sha256: hash.digest("hex"), bytes };
}
