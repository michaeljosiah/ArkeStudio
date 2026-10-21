import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, type ReadStream } from "node:fs";
import { open, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { openPromise, type Entry } from "yauzl";
import { ZipFile } from "yazl";
import { listeningAssetIds, readListening, readWorldManifest, WORLD_MANIFEST_FILE, type WorldManifest } from "@arke-studio/contracts";
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

export type WorldPackageCheck = { ok: true; manifest: WorldManifest; sha256: string; bytes: number } | { ok: false; problems: string[] };

/**
 * Reads a written package back as Arke Player will (SPEC-058 R-5, R-13): world.json and each
 * listening document through the shared readers, nothing in the ZIP the manifest does not name,
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
    const used = new Set<string>(manifest.keyArt !== undefined ? [manifest.keyArt] : []);
    for (const production of manifest.productions) {
      for (const assetId of [production.picture, production.book, production.narration, production.listening]) if (assetId !== undefined) used.add(assetId);
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
