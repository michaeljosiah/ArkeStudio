import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { toExtendedLength } from "../world/paths.js";

export class PublicationFileError extends Error {
  constructor(readonly code: "unsafe-path" | "limit-exceeded" | "source-changed" | "invalid-package" |
    "invalid-manifest" | "unsupported-schema" | "unsupported-profile" | "unsupported-capability", message: string) {
    super(message);
    this.name = "PublicationFileError";
  }
}

export interface PublicationFileDigest { sha256: string; byteLength: number }

/** Check every component; checking only the leaf misses a junction in an ancestor. */
export async function checkedPublicationPath(root: string, portable: string): Promise<string> {
  const segments = portable.split("/");
  if (isAbsolute(portable) || /[\\:]/.test(portable) || [...portable].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
      segments.some(part => !part || part === "." || part === ".." || /[. ]$/.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new PublicationFileError("unsafe-path", "Publication source has an unsafe relative path.");
  }
  const base = await realpath(toExtendedLength(root));
  let cursor = base;
  for (let index = 0; index < segments.length; index++) {
    cursor = join(cursor, segments[index]!);
    const info = await lstat(toExtendedLength(cursor));
    if (info.isSymbolicLink() || (index < segments.length - 1 ? !info.isDirectory() : !info.isFile())) {
      throw new PublicationFileError("unsafe-path", "Publication sources must be regular files without linked parents.");
    }
    const rel = relative(base, await realpath(toExtendedLength(cursor)));
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
      throw new PublicationFileError("unsafe-path", "Publication source escapes its root.");
    }
  }
  return cursor;
}

function unchanged(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
    before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

/**
 * Stream through a fixed buffer, optionally copying into an already exclusive destination.
 * Stat and identity checks detect ordinary concurrent replacement; portable path checks are
 * not an OS sandbox against a process actively swapping directory ancestors (SPEC-002).
 */
export async function readPublicationFile(
  root: string, portable: string, maxBytes: number, signal?: AbortSignal,
  destination?: FileHandle, collect?: Buffer[],
): Promise<PublicationFileDigest & { assertUnchanged(): Promise<void> }> {
  signal?.throwIfAborted();
  const path = await checkedPublicationPath(root, portable);
  const before = await lstat(toExtendedLength(path));
  if (!Number.isSafeInteger(before.size) || before.size > maxBytes) {
    throw new PublicationFileError("limit-exceeded", "Publication file exceeds its byte limit.");
  }
  const assertUnchanged = async () => {
    signal?.throwIfAborted();
    const afterPath = await checkedPublicationPath(root, portable);
    if (afterPath !== path || !unchanged(before, await lstat(toExtendedLength(afterPath)))) {
      throw new PublicationFileError("source-changed", "Publication source changed since it was read.");
    }
  };
  const file = await open(toExtendedLength(path), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!unchanged(before, await file.stat())) throw new PublicationFileError("source-changed", "Publication source changed while opening.");
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(1024 * 1024);
    let length = 0;
    while (true) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      length += bytesRead;
      if (length > maxBytes) throw new PublicationFileError("limit-exceeded", "Publication file grew past its byte limit.");
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      if (collect) collect.push(Buffer.from(chunk));
      if (destination) {
        let written = 0;
        while (written < bytesRead) {
          signal?.throwIfAborted();
          const result = await destination.write(chunk, written, bytesRead - written, null);
          if (!result.bytesWritten) throw new Error("Publication copy made no progress.");
          written += result.bytesWritten;
        }
      }
    }
    signal?.throwIfAborted();
    if (length !== before.size || !unchanged(before, await file.stat())) {
      throw new PublicationFileError("source-changed", "Publication source changed while reading.");
    }
    await assertUnchanged();
    return { sha256: hash.digest("hex"), byteLength: length, assertUnchanged };
  } finally {
    await file.close();
  }
}

export function requirePublicationDigest(actual: PublicationFileDigest, expected: { sha256: string; byteLength?: number }): void {
  if (actual.sha256 !== expected.sha256 || (expected.byteLength !== undefined && actual.byteLength !== expected.byteLength)) {
    throw new PublicationFileError("source-changed", "Publication file no longer matches its declared hash or length.");
  }
}
