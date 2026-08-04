import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { imageFormatOf } from "../queue/verify.js";
import { toExtendedLength } from "./paths.js";

const MAX_REFERENCES = 16;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024 - 1;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;

export interface WorldImageReference {
  name: string;
  contentType: "image/png" | "image/jpeg" | "image/webp";
  data: Uint8Array;
}

export class WorldReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorldReferenceError";
  }
}

function validatePortablePath(path: string): string[] {
  if (
    path.length === 0 ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.includes(":") ||
    isAbsolute(path)
  ) {
    throw new WorldReferenceError("image reference path is invalid");
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new WorldReferenceError("image reference path is invalid");
  }
  return segments;
}

function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export async function readContainedImageReferences(
  worldDir: string,
  paths: readonly string[],
): Promise<WorldImageReference[]> {
  if (paths.length > MAX_REFERENCES) throw new WorldReferenceError("at most 16 image references are supported");
  const root = await realpath(toExtendedLength(worldDir));
  const results: WorldImageReference[] = [];
  let totalBytes = 0;
  for (const [index, portable] of paths.entries()) {
    const segments = validatePortablePath(portable);
    let cursor = root;
    let validatedFile: Awaited<ReturnType<typeof lstat>> | null = null;
    for (const segment of segments) {
      cursor = join(cursor, segment);
      const info = await lstat(toExtendedLength(cursor)).catch(() => null);
      if (!info) throw new WorldReferenceError("an image reference is missing");
      if (info.isSymbolicLink()) throw new WorldReferenceError("linked image references are not allowed");
      validatedFile = info;
    }
    const resolved = await realpath(toExtendedLength(cursor));
    if (!contained(root, resolved)) throw new WorldReferenceError("image reference escapes the world");
    const handle = await open(toExtendedLength(resolved), "r");
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new WorldReferenceError("image reference is not a file");
      if (!validatedFile || info.dev !== validatedFile.dev || info.ino !== validatedFile.ino) {
        throw new WorldReferenceError("image reference changed during preparation");
      }
      if (info.size > MAX_IMAGE_BYTES) throw new WorldReferenceError("image reference exceeds OpenAI's 50 MB limit");
      totalBytes += info.size;
      if (totalBytes > MAX_TOTAL_BYTES) throw new WorldReferenceError("image references exceed OpenAI's 512 MB request limit");
      const data = Uint8Array.from(await handle.readFile());
      const format = imageFormatOf(data);
      if (!format) throw new WorldReferenceError("image reference must be a valid PNG, JPEG, or WebP file");
      results.push({
        name: `reference-${String(index + 1).padStart(2, "0")}${format.extension}`,
        contentType: format.contentType,
        data,
      });
    } finally {
      await handle.close();
    }
  }
  return results;
}
