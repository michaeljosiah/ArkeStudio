import { open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { STORY_EPUB_READING_PROFILE } from "@arke-studio/contracts";
import { fitReadingImage, pngHasAlpha } from "../references/reading-image.js";
import type { FfmpegRunner } from "../takes/export.js";
import { checkedPublicationPath, readPublicationFile, requirePublicationDigest } from "./files.js";
import { inspectStoryImage, STORY_ILLUSTRATION_LIMITS, type StoryIllustration } from "./story-illustrations.js";

type Media = { file: string; sha256: string; byteLength: number };
type Image = Pick<StoryIllustration, "file" | "mediaType">;
export interface StoryEpubImages {
  profile: typeof STORY_EPUB_READING_PROFILE;
  encoder: string;
  images: Array<Media & Image & { source: string; width: number; height: number }>;
}

/** Convert each unique captured original once; no world path or existing edition is writable here. */
export async function captureEpubImages(inputRoot: string, files: readonly string[], media: readonly Media[], ffmpeg: FfmpegRunner, signal: AbortSignal): Promise<StoryEpubImages> {
  const encoder = await ffmpeg.identity?.(signal);
  if (!encoder) throw new Error("Reading-size EPUB needs the host’s image encoder identity.");
  const result: StoryEpubImages = { profile: { ...STORY_EPUB_READING_PROFILE }, encoder, images: [] };
  for (const [index, source] of [...new Set(files)].entries()) {
    signal.throwIfAborted();
    const receipt = media.find(row => row.file === source);
    if (!receipt) throw new Error("An EPUB image has no captured original.");
    const chunks: Buffer[] = [];
    requirePublicationDigest(await readPublicationFile(inputRoot, source, STORY_ILLUSTRATION_LIMITS.fileBytes, signal, undefined, chunks), receipt);
    const bytes = Buffer.concat(chunks); inspectStoryImage(bytes);
    const alpha = pngHasAlpha(bytes), file = `artifacts/epub-reading-${index}.${alpha ? "png" : "jpg"}`;
    const stage = join(inputRoot, file.replace(/\.(png|jpg)$/, ".tmp.$1"));
    try {
      await fitReadingImage(await checkedPublicationPath(inputRoot, source), stage, alpha, ffmpeg, signal);
      const rendered: Buffer[] = [];
      const digest = await readPublicationFile(inputRoot, file.replace(/\.(png|jpg)$/, ".tmp.$1"), STORY_ILLUSTRATION_LIMITS.fileBytes, signal, undefined, rendered);
      const size = inspectStoryImage(Buffer.concat(rendered));
      if (Math.max(size.width, size.height) > result.profile.maxEdge || size.mediaType !== (alpha ? "image/png" : "image/jpeg")) throw new Error("The reading-size image did not match the captured profile.");
      const handle = await open(stage, "r+"); try { await handle.sync(); } finally { await handle.close(); }
      signal.throwIfAborted(); await rename(stage, join(inputRoot, file));
      result.images.push({ source, file, ...size, sha256: digest.sha256, byteLength: digest.byteLength });
    } finally { await rm(stage, { force: true }); }
  }
  return result;
}

export function epubImage<T extends Image>(image: T, reading?: StoryEpubImages): T {
  if (!reading) return image;
  const fitted = reading.images.find(row => row.source === image.file);
  if (!fitted) throw new Error("The captured EPUB image rendition is missing.");
  return { ...image, file: fitted.file, mediaType: fitted.mediaType };
}
