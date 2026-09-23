import { lstat, opendir, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  MAX_PUBLICATION_ASSETS, PUBLICATION_MANIFEST_FILE, PublicationAssetPathSchema,
  readPublicationManifest, type VideoPublicationManifest,
} from "@arke-studio/contracts";
import { toExtendedLength } from "../world/paths.js";
import { PublicationFileError, readPublicationFile, requirePublicationDigest } from "./files.js";

export interface PublicationFileLimits {
  manifestBytes: number;
  /** Capture-only bound for editable source records, which can include timeline history. */
  recordBytes: number;
  assetBytes: number;
  totalBytes: number;
  entries: number;
}

export const DEFAULT_PUBLICATION_FILE_LIMITS: Readonly<PublicationFileLimits> = Object.freeze({
  manifestBytes: 1024 * 1024,
  recordBytes: 64 * 1024 * 1024,
  assetBytes: 32 * 1024 ** 3,
  totalBytes: 64 * 1024 ** 3,
  entries: MAX_PUBLICATION_ASSETS * 4,
});

export function publicationFileLimits(input: Partial<PublicationFileLimits> = {}): PublicationFileLimits {
  const limits = { ...DEFAULT_PUBLICATION_FILE_LIMITS, ...input };
  if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value < 1)) {
    throw new PublicationFileError("limit-exceeded", "Publication limits must be positive safe integers.");
  }
  return limits;
}

export interface VerifiedPublicationDirectory {
  directory: string;
  manifest: VideoPublicationManifest;
  manifestSha256: string;
  byteLength: number;
}

/** JSON.parse validates syntax first; then track decoded keys in each object before Zod sees it. */
function parseManifest(text: string): unknown {
  const value: unknown = JSON.parse(text);
  const scopes: (Set<string> | null)[] = [];
  let quoted = "";
  // Strings are consumed whole, so punctuation inside them cannot change object scope.
  for (const match of text.matchAll(/"(?:[^"\\]|\\[\s\S])*"|[{}[\]:]/g)) {
    const token = match[0];
    if (token.startsWith('"')) quoted = token;
    else if (token === "{") scopes.push(new Set());
    else if (token === "[") scopes.push(null);
    else if (token === "}" || token === "]") scopes.pop();
    else if (token === ":") {
      const key = JSON.parse(quoted) as string;
      const keys = scopes.at(-1)!;
      if (keys!.has(key)) throw new PublicationFileError("invalid-package", "Publication manifest contains duplicate JSON members.");
      keys!.add(key);
    }
  }
  return value;
}

/**
 * Directory-only integrity verification. The future ZIP reader must validate entries before
 * extraction. This checks bytes, not codecs or caption semantics, and grants no lasting trust
 * in a folder another process can subsequently edit; a player must pin or reverify its inputs.
 */
export async function verifyPublicationDirectory(
  directory: string,
  options: { signal?: AbortSignal; limits?: Partial<PublicationFileLimits>; supportedCapabilities?: readonly string[];
    onAssetVerified?: (key: string) => void | Promise<void> } = {},
): Promise<VerifiedPublicationDirectory> {
  const { signal } = options;
  const limits = publicationFileLimits(options.limits);
  signal?.throwIfAborted();
  const rootInfo = await lstat(toExtendedLength(directory));
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new PublicationFileError("unsafe-path", "A publication must be a real directory.");
  const root = await realpath(toExtendedLength(directory));
  const chunks: Buffer[] = [];
  const manifestDigest = await readPublicationFile(root, PUBLICATION_MANIFEST_FILE, limits.manifestBytes, signal, undefined, chunks);
  let json: unknown;
  try { json = parseManifest(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch (error) {
    if (error instanceof PublicationFileError) throw error;
    throw new PublicationFileError("invalid-package", "Publication manifest is not valid UTF-8 JSON.");
  }
  const result = readPublicationManifest(json, options.supportedCapabilities);
  if (!result.ok) throw new PublicationFileError(result.code, result.reason);
  const manifest = result.manifest;
  const expected = new Set([PUBLICATION_MANIFEST_FILE, ...Object.values(manifest.assets).map(asset => asset.href)]);
  let entries = 0;
  const found = new Set<string>();
  const spellings = new Map<string, string>();
  const scan = async (prefix: string): Promise<void> => {
    signal?.throwIfAborted();
    const directory = await opendir(toExtendedLength(join(root, prefix)));
    for await (const entry of directory) {
      signal?.throwIfAborted();
      if (++entries > limits.entries) throw new PublicationFileError("limit-exceeded", "Publication has too many directory entries.");
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      const prior = spellings.get(name.toLowerCase());
      if (prior !== undefined && prior !== name) throw new PublicationFileError("unsafe-path", "Publication paths collide ignoring case.");
      spellings.set(name.toLowerCase(), name);
      if (name !== PUBLICATION_MANIFEST_FILE && !PublicationAssetPathSchema.safeParse(name).success) {
        throw new PublicationFileError("unsafe-path", "Publication contains a non-portable path.");
      }
      if (entry.isSymbolicLink()) throw new PublicationFileError("unsafe-path", "Publication contains a symbolic link or junction.");
      if (entry.isDirectory()) {
        if (name.split("/").length > 32) throw new PublicationFileError("limit-exceeded", "Publication directories are nested too deeply.");
        await scan(name);
      } else if (entry.isFile()) {
        if (!expected.has(name)) throw new PublicationFileError("invalid-package", "Publication contains an unlisted file.");
        found.add(name);
      } else throw new PublicationFileError("unsafe-path", "Publication contains a non-regular file.");
    }
  };
  await scan("");
  if (found.size !== expected.size) throw new PublicationFileError("invalid-package", "Publication is missing a declared file.");
  let bytes = manifestDigest.byteLength;
  const reads = [manifestDigest];
  for (const [key, asset] of Object.entries(manifest.assets)) {
    if (asset.byteLength > limits.assetBytes || asset.byteLength > limits.totalBytes - bytes) {
      throw new PublicationFileError("limit-exceeded", "Publication exceeds its asset or total byte limit.");
    }
    const actual = await readPublicationFile(root, asset.href, asset.byteLength, signal);
    requirePublicationDigest(actual, asset);
    reads.push(actual);
    bytes += actual.byteLength;
    await options.onAssetVerified?.(key);
  }
  if (bytes > limits.totalBytes) throw new PublicationFileError("limit-exceeded", "Publication exceeds its total byte limit.");
  requirePublicationDigest(await readPublicationFile(root, PUBLICATION_MANIFEST_FILE, limits.manifestBytes, signal), manifestDigest);
  // A later, large asset can take a long time to hash. Recheck the inventory and the file
  // identities/timestamps saved by every read so edits to earlier assets are still refused.
  entries = 0; found.clear(); spellings.clear();
  await scan("");
  if (found.size !== expected.size) throw new PublicationFileError("invalid-package", "Publication is missing a declared file.");
  for (const read of reads) await read.assertUnchanged();
  signal?.throwIfAborted();
  return { directory: root, manifest, manifestSha256: manifestDigest.sha256, byteLength: bytes };
}
