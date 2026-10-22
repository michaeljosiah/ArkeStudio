import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  GUIDE_MEDIA_TYPE,
  GUIDE_RECORD_FILE,
  GuideRecordSchema,
  EMPTY_GUIDE_RECORD,
  guideCounts,
  guideDocument,
  guideProductionsOf,
  guideSheetPicture,
  MAX_GUIDE_VOICE_MS,
  packageSlug,
  type AudiobookTake,
  type GuideDocument,
  type GuideProductionChapters,
  type GuideRecord,
  type GuideRecordVoice,
  type GuideVoiceLine,
  type ListeningChapter,
  type SetGuideEntry,
} from "@arke-studio/contracts";
import { fitReadingImage, pngHasAlpha } from "../references/reading-image.js";
import type { FfmpegRunner } from "../takes/export.js";
import { toExtendedLength } from "../world/paths.js";
import type { WorldStore } from "../world/store.js";
import { sha256 } from "../world/text-files.js";
import { planAudiobook } from "./audiobook.js";
import { anyNarrator, audiobookListening } from "./audiobook-listening.js";
import { containedWorldFile } from "./interactive.js";

/** A guide's pictures are portraits and places on a phone's page, not a chapter's full screen (R-13). */
const GUIDE_PICTURE_EDGE = 1024;

/**
 * A world's Guide in the coordinator (SPEC-059 R-1 – R-8): the record's one write, the chapters an
 * `after` can name, and the lines a character's voice line is chosen from. What the record makes
 * public is read by `guideDocument` in contracts, for the Studio's preview and the package alike.
 */

/** The record as on disk; a world without one has chosen nothing (R-2). */
async function liveGuide(store: WorldStore): Promise<{ raw: string | null; record: GuideRecord }> {
  let raw: string;
  try {
    raw = await readFile(toExtendedLength(join(store.dir, GUIDE_RECORD_FILE)), "utf8");
  } catch {
    return { raw: null, record: EMPTY_GUIDE_RECORD };
  }
  // A record that will not read is not written over: the choices in it are the author's, and an
  // empty Guide in their place would quietly unpublish everything at the next package.
  const parsed = GuideRecordSchema.safeParse((() => { try { return JSON.parse(raw) as unknown; } catch { return null; } })());
  if (!parsed.success) throw new Error("guide.json can't be read · fix it or remove it");
  return { raw, record: parsed.data };
}

/**
 * One Guide write at a time for each world. The coordinator handles frames concurrently, so two
 * switches flipped quickly would otherwise both read the same record, and the second's commit would
 * fail its base hash and be lost (codex on PR 2156): each change reads what the last one wrote.
 */
const lanes = new WeakMap<WorldStore, Promise<unknown>>();

/** Replaces one entry's choices, or clears them (R-4, R-8), through the world's own write. */
export function setGuideEntry(store: WorldStore, change: SetGuideEntry, source: string): Promise<void> {
  const run = (lanes.get(store) ?? Promise.resolve()).then(() => writeGuideEntry(store, change, source));
  lanes.set(store, run.catch(() => {}));
  return run;
}

async function writeGuideEntry(store: WorldStore, change: SetGuideEntry, source: string): Promise<void> {
  const { raw, record } = await liveGuide(store);
  const kind = record[change.entryKind] as Record<string, unknown>;
  const next = { ...kind };
  if (change.entry === null) delete next[change.id];
  else next[change.id] = change.entry;
  const written: GuideRecord = GuideRecordSchema.parse({ ...record, [change.entryKind]: next });
  await store.commit({
    kind: "guide-save",
    source,
    files: [{ path: GUIDE_RECORD_FILE, action: raw === null ? "create" : "replace", content: `${JSON.stringify(written, null, 2)}\n`, baseHash: raw === null ? null : sha256(raw) }],
  });
}

/** Each production's chapters as the Guide numbers them (contracts' `guideProductionsOf`). */
export function guideProductions(store: WorldStore): GuideProductionChapters[] {
  return guideProductionsOf(store.getBundle().productions);
}

/** A chapter read whole: every block made, as the package's narration needs. */
const readWhole = (chapter: ListeningChapter) => chapter.state === "read" && (chapter.blocks.length > 0 || (chapter.audioStudio !== undefined && chapter.mix !== undefined));

/**
 * A chapter's lines in one character's own voice (R-6): each sentence of a block whose retained
 * take — the one the chapter plays — records that character as its speaker and was not handed to
 * the narrator, short enough to be a voice line. The plan says who a block is meant for; only the
 * take says who read it, and a take kept for its words may be a narrator's stand-in (codex on PR
 * 2156). A sentence starts where the plan places it in its block and runs to the next one, as an
 * offset into the take.
 *
 * A chapter arranged in Audio Studio offers none: its sentences sit on the arranged clock and its
 * blocks name a performance's source, so no offset into one file is the passage heard.
 */
export function chapterVoiceLines(chapter: ListeningChapter, takes: Readonly<Record<string, Pick<AudiobookTake, "artifactId" | "sheet" | "substituted">>>, characterId: string, production: { id: string; title: string; number: number }): GuideVoiceLine[] {
  if (chapter.audioStudio !== undefined) return [];
  const lines: GuideVoiceLine[] = [];
  for (const block of chapter.blocks) {
    const take = takes[block.key];
    if (take === undefined || take.sheet !== characterId || take.substituted !== undefined || (block.artifactId !== undefined && block.artifactId !== take.artifactId)) continue;
    block.sentences.forEach((sentence, index) => {
      const start = Math.max(0, sentence.at - block.at);
      const end = (block.sentences[index + 1]?.at ?? block.at + block.seconds) - block.at;
      const seconds = end - start;
      const text = sentence.text.trim();
      if (text === "" || seconds <= 0 || seconds * 1000 > MAX_GUIDE_VOICE_MS) return;
      lines.push({ production: production.id, productionTitle: production.title, chapter: chapter.chapterId, chapterNumber: production.number, block: block.key, sentence: index, text, file: block.file, start, seconds });
    });
  }
  return lines;
}

/** A character's lines across the world's productions, in manuscript order (R-6). */
export async function guideVoiceLines(store: WorldStore, characterId: string, signal?: AbortSignal): Promise<GuideVoiceLine[]> {
  const lines: GuideVoiceLine[] = [];
  for (const production of guideProductions(store)) {
    signal?.throwIfAborted();
    const numbers = new Map(production.chapters.map((chapter) => [chapter.id, chapter.number]));
    const listening = await audiobookListening(store, production.id, signal !== undefined ? { signal } : {}).catch(() => null);
    if (listening === null) continue;
    const narrator = await anyNarrator(store, production.id);
    for (const chapter of listening.chapters.filter(readWhole)) {
      const plan = await planAudiobook(store, production.id, chapter.chapterId, { narrator }).catch(() => null);
      const record = plan === null || plan.record === "unreadable" ? null : plan.record;
      if (record === null) continue;
      lines.push(...chapterVoiceLines(chapter, record.takes, characterId, { id: production.id, title: production.title, number: numbers.get(chapter.chapterId) ?? chapter.order }));
    }
  }
  return lines;
}

/** The line a record names, as it is now: null when its take, block or sentence is gone. */
export function resolveGuideVoice(lines: readonly GuideVoiceLine[], voice: GuideRecordVoice): GuideVoiceLine | null {
  return lines.find((line) => line.production === voice.production && line.chapter === voice.chapter && line.block === voice.block && line.sentence === voice.sentence) ?? null;
}

const SHEET_TYPES = { characters: "character", locations: "location", factions: "faction" } as const;

/**
 * The guide as it would ship now, its pictures and voice lines named by where they are in the
 * world rather than as package files: what the export packs (R-15) and what it compares under the
 * gate. A picture the world does not hold, and a voice line no longer read, are left out. Null when
 * nothing is public. `places` gives the packaged production's chapters their EPUB documents.
 */
export async function guideDraft(store: WorldStore, places?: { production: string; book: ReadonlyMap<string, string> }, signal?: AbortSignal): Promise<{ document: GuideDocument; lines: ReadonlyMap<string, GuideVoiceLine> } | null> {
  const bundle = store.getBundle();
  const record = bundle.guide;
  const world = {
    characters: bundle.sheets.filter((sheet) => sheet.type === SHEET_TYPES.characters),
    locations: bundle.sheets.filter((sheet) => sheet.type === SHEET_TYPES.locations),
    factions: bundle.sheets.filter((sheet) => sheet.type === SHEET_TYPES.factions),
    canon: bundle.canon,
  };
  const counts = guideCounts(record, world);
  if (counts.characters.public + counts.places.public + counts.lore.public === 0) return null;

  const pictures = new Map<string, string>();
  for (const kind of ["characters", "locations", "factions"] as const) {
    for (const sheet of world[kind]) {
      if (record[kind][sheet.id]?.public !== true) continue;
      const path = guideSheetPicture(bundle.referenceKits, kind, sheet.id);
      if ((await containedWorldFile(store.dir, path)) !== null) pictures.set(`${kind}:${sheet.id}`, path);
    }
  }
  // Only the characters whose voice line ships are asked for their lines: listing them reads every
  // chapter's plan. Kept by the entry's id, which for a character is its sheet's package slug, as
  // characters are named first.
  const lines = new Map<string, GuideVoiceLine>();
  for (const sheet of world.characters) {
    const entry = record.characters[sheet.id];
    if (entry?.public !== true || entry.voice === undefined) continue;
    const line = resolveGuideVoice(await guideVoiceLines(store, sheet.id, signal), entry.voice);
    if (line !== null && (await containedWorldFile(store.dir, line.file)) !== null) lines.set(packageSlug(sheet.id), line);
  }
  const productions = guideProductionsOf(bundle.productions).map((production) =>
    places?.production !== production.id ? production : { ...production, chapters: production.chapters.map((chapter) => (places.book.has(chapter.id) ? { ...chapter, book: places.book.get(chapter.id)! } : chapter)) },
  );
  const document = guideDocument(record, {
    ...world,
    productions,
    picture: (kind, sheet) => pictures.get(`${kind}:${sheet.id}`),
    voice: (sheet) => {
      const line = lines.get(packageSlug(sheet.id));
      return line === undefined ? undefined : { audio: line.file, text: line.text.slice(0, 2000), duration: Math.min(MAX_GUIDE_VOICE_MS, Math.max(1, Math.round(line.seconds * 1000))), production: line.production, chapter: line.chapter };
    },
  });
  return document === null ? null : { document, lines };
}

export interface GuidePacking {
  ffmpeg: FfmpegRunner;
  signal: AbortSignal;
  /** Where a package path is made on disk. */
  at: (path: string) => string;
  /** Records a made file in the package's inventory. */
  add: (assetId: string, path: string, mediaType: string) => Promise<void>;
  /** Says a file's original digest, for the package's provenance. */
  original: (assetId: string, file: string) => Promise<void>;
}

/**
 * The guide in a package (R-13, R-15): each picture fitted to 1024 px (a transparent one stays
 * PNG), each voice line cut from its take as M4A, every file once however many entries show it,
 * and the guide document naming them by their package ids. Null when nothing is public.
 */
export async function packGuide(draft: GuideDocument, lines: ReadonlyMap<string, GuideVoiceLine>, store: WorldStore, packing: GuidePacking): Promise<{ ok: true } | { ok: false; blocker: string }> {
  const ids = new Map<string, string>();
  let numbered = 0;
  const fit = async (file: string): Promise<string> => {
    const known = ids.get(file);
    if (known !== undefined) return known;
    const real = (await containedWorldFile(store.dir, file))!;
    const keepsAlpha = pngHasAlpha(await readFile(toExtendedLength(real)));
    const assetId = `g${String(++numbered).padStart(3, "0")}`;
    const path = `guide/${assetId}.${keepsAlpha ? "png" : "jpg"}`;
    await fitReadingImage(real, packing.at(path), keepsAlpha, packing.ffmpeg, packing.signal, GUIDE_PICTURE_EDGE);
    await packing.add(assetId, path, keepsAlpha ? "image/png" : "image/jpeg");
    await packing.original(assetId, real);
    ids.set(file, assetId);
    return assetId;
  };
  const cut = async (characterId: string): Promise<string> => {
    const line = lines.get(characterId)!;
    const real = (await containedWorldFile(store.dir, line.file))!;
    const assetId = `g${String(++numbered).padStart(3, "0")}`;
    const path = `guide/${assetId}.m4a`;
    const seconds = Math.min(line.seconds, MAX_GUIDE_VOICE_MS / 1000);
    await packing.ffmpeg.run(["-y", "-ss", line.start.toFixed(3), "-t", seconds.toFixed(3), "-i", real, "-vn", "-ac", "1", "-ar", "44100", "-c:a", "aac", "-b:a", "96k", packing.at(path)], () => {}, packing.signal);
    await packing.add(assetId, path, "audio/mp4");
    return assetId;
  };

  await mkdir(toExtendedLength(packing.at("guide")), { recursive: true });
  const characters: GuideDocument["characters"] = [];
  try {
    for (const character of draft.characters) {
      const portrait = character.portrait !== undefined ? await fit(character.portrait) : undefined;
      const audio = character.voice !== undefined && lines.has(character.id) ? await cut(character.id) : undefined;
      characters.push({ ...character, ...(portrait !== undefined ? { portrait } : {}), ...(character.voice !== undefined && audio !== undefined ? { voice: { ...character.voice, audio } } : {}) });
    }
    const places: GuideDocument["places"] = [];
    for (const place of draft.places) places.push({ ...place, ...(place.picture !== undefined ? { picture: await fit(place.picture) } : {}) });
    const document: GuideDocument = { ...draft, characters, places };
    await writeFile(toExtendedLength(packing.at("guide/guide.json")), `${JSON.stringify(document, null, 2)}\n`, "utf8");
    await packing.add("guide", "guide/guide.json", GUIDE_MEDIA_TYPE);
  } catch {
    if (packing.signal.aborted) throw packing.signal.reason;
    return { ok: false, blocker: "the guide's pictures or voice lines could not be made" };
  }
  return { ok: true };
}
