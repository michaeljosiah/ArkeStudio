import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  chapterMix,
  hasTiming,
  audiobookTextHash,
  DEFAULT_NARRATOR,
  ESTIMATED_CHARACTERS_PER_SECOND,
  isWorldImagePath,
  listeningChapter,
  placePictures,
  worldImageReferences,
  type AudiobookListening,
  type AudiobookPicture,
  type AudiobookPictureSource,
  type AudiobookReader,
  type ChapterAudiobook,
  type ListeningChapter,
  type ListeningInputBlock,
  type PictureLook,
  type PictureShot,
} from "@arke-studio/contracts";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import type { WorldStore } from "../world/store.js";
import { planAudiobook, readAudiobookBook, updateAudiobook, type AudiobookPlan } from "./audiobook.js";
import { renderChapterMix } from "./audiobook-mix.js";
import { chapterTiming } from "./audiobook-timing.js";
import type { FfmpegRunner } from "../takes/export.js";

/**
 * The book as a listener hears it (design turn 186, SPEC-047 R-66..R-71): every chapter of the
 * production in order, retired ones left out, each with the takes that say its words now — the
 * rest are the gaps they are — and its pictures on the chapter's clock. The player in the app
 * and the package both play this plan; nothing here writes, and nothing is asked of a provider.
 *
 * What plays is judged by the words alone, never by who would read the block today (codex on
 * PR 1491): the reader a block is meant for comes from the live voice catalogue, which is empty
 * offline, without a key or while the voice sidecar is down, and a book whose every take is on
 * the shelf must not fall silent because the narrator could not be asked for. A take whose words
 * are the block's plays whoever read it; a take of other words is a gap.
 */

/** A take's length: as measured when it was filed, else its cut from a grouped request, else its words at the reading rate. */
function takeSeconds(store: WorldStore, artifactId: string, take: { grouped?: { durationSec: number } }, text: string): number {
  const artifact = store.getBundle().artifacts.find((candidate) => candidate.id === artifactId);
  const measured = artifact?.mediaInfo?.durationSec;
  if (measured !== undefined && measured > 0) return measured;
  if (take.grouped !== undefined) return take.grouped.durationSec;
  return Math.max(1, text.length / ESTIMATED_CHARACTERS_PER_SECOND);
}

/** A chapter's blocks as the plan reads them: each block whose take says its words now, with that take. */
export function listeningBlocks(store: WorldStore, plan: Pick<AudiobookPlan, "blocks" | "record" | "present">): ListeningInputBlock[] {
  const record = plan.record === "unreadable" ? null : plan.record;
  return plan.blocks.map((planned) => {
    const block = { key: planned.block.key, text: planned.block.text };
    const take = record?.takes[planned.block.key];
    if (take === undefined || !plan.present.has(take.artifactId) || take.textHash !== audiobookTextHash(planned.block.text)) return block;
    const artifact = store.getBundle().artifacts.find((candidate) => candidate.id === take.artifactId);
    if (artifact === undefined) return block;
    return { ...block, take: { file: `artifacts/${artifact.file}`, seconds: takeSeconds(store, take.artifactId, take, planned.block.text), grouped: take.grouped !== undefined, artifactId: take.artifactId } };
  });
}

/** Whether a file is an image still in the world: checked on disk, as the picture would be served. */
async function onShelf(store: WorldStore, file: string): Promise<boolean> {
  if (!isWorldImagePath(file)) return false;
  return stat(toExtendedLength(join(store.dir, fromPortable(file)))).then((s) => s.isFile(), () => false);
}

/**
 * The pictures a chapter may show: in the world's image catalogue now — a retired or superseded
 * artifact leaves it though its bytes stay on disk (codex on PR 1491) — and on the shelf.
 */
async function usablePictures(store: WorldStore, pictures: Readonly<Record<string, AudiobookPicture>>): Promise<Set<string>> {
  const listed = new Set(worldImageReferences(store.getBundle()).map((reference) => reference.file));
  const usable = new Set<string>();
  for (const picture of Object.values(pictures)) if (listed.has(picture.file) && (await onShelf(store, picture.file))) usable.add(picture.file);
  return usable;
}

/** The book's cover (R-69): the world's key art, when it is on the shelf. */
export async function bookCover(store: WorldStore): Promise<string | null> {
  const keyArt = store.getBundle().keyArt;
  return keyArt !== null && (await onShelf(store, keyArt)) ? keyArt : null;
}

/**
 * Who `planAudiobook` assigns the blocks to: the book's own narrator as written, else the
 * shipped one. Only the blocks, their words and the record are read from the plan, never its
 * states, so this asks no catalogue and needs none to be up.
 */
export async function anyNarrator(store: WorldStore, productionId: string): Promise<AudiobookReader> {
  const book = await readAudiobookBook(store, productionId).catch(() => null);
  return book !== null && book !== "unreadable" && book.narrator !== undefined ? book.narrator : { ...DEFAULT_NARRATOR };
}

/**
 * A chapter with timing as the player hears it (design turn 187, R-85): its one mix, rendered
 * by the renderer the chapter's Play uses and kept in the cache under its plan's name, and the
 * blocks' places on that mix's clock. Null for a chapter with none, or whose mix cannot be made
 * here — the takes then play back to back, as before timing.
 */
async function timedListening(store: WorldStore, productionId: string, plan: AudiobookPlan, ffmpeg: FfmpegRunner | undefined, always = false): Promise<{ bars: Array<{ key: string; at: number; seconds: number }>; seconds: number; mix: { file: string; seconds: number } } | null> {
  const record = plan.record === "unreadable" ? null : plan.record;
  if (!hasTiming(record) && !always) return null;
  try {
    const timing = chapterTiming(store, plan, "skip");
    const mix = chapterMix(timing);
    if (mix.voices.length === 0) return null;
    const rendered = await renderChapterMix(store.dir, productionId, plan.chapter.file, mix, ffmpeg !== undefined ? { ffmpeg } : {});
    const bars = timing.bars.filter((bar) => bar.kind === "block" && bar.made).map((bar) => ({ key: bar.key, at: bar.at, seconds: bar.seconds }));
    return { bars, seconds: rendered.seconds, mix: { file: rendered.file, seconds: rendered.seconds } };
  } catch {
    return null;
  }
}

/**
 * `mixAll`: every chapter on its one mix, timing or none (design turn 197, rule 7) — the video
 * takes its sound from the renderer the chapter's Play uses and nothing else, so a chapter with
 * no timing is rendered as one too: its takes back to back, at the book's one loudness.
 */
export async function audiobookListening(store: WorldStore, productionId: string, options: { ffmpeg?: FfmpegRunner; mixAll?: boolean } = {}): Promise<AudiobookListening> {
  const production = store.getBundle().productions.find((p) => p.meta.id === productionId);
  if (!production) throw new Error("That production is no longer in this world.");
  const cover = await bookCover(store);
  const narrator = await anyNarrator(store, productionId);
  const chapters: ListeningChapter[] = [];
  for (const summary of [...production.chapters].filter((c) => !c.retired).sort((a, b) => a.order - b.order)) {
    let plan: AudiobookPlan;
    try {
      plan = await planAudiobook(store, productionId, summary.id, { narrator });
    } catch {
      // A chapter that cannot be read is listed and held, never skipped (R-67).
      chapters.push({ chapterId: summary.id, order: summary.order, title: summary.title, state: "not read", seconds: 0, blocks: [], gaps: [], pictures: [], opening: cover });
      continue;
    }
    const record = plan.record === "unreadable" ? null : plan.record;
    const pictures = record?.pictures ?? {};
    const usable = await usablePictures(store, pictures);
    const timed = await timedListening(store, productionId, plan, options.ffmpeg, options.mixAll === true);
    chapters.push(listeningChapter({ chapterId: summary.id, order: summary.order, title: summary.title, blocks: listeningBlocks(store, plan), pictures, cover, usable: (file) => usable.has(file), ...(timed !== null ? { timed } : {}) }));
  }
  return { productionId, title: production.meta.title, cover, chapters };
}

/**
 * Where a block's picture's subject stands (design turn 197b): set by dragging in the video's
 * preview, kept on the picture — whichever key it is kept under, as a Remove finds it — and
 * `null` back to the centre. A block with no picture refuses.
 */
export async function setAudiobookPictureFocus(store: WorldStore, productionId: string, chapterFile: string, block: string, focus: { x: number; y: number } | null): Promise<ChapterAudiobook> {
  const production = store.getBundle().productions.find((p) => p.meta.id === productionId);
  const summary = production?.chapters.find((c) => c.file === chapterFile || c.id === chapterFile);
  if (summary === undefined) throw new Error("that chapter is no longer in this production");
  const plan = await planAudiobook(store, productionId, summary.id, { narrator: await anyNarrator(store, productionId) });
  const blocks = plan.blocks.map((candidate) => ({ key: candidate.block.key, text: candidate.block.text }));
  const index = blocks.findIndex((candidate) => candidate.key === block);
  if (index < 0) throw new Error("that block is no longer in the chapter");
  const round = (share: number) => Math.round(Math.min(1, Math.max(0, share)) * 1000) / 1000;
  return updateAudiobook(store, productionId, plan.chapter, (current) => {
    const held = current.pictures ?? {};
    const shown = placePictures(blocks, held).placed.find((entry) => entry.index === index);
    if (shown === undefined) throw new Error("that block has no picture");
    const { focus: _old, ...rest } = shown.picture;
    const next = focus === null ? rest : { ...rest, focus: { x: round(focus.x), y: round(focus.y) } };
    if (JSON.stringify(next) === JSON.stringify(shown.picture)) return null;
    return { ...current, updatedAt: store.now(), pictures: { ...held, [shown.key]: next } };
  });
}

/**
 * A picture set on a block, or taken off (turn 186c, R-69): only a picture the world holds — one
 * `worldImageReferences` lists, as the panel offers it — written into the chapter's record keyed
 * by the block, with the block's words so it can follow them, through the record's own lane.
 *
 * The block's picture is the one shown there, wherever it is kept: a picture that followed its
 * words to this block after a paragraph moved is still kept under its old key, and a Remove or a
 * replacement that only looked under the block's own key left it standing (codex on PR 1491).
 */
export async function setAudiobookPicture(
  store: WorldStore,
  productionId: string,
  chapterFile: string,
  block: string,
  picture: { file: string; source: AudiobookPictureSource } | null,
  /**
   * A picture Arke made keeps the look it was made under (design turn 191c, R-98), to be marked
   * when that changes, and the shot it was made from (194g), for its card.
   */
  made: { look?: PictureLook; shot?: PictureShot } = {},
): Promise<ChapterAudiobook> {
  const production = store.getBundle().productions.find((p) => p.meta.id === productionId);
  const summary = production?.chapters.find((c) => c.file === chapterFile || c.id === chapterFile);
  if (summary === undefined) throw new Error("that chapter is no longer in this production");
  const plan = await planAudiobook(store, productionId, summary.id, { narrator: await anyNarrator(store, productionId) });
  const planned = plan.blocks.find((candidate) => candidate.block.key === block);
  if (planned === undefined) throw new Error("that block is no longer in the chapter");
  if (picture !== null) {
    const listed = worldImageReferences(store.getBundle()).some((reference) => reference.file === picture.file);
    if (!listed || !(await onShelf(store, picture.file))) throw new Error("that picture is not in this world");
  }
  const blocks = plan.blocks.map((candidate) => ({ key: candidate.block.key, text: candidate.block.text }));
  const index = blocks.findIndex((candidate) => candidate.key === block);
  return updateAudiobook(store, productionId, plan.chapter, (current) => {
    const held = current.pictures ?? {};
    // Every key whose picture would stand on this block now, its own included — each placed on
    // its own, so one a second picture shadows there goes too rather than surfacing later.
    const here = new Set([block, ...Object.entries(held).filter(([key, entry]) => placePictures(blocks, { [key]: entry }).placed[0]?.index === index).map(([key]) => key)]);
    const rest: Record<string, AudiobookPicture> = Object.fromEntries(Object.entries(held).filter(([key]) => !here.has(key)));
    if (picture === null && Object.keys(rest).length === Object.keys(held).length) return null;
    const next: Record<string, AudiobookPicture> = picture === null ? rest : { ...rest, [block]: { file: picture.file, source: picture.source, textHash: audiobookTextHash(planned.block.text), at: store.now(), ...(made.look !== undefined ? { look: made.look } : {}), ...(made.shot !== undefined ? { shot: made.shot } : {}) } };
    const { pictures: _old, ...without } = current;
    return { ...without, updatedAt: store.now(), ...(Object.keys(next).length > 0 ? { pictures: next } : {}) };
  });
}
