import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  audiobookTextHash,
  ESTIMATED_CHARACTERS_PER_SECOND,
  isWorldImagePath,
  listeningChapter,
  worldImageReferences,
  type AudiobookListening,
  type AudiobookPicture,
  type AudiobookPictureSource,
  type AudiobookReader,
  type ChapterAudiobook,
  type ListeningChapter,
  type ListeningInputBlock,
} from "@arke-studio/contracts";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import type { WorldStore } from "../world/store.js";
import { planAudiobook, updateAudiobook, type AudiobookPlan } from "./audiobook.js";

/**
 * The book as a listener hears it (design turn 186, SPEC-047 R-57..R-62): every chapter of the
 * production in order, retired ones left out, each read as its own press would plan it — the
 * blocks that are made and current play, the rest are the gaps they are — with its pictures on
 * the chapter's clock. The player in the app and the package both play this plan; nothing here
 * writes, and nothing is asked of a provider.
 */

/** A take's length: as measured when it was filed, else its cut from a grouped request, else its words at the reading rate. */
function takeSeconds(store: WorldStore, artifactId: string, take: { grouped?: { durationSec: number } }, text: string): number {
  const artifact = store.getBundle().artifacts.find((candidate) => candidate.id === artifactId);
  const measured = artifact?.mediaInfo?.durationSec;
  if (measured !== undefined && measured > 0) return measured;
  if (take.grouped !== undefined) return take.grouped.durationSec;
  return Math.max(1, text.length / ESTIMATED_CHARACTERS_PER_SECOND);
}

/** A chapter's blocks as the plan reads them: each made block with the take that plays it. */
export function listeningBlocks(store: WorldStore, plan: Pick<AudiobookPlan, "blocks" | "record">): ListeningInputBlock[] {
  const record = plan.record === "unreadable" ? null : plan.record;
  return plan.blocks.map((planned) => {
    const block = { key: planned.block.key, text: planned.block.text };
    const take = record?.takes[planned.block.key];
    if (planned.state !== "made" || take === undefined) return block;
    const artifact = store.getBundle().artifacts.find((candidate) => candidate.id === take.artifactId);
    if (artifact === undefined) return block;
    return { ...block, take: { file: `artifacts/${artifact.file}`, seconds: takeSeconds(store, take.artifactId, take, planned.block.text), grouped: take.grouped !== undefined } };
  });
}

/** Whether a picture's file is an image still in the world: checked on disk, as the picture would be served. */
async function onShelf(store: WorldStore, file: string): Promise<boolean> {
  if (!isWorldImagePath(file)) return false;
  return stat(toExtendedLength(join(store.dir, fromPortable(file)))).then((s) => s.isFile(), () => false);
}

/** The book's cover (R-60): the world's key art, when it is on the shelf. */
export async function bookCover(store: WorldStore): Promise<string | null> {
  const keyArt = store.getBundle().keyArt;
  return keyArt !== null && (await onShelf(store, keyArt)) ? keyArt : null;
}

export async function audiobookListening(store: WorldStore, productionId: string, narrator: AudiobookReader): Promise<AudiobookListening> {
  const production = store.getBundle().productions.find((p) => p.meta.id === productionId);
  if (!production) throw new Error("That production is no longer in this world.");
  const cover = await bookCover(store);
  const chapters: ListeningChapter[] = [];
  for (const summary of [...production.chapters].filter((c) => !c.retired).sort((a, b) => a.order - b.order)) {
    let plan: AudiobookPlan;
    try {
      plan = await planAudiobook(store, productionId, summary.id, { narrator });
    } catch {
      // A chapter that cannot be read is listed and held, never skipped (R-58).
      chapters.push({ chapterId: summary.id, order: summary.order, title: summary.title, state: "not read", seconds: 0, blocks: [], gaps: [], pictures: [], opening: cover });
      continue;
    }
    const record = plan.record === "unreadable" ? null : plan.record;
    const pictures = record?.pictures ?? {};
    const usable = new Set<string>();
    for (const picture of Object.values(pictures)) if (await onShelf(store, picture.file)) usable.add(picture.file);
    chapters.push(listeningChapter({ chapterId: summary.id, order: summary.order, title: summary.title, blocks: listeningBlocks(store, plan), pictures, cover, usable: (file) => usable.has(file) }));
  }
  return { productionId, title: production.meta.title, cover, chapters };
}

/**
 * A picture set on a block, or taken off (turn 186c, R-60): only a picture the world holds — one
 * `worldImageReferences` lists, as the panel offers it — written into the chapter's record keyed
 * by the block, with the block's words so it can follow them, through the record's own lane.
 */
export async function setAudiobookPicture(
  store: WorldStore,
  productionId: string,
  chapterFile: string,
  block: string,
  picture: { file: string; source: AudiobookPictureSource } | null,
  narrator: AudiobookReader,
): Promise<ChapterAudiobook> {
  const production = store.getBundle().productions.find((p) => p.meta.id === productionId);
  const summary = production?.chapters.find((c) => c.file === chapterFile || c.id === chapterFile);
  if (summary === undefined) throw new Error("that chapter is no longer in this production");
  const plan = await planAudiobook(store, productionId, summary.id, { narrator });
  const planned = plan.blocks.find((candidate) => candidate.block.key === block);
  if (planned === undefined) throw new Error("that block is no longer in the chapter");
  if (picture !== null) {
    const listed = worldImageReferences(store.getBundle()).some((reference) => reference.file === picture.file);
    if (!listed || !(await onShelf(store, picture.file))) throw new Error("that picture is not in this world");
  }
  return updateAudiobook(store, productionId, plan.chapter, (current) => {
    const { [block]: _was, ...rest } = current.pictures ?? {};
    const next: Record<string, AudiobookPicture> = picture === null ? rest : { ...rest, [block]: { file: picture.file, source: picture.source, textHash: audiobookTextHash(planned.block.text), at: store.now() } };
    if (picture === null && _was === undefined) return null;
    const { pictures: _old, ...without } = current;
    return { ...without, updatedAt: store.now(), ...(Object.keys(next).length > 0 ? { pictures: next } : {}) };
  });
}
