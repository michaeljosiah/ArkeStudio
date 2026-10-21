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

export interface StoryDownload {
  url: string;
  sha256: string;
  bytes: number;
  unpackedBytes: number;
  version: string;
  summary: string;
}

function archivePath(source: StoryDownload, scratchRoot: string): string {
  if (!/^[a-f0-9]{64}$/.test(source.sha256)) throw new Error("Invalid story release descriptor.");
  storyDownloadRequiredBytes(source);
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
}): Promise<{ directory: string; dispose(): Promise<void> }> {
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
  const dispose = async () => { await clearScratch(); await discardStoryDownload(source, scratchRoot); };
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
    if (received < source.bytes) {
      let url = new URL(source.url), response: Response | undefined;
      for (let redirects = 0; redirects <= 5; redirects++) {
        if (url.protocol !== "https:" || url.username || url.password ||
            !["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(url.hostname)) {
          throw invalid("Story download redirected outside its release host.");
        }
        resetIdle();
        response = await (options.fetch ?? fetch)(url, { signal, redirect: "manual", ...(received ? { headers: { Range: `bytes=${received}-` } } : {}) });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location || redirects === 5) throw new Error("Story download redirect failed.");
        url = new URL(location, url);
      }
      if (!response?.ok || !response.body) {
        await response?.body?.cancel();
        throw new Error(`Story download failed (${response?.status ?? "no response"}). Try again when online.`);
      }
      // Like local setup, append only a complete, explicitly bounded remainder. A server that
      // ignores Range may send 200; start over, never append its full response to retained bytes.
      if (response.status === 200) received = 0;
      else if (received && response.status === 206) {
        const range = response.headers.get("content-range")?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
        if (!range || Number(range[1]) !== received || Number(range[2]) !== source.bytes - 1 || Number(range[3]) !== source.bytes) {
          await response.body.cancel(); throw invalid("Story download resume range differs from this release. Please retry.");
        }
      } else { await response.body.cancel(); throw invalid("Story download returned an unexpected response. Please retry."); }
      const length = response.headers.get("content-length");
      if (length !== null && Number(length) !== source.bytes - received) { await response.body.cancel(); throw invalid("Story download size differs from this release."); }
      let lastPercent = -1;
      options.progress?.(`${received ? "Resuming" : "Downloading"} The Undersong… ${Math.floor(received * 100 / source.bytes)}%`);
      const measure = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        resetIdle();
        received += chunk.length;
        if (received > source.bytes) { callback(invalid("Story download exceeds its declared size.")); return; }
        const percent = Math.floor(received * 100 / source.bytes);
        if (percent !== lastPercent) { lastPercent = percent; options.progress?.(`Downloading The Undersong… ${percent}%`); }
        callback(null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body as never), measure, createWriteStream(archive, { flags: received ? "a" : "w" }), { signal });
      clearTimeout(idleTimer);
      idleTimer = undefined; // Extraction has caller cancellation, not the network idle deadline.
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
export async function cleanupStoryDownload(download: { dispose(): Promise<void> } | undefined): Promise<boolean> {
  try { await download?.dispose(); return true; }
  catch { return false; }
}
