import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, open, rm, statfs } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { crc32 } from "node:zlib";
import { openPromise, type Entry } from "yauzl";
import { readWorldMeta } from "./scan.js";
import { storyDownloadRequiredBytes } from "@arke-studio/contracts";

export interface StoryDownloadPart {
  url: string;
  sha256: string;
  bytes: number;
}

export const MAX_STORY_DOWNLOAD_PART_BYTES = 1024 ** 3;
export const MAX_STORY_DOWNLOAD_PARTS = 1000;

export type StoryDownload = {
  sha256: string;
  bytes: number;
  unpackedBytes: number;
  version: string;
  summary: string;
} & ({ url: string; parts?: never } | { url?: never; parts: readonly StoryDownloadPart[] });

function releaseUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password ||
      !["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(url.hostname)) {
    throw new Error("Story download redirected outside its release host.");
  }
  return url;
}

function downloadParts(source: StoryDownload): readonly StoryDownloadPart[] {
  if (typeof source.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(source.sha256)) throw new Error("Invalid story release descriptor.");
  storyDownloadRequiredBytes(source);
  if (source.parts === undefined) {
    if (typeof source.url !== "string") throw new Error("Invalid story release URL.");
    releaseUrl(source.url);
    return [{ url: source.url, bytes: source.bytes, sha256: source.sha256 }];
  }
  if (source.url !== undefined || !Array.isArray(source.parts) || source.parts.length < 1 || source.parts.length > MAX_STORY_DOWNLOAD_PARTS) throw new Error("Invalid story release parts.");
  let bytes = 0;
  for (const part of source.parts) {
    if (!part || typeof part.url !== "string" || typeof part.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(part.sha256) || !Number.isSafeInteger(part.bytes) || part.bytes <= 0 || part.bytes > MAX_STORY_DOWNLOAD_PART_BYTES) throw new Error("Invalid story release part.");
    releaseUrl(part.url);
    bytes += part.bytes;
    if (!Number.isSafeInteger(bytes) || bytes > source.bytes) throw new Error("Story release parts differ from its declared size.");
  }
  if (bytes !== source.bytes) throw new Error("Story release parts differ from its declared size.");
  return source.parts;
}

function archivePath(source: StoryDownload, scratchRoot: string): string {
  downloadParts(source);
  return join(scratchRoot, `story-${source.sha256}.part`);
}

export async function inspectStoryDownload(source: StoryDownload, scratchRoot: string) {
  const info = await lstat(archivePath(source, scratchRoot)).catch(() => null);
  const retainedBytes = info?.isFile() && !info.isSymbolicLink() && info.size <= source.bytes ? info.size : 0;
  const disk = await statfs(scratchRoot).catch(() => statfs(dirname(scratchRoot))).catch(() => null);
  return { retainedBytes, hasRetainedData: info !== null, requiredBytes: storyDownloadRequiredBytes(source, retainedBytes), freeBytes: disk ? disk.bavail * disk.bsize : null };
}

/** Only the currently pinned archive is owned here; never sweep other releases or user files. */
export async function discardStoryDownload(source: StoryDownload, scratchRoot: string): Promise<void> {
  await rm(archivePath(source, scratchRoot), { force: true });
}

/** A build-pinned release, never a URL or digest supplied by a renderer. SPEC-016 R-6. */
export async function downloadStory(source: StoryDownload, scratchRoot: string, options: {
  signal: AbortSignal;
  progress?: (text: string) => void;
  fetch?: typeof fetch;
}): Promise<{ directory: string; dispose(options?: { keepArchive?: boolean }): Promise<void> }> {
  const archive = archivePath(source, scratchRoot);
  options.signal.throwIfAborted();
  await mkdir(scratchRoot, { recursive: true });
  const partial = await lstat(archive).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (partial && (!partial.isFile() || partial.isSymbolicLink() || partial.size > source.bytes)) throw new Error("The retained story download is invalid. Remove downloaded data and try again.");
  const space = await inspectStoryDownload(source, scratchRoot);
  if (space.freeBytes === null) throw new Error("Could not check free disk space for the story download.");
  if (space.freeBytes < space.requiredBytes) {
    throw new Error("Not enough disk space to download and install this story. Free space and try again.");
  }
  const container = await mkdtemp(join(scratchRoot, "story-download-"));
  const directory = join(container, "world");
  const clearScratch = () => rm(container, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  const dispose = async (options?: { keepArchive?: boolean }) => { await clearScratch(); if (!options?.keepArchive) await discardStoryDownload(source, scratchRoot); };
  let keepPartial = true, verified = false;
  const invalid = (message: string) => { keepPartial = false; return new Error(message); };
  // Bound stalled transfers, not the total time a slow connection needs for a large story.
  const idle = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => idle.abort(new Error("Story download made no progress for three minutes. Please retry.")), 180_000);
    idleTimer.unref();
  };
  const signal = AbortSignal.any([options.signal, idle.signal]);
  try {
    let received = space.retainedBytes;
    let start = 0;
    for (const part of downloadParts(source)) {
      signal.throwIfAborted();
      const end = start + part.bytes;
      if (received < end) {
        let offset = Math.max(0, received - start);
        let url = releaseUrl(part.url), response: Response | undefined;
        for (let redirects = 0; redirects <= 5; redirects++) {
          resetIdle();
          response = await (options.fetch ?? fetch)(url, { signal, redirect: "manual", ...(offset ? { headers: { Range: `bytes=${offset}-` } } : {}) });
          if (![301, 302, 303, 307, 308].includes(response.status)) break;
          const location = response.headers.get("location");
          await response.body?.cancel();
          if (!location || redirects === 5) throw new Error("Story download redirect failed.");
          try { url = releaseUrl(new URL(location, url).href); }
          catch { throw invalid("Story download redirected outside its release host."); }
        }
        if (!response?.ok || !response.body) {
          await response?.body?.cancel();
          throw new Error(`Story download failed (${response?.status ?? "no response"}). Try again when online.`);
        }
        // A host may ignore Range. Replace only this part; completed, verified parts stay intact.
        if (response.status === 200) offset = 0;
        else if (offset && response.status === 206) {
          const range = response.headers.get("content-range")?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
          if (!range || Number(range[1]) !== offset || Number(range[2]) !== part.bytes - 1 || Number(range[3]) !== part.bytes) {
            await response.body.cancel(); throw invalid("Story download resume range differs from this release. Please retry.");
          }
        } else { await response.body.cancel(); throw invalid("Story download returned an unexpected response. Please retry."); }
        const length = response.headers.get("content-length");
        if (length !== null && Number(length) !== part.bytes - offset) { await response.body.cancel(); throw invalid("Story download size differs from this release."); }
        if (received > start + offset) {
          const handle = await open(archive, "r+");
          try { await handle.truncate(start + offset); } finally { await handle.close(); }
        }
        received = start + offset;
        let lastPercent = -1;
        options.progress?.(`${offset ? "Resuming" : "Downloading"} The Undersong… ${Math.floor(received * 100 / source.bytes)}%`);
        const measure = new Transform({ transform(chunk: Buffer, _encoding, callback) {
          resetIdle();
          received += chunk.length;
          if (received > end) { callback(invalid("Story download exceeds its declared size.")); return; }
          const percent = Math.floor(received * 100 / source.bytes);
          if (percent !== lastPercent) { lastPercent = percent; options.progress?.(`Downloading The Undersong… ${percent}%`); }
          callback(null, chunk);
        } });
        await pipeline(Readable.fromWeb(response.body as never), measure, createWriteStream(archive, { flags: received ? "a" : "w" }), { signal });
        clearTimeout(idleTimer);
        idleTimer = undefined; // Disk verification and extraction have caller cancellation only.
        if (received !== end) throw new Error("Story download was interrupted. Resume to finish it.");
      }
      // Recheck retained completed parts before fetching more. Never trust a cached prefix.
      if (source.parts) {
        options.progress?.("Verifying The Undersong…");
        const digest = createHash("sha256");
        for await (const chunk of createReadStream(archive, { start, end: end - 1, signal })) digest.update(chunk);
        if (digest.digest("hex") !== part.sha256) throw invalid("Story download part failed its integrity check. Please retry.");
      }
      start = end;
    }
    if (received !== source.bytes) throw new Error("Story download was interrupted. Resume to finish it.");
    options.progress?.("Verifying The Undersong…");
    // A retained prefix is never trusted. Hash all bytes, including the prefix, on every attempt.
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(archive, { signal })) digest.update(chunk);
    if (digest.digest("hex") !== source.sha256) throw invalid("Story download failed its integrity check. Please retry.");
    verified = true; keepPartial = false;
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
  } catch (error) {
    await clearScratch().catch(() => {});
    if (verified && options.signal.aborted) keepPartial = true;
    const file = await lstat(archive).catch(() => null);
    if (keepPartial && file?.isFile() && file.size > 0 && file.size <= source.bytes) {
      const handle = await open(archive, "r+");
      try { await handle.sync(); } finally { await handle.close(); }
    } else await discardStoryDownload(source, scratchRoot).catch(() => {});
    throw error;
  }
  finally { clearTimeout(idleTimer); }
}

/** Cleanup cannot turn an already installed world into a failed command. */
export async function cleanupStoryDownload(download: { dispose(options?: { keepArchive?: boolean }): Promise<void> } | undefined, options?: { keepArchive?: boolean }): Promise<boolean> {
  try { await download?.dispose(options); return true; }
  catch { return false; }
}
