import { mkdtemp, open, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  PublicationCaptureSchema, fingerprintPublicationCapture, type PublicationCapture,
} from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import { toExtendedLength } from "../world/paths.js";
import { PublicationFileError, readPublicationFile, requirePublicationDigest } from "./files.js";
import { publicationFileLimits, type PublicationFileLimits } from "./verify.js";

export interface PublicationCaptureRequest {
  receipt: PublicationCapture;
  /** Receipt key -> world-relative source file. The trusted profile compiler owns completeness. */
  records: Record<string, string>;
  media: Record<string, string>;
}

export interface CapturedPublicationInputs {
  directory: string;
  receipt: PublicationCapture;
  fingerprint: string;
  /** Receipt key -> copied absolute host path. These paths never go in the public manifest. */
  media: Record<string, string>;
  dispose(): Promise<void>;
}

/**
 * Pin the compiler's declared source dependencies, serialised with app writes. This does not
 * derive a RenderPlan or discover omitted dependencies: a trusted profile compiler must provide
 * hashes for every record used in its plan/settings. It cannot turn a stale plan into a new one.
 * Copies are temporary build inputs, never a completion receipt or a published package.
 */
export async function capturePublicationInputs(
  store: WorldStore,
  request: PublicationCaptureRequest,
  scratchRoot: string,
  options: { signal?: AbortSignal; limits?: Partial<PublicationFileLimits>; onCopied?: (key: string) => void | Promise<void> } = {},
): Promise<CapturedPublicationInputs> {
  const signal = options.signal ? AbortSignal.any([options.signal, store.closingSignal]) : store.closingSignal;
  signal.throwIfAborted();
  const receipt = PublicationCaptureSchema.parse(request.receipt);
  const records = { ...request.records };
  const media = { ...request.media };
  const limits = publicationFileLimits(options.limits);
  for (const [field, paths] of [["records", records], ["media", media]] as const) {
    if (Object.keys(paths).length !== receipt[field].length || receipt[field].some(item => !Object.hasOwn(paths, item.key) || typeof paths[item.key] !== "string")) {
      throw new PublicationFileError("invalid-package", `Publication ${field} paths must match the receipt exactly.`);
    }
  }
  // Only use an existing host-owned scratch root. mkdtemp reserves a fresh child; a caller
  // cannot ask this operation to overwrite an edition or clean somebody else's directory.
  const scratch = await realpath(toExtendedLength(scratchRoot));
  let directory: string | undefined;
  let disposed = false;
  const discard = async () => {
    if (directory && !disposed) {
      await rm(toExtendedLength(directory), { recursive: true, force: true });
      disposed = true;
    }
  };
  try {
    return await store.ownedWrite(async () => {
      signal.throwIfAborted();
      const checkRecords = async () => {
        for (const record of receipt.records) {
          requirePublicationDigest(await readPublicationFile(store.dir, records[record.key]!, limits.manifestBytes, signal), record);
        }
      };
      await checkRecords();
      directory = await mkdtemp(toExtendedLength(join(scratch, "arke-publication-")));
      const copies: Record<string, string> = Object.create(null) as Record<string, string>;
      let totalBytes = 0;
      for (const [index, source] of receipt.media.entries()) {
        signal.throwIfAborted();
        if (source.byteLength > limits.assetBytes || source.byteLength > limits.totalBytes - totalBytes) {
          throw new PublicationFileError("limit-exceeded", "Publication capture exceeds its byte limits.");
        }
        const path = join(directory, `source-${index}`);
        const destination = await open(toExtendedLength(path), "wx");
        try {
          const actual = await readPublicationFile(store.dir, media[source.key]!, source.byteLength, signal, destination);
          requirePublicationDigest(actual, source);
          await destination.sync();
        } finally { await destination.close(); }
        copies[source.key] = path;
        totalBytes += source.byteLength;
        await options.onCopied?.(source.key);
      }
      // Managed writes were held by ownedWrite. External writes still need a second check,
      // including source bytes: a file may have been replaced after its copy completed.
      await checkRecords();
      for (const source of receipt.media) {
        requirePublicationDigest(await readPublicationFile(store.dir, media[source.key]!, source.byteLength, signal), source);
      }
      signal.throwIfAborted();
      await store.assertOwnership();
      const fingerprint = await fingerprintPublicationCapture(receipt);
      signal.throwIfAborted();
      return { directory, receipt, fingerprint, media: copies, dispose: discard };
    });
  } catch (error) {
    await discard();
    throw error;
  }
}
