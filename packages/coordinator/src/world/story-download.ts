import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, statfs } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { crc32 } from "node:zlib";
import { openPromise, type Entry } from "yauzl";
import { readWorldMeta } from "./scan.js";

export interface StoryDownload {
  url: string;
  sha256: string;
  bytes: number;
  unpackedBytes: number;
  version: string;
  summary: string;
}

/** A build-pinned release, never a URL or digest supplied by a renderer. SPEC-016 R-6. */
export async function downloadStory(source: StoryDownload, scratchRoot: string, options: {
  signal: AbortSignal;
  progress?: (text: string) => void;
  fetch?: typeof fetch;
}): Promise<{ directory: string; dispose(): Promise<void> }> {
  if (!/^[a-f0-9]{64}$/.test(source.sha256) || !Number.isSafeInteger(source.bytes) || source.bytes <= 0 ||
      !Number.isSafeInteger(source.unpackedBytes) || source.unpackedBytes <= 0) throw new Error("Invalid story release descriptor.");
  await mkdir(scratchRoot, { recursive: true });
  const disk = await statfs(scratchRoot);
  if (disk.bavail * disk.bsize < source.bytes + source.unpackedBytes * 2 + 64 * 1024 * 1024) {
    throw new Error("Not enough disk space to download and install this story. Free space and try again.");
  }
  const container = await mkdtemp(join(scratchRoot, "story-download-"));
  const directory = join(container, "world"), archive = join(container, "story.zip");
  const dispose = () => rm(container, { recursive: true, force: true });
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(60 * 60 * 1000)]);
  try {
    let url = new URL(source.url), response: Response | undefined;
    for (let redirects = 0; redirects <= 5; redirects++) {
      if (url.protocol !== "https:" || url.username || url.password ||
          !["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(url.hostname)) {
        throw new Error("Story download redirected outside its release host.");
      }
      response = await (options.fetch ?? fetch)(url, { signal, redirect: "manual" });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location || redirects === 5) throw new Error("Story download redirect failed.");
      url = new URL(location, url);
    }
    if (!response?.ok || !response.body) throw new Error(`Story download failed (${response?.status ?? "no response"}). Try again when online.`);
    const length = response.headers.get("content-length");
    if (length !== null && Number(length) !== source.bytes) { await response.body.cancel(); throw new Error("Story download size differs from this release."); }
    let received = 0, lastPercent = -1;
    const digest = createHash("sha256");
    const measure = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > source.bytes) { callback(new Error("Story download exceeds its declared size.")); return; }
      digest.update(chunk);
      const percent = Math.floor(received * 100 / source.bytes);
      if (percent !== lastPercent) { lastPercent = percent; options.progress?.(`Downloading The Undersong… ${percent}%`); }
      callback(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body as never), measure, createWriteStream(archive, { flags: "wx" }), { signal });
    if (received !== source.bytes || digest.digest("hex") !== source.sha256) throw new Error("Story download failed its integrity check. Please retry.");
    options.progress?.("Verifying and unpacking The Undersong…");
    await mkdir(directory);
    const zip = await openPromise(archive, { autoClose: false, strictFileNames: true, validateEntrySizes: true });
    try {
      if (zip.entryCount > 20000) throw new Error("Story archive has too many files.");
      const entries: Entry[] = [], paths = new Map<string, { name: string; directory: boolean; explicit: boolean }>();
      let total = 0;
      for await (const entry of zip.eachEntry()) {
        signal.throwIfAborted();
        const dir = entry.fileName.endsWith("/"), name = dir ? entry.fileName.slice(0, -1) : entry.fileName;
        const parts = name.split("/"), kind = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (parts.length > 32 || /[\\:]/.test(name) || [...name].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) || parts.some(p => !p || p === "." || p === ".." || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)) ||
            (kind !== 0 && kind !== (dir ? 0o040000 : 0o100000)) || entry.isEncrypted() || ![0, 8].includes(entry.compressionMethod)) throw new Error("Unsafe story archive entry.");
        for (let i = 0; i < parts.length; i++) {
          const spelling = parts.slice(0, i + 1).join("/"), leaf = i === parts.length - 1, isDir = !leaf || dir, prior = paths.get(spelling.toLowerCase());
          if (prior && (prior.name !== spelling || prior.directory !== isDir || (leaf && prior.explicit))) throw new Error("Colliding story archive paths.");
          paths.set(spelling.toLowerCase(), { name: spelling, directory: isDir, explicit: leaf || prior?.explicit === true });
        }
        if (paths.size > 30000 || !Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 || (dir && entry.uncompressedSize !== 0) || entry.uncompressedSize > source.unpackedBytes - total) throw new Error("Story archive exceeds its extraction limit.");
        total += entry.uncompressedSize; entries.push(entry);
      }
      if (total !== source.unpackedBytes) throw new Error("Story archive expanded size differs from this release.");
      for (const entry of entries) {
        signal.throwIfAborted();
        const file = join(directory, entry.fileName);
        if (entry.fileName.endsWith("/")) { await mkdir(file, { recursive: true }); continue; }
        await mkdir(dirname(file), { recursive: true });
        let bytes = 0, crc = 0;
        const check = new Transform({ transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length; crc = crc32(chunk, crc);
          callback(bytes > entry.uncompressedSize ? new Error("Story entry exceeds its size.") : null, chunk);
        } });
        await pipeline(await zip.openReadStreamPromise(entry), check, createWriteStream(file, { flags: "wx" }), { signal });
        if (bytes !== entry.uncompressedSize || crc !== entry.crc32) throw new Error("Story entry integrity check failed.");
      }
    } finally { await new Promise<void>((resolve, reject) => { zip.once("close", resolve); zip.once("error", reject); zip.close(); }); }
    signal.throwIfAborted();
    await readWorldMeta(directory);
    options.progress?.("Installing your independent copy…");
    return { directory, dispose };
  } catch (error) { await dispose(); throw error; }
}
