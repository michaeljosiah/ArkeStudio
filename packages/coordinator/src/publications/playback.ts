import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { copyPublicationDirectory, extractPublicationZip, type PublicationArchiveOptions } from "./archive.js";
import { checkedPublicationPath, PublicationFileError, readPublicationFile } from "./files.js";
import type { VerifiedPublicationDirectory } from "./verify.js";

import { PUBLICATION_VTT_BYTES, validatePublicationVtt } from "./captions.js";
export { validatePublicationVtt } from "./captions.js";

export interface PinnedPublication extends VerifiedPublicationDirectory {
  mediaType: string;
  dispose(): Promise<void>;
}

/** Pin first, then preflight: the player never serves the mutable source package. */
export async function openPublication(
  source: string, kind: "directory" | "zip", scratchRoot: string,
  probe: (video: string, mediaType: string, signal?: AbortSignal) => Promise<{ duration: number; mediaType: string }>,
  options: PublicationArchiveOptions = {},
): Promise<PinnedPublication> {
  const container = await mkdtemp(join(scratchRoot, "player-"));
  const dispose = () => rm(container, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  try {
    const pinned = kind === "zip"
      ? await extractPublicationZip(source, container, options)
      : await copyPublicationDirectory(source, join(container, "publication"), options);
    const video = pinned.manifest.assets[pinned.manifest.content.video]!;
    const measured = await probe(await checkedPublicationPath(pinned.directory, video.href), video.mediaType, options.signal);
    if (!Number.isFinite(measured.duration) || measured.duration <= 0) throw new PublicationFileError("invalid-package", "Publication video has no measurable duration.");
    for (const track of pinned.manifest.content.textTracks) {
      const asset = pinned.manifest.assets[track.asset]!;
      const buffers: Buffer[] = [];
      await readPublicationFile(pinned.directory, asset.href, PUBLICATION_VTT_BYTES, options.signal, undefined, buffers);
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(buffers)); }
      catch { throw new PublicationFileError("invalid-package", "Captions must be UTF-8."); }
      validatePublicationVtt(text, measured.duration);
    }
    options.signal?.throwIfAborted();
    return { ...pinned, mediaType: measured.mediaType, dispose };
  } catch (error) { await dispose(); throw error; }
}
