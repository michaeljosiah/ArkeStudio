import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { copyPublicationDirectory, extractPublicationZip, type PublicationArchiveOptions } from "./archive.js";
import { checkedPublicationPath, PublicationFileError, readPublicationFile } from "./files.js";
import type { VerifiedPublicationDirectory } from "./verify.js";

/** A deliberately inert WebVTT subset: cue ids, timing and text; no CSS or regions. */
export function validatePublicationVtt(text: string, duration: number): void {
  const fail = () => { throw new PublicationFileError("invalid-package", "Unsupported or invalid WebVTT captions."); };
  const lines = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!/^WEBVTT(?:[ \t][^\n]*)?\n\n/.test(lines) || lines.includes("\0") || lines.includes("\r")) fail();
  const blocks = lines.trimEnd().split(/\n\n+/).slice(1);
  let previous = -1;
  const stamp = (value: string): number => {
    const m = /^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)\.(\d{3})$/.exec(value);
    if (!m) { fail(); return 0; }
    return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
  };
  for (const block of blocks) {
    const rows = block.split("\n");
    if (/^NOTE(?:[ \t]|$)/.test(rows[0]!)) continue;
    if (!rows[0]!.includes("-->")) rows.shift();
    const timing = /^(\S+) --> (\S+)$/.exec(rows.shift() ?? "");
    if (!timing || !rows.join("\n").trim()) { fail(); continue; }
    const start = stamp(timing[1]!); const end = stamp(timing[2]!);
    if (!Number.isFinite(end) || start < previous || end <= start || end > duration + 0.05 || rows.some(row => row.includes("-->"))) fail();
    previous = start;
  }
}

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
      await readPublicationFile(pinned.directory, asset.href, 8 * 1024 * 1024, options.signal, undefined, buffers);
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(buffers)); }
      catch { throw new PublicationFileError("invalid-package", "Captions must be UTF-8."); }
      validatePublicationVtt(text, measured.duration);
    }
    options.signal?.throwIfAborted();
    return { ...pinned, mediaType: measured.mediaType, dispose };
  } catch (error) { await dispose(); throw error; }
}
