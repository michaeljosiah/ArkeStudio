import { createReadStream, createWriteStream, type ReadStream } from "node:fs";
import { mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { crc32 } from "node:zlib";
import { openPromise, type Entry } from "yauzl";
import { ZipFile } from "yazl";
import { PUBLICATION_MANIFEST_FILE, PublicationAssetPathSchema } from "@arke-studio/contracts";
import { toExtendedLength } from "../world/paths.js";
import { checkedPublicationPath, PublicationFileError, readPublicationFile, requirePublicationDigest } from "./files.js";
import { publicationFileLimits, verifyPublicationDirectory, type PublicationFileLimits, type VerifiedPublicationDirectory } from "./verify.js";

export interface PublicationArchiveOptions {
  signal?: AbortSignal;
  limits?: Partial<PublicationFileLimits>;
}

export interface ExtractedPublication extends VerifiedPublicationDirectory {
  /** Removes the owned extraction and pinned archive, never the caller's ZIP. */
  dispose(): Promise<void>;
}

// Media is already compressed. This also leaves room for bounded ZIP64 headers/central records.
export function publicationArchiveByteLimit(limits: Partial<PublicationFileLimits> = {}): number {
  return Math.min(Number.MAX_SAFE_INTEGER, publicationFileLimits(limits).totalBytes + 16 * 1024 * 1024);
}

/** Copy only verified inventory files; the receiving tree is newly allocated by this call. */
export async function copyPublicationDirectory(source: string, destination: string, options: PublicationArchiveOptions = {}): Promise<VerifiedPublicationDirectory> {
  const verified = await verifyPublicationDirectory(source, options);
  const limits = publicationFileLimits(options.limits);
  await mkdir(toExtendedLength(destination));
  try {
    const files = [[PUBLICATION_MANIFEST_FILE, { sha256: verified.manifestSha256, byteLength: limits.manifestBytes }],
      ...Object.values(verified.manifest.assets).map(asset => [asset.href, asset] as const)] as const;
    for (const [href, expected] of files) {
      options.signal?.throwIfAborted();
      const target = join(destination, href);
      await mkdir(toExtendedLength(dirname(target)), { recursive: true });
      const handle = await open(toExtendedLength(target), "wx");
      try {
        const actual = await readPublicationFile(verified.directory, href, expected.byteLength, options.signal, handle);
        requirePublicationDigest(actual, href === PUBLICATION_MANIFEST_FILE ? { sha256: expected.sha256 } : expected);
        await handle.sync();
      } finally { await handle.close(); }
    }
    const copied = await verifyPublicationDirectory(destination, options);
    if (copied.manifestSha256 !== verified.manifestSha256) throw new PublicationFileError("source-changed", "Publication changed while copying.");
    return copied;
  } catch (error) {
    await rm(toExtendedLength(destination), { recursive: true, force: true });
    throw error;
  }
}

/** Streaming ZIP64 writer. The destination must be absent; callers promote only after verification. */
export async function writePublicationZip(directory: string, destination: string, options: PublicationArchiveOptions = {}): Promise<void> {
  const verified = await verifyPublicationDirectory(directory, options);
  const manifest = await readPublicationFile(verified.directory, PUBLICATION_MANIFEST_FILE, publicationFileLimits(options.limits).manifestBytes, options.signal);
  requirePublicationDigest(manifest, { sha256: verified.manifestSha256 });
  const files = [[PUBLICATION_MANIFEST_FILE, manifest.byteLength], ...Object.values(verified.manifest.assets)
    .sort((a, b) => a.href < b.href ? -1 : 1).map(asset => [asset.href, asset.byteLength] as const)] as const;
  const zip = new ZipFile();
  const output = zip.outputStream as Readable;
  const streams = new Set<ReadStream>();
  const cancelled = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, cancelled.signal]) : cancelled.signal;
  zip.on("error", error => output.destroy(error));
  const handle = await open(toExtendedLength(destination), "wx");
  let complete = false;
  try {
    for (const [href, size] of files) {
      zip.addReadStreamLazy(href, { size, compress: false, mtime: new Date("2000-01-01T00:00:00Z"), mode: 0o100644 }, callback => {
        void checkedPublicationPath(verified.directory, href).then(path => {
          signal.throwIfAborted();
          // Read at most one byte beyond the declaration: yazl detects a changed length without
          // allowing a concurrently growing source to fill the destination filesystem.
          const stream = createReadStream(toExtendedLength(path), { flags: "r", end: size, signal });
          streams.add(stream);
          stream.once("close", () => streams.delete(stream));
          callback(null, stream);
        }).catch(error => callback(error, Readable.from([])));
      });
    }
    zip.end();
    await pipeline(output, createWriteStream(toExtendedLength(destination), { fd: handle.fd, autoClose: false, emitClose: false }), { signal });
    await handle.sync();
    signal.throwIfAborted();
    complete = true;
  } finally {
    output.destroy();
    cancelled.abort();
    await Promise.all([...streams].map(stream => new Promise<void>(resolve => {
      if (stream.closed) { resolve(); return; }
      stream.once("close", resolve); stream.destroy();
    })));
    await handle.close();
    if (!complete) await rm(toExtendedLength(destination), { force: true });
  }
}

/** Pin the ZIP, validate every central entry before extraction, then verify the portable tree. */
export async function extractPublicationZip(archive: string, scratchRoot: string, options: PublicationArchiveOptions = {}): Promise<ExtractedPublication> {
  const limits = publicationFileLimits(options.limits);
  options.signal?.throwIfAborted();
  const scratch = await realpath(toExtendedLength(scratchRoot));
  const container = await mkdtemp(toExtendedLength(join(scratch, "arke-publication-unzip-")));
  const directory = join(container, "publication");
  const pinned = join(container, "source.zip");
  let disposed = false;
  const dispose = async () => {
    if (!disposed) { await rm(toExtendedLength(container), { recursive: true, force: true }); disposed = true; }
  };
  try {
    const copy = await open(toExtendedLength(pinned), "wx");
    try { await readPublicationFile(dirname(archive), basename(archive), publicationArchiveByteLimit(limits), options.signal, copy); }
    finally { await copy.close(); }
    const zip = await openPromise(toExtendedLength(pinned), { autoClose: false, strictFileNames: true, validateEntrySizes: true });
    try {
      if (zip.entryCount > limits.entries) throw new PublicationFileError("limit-exceeded", "Publication ZIP has too many entries.");
      const entries: Entry[] = [];
      const paths = new Map<string, { spelling: string; directory: boolean; explicit: boolean }>();
      let total = 0;
      for await (const entry of zip.eachEntry()) {
        options.signal?.throwIfAborted();
        if (entries.length >= limits.entries) throw new PublicationFileError("limit-exceeded", "Publication ZIP has too many entries.");
        const isDirectory = entry.fileName.endsWith("/");
        const name = isDirectory ? entry.fileName.slice(0, -1) : entry.fileName;
        if ((name !== PUBLICATION_MANIFEST_FILE && !PublicationAssetPathSchema.safeParse(name).success) ||
            (name === PUBLICATION_MANIFEST_FILE && isDirectory) || name.split("/").length > 32) {
          throw new PublicationFileError("unsafe-path", "Publication ZIP contains an unsafe entry path.");
        }
        const kind = (entry.externalFileAttributes >>> 16) & 0o170000;
        if ((kind !== 0 && kind !== (isDirectory ? 0o040000 : 0o100000)) ||
            ((entry.externalFileAttributes & 0x10) !== 0 && !isDirectory) || entry.isEncrypted() || ![0, 8].includes(entry.compressionMethod)) {
          throw new PublicationFileError("unsafe-path", "Publication ZIP contains a link, special file or unsupported encoding.");
        }
        const segments = name.split("/");
        for (let index = 0; index < segments.length; index++) {
          const path = segments.slice(0, index + 1).join("/");
          const leaf = index === segments.length - 1;
          const directory = !leaf || isDirectory;
          const prior = paths.get(path.toLowerCase());
          if (prior && (prior.spelling !== path || prior.directory !== directory || (leaf && prior.explicit))) {
            throw new PublicationFileError("unsafe-path", "Publication ZIP contains duplicate or colliding paths.");
          }
          paths.set(path.toLowerCase(), { spelling: path, directory, explicit: leaf || prior?.explicit === true });
          if (paths.size > limits.entries) throw new PublicationFileError("limit-exceeded", "Publication ZIP has too many paths.");
        }
        const bound = name === PUBLICATION_MANIFEST_FILE ? limits.manifestBytes : limits.assetBytes;
        if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 || entry.uncompressedSize > bound ||
            entry.uncompressedSize > limits.totalBytes - total || (isDirectory && entry.uncompressedSize !== 0)) {
          throw new PublicationFileError("limit-exceeded", "Publication ZIP exceeds its declared extraction limits.");
        }
        total += entry.uncompressedSize;
        entries.push(entry);
      }
      await mkdir(toExtendedLength(directory));
      for (const entry of entries) {
        options.signal?.throwIfAborted();
        const path = join(directory, entry.fileName);
        if (entry.fileName.endsWith("/")) { await mkdir(toExtendedLength(path), { recursive: true }); continue; }
        await mkdir(toExtendedLength(dirname(path)), { recursive: true });
        let bytes = 0, checksum = 0;
        const measure = new Transform({ transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > entry.uncompressedSize) { callback(new PublicationFileError("limit-exceeded", "ZIP entry expanded beyond its declaration.")); return; }
          checksum = crc32(chunk, checksum);
          callback(null, chunk);
        } });
        await pipeline(await zip.openReadStreamPromise(entry), measure, createWriteStream(toExtendedLength(path), { flags: "wx" }), { signal: options.signal });
        if (bytes !== entry.uncompressedSize || checksum !== entry.crc32) throw new PublicationFileError("invalid-package", "ZIP entry length or CRC does not match.");
      }
    } finally {
      // yauzl owns the descriptor. Wait for closure before disposing its pinned file on Windows.
      await new Promise<void>((resolve, reject) => { zip.once("close", resolve); zip.once("error", reject); zip.close(); });
    }
    const verified = await verifyPublicationDirectory(directory, options);
    return { ...verified, dispose };
  } catch (error) {
    await dispose();
    if (error instanceof PublicationFileError || (error instanceof Error && error.name === "AbortError") ||
        /^(?:ENOENT|EACCES|EPERM|EIO|ENOSPC|EMFILE|ENFILE|EBUSY)$/.test((error as NodeJS.ErrnoException).code ?? "")) throw error;
    throw new PublicationFileError("invalid-package", "Publication ZIP is malformed or uses an unsupported encoding.");
  }
}
