import { mkdir, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  AudiobookBookSchema,
  ChapterAudiobookSchema,
  DEFAULT_AUDIOBOOK_BOOK,
  audiobookBlocks,
  audiobookDirectionFor,
  audiobookRekeyed,
  audiobookBlockState,
  audiobookRecordingKey,
  audiobookHeading,
  audiobookTextHash,
  legacyVoiceModel,
  holdDirection,
  mapCadence,
  markerSegments,
  normalizeSpeechText,
  voiceSourceFor,
  type AudiobookBlock,
  type AudiobookBlockState,
  type AudiobookBook,
  type AudiobookDirection,
  type AudiobookDirectionInput,
  type AudiobookReader,
  type AudiobookReading,
  type AudiobookSubstitution,
  type CadencePlan,
  type ChapterAudiobook,
  type HeldControl,
  type ChapterVoices,
  type ClonedVoice,
  type ManifestModel,
  type Sheet,
  type VoiceCandidate,
} from "@arke-studio/contracts";
import { audioHash } from "../audio/qc.js";
import { clipFor } from "../voice/library.js";
import { splitForSpeech } from "../voice/service.js";
import { atomicWriteFile } from "../world/atomic.js";
import { AUDIOBOOK_DIRECTION_SCHEMA_VERSION, AUDIOBOOK_MARKERS_SCHEMA_VERSION } from "../world/commit.js";
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
export async function writeAudiobook(store: WorldStore, productionId: string, chapterFile: string, record: ChapterAudiobook): Promise<void> {
  const { direction, ...undirected } = record;
  const directed = Object.keys(direction).length > 0;
  if (directed) await store.ensureSchemaVersion(AUDIOBOOK_DIRECTION_SCHEMA_VERSION, "audiobook-direction");
  // A marker, or the words a direction was written for, is a field the build before it reads
  // as unreadable (R-49): raised before the first record that carries one.
  const marked = Object.values(direction).some((entry) => entry.text !== undefined || entry.dropped !== undefined || entry.plan.cues.some((cue) => cue.kind === "delivery"));
  if (marked) await store.ensureSchemaVersion(AUDIOBOOK_MARKERS_SCHEMA_VERSION, "audiobook-markers");
  await writeOwned(store, audiobookPath(productionId, chapterFile), directed ? record : undirected, chapterFile === "book" ? undefined : legacyAudiobookPath(productionId, chapterFile));
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
  if (plan.reading !== "cast") return null;
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

export async function writeAudiobookBook(store: WorldStore, productionId: string, book: AudiobookBook): Promise<void> {
  await writeOwned(store, audiobookBookPath(productionId), book);
  await store.reload();
}

export function emptyAudiobook(chapterVersion: number, hash: string, now: string): ChapterAudiobook {
  return { schemaVersion: 1, chapterVersion, hash, updatedAt: now, takes: {}, flags: {}, direction: {} };
}

/** The digest `mapCadence` verifies a plan against: the block's words, whitespace folded. */
export function directionSourceHash(text: string): string {
  return audioHash(Buffer.from(normalizeSpeechText(text)));
}

/** A plan from what a window or a derivation sends (R-6): the hashes are the block's, never the sender's. */
export function directionPlan(text: string, input: AudiobookDirectionInput): CadencePlan {
  return { schemaVersion: 1, sourceTextHash: directionSourceHash(text), delivery: input.delivery, speed: input.speed, cues: input.cues, ...(input.phrase !== undefined ? { phrase: input.phrase } : {}) };
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

/** One request's worth of a directed block: the words as sent, and the settings and sentence beside them. */
export interface RenderedPart {
  text: string;
  voiceSettings: Record<string, number>;
  instructions?: string;
}

export type DirectionCheck =
  | { ok: true; mapped: ReturnType<typeof mapCadence>; parts: RenderedPart[]; held: HeldControl[] }
  | { ok: false; reason: string };

/**
 * A directed block in parts, each rendered on its own (R-5; codex on PR 1186): the words are
 * split at sentence ends within the reader's cap, each piece carries the cues that fall in it
 * at their positions in the piece, and each is mapped whole, so the delivery's tag and the
 * phrase's lead every part rather than the first alone. A piece whose rendering still runs
 * over the cap — the tags are extra ink — is split again at half its size until it fits, so the
 * bound holds after rendering for any authored text. An emphasis whose span a seam would cut
 * cannot be carried by either piece: the direction is refused in one clause rather than sent
 * with the emphasis silently gone and its name on the take. One part for a block within the cap.
 *
 * Before the cap, a block is cut at the edges of every marker its row makes in parts (R-41):
 * a settings-only or sentence-carried delivery cannot change inside one request, so the
 * marker's words are a request of their own, with its delivery's settings and sentence, and
 * the block's reading resumes in the next.
 */
export function renderParts(text: string, plan: CadencePlan, model: ManifestModel, language: string | undefined, cap: number | undefined): RenderedPart[] {
  const out: RenderedPart[] = [];
  for (const segment of markerSegments(text, plan, model, language)) out.push(...renderSegment(segment.text, segment.plan, model, language, cap));
  return out;
}

function renderSegment(whole: string, plan: CadencePlan, model: ManifestModel, language: string | undefined, cap: number | undefined): RenderedPart[] {
  const render = (piece: string, cues: CadencePlan["cues"]): RenderedPart => {
    const mapped = mapCadence(piece, directionSourceHash(piece), { ...plan, sourceTextHash: directionSourceHash(piece), cues }, model, language);
    return { text: mapped.providerText, voiceSettings: mapped.voiceSettings, ...(mapped.instructions !== undefined ? { instructions: mapped.instructions } : {}) };
  };
  if (cap === undefined) return [render(whole, plan.cues)];
  const out: RenderedPart[] = [];
  const place = (piece: string, from: number, max: number): void => {
    const to = from + piece.length;
    for (const cue of plan.cues) {
      if ((cue.kind === "emphasis" || cue.kind === "delivery") && ((cue.span.from < from && cue.span.to > from) || (cue.span.from < to && cue.span.to > to))) {
        throw new Error(`${cue.kind === "emphasis" ? "emphasis" : "marker"} “${cue.span.text}” straddles the cap's split · shorten the span`);
      }
    }
    const cues = plan.cues
      .filter((cue) => (cue.kind === "emphasis" || cue.kind === "delivery" ? cue.span.from >= from && cue.span.to <= to : cue.at >= from && cue.at <= to))
      .map((cue) => (cue.kind === "emphasis" || cue.kind === "delivery" ? { ...cue, span: { ...cue.span, from: cue.span.from - from, to: cue.span.to - from } } : { ...cue, at: cue.at - from }));
    const rendered = render(piece, cues);
    if (rendered.text.length <= cap || max <= 1 || piece.length <= 1) {
      out.push(rendered);
      return;
    }
    let offset = 0;
    for (const smaller of splitForSpeech(piece, Math.max(1, Math.floor(max / 2)))) {
      const at = piece.indexOf(smaller, offset);
      place(smaller, from + Math.max(at, 0), Math.floor(max / 2));
      offset = Math.max(at, 0) + smaller.length;
    }
  };
  const pieces = whole.length > cap ? splitForSpeech(whole, cap) : [whole];
  let offset = 0;
  for (const piece of pieces) {
    const at = whole.indexOf(piece, offset);
    place(piece, Math.max(at, 0), cap);
    offset = Math.max(at, 0) + piece.length;
  }
  return out;
}

/**
 * A direction held to its block and its reader (R-9): every cue is checked by `mapCadence`
 * against the words it names, and the parts the reader's cap makes of the block are rendered
 * here too, so a cue no part can carry is refused where the direction is written.
 *
 * `strict` is the author's write (R-42): a control the reader cannot express is refused in one
 * clause, never accepted to be flagged later — except one the stored direction already holds,
 * which a write of another control carries on unchanged. `hold` is everything after (R-47): a
 * reader change, a run, an accepted card — what the reader cannot express is left out of what
 * is sent and named in `held`, and the direction stands for a reader that can.
 */
export function checkDirection(text: string, plan: CadencePlan, model: ManifestModel, language?: string, mode: "strict" | "hold" = "strict", alreadyHeld: readonly string[] = []): DirectionCheck {
  let sent: CadencePlan;
  let held: HeldControl[];
  let mapped: ReturnType<typeof mapCadence>;
  try {
    mapped = mapCadence(text, directionSourceHash(text), plan, model, language);
    ({ plan: sent, held } = holdDirection(text, plan, model, language));
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  if (mode === "strict") {
    const fresh = held.find((control) => !alreadyHeld.includes(heldKey(plan, control)));
    if (fresh !== undefined) {
      const name = fresh.control === "delivery" ? plan.delivery : fresh.control === "marker" ? markerName(plan, fresh.cueIndex) : fresh.control;
      return { ok: false, reason: `${name} · ${model.displayName} ${fresh.reason}`.replace(/\.$/, "") };
    }
  }
  let parts: RenderedPart[];
  try {
    parts = renderParts(text, sent, model, language, model.limits.maxPromptChars);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, mapped, parts, held };
}

function markerName(plan: CadencePlan, cueIndex: number | undefined): string {
  const cue = cueIndex === undefined ? undefined : plan.cues[cueIndex];
  return cue?.kind === "delivery" ? `[${cue.delivery ?? cue.phrase}]` : "marker";
}

/**
 * A held control named by what it is rather than where it sits, so the same control held
 * before and after a write matches although other cues moved around it.
 */
export function heldKey(plan: CadencePlan, control: HeldControl): string {
  if (control.cueIndex !== undefined) return `cue:${JSON.stringify(plan.cues[control.cueIndex])}`;
  if (control.control === "delivery") return `delivery:${plan.delivery}`;
  if (control.control === "phrase") return `phrase:${plan.phrase ?? ""}`;
  if (control.control === "speed") return `speed:${plan.speed}`;
  return control.control;
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
    const byPerson = recorded.has(audiobookRecordingKey(block));
    return { block, ...planned, ...(byPerson ? { recorded: true as const } : {}), state: audiobookBlockState(block, record, planned.assigned, hasArtifact, byPerson) };
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
  const recorded = new Set(book === null || book === "unreadable" ? [] : (book.recorded ?? []));
  const blocks = assignReaders(derived.blocks, reading, input.narrator, sheets, store.getBundle().clonedVoices ?? [], record === "unreadable" ? null : record, (artifactId) => present.has(artifactId), recorded);
  return {
    chapter: { id: summary.id, file: summary.file, title: summary.title, order: summary.order, version: opened.version, hash: sha256(opened.body) },
    body: opened.body,
    cast,
    ambiguous: derived.ambiguous,
    record,
    present,
    reading,
    blocks,
  };
}
