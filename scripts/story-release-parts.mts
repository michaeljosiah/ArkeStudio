import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { basename } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { MAX_STORY_DOWNLOAD_PART_BYTES, MAX_STORY_DOWNLOAD_PARTS } from "../packages/coordinator/src/world/story-download.js";

/** Transport slices of one verified ZIP, not independently extractable archives. */
export async function splitStoryArchive(archive: string, expected: { bytes: number; sha256: string }, partBytes = MAX_STORY_DOWNLOAD_PART_BYTES) {
  if (!Number.isSafeInteger(partBytes) || partBytes <= 0 || partBytes > MAX_STORY_DOWNLOAD_PART_BYTES ||
      !Number.isSafeInteger(expected.bytes) || expected.bytes <= 0 || Math.ceil(expected.bytes / partBytes) > MAX_STORY_DOWNLOAD_PARTS ||
      !/^[a-f0-9]{64}$/.test(expected.sha256)) throw new Error("Invalid story archive part configuration.");
  const info = await lstat(archive);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== expected.bytes) throw new Error("Story archive changed before splitting.");
  const whole = createHash("sha256"), parts: Array<{ file: string; bytes: number; sha256: string }> = [];
  for (let start = 0; start < expected.bytes; start += partBytes) {
    const file = `${archive}.part-${String(parts.length + 1).padStart(3, "0")}`;
    const size = Math.min(partBytes, expected.bytes - start), digest = createHash("sha256");
    let bytes = 0;
    const measure = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length; whole.update(chunk); digest.update(chunk); callback(null, chunk);
    } });
    await pipeline(createReadStream(archive, { start, end: start + size - 1 }), measure, createWriteStream(file, { flags: "wx" }));
    if (bytes !== size) throw new Error("Story archive changed while splitting.");
    parts.push({ file: basename(file), bytes, sha256: digest.digest("hex") });
  }
  if (whole.digest("hex") !== expected.sha256 || (await lstat(archive)).size !== expected.bytes) throw new Error("Story archive changed while splitting.");
  return parts;
}
