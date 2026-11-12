import type { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { ZipFile } from "yazl";

/**
 * The manuscript's `.docx` and EPUB as zips in memory (design turn 131, SPEC-012 R-52), written
 * by yazl as every other archive here is. They were written by hand once, as the reader in
 * `document-text.ts` reads them; a second hand-rolled writer was one more copy of the format to
 * keep right, and yazl writes the one thing OCF asks of an EPUB's `mimetype` — no extra field in
 * its local header — whatever the options.
 */
export interface ZipEntry {
  /** The entry's path inside the zip, `/`-separated. */
  name: string;
  data: Uint8Array;
  /**
   * Stored rather than deflated: an EPUB's `mimetype` must be the first entry and stored, so a
   * reader can check it by byte offset, and a picture is already as small as deflate makes it.
   */
  stored?: boolean;
}

// One fixed timestamp, local midnight on DOS time's first day because yazl writes local time:
// a manuscript's date is in its words, not in its container, and a file that differs only by
// clock is a file that cannot be compared. No Unix timestamp either, so no extra field anywhere.
const ENTRY_TIME = { mtime: new Date(1980, 0, 1), forceDosTimestamp: true };

export async function writeZip(entries: readonly ZipEntry[]): Promise<Uint8Array> {
  const zip = new ZipFile(), output = zip.outputStream as Readable;
  // yazl reports a failed deflate on the zip, not on its stream, which would then never end.
  zip.on("error", (error) => output.destroy(error));
  for (const entry of entries) zip.addBuffer(Buffer.from(entry.data), entry.name, { ...ENTRY_TIME, compress: !entry.stored });
  zip.end();
  return new Uint8Array(await buffer(output));
}
