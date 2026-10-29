import { createHash } from "node:crypto";
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
  guideTeasers,
  listeningPictureNamed,
  MAX_GUIDE_VOICE_MS,
  MAX_MUSIC_TRACK_MS,
  MAX_TEASER_CLIP_MS,
  musicTrackLengthMs,
  packageSlug,
  productionShape,
  type AudiobookListening,
  type AudiobookTake,
  type GuideDocument,
  type GuideMadeMoment,
  type GuideMadeSong,
  type GuideProductionChapters,
  type GuideRecord,
  type GuideRecordMoment,
  type GuideRecordSong,
  type GuideRecordVoice,
  type GuideTeaser,
  type GuideVoiceLine,
  type ListeningChapter,
  type MusicRecord,
  type SetGuideEntry,
  type SetGuideTeasers,
  type WorldBundle,
} from "@arke-studio/contracts";
import { fitReadingImage, pngHasAlpha } from "../references/reading-image.js";
import type { FfmpegRunner } from "../takes/export.js";
import { GUIDE_TEASERS_SCHEMA_VERSION } from "../world/commit.js";
import { toExtendedLength } from "../world/paths.js";
import type { WorldStore } from "../world/store.js";
import { sha256 } from "../world/text-files.js";
import { planAudiobook } from "./audiobook.js";
import { anyNarrator, audiobookListening } from "./audiobook-listening.js";
import { containedWorldFile } from "./interactive.js";
import { musicRenderPlan, renderMusicTrack } from "./music-render.js";

/** A guide's pictures are portraits and places on a phone's page, not a chapter's full screen (R-13). */
const GUIDE_PICTURE_EDGE = 1024;
/** A picture teaser opens full screen (SPEC-059 R-29, R-32), so it ships larger than a portrait. */
const TEASER_PICTURE_EDGE = 1280;
/** A clip's loop is a tile's and a phone's, not a chapter's full screen. */
const TEASER_LOOP_SIDE = 720;

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

const inLane = (store: WorldStore, write: () => Promise<void>): Promise<void> => {
  const run = (lanes.get(store) ?? Promise.resolve()).then(write);
  lanes.set(store, run.catch(() => {}));
  return run;
};

/** Replaces one entry's choices, or clears them (R-4, R-8), through the world's own write. */
export function setGuideEntry(store: WorldStore, change: SetGuideEntry, source: string): Promise<void> {
  return inLane(store, async () => {
    const { raw, record } = await liveGuide(store);
    const kind = record[change.entryKind] as Record<string, unknown>;
    const next = { ...kind };
    if (change.entry === null) delete next[change.id];
    else next[change.id] = change.entry;
    // A theme raises the world at the commit (R-35): a build before it reads the record as unreadable.
    await writeGuide(store, raw, GuideRecordSchema.parse({ ...record, [change.entryKind]: next }), source);
  });
}

/** Replaces the teasers whole, in the author's order (R-24, R-27): Add, remove and a drag are each a new list. */
export function setGuideTeasers(store: WorldStore, change: SetGuideTeasers, source: string): Promise<void> {
  return inLane(store, async () => {
    const { raw, record } = await liveGuide(store);
    const { teasers: _teasers, ...rest } = record;
    // A build before teasers reads a record naming them as unreadable, so the world says first
    // that it needs a build that knows them.
    if (change.teasers.length > 0) await store.ensureSchemaVersion(GUIDE_TEASERS_SCHEMA_VERSION, "guide-teasers");
    // A song is newer still (R-36), and raises the world at the commit, as a theme does.
    await writeGuide(store, raw, GuideRecordSchema.parse(change.teasers.length > 0 ? { ...rest, teasers: change.teasers } : rest), source);
  });
}

async function writeGuide(store: WorldStore, raw: string | null, written: GuideRecord, source: string): Promise<void> {
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
    for (const chapter of listening.chapters.filter(readWhole)) {
      const plan = await planAudiobook(store, production.id, chapter.chapterId, { narrator: await anyNarrator(store, production.id, chapter.chapterId) }).catch(() => null);
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

/** A clip's narration as it is cut: a run of pieces of takes, or of the chapter's mix, back to back. */
export interface GuideClipCut {
  segments: Array<{ file: string; start: number; seconds: number }>;
}

/** A song teaser's excerpt as it is cut (R-36, R-37): a window on its track's render. */
export interface GuideSongCut {
  /** The track's render, absolute: Play all's and the album's own (SPEC-060 R-8, R-16). */
  path: string;
  start: number;
  seconds: number;
}

/** The guide as it would ship, its files still the world's: what the export packs and compares. */
export interface GuideDraft {
  document: GuideDocument;
  lines: ReadonlyMap<string, GuideVoiceLine>;
  /** Each clip teaser's narration, by the name the draft's `audio` gives it. */
  clips: ReadonlyMap<string, GuideClipCut>;
  /** Each song teaser's excerpt, by the name the draft's `audio` gives it. */
  songs?: ReadonlyMap<string, GuideSongCut>;
}

/** A track of one of the world's music productions, with its album, as the bundle holds them. */
export function guideMusicTrack(bundle: Pick<WorldBundle, "productions">, production: string, track: string): { record: MusicRecord; track: MusicRecord["tracks"][number]; title: string } | undefined {
  const found = bundle.productions.find((candidate) => candidate.meta.id === production);
  if (found === undefined || !productionShape(found.meta).isMusic) return undefined;
  const record = found.music ?? null;
  const entry = record?.tracks.find((candidate) => candidate.id === track);
  return record !== null && entry !== undefined ? { record, track: entry, title: found.meta.title } : undefined;
}

const songKey = (teaser: GuideRecordSong) => `${teaser.production}\n${teaser.track}`;

/**
 * The songs the teasers name, as they are now (SPEC-059 R-36, R-37): each a window of at most 30
 * seconds on its track as the album plays it — its trim, fades and loudness, the render the export
 * ships (SPEC-060 R-16) — with the album's square cover, or the world's key art where it has none.
 * A track that is gone, or one that will not render, is left out.
 */
export async function guideSongs(store: WorldStore, choices: GuideRecord["teasers"], signal?: AbortSignal, ffmpeg?: FfmpegRunner): Promise<{ made: Map<string, GuideMadeSong>; songs: Map<string, GuideSongCut> }> {
  const made = new Map<string, GuideMadeSong>();
  const songs = new Map<string, GuideSongCut>();
  const bundle = store.getBundle();
  for (const choice of choices ?? []) {
    if (choice.kind !== "song" || ffmpeg === undefined) continue;
    const found = guideMusicTrack(bundle, choice.production, choice.track);
    if (found === undefined) continue;
    const plan = musicRenderPlan({ tracks: [found.track] }, bundle.artifacts);
    if (!plan.ok) continue;
    const planned = plan.tracks[0]!;
    // The excerpt is a window on the track alone: its gap and its join to the next are the album's.
    let rendered: Awaited<ReturnType<typeof renderMusicTrack>>;
    try {
      rendered = await renderMusicTrack(store.dir, { ...planned, gapMs: 0 }, found.record.loudness, { ffmpeg, ...(signal !== undefined ? { signal } : {}) });
    } catch {
      if (signal?.aborted) throw signal.reason;
      continue;
    }
    const startMs = Math.min(choice.start, Math.max(0, rendered.durationMs - 1000));
    const lengthMs = Math.min(choice.duration, MAX_TEASER_CLIP_MS, rendered.durationMs - startMs);
    if (!(lengthMs > 0)) continue;
    const cover = found.record.cover === undefined ? undefined : bundle.artifacts.find((artifact) => artifact.id === found.record.cover);
    const coverFile = cover !== undefined ? `artifacts/${cover.file}` : bundle.keyArt ?? undefined;
    if (coverFile === undefined || (await containedWorldFile(store.dir, coverFile)) === null) continue;
    // Named by what it is cut from, so a track edited or made again changes the draft the gate compares.
    const audio = `song-${createHash("sha256").update(JSON.stringify([rendered.file, startMs, lengthMs])).digest("hex").slice(0, 16)}`;
    songs.set(audio, { path: rendered.path, start: startMs / 1000, seconds: lengthMs / 1000 });
    made.set(songKey(choice), { title: found.track.title, picture: coverFile, audio, duration: lengthMs });
  }
  return { made, songs };
}

const momentKey = (teaser: GuideRecordMoment) => `${teaser.kind}\n${teaser.production}\n${teaser.chapter}\n${teaser.block}`;

/**
 * The moments a picture or clip teaser names, as they are now (SPEC-059 R-25, R-27): the moment's
 * picture by its world path, and for a clip its narration — at most 30 seconds from the moment's
 * start and never past its hold — from a chapter read whole. A moment that is gone, a picture the
 * world does not hold, or a clip whose chapter is no longer read whole is left out.
 */
export async function guideMoments(store: WorldStore, choices: GuideRecord["teasers"], signal?: AbortSignal, ffmpeg?: FfmpegRunner): Promise<{ made: Map<string, GuideMadeMoment>; clips: Map<string, GuideClipCut> }> {
  const made = new Map<string, GuideMadeMoment>();
  const clips = new Map<string, GuideClipCut>();
  const plans = new Map<string, AudiobookListening | null>();
  for (const choice of choices ?? []) {
    if (choice.kind !== "picture" && choice.kind !== "clip") continue;
    // With the export's own ffmpeg, so a chapter arranged from a compressed source reads here as it
    // does in the package (codex on PR 2173).
    if (!plans.has(choice.production)) plans.set(choice.production, await audiobookListening(store, choice.production, { ...(signal !== undefined ? { signal } : {}), ...(ffmpeg !== undefined ? { ffmpeg } : {}) }).catch(() => null));
    const chapter = plans.get(choice.production)?.chapters.find((candidate) => candidate.chapterId === choice.chapter);
    // A mark by its own key, as a block's own picture is by its block's (design turn 237, R-202).
    const moment = chapter === undefined ? undefined : listeningPictureNamed(chapter.pictures, choice.block);
    if (chapter === undefined || moment === undefined || (await containedWorldFile(store.dir, moment.file)) === null) continue;
    const title = chapter.title.trim() === "" ? `Chapter ${chapter.order}` : chapter.title.trim();
    if (choice.kind === "picture") {
      made.set(momentKey(choice), { title, picture: moment.file });
      continue;
    }
    if (!readWhole(chapter)) continue;
    const seconds = Math.min(MAX_TEASER_CLIP_MS / 1000, moment.seconds, chapter.seconds - moment.at);
    if (!(seconds > 0)) continue;
    const from = moment.at;
    const to = from + seconds;
    const segments =
      chapter.mix !== undefined
        ? [{ file: chapter.mix.file, start: from, seconds }]
        : chapter.blocks
            .filter((block) => block.at < to && block.at + block.seconds > from)
            .map((block) => ({ file: block.file, start: Math.max(0, from - block.at), seconds: Math.min(to, block.at + block.seconds) - Math.max(from, block.at) }));
    if (segments.length === 0) continue;
    let contained = true;
    for (const segment of segments) if ((await containedWorldFile(store.dir, segment.file)) === null) contained = false;
    if (!contained) continue;
    // Named by what it is cut from, so a take made again changes the draft the gate compares.
    const audio = `clip-${createHash("sha256").update(JSON.stringify(segments)).digest("hex").slice(0, 16)}`;
    clips.set(audio, { segments });
    // A loop with a problem (a retired artifact, a picture changed under it) ships its still, as
    // the narration's export does (codex on PR 2173).
    const loop = moment.motion !== undefined && moment.motionProblem === undefined && (await containedWorldFile(store.dir, moment.motion.file)) !== null ? moment.motion.file : undefined;
    made.set(momentKey(choice), { title, picture: moment.file, audio, duration: Math.max(1, Math.round(seconds * 1000)), ...(loop !== undefined ? { motion: loop } : {}) });
  }
  return { made, clips };
}

/**
 * The guide as it would ship now, its pictures and voice lines named by where they are in the
 * world rather than as package files: what the export packs (R-15) and what it compares under the
 * gate. A picture the world does not hold, and a voice line no longer read, are left out. Null when
 * nothing is public and there are no teasers. `places` gives the packaged production's chapters
 * their EPUB documents.
 */
export async function guideDraft(store: WorldStore, places?: { production: string; book: ReadonlyMap<string, string> }, signal?: AbortSignal, ffmpeg?: FfmpegRunner): Promise<GuideDraft | null> {
  const bundle = store.getBundle();
  const record = bundle.guide;
  const world = {
    characters: bundle.sheets.filter((sheet) => sheet.type === SHEET_TYPES.characters),
    locations: bundle.sheets.filter((sheet) => sheet.type === SHEET_TYPES.locations),
    factions: bundle.sheets.filter((sheet) => sheet.type === SHEET_TYPES.factions),
    canon: bundle.canon,
  };
  const counts = guideCounts(record, world);
  if (counts.characters.public + counts.places.public + counts.lore.public + counts.teasers.chosen === 0) return null;

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
  const moments = await guideMoments(store, record.teasers, signal, ffmpeg);
  const songs = await guideSongs(store, record.teasers, signal, ffmpeg);
  const document = guideDocument(record, {
    ...world,
    productions,
    picture: (kind, sheet) => pictures.get(`${kind}:${sheet.id}`),
    voice: (sheet) => {
      const line = lines.get(packageSlug(sheet.id));
      return line === undefined ? undefined : { audio: line.file, text: line.text.slice(0, 2000), duration: Math.min(MAX_GUIDE_VOICE_MS, Math.max(1, Math.round(line.seconds * 1000))), production: line.production, chapter: line.chapter };
    },
    moment: (teaser) => moments.made.get(momentKey(teaser)),
    // A theme carries its track's title and length as it plays (R-37); a track never measured has
    // no length to name, so it waits, as a total does (#253).
    theme: (theme) => {
      const found = guideMusicTrack(bundle, theme.production, theme.track);
      const length = found === undefined ? null : musicTrackLengthMs(found.track, bundle.artifacts);
      return found === undefined || length === null || length < 1 ? undefined : { title: found.track.title, duration: Math.min(MAX_MUSIC_TRACK_MS, length) };
    },
    song: (teaser) => songs.made.get(songKey(teaser)),
  });
  return document === null ? null : { document, lines, clips: moments.clips, songs: songs.songs };
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
 * The guide in a package (R-13, R-15, R-29): each picture fitted to 1024 px (a teaser's to 1280; a
 * transparent one stays PNG), each voice line cut from its take as M4A, each clip's narration cut
 * and joined as M4A and its loop fitted, every file once however many entries show it, and the
 * guide document naming them by their package ids.
 */
export async function packGuide(drafted: GuideDraft, store: WorldStore, packing: GuidePacking): Promise<{ ok: true } | { ok: false; blocker: string }> {
  const { document: draft, lines, clips } = drafted;
  const songs = drafted.songs ?? new Map<string, GuideSongCut>();
  const ids = new Map<string, string>();
  let numbered = 0;
  const fit = async (file: string, edge = GUIDE_PICTURE_EDGE, prefix = "g", folder = "guide"): Promise<string> => {
    const known = ids.get(`${edge}\n${file}`);
    if (known !== undefined) return known;
    const real = (await containedWorldFile(store.dir, file))!;
    const keepsAlpha = pngHasAlpha(await readFile(toExtendedLength(real)));
    const assetId = `${prefix}${String(++numbered).padStart(3, "0")}`;
    const path = `${folder}/${assetId}.${keepsAlpha ? "png" : "jpg"}`;
    await fitReadingImage(real, packing.at(path), keepsAlpha, packing.ffmpeg, packing.signal, edge);
    await packing.add(assetId, path, keepsAlpha ? "image/png" : "image/jpeg");
    await packing.original(assetId, real);
    ids.set(`${edge}\n${file}`, assetId);
    return assetId;
  };
  // A clip's narration (R-25): its pieces joined back to back as one mono M4A, as a voice line is cut.
  const clip = async (audio: string): Promise<string> => {
    const cut = clips.get(audio)!;
    const inputs: string[] = [];
    for (const segment of cut.segments) inputs.push("-ss", segment.start.toFixed(3), "-t", segment.seconds.toFixed(3), "-i", (await containedWorldFile(store.dir, segment.file))!);
    const join = `${cut.segments.map((_, index) => `[${index}:a]aformat=sample_rates=44100:channel_layouts=mono[a${index}]`).join(";")};${cut.segments.map((_, index) => `[a${index}]`).join("")}concat=n=${cut.segments.length}:v=0:a=1[out]`;
    const assetId = `t${String(++numbered).padStart(3, "0")}`;
    const path = `guide/teasers/${assetId}.m4a`;
    await packing.ffmpeg.run(["-y", ...inputs, "-filter_complex", join, "-map", "[out]", "-ac", "1", "-ar", "44100", "-c:a", "aac", "-b:a", "96k", packing.at(path)], () => {}, packing.signal);
    await packing.add(assetId, path, "audio/mp4");
    return assetId;
  };
  // A song's excerpt (R-37): a window on its track's render, kept stereo, at most 30 seconds.
  const song = async (audio: string): Promise<string> => {
    const cut = songs.get(audio)!;
    const assetId = `t${String(++numbered).padStart(3, "0")}`;
    const path = `guide/teasers/${assetId}.m4a`;
    const seconds = Math.min(cut.seconds, MAX_TEASER_CLIP_MS / 1000);
    await packing.ffmpeg.run(["-y", "-ss", cut.start.toFixed(3), "-t", seconds.toFixed(3), "-i", cut.path, "-vn", "-map_metadata", "-1", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", packing.at(path)], () => {}, packing.signal);
    await packing.add(assetId, path, "audio/mp4");
    return assetId;
  };
  const loop = async (file: string): Promise<string> => {
    const real = (await containedWorldFile(store.dir, file))!;
    const assetId = `t${String(++numbered).padStart(3, "0")}`;
    const path = `guide/teasers/${assetId}.mp4`;
    const side = `scale='min(${TEASER_LOOP_SIDE},iw)':'min(${TEASER_LOOP_SIDE},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`;
    await packing.ffmpeg.run(["-y", "-i", real, "-an", "-vf", side, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", packing.at(path)], () => {}, packing.signal);
    await packing.add(assetId, path, "video/mp4");
    await packing.original(assetId, real);
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
    const teasers: GuideTeaser[] = [];
    const drafts = guideTeasers(draft);
    if (drafts.some((teaser) => teaser.kind !== "character" && teaser.kind !== "place")) await mkdir(toExtendedLength(packing.at("guide/teasers")), { recursive: true });
    for (const teaser of drafts) {
      if (teaser.kind === "picture") teasers.push({ ...teaser, picture: await fit(teaser.picture, TEASER_PICTURE_EDGE, "t", "guide/teasers") });
      else if (teaser.kind === "clip") {
        const picture = await fit(teaser.picture, TEASER_PICTURE_EDGE, "t", "guide/teasers");
        const audio = await clip(teaser.audio);
        const { motion: _motion, ...still } = teaser;
        teasers.push({ ...still, picture, audio, ...(teaser.motion !== undefined ? { motion: await loop(teaser.motion) } : {}) });
      } else if (teaser.kind === "song") teasers.push({ ...teaser, picture: await fit(teaser.picture, TEASER_PICTURE_EDGE, "t", "guide/teasers"), audio: await song(teaser.audio) });
      else teasers.push(teaser);
    }
    // The version is the draft's: 3 only with a theme or a song (R-37), and teasers only where it has them.
    const document = { ...draft, characters, places, ...(drafts.length > 0 ? { teasers } : {}) } as GuideDocument;
    await writeFile(toExtendedLength(packing.at("guide/guide.json")), `${JSON.stringify(document, null, 2)}\n`, "utf8");
    await packing.add("guide", "guide/guide.json", GUIDE_MEDIA_TYPE);
  } catch {
    if (packing.signal.aborted) throw packing.signal.reason;
    return { ok: false, blocker: "the guide's pictures or voice lines could not be made" };
  }
  return { ok: true };
}
