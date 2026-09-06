import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { imageFormatOf, mp4Problem } from "../queue/verify.js";
import { toExtendedLength } from "./paths.js";

const MAX_REFERENCES = 16;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024 - 1;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
/**
 * Clips carried as motion references (issue 852). Three is what the one route that reads them
 * takes; the byte ceiling is the fal client's inline limit, applied here so a clip is refused
 * before the job leaves the queue rather than after the request has been journalled as sent.
 */
const MAX_VIDEO_REFERENCES = 3;
const MAX_VIDEO_BYTES = 48 * 1024 * 1024;
const VIDEO_TYPES: Record<string, WorldVideoReference["contentType"]> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
};
/** EBML's four magic bytes, which every WebM opens with. */
const WEBM_MAGIC = [0x1a, 0x45, 0xdf, 0xa3];

export interface WorldImageReference {
  name: string;
  contentType: "image/png" | "image/jpeg" | "image/webp";
  data: Uint8Array;
}

export interface WorldVideoReference {
  contentType: "video/mp4" | "video/quicktime" | "video/webm";
  data: Uint8Array;
}

export class WorldReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorldReferenceError";
  }
}

function validatePortablePath(path: string, what = "image reference"): string[] {
  if (
    path.length === 0 ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.includes(":") ||
    isAbsolute(path)
  ) {
    throw new WorldReferenceError(`${what} path is invalid`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new WorldReferenceError(`${what} path is invalid`);
  }
  return segments;
}

function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Walk a world-relative path segment by segment, refusing a link anywhere along it, and prove
 * the real file sits inside the world. One walk for pictures and clips alike (issue 852): the
 * containment argument is subtle enough that a second copy would be a second place to lose it.
 */
async function walkContained(
  root: string,
  portable: string,
  what: string,
): Promise<{ resolved: string; validatedFile: Awaited<ReturnType<typeof lstat>> | null }> {
  const segments = validatePortablePath(portable, what);
  let cursor = root;
  let validatedFile: Awaited<ReturnType<typeof lstat>> | null = null;
  for (const segment of segments) {
    cursor = join(cursor, segment);
    const info = await lstat(toExtendedLength(cursor)).catch(() => null);
    if (!info) throw new WorldReferenceError(`${what.startsWith("image") ? "an" : "a"} ${what} is missing`);
    if (info.isSymbolicLink()) throw new WorldReferenceError(`linked ${what}s are not allowed`);
    validatedFile = info;
  }
  const resolved = await realpath(toExtendedLength(cursor));
  if (!contained(root, resolved)) throw new WorldReferenceError(`${what} escapes the world`);
  return { resolved, validatedFile };
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
    const { resolved, validatedFile } = await walkContained(root, portable, "image reference");
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

/**
 * The bench's clips, read under the same containment as its pictures (issue 852). Typed from
 * the extension and then checked against the bytes — a data URI IS its declared type as far as
 * the route is concerned, so a mislabelled file would not fail as "wrong format" but as a corrupt
 * clip, which reads as the model's fault.
 */
export async function readContainedVideoReferences(
  worldDir: string,
  paths: readonly string[],
): Promise<WorldVideoReference[]> {
  if (paths.length > MAX_VIDEO_REFERENCES) {
    throw new WorldReferenceError(`at most ${MAX_VIDEO_REFERENCES} video references are supported`);
  }
  const root = await realpath(toExtendedLength(worldDir));
  const results: WorldVideoReference[] = [];
  let totalBytes = 0;
  for (const portable of paths) {
    const { resolved, validatedFile } = await walkContained(root, portable, "video reference");
    const dot = portable.lastIndexOf(".");
    const contentType = VIDEO_TYPES[dot === -1 ? "" : portable.slice(dot).toLowerCase()];
    if (contentType === undefined) throw new WorldReferenceError("video reference must be an MP4, MOV or WebM file");
    const handle = await open(toExtendedLength(resolved), "r");
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new WorldReferenceError("video reference is not a file");
      if (!validatedFile || info.dev !== validatedFile.dev || info.ino !== validatedFile.ino) {
        throw new WorldReferenceError("video reference changed during preparation");
      }
      totalBytes += info.size;
      if (totalBytes > MAX_VIDEO_BYTES) {
        throw new WorldReferenceError(`video references exceed the ${MAX_VIDEO_BYTES / 1024 / 1024} MB inline limit`);
      }
      const data = Uint8Array.from(await handle.readFile());
      const problem =
        contentType === "video/webm"
          ? WEBM_MAGIC.every((byte, index) => data[index] === byte)
            ? null
            : "not a WebM file"
          : mp4Problem(data);
      if (problem !== null) throw new WorldReferenceError(`video reference is not a valid clip: ${problem}`);
      results.push({ contentType, data });
    } finally {
      await handle.close();
    }
  }
  return results;
}
