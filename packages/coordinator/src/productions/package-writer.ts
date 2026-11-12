import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { atomicWriteFile } from "../world/atomic.js";
import { toExtendedLength } from "../world/paths.js";

/**
 * One way to make a package in staging (issue 2803).
 *
 * The exporters each staged, copied, hashed and checked their packages their own way, and most
 * read every file whole into memory twice on the way: once to hash it for the manifest, and again
 * to check it against that manifest before the package was named. Here a copy is hashed while it
 * streams — one read of the source, nothing held whole — and the check reads a file again only if
 * it is no longer the file that was written.
 *
 * Nothing here takes the world's gate. A package is made outside it and moved into place under
 * it, so the exporter decides what to read again there and holds the gate for little more than
 * the rename.
 */

/** One file a package carries: its path inside the package, full SHA-256 in hex, and size. */
export interface PackedFile {
  readonly file: string;
  readonly sha256: string;
  readonly bytes: number;
}

/** Stream a file once and hash it; nothing is held whole. */
export async function hashFile(path: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(toExtendedLength(path))) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  return { sha256: hash.digest("hex"), bytes };
}

/** Which file this is on disk, to the nanosecond it was last written. */
async function identityOf(path: string): Promise<string> {
  const found = await stat(toExtendedLength(path), { bigint: true });
  return `${found.dev}:${found.ino}:${found.size}:${found.mtimeNs}`;
}

export class PackageWriter {
  private readonly written = new Map<string, PackedFile & { identity: string }>();

  private constructor(readonly dir: string) {}

  /** An empty staging folder: whatever an interrupted export left there is not this package. */
  static async stage(dir: string): Promise<PackageWriter> {
    await rm(toExtendedLength(dir), { recursive: true, force: true });
    await mkdir(toExtendedLength(dir), { recursive: true });
    return new PackageWriter(dir);
  }

  /** Copy a file in, hashing what is written as it streams. */
  async copyIn(source: string, file: string): Promise<PackedFile> {
    const target = join(this.dir, file);
    await mkdir(toExtendedLength(dirname(target)), { recursive: true });
    const hash = createHash("sha256");
    let bytes = 0;
    await pipeline(
      createReadStream(toExtendedLength(source)),
      new Transform({ transform(chunk: Buffer, _encoding, done) { hash.update(chunk); bytes += chunk.length; done(null, chunk); } }),
      createWriteStream(toExtendedLength(target)),
    );
    return this.record(file, hash.digest("hex"), bytes);
  }

  /** Take in a file something else wrote into staging — an encoder's output — reading it once. */
  async adopt(file: string): Promise<PackedFile> {
    const { sha256, bytes } = await hashFile(join(this.dir, file));
    return this.record(file, sha256, bytes);
  }

  /** A text file of the package's own, such as its page or manifest; not one of `files()`. */
  async writeText(file: string, text: string): Promise<number> {
    await atomicWriteFile(join(this.dir, file), text);
    return Buffer.byteLength(text);
  }

  /** Every file copied in or adopted, in the order a manifest lists them. */
  files(): PackedFile[] {
    return [...this.written.values()]
      .map(({ file, sha256, bytes }) => ({ file, sha256, bytes }))
      .sort((a, b) => a.file.localeCompare(b.file));
  }

  /**
   * A staged file's hash as it stands now, for the read-back before a package is named: the one
   * taken while it was written, if it is still that file, and otherwise read again.
   */
  async currentSha256(file: string): Promise<string> {
    const path = join(this.dir, file);
    const recorded = this.written.get(file);
    if (recorded !== undefined && recorded.identity === await identityOf(path)) return recorded.sha256;
    return (await hashFile(path)).sha256;
  }

  /** Move the staged package to `target`. Called under the world's gate; it is the only work there. */
  async commit(target: string): Promise<void> {
    await mkdir(toExtendedLength(dirname(target)), { recursive: true });
    await rename(toExtendedLength(this.dir), toExtendedLength(target));
  }

  private async record(file: string, sha256: string, bytes: number): Promise<PackedFile> {
    this.written.set(file, { file, sha256, bytes, identity: await identityOf(join(this.dir, file)) });
    return { file, sha256, bytes };
  }
}
