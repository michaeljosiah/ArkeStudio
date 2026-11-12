import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, type ReadStream } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { openPromise } from "yauzl";
import { ZipFile } from "yazl";
import type { ManuscriptDocument } from "@arke-studio/contracts";
import { epubEntries, type EpubOptions } from "../productions/manuscript.js";
import { checkedPublicationPath, requirePublicationDigest } from "./files.js";
import { illustrationName, type StoryIllustration } from "./story-illustrations.js";

/** Hundreds of full-size pictures must not become several simultaneous copies of the whole book. */
export async function writeIllustratedEpub(document: ManuscriptDocument, options: Omit<EpubOptions, "illustrations">,
  illustrations: readonly StoryIllustration[], media: readonly { file: string; sha256: string; byteLength: number }[],
  inputRoot: string, destination: string, signal: AbortSignal): Promise<void> {
  const entries = epubEntries(document, { ...options, illustrations: illustrations.map(image => ({ ...image, bytes: new Uint8Array() })) });
  const sources = new Map(illustrations.map((image, index) => ["OEBPS/" + illustrationName(index, image), media.find(file => file.file === image.file)]));
  const stage = destination + "." + randomUUID() + ".tmp", zip = new ZipFile(), output = zip.outputStream as Readable;
  const cancelled = new AbortController(), operation = AbortSignal.any([signal, cancelled.signal]), streams = new Set<ReadStream>();
  zip.on("error", error => output.destroy(error));
  let complete = false;
  try {
    for (const entry of entries) {
      operation.throwIfAborted();
      if (!sources.has(entry.name)) { zip.addBuffer(Buffer.from(entry.data), entry.name, { compress: !entry.stored, mtime: new Date("2000-01-01T00:00:00Z"), forceDosTimestamp: true }); continue; }
      const source = sources.get(entry.name);
      if (!source) throw new Error("An illustration has no captured media receipt.");
      zip.addReadStreamLazy(entry.name, { size: source.byteLength, compress: false, mtime: new Date("2000-01-01T00:00:00Z"), forceDosTimestamp: true }, callback => {
        void checkedPublicationPath(inputRoot, source.file).then(path => {
          operation.throwIfAborted();
          const hash = createHash("sha256"); let byteLength = 0;
          const stream = createReadStream(path, { end: source.byteLength, signal: operation }); streams.add(stream);
          stream.once("close", () => streams.delete(stream));
          const check = new Transform({ transform(chunk: Buffer, _encoding, done) { hash.update(chunk); byteLength += chunk.length; done(null, chunk); },
            flush(done) { try { requirePublicationDigest({ sha256: hash.digest("hex"), byteLength }, source); done(); } catch (error) { done(error as Error); } } });
          stream.on("error", error => check.destroy(error)); check.on("error", error => { stream.destroy(); output.destroy(error); });
          callback(null, stream.pipe(check));
        }).catch(error => callback(error, Readable.from([])));
      });
    }
    zip.end();
    await pipeline(output, createWriteStream(stage, { flags: "wx" }), { signal: operation });
    const handle = await open(stage, "r+");
    try { await handle.sync(); } finally { await handle.close(); }
    operation.throwIfAborted(); complete = true;
  } finally {
    output.destroy(); cancelled.abort();
    await Promise.all([...streams].map(stream => new Promise<void>(resolve => { if (stream.closed) { resolve(); return; } stream.once("close", resolve); stream.destroy(); })));
    if (!complete) await rm(stage, { force: true });
  }
  try { signal.throwIfAborted(); await rename(stage, destination); }
  finally { await rm(stage, { force: true }); }
}

/** Read just the requested XHTML/CSS parts from a large illustrated edition, bounded independently. */
export async function readEpubPreview(path: string, chapter: number): Promise<{ page: string; css: string }> {
  const wanted = new Map([[`OEBPS/chapter-${chapter + 1}.xhtml`, "page"], ["OEBPS/style.css", "css"]]);
  const result: Record<string, string> = {};
  const zip = await openPromise(path, { autoClose: false, strictFileNames: true, validateEntrySizes: true });
  try {
    for await (const entry of zip.eachEntry()) {
      const key = wanted.get(entry.fileName); if (!key) continue;
      if (result[key] !== undefined || entry.uncompressedSize > 4_000_000) throw new Error("The captured book page is too large or duplicated.");
      const input = await zip.openReadStreamPromise(entry), parts: Buffer[] = []; let bytes = 0;
      for await (const chunk of input) { bytes += chunk.length; if (bytes > 4_000_000) { input.destroy(); throw new Error("The captured book page is too large."); } parts.push(chunk); }
      result[key] = Buffer.concat(parts).toString("utf8");
    }
  } finally { await new Promise<void>(resolve => { if (!zip.isOpen) { resolve(); return; } zip.once("close", resolve); zip.close(); }); }
  if (result.page === undefined || result.css === undefined) throw new Error("The captured book page is incomplete.");
  return { page: result.page, css: result.css };
}
