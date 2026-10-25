import { z } from "zod";
import type { ArtifactSidecar } from "./artifact.js";
import { ArtifactIdSchema, SessionIdSchema, SlugSchema, TakeIdSchema } from "./ids.js";
import { MAX_MUSIC_TRACKS, MAX_MUSIC_TRACK_MS, MUSIC_KINDS, type MusicKind } from "./world-package.js";

/**
 * A music production (SPEC-060, design turn 238): an Album, a Single or a Soundtrack made in a
 * world. Its kind is the production's own `kind` beside `medium: "music"`, so a card, the switcher
 * and World Chat read it as they read any production's; what only music has — the cover, the
 * album's loudness and the tracks in order — lives in `productions/<id>/music.json`, written only
 * through the production store.
 *
 * A track points at audio that is already the world's: a kept Bench take or an imported file are
 * both artifacts on the shelf (R-6), so `source` names an artifact. A take a track's own composer
 * makes (task 3, R-9) is a Bench take first and an artifact once kept, which is why `source` may
 * also name the take itself. The edits a track carries — its trim, its fades, its sections and the
 * join to the next track — are optional here and applied only at render (R-11, R-16), never to the
 * source, so the take or file stays as it was made.
 */

export const MUSIC_RECORD_FILE = "music.json";
/** The album's loudness target when the author has set none (R-4, 238j): streaming's −14 LUFS. */
export const DEFAULT_MUSIC_LOUDNESS = -14;
/** A music cover is square, made and shipped at 1024 × 1024 (call 5). */
export const MUSIC_COVER_EDGE = 1024;
/** What every track is rendered to for Play all and the package (R-16). */
export const MUSIC_AAC_KBPS = 256;
/** What Import a file takes (R-6, 238d). */
export const MUSIC_IMPORT_EXTENSIONS = ["wav", "mp3", "m4a", "flac"] as const;

export const MusicKindSchema = z.enum(MUSIC_KINDS);

const BenchTakeRefSchema = z.object({ sessionId: SessionIdSchema, takeId: TakeIdSchema }).strict();
export type MusicTakeRef = z.infer<typeof BenchTakeRefSchema>;

/** Where a track's audio is: an artifact on the world's shelf, or a Bench take not yet kept. */
export const MusicTrackSourceSchema = z.union([
  z.object({ artifactId: ArtifactIdSchema }).strict(),
  z.object({ take: BenchTakeRefSchema }).strict(),
]);
export type MusicTrackSource = z.infer<typeof MusicTrackSourceSchema>;

/** A section marked on a track (238j): a label and where it starts, on the source's own clock. */
export const MusicSectionSchema = z.object({ label: z.string().trim().min(1).max(100), atMs: z.number().int().min(0).max(MAX_MUSIC_TRACK_MS) }).strict();
export type MusicSection = z.infer<typeof MusicSectionSchema>;

/** What comes between a track and the next (238k, R-13): a gap, or a crossfade. */
export const MusicJoinSchema = z.union([
  z.object({ gapMs: z.number().int().min(0).max(30_000) }).strict(),
  z.object({ crossfadeMs: z.number().int().min(0).max(15_000) }).strict(),
]);
export type MusicJoin = z.infer<typeof MusicJoinSchema>;

export const MusicRecordTrackSchema = z.object({
  /** The track's id in the package's music document: a slug, unique on the album. */
  id: SlugSchema,
  title: z.string().trim().min(1).max(200),
  source: MusicTrackSourceSchema,
  /** The Bench takes made for this track by its composer (R-9), in the order they were made. */
  takes: z.array(BenchTakeRefSchema).max(200).default([]),
  /** Plain text, as the lyricist drafts it or the author types it (call 3). */
  lyrics: z.string().max(20_000).optional(),
  sections: z.array(MusicSectionSchema).max(200).optional(),
  trim: z.object({ startMs: z.number().int().min(0), endMs: z.number().int().min(1) }).strict().optional(),
  fadeInMs: z.number().int().min(0).max(60_000).optional(),
  fadeOutMs: z.number().int().min(0).max(60_000).optional(),
  next: MusicJoinSchema.optional(),
}).strict();
export type MusicRecordTrack = z.infer<typeof MusicRecordTrackSchema>;

/** `productions/<id>/music.json` (R-4). */
export const MusicRecordSchema = z.object({
  version: z.literal(1),
  /** The production a soundtrack is for (R-1), by id. */
  for: SlugSchema.optional(),
  cover: ArtifactIdSchema.optional(),
  loudness: z.number().min(-30).max(-6).default(DEFAULT_MUSIC_LOUDNESS),
  tracks: z.array(MusicRecordTrackSchema).max(MAX_MUSIC_TRACKS),
}).strict().superRefine((record, ctx) => {
  const seen = new Set<string>();
  for (const [index, track] of record.tracks.entries()) {
    if (seen.has(track.id)) ctx.addIssue({ code: "custom", path: ["tracks", index, "id"], message: `track ${track.id} repeats` });
    seen.add(track.id);
    if (track.trim !== undefined && track.trim.endMs <= track.trim.startMs) ctx.addIssue({ code: "custom", path: ["tracks", index, "trim"], message: "a trim ends after it starts" });
  }
});
export type MusicRecord = z.infer<typeof MusicRecordSchema>;

export const EMPTY_MUSIC_RECORD: MusicRecord = { version: 1, loudness: DEFAULT_MUSIC_LOUDNESS, tracks: [] };

/** The production's music kind: what it stores, or an album, the medium's plain default. */
export function musicKindOf(meta: { kind?: string | undefined }): MusicKind {
  return MusicKindSchema.safeParse(meta.kind).success ? (meta.kind as MusicKind) : "album";
}

type ShelfArtifact = Pick<ArtifactSidecar, "id" | "kind" | "file" | "generation" | "mediaInfo" | "retiredAt" | "production">;

/** The artifact a track plays, when its source is one on the shelf. */
export function musicTrackArtifact<A extends ShelfArtifact>(track: Pick<MusicRecordTrack, "source">, artifacts: readonly A[]): A | undefined {
  const id = "artifactId" in track.source ? track.source.artifactId : undefined;
  return id === undefined ? undefined : artifacts.find((artifact) => artifact.id === id);
}

/**
 * How long a track plays, in ms: its source's measured length, inside its trim. Null when the
 * source was never measured, so a total is never a guess (#253).
 */
export function musicTrackLengthMs(track: Pick<MusicRecordTrack, "source" | "trim">, artifacts: readonly ShelfArtifact[]): number | null {
  const seconds = musicTrackArtifact(track, artifacts)?.mediaInfo?.durationSec;
  if (seconds === undefined) return null;
  const whole = Math.round(seconds * 1000);
  if (track.trim === undefined) return whole;
  return Math.max(0, Math.min(whole, track.trim.endMs) - Math.min(whole, track.trim.startMs));
}

/**
 * A track's edges as the sequence plays it (R-13, R-16). A gap is that much silence after the
 * track; a crossfade is the track's own fade-out and the next track's fade-in, back to back,
 * never an overlap, so every track's file plays whole when it is opened alone. The longer of a
 * track's own fade and the join's wins. A join after the last track joins nothing.
 */
export function musicTrackEdges(record: Pick<MusicRecord, "tracks">, index: number): { fadeInMs: number; fadeOutMs: number; gapMs: number } {
  const track = record.tracks[index];
  if (track === undefined) return { fadeInMs: 0, fadeOutMs: 0, gapMs: 0 };
  const last = index === record.tracks.length - 1;
  const before = index > 0 ? record.tracks[index - 1]!.next : undefined;
  const after = last ? undefined : track.next;
  return {
    fadeInMs: Math.max(track.fadeInMs ?? 0, before !== undefined && "crossfadeMs" in before ? before.crossfadeMs : 0),
    fadeOutMs: Math.max(track.fadeOutMs ?? 0, after !== undefined && "crossfadeMs" in after ? after.crossfadeMs : 0),
    gapMs: after !== undefined && "gapMs" in after ? after.gapMs : 0,
  };
}

/** The album's length as it plays (238c, R-13): its tracks and gaps; null while any track's length is unknown. */
export function musicTotalMs(record: Pick<MusicRecord, "tracks">, artifacts: readonly ShelfArtifact[]): number | null {
  let total = 0;
  for (const [index, track] of record.tracks.entries()) {
    const length = musicTrackLengthMs(track, artifacts);
    if (length === null) return null;
    total += length + musicTrackEdges(record, index).gapMs;
  }
  return total;
}

/**
 * A kept music take, as Add track lists them (238d): a Bench music take, or a sound an audio
 * drama made as music (SPEC-057 R-40). `song` says whether it was made with words, which is what
 * Songs and Instrumental filter on.
 */
export function keptMusic<A extends ShelfArtifact>(artifacts: readonly A[]): Array<{ artifact: A; song: boolean; title: string }> {
  const out: Array<{ artifact: A; song: boolean; title: string }> = [];
  for (const artifact of artifacts) {
    if (artifact.kind !== "audio" || artifact.retiredAt !== undefined) continue;
    const generation = artifact.generation;
    if (generation === undefined) continue;
    if ("params" in generation && generation.source === "bench" && generation.params.kind === "music") {
      out.push({ artifact, song: generation.params.lyrics.trim() !== "", title: musicTitleFrom(generation.brief, artifact.file) });
    } else if (generation.source === "sound" && generation.cue === "music") {
      out.push({ artifact, song: false, title: generation.name });
    }
  }
  return out;
}

/**
 * A track's first title (R-6): the take's brief, cut to its first clause, else the file's name.
 * The author renames it on the page; nothing here is meant to be the last word.
 */
export function musicTitleFrom(brief: string | undefined, file: string): string {
  const firstClause = (brief ?? "").split(/[.,;\n]/)[0]!.trim();
  if (firstClause.length > 0) return firstClause.slice(0, 80);
  const name = (file.split("/").pop() ?? file).replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim() || "Untitled";
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}`.slice(0, 80);
}

/** A track id from its title, unique on the album: the package's music document names it. */
export function musicTrackId(title: string, taken: readonly string[]): string {
  const base = title.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "track";
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let counter = 2; ; counter++) if (!used.has(`${base}-${counter}`)) return `${base}-${counter}`;
}

/** `3:42`, `1:04:12`: how the album page writes a length. */
export function musicClock(ms: number): string {
  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600), minutes = Math.floor((total % 3600) / 60), seconds = total % 60;
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}` : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Where a track is heard in the world's other productions (R-14): read, never stored. */
export const MusicHeardRowSchema = z.object({
  production: SlugSchema,
  productionTitle: z.string().min(1).max(200),
  /** The chapter, episode or cut it is placed in, as the music document's `chapter` names it. */
  chapter: SlugSchema,
  /** What the page says: `Chapter 9`, `Episode 2`, `Cut`. */
  label: z.string().min(1).max(200),
  /** Where in it, ms. */
  at: z.number().int().min(0),
  /** Where the row opens, in the Studio. */
  open: z.string().min(1).max(500),
}).strict();
export type MusicHeardRow = z.infer<typeof MusicHeardRowSchema>;
