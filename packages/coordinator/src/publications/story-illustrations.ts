import PDFDocument from "pdfkit";
import { audiobookBlocks, audiobookBlockOptions, audiobookHeading, audiobookTextHash, chapterParagraphs,
  kitLookLibrary, pictureLookChanged, placePictures, worldImageReferences } from "@arke-studio/contracts";
import type { AudiobookPlan } from "../productions/audiobook.js";
import type { WorldStore } from "../world/store.js";
import { readPublicationFile } from "./files.js";

export interface StoryIllustration {
  chapter: number;
  /** Before this manuscript paragraph; -1 is the chapter opening, after its heading. */
  paragraph: number;
  file: string;
  alt: string;
  mediaType: "image/png" | "image/jpeg";
}
export const STORY_ILLUSTRATION_LIMITS = { count: 1000, fileBytes: 20 * 1024 ** 2, totalBytes: 2 * 1024 ** 3, pixels: 40_000_000 };
export const illustrationName = (index: number, image: Pick<StoryIllustration, "mediaType">) => `illustration-${index + 1}.${image.mediaType === "image/png" ? "png" : "jpg"}`;

/** Reuse the player's placement, but refuse its stale/missing fallbacks at the publication boundary. */
export async function storyIllustrations(store: WorldStore, chapters: readonly { title: string; body: string; plan: AudiobookPlan | null }[], blockers: string[]): Promise<StoryIllustration[]> {
  const bundle = store.getBundle(), listed = new Set(worldImageReferences(bundle).map(image => image.file));
  const images: StoryIllustration[] = [];
  const checked = new Map<string, StoryIllustration["mediaType"]>();
  let totalBytes = 0;
  for (const [chapter, source] of chapters.entries()) {
    const plan = source.plan;
    if (!plan || plan.record === "unreadable" || plan.cast === "unreadable") {
      blockers.push(`${source.title}: illustration bindings could not be read.`); continue;
    }
    const record = plan.record;
    const paragraphs = chapterParagraphs(source.body).length;
    const blocks = plan.blocks.map(row => row.block);
    const { placed, lost } = placePictures(blocks, record?.pictures, file => listed.has(file));
    for (const key of lost) blockers.push(`${source.title}: picture ${key} is missing or no longer has a manuscript position.`);
    const automatic = audiobookBlocks(source.body, plan.cast, audiobookHeading(plan.chapter.order, plan.chapter.title), audiobookBlockOptions(plan.book)).blocks;
    for (const entry of placed) {
      const block = blocks[entry.index]!;
      const original = block.starts?.includes(entry.key) ? automatic.find(candidate => candidate.key === entry.key) : undefined;
      if (entry.picture.textHash !== audiobookTextHash(block.text) && (!original || entry.picture.textHash !== audiobookTextHash(original.text))) {
        blockers.push(`${source.title}: picture ${entry.key} belongs to earlier text. Reattach it to the current passage.`); continue;
      }
      if (pictureLookChanged(entry.picture.look, record?.look, kitLookLibrary(bundle.referenceKits, record?.look), entry.picture.lookReview)) {
        blockers.push(`${source.title}: picture ${entry.key} has a changed look. Review it before publishing.`); continue;
      }
      if (block.paragraph < -1 || block.paragraph >= paragraphs) {
        blockers.push(`${source.title}: picture ${entry.key} has an unavailable manuscript position.`); continue;
      }
      if (images.length >= STORY_ILLUSTRATION_LIMITS.count) { blockers.push("The illustrated EPUB exceeds 1,000 pictures. Select fewer chapters."); return images; }
      const file = entry.picture.file;
      try {
        let mediaType = checked.get(file);
        if (!mediaType) {
          const chunks: Buffer[] = [];
          const receipt = await readPublicationFile(store.dir, file, STORY_ILLUSTRATION_LIMITS.fileBytes, store.closingSignal, undefined, chunks);
          totalBytes += receipt.byteLength;
          if (totalBytes > STORY_ILLUSTRATION_LIMITS.totalBytes) throw new Error("the selected pictures exceed 2 GiB");
          const bytes = Buffer.concat(chunks);
          mediaType = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? "image/png" : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? "image/jpeg" : undefined;
          if (!mediaType) throw new Error("use a PNG or JPEG illustration");
          // The same PNG/JPEG parser as the PDF cover checks structure and dimensions without
          // introducing a new image codec or a native-tool requirement for a reading edition.
          // An empty font skips the optional standard-font loader in the bundled host; no text is rendered here.
          const parser = new PDFDocument({ autoFirstPage: false, font: "" }); parser.resume();
          try {
            const size = (parser as unknown as { openImage(bytes: Buffer): { width: number; height: number } }).openImage(bytes);
            if (!(size.width > 0 && size.height > 0 && size.width * size.height <= STORY_ILLUSTRATION_LIMITS.pixels)) throw new Error("the picture exceeds 40 megapixels");
          } finally { parser.end(); }
          checked.set(file, mediaType);
        }
        const alt = entry.picture.shot?.frame.trim() || `Illustration for ${source.title}, ${block.paragraph < 0 ? "chapter opening" : `passage ${block.paragraph + 1}`}.`;
        images.push({ chapter, paragraph: block.paragraph, file, alt, mediaType });
      } catch (error) { blockers.push(`${source.title}: picture ${entry.key}: ${error instanceof Error ? error.message : "the image could not be read"}.`); }
    }
  }
  return images;
}
