import { mkdir, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  AudiobookBookSchema,
  ChapterAudiobookSchema,
  DEFAULT_AUDIOBOOK_BOOK,
  audiobookBlocks,
  audiobookNoteKey,
  audiobookReadingNotes,
  hasReadingNotes,
  audiobookDirectionFor,
  audiobookRekeyed,
  audiobookBlockState,
  audiobookRecordingKey,
  audiobookHeading,
  audiobookTextHash,
  CADENCE_PHRASE_MAX,
  legacyVoiceModel,
  normalizeSpeechText,
  voiceDisplayLabel,
  voiceSourceFor,
  type AudiobookBlock,
  type AudiobookBlockState,
  type AudiobookBook,
  type AudiobookDirection,
  type AudiobookDirectionInput,
  type AudiobookReader,
  type AudiobookReadingNotes,
  type AudiobookReading,
  type AudiobookSubstitution,
  type CadencePlan,
  type ChapterAudiobook,
  type ChapterVoices,
  type ClonedVoice,
  type ManifestModel,
  type Sheet,
  type Sound,
  type VoiceCandidate,
  type WorldDesignedVoice,
} from "@arke-studio/contracts";
import { clipFor } from "../voice/library.js";
import { directionPlan } from "../voice/direction.js";
import { atomicWriteFile } from "../world/atomic.js";
import { AUDIOBOOK_DIRECTION_SCHEMA_VERSION, AUDIOBOOK_GROUPED_SCHEMA_VERSION, AUDIOBOOK_MARKERS_SCHEMA_VERSION, AUDIOBOOK_NOTE_SCHEMA_VERSION, AUDIOBOOK_PERFORMED_SCHEMA_VERSION, AUDIOBOOK_PICTURES_SCHEMA_VERSION, AUDIOBOOK_READING_NOTES_SCHEMA_VERSION, AUDIOBOOK_TIMING_SCHEMA_VERSION } from "../world/commit.js";
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

/**
 * Written after every block a run lands, so a stop or a lost claim leaves the takes made so far
 * standing (R-18). A record with no direction is written without the field, in the shape the
 * first build reads, and one with a direction raises the world past that build first (codex on
 * PR 1186): its strict reader would otherwise take the record for unreadable and make the
 * chapter's paid takes again.
 */
export async function writeAudiobook(store: WorldStore, productionId: string, chapterFile: string, untimed: ChapterAudiobook): Promise<void> {
  // Timing, reactions, beds and sounds (design turn 187, R-89) the same way: each part written
  // only when it holds something, and the world raised before the first record carrying any.
  const { timing, reactions, beds, sounds, ...bare } = untimed;
  const parts = { timing, reactions, beds, sounds };
  const kept = Object.fromEntries(Object.entries(parts).filter(([, part]) => part !== undefined && Object.keys(part).length > 0));
  if (Object.keys(kept).length > 0) await store.ensureSchemaVersion(AUDIOBOOK_TIMING_SCHEMA_VERSION, "audiobook-timing");
  const record: ChapterAudiobook = { ...bare, ...kept };
  // A record with no picture is written without the field, in the shape the builds before
  // pictures read; one with a picture raises the world past them first (design turn 186, R-73).
  const { pictures, ...unpictured } = record;
  const pictured = pictures !== undefined && Object.keys(pictures).length > 0;
  if (pictured) await store.ensureSchemaVersion(AUDIOBOOK_PICTURES_SCHEMA_VERSION, "audiobook-pictures");
  const { direction, ...undirected } = pictured ? { ...unpictured, pictures } : unpictured;
  const directed = Object.keys(direction).length > 0;
  if (directed) await store.ensureSchemaVersion(AUDIOBOOK_DIRECTION_SCHEMA_VERSION, "audiobook-direction");
  // A marker, or the words a direction was written for, is a field the build before it reads
  // as unreadable (R-49): raised before the first record that carries one.
  const marked = Object.values(direction).some((entry) => entry.text !== undefined || entry.dropped !== undefined || entry.plan.cues.some((cue) => cue.kind === "delivery"));
  if (marked) await store.ensureSchemaVersion(AUDIOBOOK_MARKERS_SCHEMA_VERSION, "audiobook-markers");
  // A take that records its note was not played (R-45) is a field the build before it cannot read.
  if (Object.values(record.takes).some((take) => take.noteHeld !== undefined)) await store.ensureSchemaVersion(AUDIOBOOK_PERFORMED_SCHEMA_VERSION, "audiobook-performed");
  // A grouped take, a take's loudness or a mismatched split's flag (design turn 185).
  if (Object.values(record.takes).some((take) => take.grouped !== undefined || take.loudness !== undefined) || Object.values(record.flags).some((flag) => flag.split !== undefined)) await store.ensureSchemaVersion(AUDIOBOOK_GROUPED_SCHEMA_VERSION, "audiobook-grouped");
  // The note (design turn 181) is written under the phrase's old key while it is one — sixty
  // characters or fewer — so a block directed before the rename, or since within the old
  // bounds, stays readable by the builds before it and raises nothing. A longer note, a sound
  // or a plan with no delivery is a shape those builds refuse, and raises the world first.
  const onDisk: Record<string, unknown> = {};
  let renamed = false;
  for (const [key, entry] of Object.entries(direction)) {
    const { note, ...plan } = entry.plan;
    const fits = note === undefined || note.length <= CADENCE_PHRASE_MAX;
    if (!fits || plan.delivery === undefined || plan.cues.some((cue) => cue.kind === "sound")) renamed = true;
    onDisk[key] = note !== undefined && fits ? { ...entry, plan: { ...plan, phrase: note } } : entry;
  }
  if (renamed) await store.ensureSchemaVersion(AUDIOBOOK_NOTE_SCHEMA_VERSION, "audiobook-note");
  await writeOwned(store, audiobookPath(productionId, chapterFile), directed ? { ...undirected, direction: onDisk } : undirected, chapterFile === "book" ? undefined : legacyAudiobookPath(productionId, chapterFile));
}

/**
 * Every write to a chapter's record goes through one lane a chapter (codex on PR 1186): the
 * run writes after each block from what it holds, and a direction set or a card accepted
 * meanwhile would otherwise be a read before the run's write and a write after it — whichever
 * landed last erasing the other's takes or directions, and a take erased is a take paid for
 * again. So each writer reads the record afresh under the lane, merges its own change into it,
 * and writes; nothing is written from a snapshot.
 */
const recordLanes = new Map<string, Promise<void>>();
export async function updateAudiobook(
  store: WorldStore,
  productionId: string,
  chapter: { file: string; version: number; hash: string },
  /** The record to write, or null to leave the file as it is; may read the world afresh under the lane's turn. */
  mutate: (current: ChapterAudiobook) => ChapterAudiobook | null | Promise<ChapterAudiobook | null>,
): Promise<ChapterAudiobook> {
  const key = `${store.dir}\n${productionId}\n${chapter.file}`;
  const ahead = recordLanes.get(key) ?? Promise.resolve();
  const turn = ahead.then(async () => {
    const held = await readAudiobook(store, productionId, chapter.file);
    // An unreadable record is no record for a writer too: the takes it named stay on the shelf
    // as artifacts, and a run reads them afresh rather than guessing at a file it cannot read.
    const current = held === null || held === "unreadable" ? emptyAudiobook(chapter.version, chapter.hash, store.now()) : held;
    const next = await mutate(current);
    if (next === null) return current;
    await writeAudiobook(store, productionId, chapter.file, next);
    return next;
  });
  // The lane holds nothing once its last turn settles (codex on PR 1186), as the file
  // mutation serialiser does: a long session across many chapters would otherwise keep a
  // settled promise, and the record it resolved to, for every chapter ever written.
  const tail = turn.then(
    () => undefined,
    () => undefined,
  );
  recordLanes.set(key, tail);
  try {
    return await turn;
  } finally {
    if (recordLanes.get(key) === tail) recordLanes.delete(key);
  }
}

/**
 * Under `cast` a run needs a cast that is current (R-12), and so does a direction (codex on
 * PR 1186): a line whose speaker the cast cannot name would otherwise be directed for the
 * narrator, and a model turn spent on a chapter the next read refuses at once.
 */
export function castRefusal(plan: Pick<AudiobookPlan, "reading" | "cast" | "chapter">): string | null {
  // Under `performed`, as under `cast`, a line's note follows its speaker (R-44), so the cast
  // must be current before anything is made.
  if (plan.reading === "narrator") return null;
  if (plan.cast === null) return "not cast · cast the lines first";
  if (plan.cast === "unreadable") return "cast unreadable · cast again";
  if (plan.cast.hash !== plan.chapter.hash) return "cast moved · cast again";
  return null;
}

/**
 * Who actually speaks a block (R-12), one rule for the run and the direction (codex on PR
 * 1186): the assigned reader when the manifest knows its model, the catalogue says it can
 * speak now and, for a cloned voice, its recording is still there; the narrator otherwise,
 * with the reason. Null only when the narrator's own model is not in the manifest.
 */
export async function effectiveReader(
  store: WorldStore,
  assigned: AudiobookReader,
  input: { narrator: AudiobookReader; models: readonly ManifestModel[]; catalogue: readonly VoiceCandidate[] },
): Promise<{ reader: AudiobookReader; model: ManifestModel; substitutedNow?: AudiobookSubstitution } | null> {
  const modelOf = (reader: AudiobookReader): ManifestModel | null =>
    input.models.find((m) => m.provider === reader.provider && m.id === reader.model && m.capability === "voice-tts") ?? null;
  const narratorModel = modelOf(input.narrator);
  if (narratorModel === null) return null;
  const same = assigned.provider === input.narrator.provider && assigned.model === input.narrator.model && assigned.voiceId === input.narrator.voiceId;
  if (same) return { reader: input.narrator, model: narratorModel };
  const model = modelOf(assigned);
  const listed = input.catalogue.find((candidate) => candidate.provider === assigned.provider && candidate.model === assigned.model && candidate.voiceId === assigned.voiceId);
  const source = voiceSourceFor(store.getBundle().clonedVoices ?? [], assigned.provider, assigned.model, assigned.voiceId);
  const clipMissing = source.kind === "missing-clone" || (source.kind === "cloned" && (await clipFor(store, source.voice)) === null);
  if (model === null || listed === undefined || listed.unavailableReason !== undefined || clipMissing) {
    return { reader: input.narrator, model: narratorModel, substitutedNow: "voice unavailable" };
  }
  return { reader: assigned, model };
}

/**
 * The book's record, written with the world raised first when it carries a field the builds
 * before it cannot read (R-49): `performed`, notes, or the book's own narrator. A record
 * without them is written in the shape the earlier build reads.
 */
export async function writeAudiobookBookRaised(store: WorldStore, productionId: string, book: AudiobookBook): Promise<void> {
  const { notes, narrator, chapterNotes, noteSources, ...rest } = book;
  // A source names a note that stands, or nothing (R-54): a note taken away takes its source.
  const sources = Object.fromEntries(Object.entries(noteSources ?? {}).filter(([key]) => notes?.[key] !== undefined));
  const kept: AudiobookBook = {
    ...rest,
    ...(notes !== undefined && Object.keys(notes).length > 0 ? { notes } : {}),
    ...(narrator !== undefined ? { narrator } : {}),
    ...(chapterNotes !== undefined && Object.keys(chapterNotes).length > 0 ? { chapterNotes } : {}),
    ...(Object.keys(sources).length > 0 ? { noteSources: sources } : {}),
  };
  if (kept.reading === "performed" || kept.notes !== undefined || kept.narrator !== undefined) await store.ensureSchemaVersion(AUDIOBOOK_PERFORMED_SCHEMA_VERSION, "audiobook-performed");
  // The book note, the chapter notes and a note's source (design turn 184) are fields the builds
  // before them read as unreadable: raised before the first record that carries one.
  if (kept.note !== undefined || kept.chapterNotes !== undefined || kept.noteSources !== undefined) await store.ensureSchemaVersion(AUDIOBOOK_READING_NOTES_SCHEMA_VERSION, "audiobook-reading-notes");
  // A book read a block a request (design turn 185d).
  if (kept.requests !== undefined) await store.ensureSchemaVersion(AUDIOBOOK_GROUPED_SCHEMA_VERSION, "audiobook-grouped");
  await writeAudiobookBook(store, productionId, kept);
}

export async function writeAudiobookBook(store: WorldStore, productionId: string, book: AudiobookBook): Promise<void> {
  await writeOwned(store, audiobookBookPath(productionId), book);
  await store.reload();
}

/**
 * Whether a take alone may record its loudness (design turn 185): only in a world already raised
 * for grouped reads. The take is gained either way; the measured values are a field the builds
 * before cannot read, and one solo take must not raise a world that otherwise stays in their shape.
 */
export function recordsLoudness(store: WorldStore): boolean {
  return ((store.getBundle().meta as { schemaVersion?: number }).schemaVersion ?? 1) >= AUDIOBOOK_GROUPED_SCHEMA_VERSION;
}

export function emptyAudiobook(chapterVersion: number, hash: string, now: string): ChapterAudiobook {
  return { schemaVersion: 1, chapterVersion, hash, updatedAt: now, takes: {}, flags: {}, direction: {} };
}

/** The model that speaks a block's assigned reader, or the narrator's when the manifest lacks it. */
export function readerModel(models: readonly ManifestModel[], reader: AudiobookReader, narrator: AudiobookReader): ManifestModel | null {
  const of = (candidate: AudiobookReader) => models.find((m) => m.provider === candidate.provider && m.id === candidate.model && m.capability === "voice-tts") ?? null;
  return of(reader) ?? of(narrator);
}

/** A cloned voice's recording language is the line's (issue 1163); a catalogue voice states none. */
export function readerLanguage(clonedVoices: readonly ClonedVoice[], reader: AudiobookReader): string | undefined {
  const source = voiceSourceFor(clonedVoices, reader.provider, reader.model, reader.voiceId);
  return source.kind === "cloned" ? source.voice.language : undefined;
}

/**
 * A direction entry for these words (R-6, R-43): keyed by the words' hash, and keeping the
 * words themselves, so a later change of wording can carry its markers rather than drop them.
 */
export function directionEntry(text: string, plan: CadencePlan, at: string, dropped?: number): AudiobookDirection {
  return { textHash: audiobookTextHash(text), plan, at, text: normalizeSpeechText(text), ...(dropped !== undefined && dropped > 0 ? { dropped } : {}) };
}

/**
 * The block's direction for its words now (R-43): the record's when it was written for them,
 * otherwise the one written for earlier words carried here — delivery, phrase and speed kept,
 * each cue moved by its anchor, the rest counted in `dropped`. Null when there is none, or it
 * was written by a build that did not keep its words.
 */
export function currentDirection(record: Pick<ChapterAudiobook, "direction"> | null, block: Pick<AudiobookBlock, "key" | "text">, at: string): AudiobookDirection | null {
  const standing = audiobookDirectionFor(record, block);
  if (standing !== null) return standing;
  const carried = audiobookRekeyed(record, block);
  return carried === null ? null : directionEntry(block.text, directionPlan(block.text, carried.input), at, carried.dropped);
}

/**
 * One block's direction set or cleared (R-6): written into the record beside the chapter,
 * keyed to the block's words, through the same ownership-checked path a run writes by. The
 * record is made if the chapter has none yet. The other blocks' directions written for earlier
 * words are carried to the words now on the way (R-43), or dropped when they kept no words.
 */
export async function writeBlockDirection(
  store: WorldStore,
  productionId: string,
  chapter: { file: string; version: number; hash: string },
  blocks: readonly AudiobookBlock[],
  key: string,
  direction: AudiobookDirection | null,
): Promise<ChapterAudiobook> {
  return updateAudiobook(store, productionId, chapter, (record) => {
    const { [key]: _was, ...rest } = record.direction;
    const kept: ChapterAudiobook["direction"] = {};
    for (const other of Object.keys(rest)) {
      const block = blocks.find((candidate) => candidate.key === other);
      const carried = block === undefined ? null : currentDirection(record, block, store.now());
      if (carried !== null) kept[other] = carried;
    }
    return { ...record, updatedAt: store.now(), direction: direction === null ? kept : { ...kept, [key]: direction } };
  });
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
  /** The block's speaker is recorded by a person (SPEC-047 R-37): made only by a recording. */
  recorded?: true;
  /**
   * A reaction read as a block (design turn 187, SPEC-047 R-83): its key is `x<n>`, its words
   * are what it says, and a sound is sent as the reader's own tag for it, never as words.
   */
  reaction?: { sound?: Sound };
  /** The speaker's performance note under `performed` (R-44): the line's leading phrase. */
  note?: string;
  /** The book note and the chapter note the block is read under (design turn 184, R-53); absent when neither is set. */
  reading?: AudiobookReadingNotes;
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
  /** The book's recorded speakers (R-37), by `audiobookRecordingKey`. */
  recorded: ReadonlySet<string> = new Set(),
  /** The book's performance notes (R-44), by `audiobookNoteKey`. */
  notes: Readonly<Record<string, string>> = {},
  /** The book note and the chapter's note (R-53), which lead every block of the chapter. */
  readingNotes: AudiobookReadingNotes = {},
  /** The world's designed voices, which name a sheet's designed voice that carries no label of its own. */
  designedVoices: readonly Pick<WorldDesignedVoice, "id" | "revision" | "name">[] = [],
): PlannedBlock[] {
  const reading_ = hasReadingNotes(readingNotes) ? readingNotes : undefined;
  return blocks.map((block) => {
    const planned = ((): Omit<PlannedBlock, "state" | "block"> => {
      // Under `performed` the narrator reads every block, as under `narrator` (R-44); a line
      // carries its speaker's note, and narration none.
      if (reading === "performed") {
        const key = audiobookNoteKey(block);
        const note = key === null ? undefined : notes[key];
        return { assigned: narrator, ...(note !== undefined ? { note } : {}) };
      }
      if (reading === "narrator" || block.speaker === undefined) return { assigned: narrator };
      if (block.sheet === undefined) return { assigned: narrator, substituted: "no sheet" };
      const sheet = sheets.find((candidate) => candidate.id === block.sheet);
      const voice = sheet?.voice;
      if (sheet === undefined || voice === undefined) return { assigned: narrator, sheet: block.sheet, substituted: "no voice" };
      const model = voice.model ?? legacyVoiceModel(voice.provider, voice.voiceId, clonedVoices);
      if (model === null || model === undefined) return { assigned: narrator, sheet: block.sheet, substituted: "no voice" };
      return {
        assigned: { provider: voice.provider, model, voiceId: voice.voiceId, label: voiceDisplayLabel(voice, { designedVoices, clonedVoices }) },
        sheet: block.sheet,
        sheetVersion: voice.assignedAtVersion,
      };
    })();
    const byPerson = recorded.has(audiobookRecordingKey(block));
    return {
      block,
      ...planned,
      ...(byPerson ? { recorded: true as const } : {}),
      ...(reading_ !== undefined ? { reading: reading_ } : {}),
      state: audiobookBlockState(block, record, planned.assigned, hasArtifact, byPerson, planned.note, reading_),
    };
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
  /** The artifact ids of the record's takes that are still on the shelf with their media (codex on PR 1180). */
  present: Set<string>;
  reading: AudiobookReading;
  blocks: PlannedBlock[];
  /** The book record as read, or null when it is absent or unreadable. */
  book: AudiobookBook | null;
}

/**
 * A chapter as a held proposal would read it (design turn 184, SPEC-047 R-54, R-55): the cast
 * it carries before it is written, the chapter note it drafted, the speaker notes it drafted
 * for speakers with none, and — for a run's preparation — the directions it would put in place
 * of the record's, whole. Nothing of it is on disk until the proposal is accepted.
 */
export interface ProposalOverride {
  cast?: ChapterVoices;
  chapterNote?: string;
  speakerNotes?: Readonly<Record<string, string>>;
  directions?: Readonly<Record<string, AudiobookDirectionInput>>;
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
  input: { narrator: AudiobookReader; override?: ProposalOverride },
): Promise<AudiobookPlan> {
  const production = store.getBundle().productions.find((p) => p.meta.id === productionId);
  if (!production) throw new Error("That production is no longer in this world.");
  const summary = production.chapters.find((c) => c.id === chapterId || c.file === chapterId);
  if (!summary) throw new Error("That chapter is no longer in this production.");
  const opened = await openChapter(store, productionId, summary.id);
  const override = input.override;
  const cast = override?.cast ?? (await readVoices(store, productionId, summary.file));
  const record = await readAudiobook(store, productionId, summary.file);
  const read = await readAudiobookBook(store, productionId);
  const book = read === null || read === "unreadable" ? null : read;
  const reading = book === null ? DEFAULT_AUDIOBOOK_BOOK.reading : book.reading;
  const derived = audiobookBlocks(opened.body, cast === "unreadable" ? null : cast, audiobookHeading(summary.order, summary.title));
  const sheets = store.getBundle().sheets.filter((sheet) => sheet.type === "character" && !sheet.retired);
  const present = await presentTakes(store, record === "unreadable" ? null : record);
  const recorded = new Set(book === null ? [] : (book.recorded ?? []));
  // A drafted note stands only where the author has none (R-54): the author's always wins.
  const notes = { ...override?.speakerNotes, ...book?.notes };
  const readingNotes = audiobookReadingNotes(
    override?.chapterNote === undefined ? book : { ...book, chapterNotes: { ...book?.chapterNotes, [summary.id]: override.chapterNote } },
    summary.id,
  );
  const blocks = assignReaders(derived.blocks, reading, input.narrator, sheets, store.getBundle().clonedVoices ?? [], record === "unreadable" ? null : record, (artifactId) => present.has(artifactId), recorded, notes, readingNotes, store.getBundle().designedVoices ?? []);
  return {
    chapter: { id: summary.id, file: summary.file, title: summary.title, order: summary.order, version: opened.version, hash: sha256(opened.body) },
    body: opened.body,
    cast,
    ambiguous: derived.ambiguous,
    record,
    present,
    reading,
    blocks,
    book,
  };
}
