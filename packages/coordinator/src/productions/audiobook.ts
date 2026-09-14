import { mkdir, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  AudiobookBookSchema,
  ChapterAudiobookSchema,
  DEFAULT_AUDIOBOOK_BOOK,
  audiobookBlocks,
  audiobookBlockState,
  audiobookHeading,
  legacyVoiceModel,
  type AudiobookBlock,
  type AudiobookBlockState,
  type AudiobookBook,
  type AudiobookReader,
  type AudiobookReading,
  type AudiobookSubstitution,
  type ChapterAudiobook,
  type ChapterVoices,
  type ClonedVoice,
  type Sheet,
} from "@arke-studio/contracts";
import { atomicWriteFile } from "../world/atomic.js";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import type { WorldStore } from "../world/store.js";
import { sha256 } from "../world/text-files.js";
import { openChapter } from "./ops.js";
import { readVoices } from "./voices.js";

/**
 * The audiobook's records (design turn 146, SPEC-047 §2.2): beside a chapter's cast, in the
 * discipline continuity and the cast set — derived-and-authored, unversioned, no track of the
 * gate's, read plainly by the scanner and never through a manifest, written through the store's
 * ownership-checked path so a run that finishes after the world's claim was lost writes nothing.
 * The takes themselves are artifacts; these records are the index of what is made and chosen.
 *
 * The chapters' records sit under `chapters/`, apart from the book's file: a chapter's file
 * stem is unconstrained, and one named `book` would otherwise write its record over the book's
 * reading and lose every take it had chosen the moment the reading changed (codex on PR 1180).
 */

export function audiobookPath(productionId: string, chapterFile: string): string {
  return `productions/${productionId}/.audiobook/chapters/${chapterFile}.json`;
}

/**
 * Where slice 1 (PR 1180, merged) wrote a chapter's record before the chapters had a folder
 * of their own: read while no record sits at the chapter's own path, moved by the next write,
 * never written to. Without this a world read by that build would show every block not made
 * and pay for its takes again (codex on PR 1183). For a chapter whose stem is `book` the old
 * path is the book's own file, so nothing is read there.
 */
export function legacyAudiobookPath(productionId: string, chapterFile: string): string {
  return `productions/${productionId}/.audiobook/${chapterFile}.json`;
}

export function audiobookBookPath(productionId: string): string {
  return `productions/${productionId}/.audiobook/book.json`;
}

/** Where a block's take lands before it is filed as an artifact: transient, never a record. */
export function audiobookLanding(productionId: string, chapterFile: string): string {
  return `.staging/audiobook/${productionId}/${chapterFile}`;
}

async function readJson<T>(store: WorldStore, rel: string, parse: (raw: unknown) => T | null): Promise<T | "unreadable" | null> {
  let raw: string;
  try {
    raw = await readFile(toExtendedLength(join(store.dir, fromPortable(rel))), "utf8");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? null : "unreadable";
  }
  try {
    return parse(JSON.parse(raw)) ?? "unreadable";
  } catch {
    return "unreadable";
  }
}

const parseChapterAudiobook = (raw: unknown): ChapterAudiobook | null => {
  const parsed = ChapterAudiobookSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

/** The record beside a chapter; a file that is there but cannot be read is said so, never absent (R-1). */
export async function readAudiobook(store: WorldStore, productionId: string, chapterFile: string): Promise<ChapterAudiobook | "unreadable" | null> {
  const current = await readJson(store, audiobookPath(productionId, chapterFile), parseChapterAudiobook);
  if (current !== null || chapterFile === "book") return current;
  return readJson(store, legacyAudiobookPath(productionId, chapterFile), parseChapterAudiobook);
}

/** The book's reading (R-11); absent means the narrator's, and an unreadable file reads the same way but is said. */
export async function readAudiobookBook(store: WorldStore, productionId: string): Promise<AudiobookBook | "unreadable" | null> {
  return readJson(store, audiobookBookPath(productionId), (raw) => {
    const parsed = AudiobookBookSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  });
}

async function writeOwned(store: WorldStore, rel: string, value: unknown, supersedes?: string): Promise<void> {
  const absolute = join(store.dir, fromPortable(rel));
  await store.ownedWrite(async () => {
    await mkdir(toExtendedLength(join(absolute, "..")), { recursive: true });
    await atomicWriteFile(absolute, `${JSON.stringify(value, null, 2)}\n`);
    // The old file goes with the same claim the new one was written under: left behind, it
    // would be read again only if the new one were lost, and then as an older record over a
    // newer set of takes.
    if (supersedes !== undefined) await unlink(toExtendedLength(join(store.dir, fromPortable(supersedes)))).catch(() => {});
  });
}

/** Written after every block a run lands, so a stop or a lost claim leaves the takes made so far standing (R-18). */
export async function writeAudiobook(store: WorldStore, productionId: string, chapterFile: string, record: ChapterAudiobook): Promise<void> {
  await writeOwned(store, audiobookPath(productionId, chapterFile), record, chapterFile === "book" ? undefined : legacyAudiobookPath(productionId, chapterFile));
}

export async function writeAudiobookBook(store: WorldStore, productionId: string, book: AudiobookBook): Promise<void> {
  await writeOwned(store, audiobookBookPath(productionId), book);
  await store.reload();
}

export function emptyAudiobook(chapterVersion: number, hash: string, now: string): ChapterAudiobook {
  return { schemaVersion: 1, chapterVersion, hash, updatedAt: now, takes: {}, flags: {} };
}

/** A block with the reader it is meant for now (R-11, R-12): before availability is asked, which the run does. */
export interface PlannedBlock {
  block: AudiobookBlock;
  /** The reader the block is assigned to — the sheet's voice under `cast` when it has one, the narrator otherwise. */
  assigned: AudiobookReader;
  sheet?: string;
  sheetVersion?: number;
  /** Set when the block was meant for a speaker but falls to the narrator before the run even asks the catalogue. */
  substituted?: AudiobookSubstitution;
  state: AudiobookBlockState;
}

/**
 * Who each block is meant for (R-11, R-12). Under `narrator` every block is the narrator's;
 * under `cast` a line is its speaker's assigned voice, and a line whose sheet has none, or whose
 * cast names no sheet, falls to the narrator with the reason kept — said on the door before
 * anything is made, and recorded on the take when it is.
 */
export function assignReaders(
  blocks: readonly AudiobookBlock[],
  reading: AudiobookReading,
  narrator: AudiobookReader,
  sheets: readonly Sheet[],
  clonedVoices: readonly ClonedVoice[],
  record: ChapterAudiobook | null,
  hasArtifact?: (artifactId: string) => boolean,
): PlannedBlock[] {
  return blocks.map((block) => {
    const planned = ((): Omit<PlannedBlock, "state" | "block"> => {
      if (reading === "narrator" || block.speaker === undefined) return { assigned: narrator };
      if (block.sheet === undefined) return { assigned: narrator, substituted: "no sheet" };
      const sheet = sheets.find((candidate) => candidate.id === block.sheet);
      const voice = sheet?.voice;
      if (sheet === undefined || voice === undefined) return { assigned: narrator, sheet: block.sheet, substituted: "no voice" };
      const model = voice.model ?? legacyVoiceModel(voice.provider, voice.voiceId, clonedVoices);
      if (model === null || model === undefined) return { assigned: narrator, sheet: block.sheet, substituted: "no voice" };
      return {
        assigned: { provider: voice.provider, model, voiceId: voice.voiceId, ...(voice.label !== undefined ? { label: voice.label } : {}) },
        sheet: block.sheet,
        sheetVersion: voice.assignedAtVersion,
      };
    })();
    return { block, ...planned, state: audiobookBlockState(block, record, planned.assigned, hasArtifact) };
  });
}

/**
 * The takes a record names that are still on the shelf (codex on PR 1180): the sidecar in the
 * bundle, not retired, and its media on disk. The record is an index, and a world carried by
 * hand can lose either; a block whose take is gone reads as not made, so it is made again
 * rather than shown as made and unplayable.
 */
export async function presentTakes(store: WorldStore, record: ChapterAudiobook | null): Promise<Set<string>> {
  const present = new Set<string>();
  if (record === null) return present;
  const artifacts = store.getBundle().artifacts;
  for (const take of Object.values(record.takes)) {
    if (present.has(take.artifactId)) continue;
    const sidecar = artifacts.find((artifact) => artifact.id === take.artifactId);
    if (sidecar === undefined || sidecar.retiredAt !== undefined) continue;
    const there = await stat(toExtendedLength(join(store.dir, "artifacts", fromPortable(sidecar.file)))).then((s) => s.isFile(), () => false);
    if (there) present.add(take.artifactId);
  }
  return present;
}

export interface AudiobookPlan {
  chapter: { id: string; file: string; title: string; order: number; version: number; hash: string };
  body: string;
  cast: ChapterVoices | "unreadable" | null;
  ambiguous: number;
  record: ChapterAudiobook | "unreadable" | null;
  reading: AudiobookReading;
  blocks: PlannedBlock[];
}

/**
 * A chapter as the run sees it (R-2, R-14): the saved prose, its cast, its record and every
 * block with the reader it is meant for and its state. Read once, so the blocks the run counts
 * are the blocks it makes — a save between the two would otherwise be counted one way and read
 * another, as the voiced read learnt (codex on PR 914).
 */
export async function planAudiobook(
  store: WorldStore,
  productionId: string,
  chapterId: string,
  input: { narrator: AudiobookReader },
): Promise<AudiobookPlan> {
  const production = store.getBundle().productions.find((p) => p.meta.id === productionId);
  if (!production) throw new Error("That production is no longer in this world.");
  const summary = production.chapters.find((c) => c.id === chapterId || c.file === chapterId);
  if (!summary) throw new Error("That chapter is no longer in this production.");
  const opened = await openChapter(store, productionId, summary.id);
  const cast = await readVoices(store, productionId, summary.file);
  const record = await readAudiobook(store, productionId, summary.file);
  const book = await readAudiobookBook(store, productionId);
  const reading = book === null || book === "unreadable" ? DEFAULT_AUDIOBOOK_BOOK.reading : book.reading;
  const derived = audiobookBlocks(opened.body, cast === "unreadable" ? null : cast, audiobookHeading(summary.order, summary.title));
  const sheets = store.getBundle().sheets.filter((sheet) => sheet.type === "character" && !sheet.retired);
  const present = await presentTakes(store, record === "unreadable" ? null : record);
  const blocks = assignReaders(derived.blocks, reading, input.narrator, sheets, store.getBundle().clonedVoices ?? [], record === "unreadable" ? null : record, (artifactId) => present.has(artifactId));
  return {
    chapter: { id: summary.id, file: summary.file, title: summary.title, order: summary.order, version: opened.version, hash: sha256(opened.body) },
    body: opened.body,
    cast,
    ambiguous: derived.ambiguous,
    record,
    reading,
    blocks,
  };
}
