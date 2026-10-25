import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  clipMusicTrim,
  EMPTY_MUSIC_RECORD,
  keptMusic,
  MAX_MUSIC_TRACKS,
  MAX_MUSIC_TRACK_MS,
  MUSIC_RECORD_FILE,
  MusicRecordSchema,
  musicKindOf,
  musicTitleFrom,
  musicTrackId,
  productionShape,
  SessionIdSchema,
  ulid,
  type BenchSession,
  type MusicJoin,
  type MusicRecord,
  type MusicRecordTrack,
  type MusicSection,
  type MusicTakeRef,
  type MusicTakeView,
  type SessionId,
} from "@arke-studio/contracts";
import { BenchStore, sessionDir } from "../bench/store.js";
import { MUSIC_COMPOSER_SCHEMA_VERSION, type CommitFileInput } from "../world/commit.js";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import { WorldStateStaleError, type WorldStatePrecondition, type WorldStore } from "../world/store.js";
import { JsonFile, sha256 } from "../world/text-files.js";
import { oneAtATime } from "./audio-drama.js";

/**
 * A music production's tracks (SPEC-060 R-4 – R-7, design turn 238). `music.json` is changed in
 * one write fenced on the file it was read from, one change at a time per production, as the audio
 * drama's record is (SPEC-057 R-85): two presses that each read the album and write it back would
 * otherwise each keep one of the two changes.
 *
 * A production made before its record — World Chat can create a music production by medium alone —
 * reads as an empty album, and its first change creates the record rather than refusing.
 */

export class MusicRefusal extends Error {}

const recordPath = (productionId: string) => `productions/${productionId}/${MUSIC_RECORD_FILE}`;

function musicProduction(store: WorldStore, productionId: string) {
  const production = store.getBundle().productions.find((entry) => entry.meta.id === productionId);
  if (production === undefined) throw new MusicRefusal("that production is no longer in this world");
  if (!productionShape(production.meta).isMusic) throw new MusicRefusal("that production is not music");
  return production;
}

/** The record as it is on disk, or the empty album a production made without one starts as. */
export async function readMusicRecord(store: WorldStore, productionId: string): Promise<{ record: MusicRecord; raw: string | null }> {
  const raw = await readFile(toExtendedLength(join(store.dir, fromPortable(recordPath(productionId)))), "utf8").catch(() => null);
  return { record: raw === null ? EMPTY_MUSIC_RECORD : MusicRecordSchema.parse(JSON.parse(raw)), raw };
}

/**
 * The album as World Chat read it (SPEC-060 R-10 – R-13): its parsed record, hashed, so a card
 * prepared against it is stale once a track's source, trim, sections or the joins move. Over the
 * parsed record rather than the file's bytes, so a read and a write agree however it was saved.
 */
export function musicRecordFence(record: MusicRecord): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(MusicRecordSchema.parse(record))).digest("hex")}`;
}

interface MusicChange {
  record: MusicRecord;
  /** The production's own kind, changed in the same commit: a Single made an Album (R-3). */
  kind?: "album";
}

/**
 * How a World Chat card writes (SPEC-060 R-19): under its own source and request id, so a
 * redelivered approval finds its commit, and only while what it was approved against holds.
 * A track's card names the album it read as `baseHash` (codex on PR 2191).
 */
export interface MusicCommitOptions {
  source?: string;
  requestId?: string;
  precondition?: WorldStatePrecondition;
  baseHash?: string;
}

async function writeMusic(store: WorldStore, productionId: string, kind: string, change: (record: MusicRecord) => MusicChange, commit: MusicCommitOptions = {}): Promise<void> {
  const path = recordPath(productionId);
  await oneAtATime(`${store.dir}/${path}`, async () => {
    musicProduction(store, productionId);
    const { record, raw } = await readMusicRecord(store, productionId);
    // A change prepared against an album that has moved since is refused, never written over it.
    if (commit.baseHash !== undefined && musicRecordFence(record) !== commit.baseHash) throw new WorldStateStaleError("The album changed since it was read. Read get_production again.");
    const next = change(record);
    const files: CommitFileInput[] = [{
      path,
      action: raw === null ? "create" : "replace",
      content: `${JSON.stringify(MusicRecordSchema.parse(next.record), null, 2)}\n`,
      baseHash: raw === null ? null : sha256(raw),
    }];
    if (next.kind !== undefined) {
      const metaPath = `productions/${productionId}/production.json`;
      const metaRaw = await readFile(toExtendedLength(join(store.dir, fromPortable(metaPath))), "utf8");
      const doc = JsonFile.parse(metaRaw);
      doc.set({ kind: next.kind });
      files.push({ path: metaPath, action: "replace", content: doc.serialize(), baseHash: sha256(metaRaw) });
    }
    await store.commit({ kind, source: commit.source ?? "music", files, ...(commit.requestId !== undefined ? { requestId: commit.requestId } : {}) }, undefined, commit.precondition);
  });
}

/**
 * Add a kept take or an imported file as the album's last track (R-6). It must be audio on this
 * world's shelf, or this production's own; a Single holds one track, so a second is added only
 * with the person's word to make it an Album.
 */
export async function addMusicTrack(store: WorldStore, productionId: string, artifactId: string, options: { makeAlbum?: boolean } = {}, commit?: MusicCommitOptions): Promise<string> {
  const production = musicProduction(store, productionId);
  const artifacts = store.getBundle().artifacts;
  const artifact = artifacts.find((candidate) => candidate.id === artifactId);
  if (artifact === undefined || artifact.retiredAt !== undefined) throw new MusicRefusal("that take is no longer on the shelf");
  if (artifact.kind !== "audio") throw new MusicRefusal("a track is audio");
  // Kept music is the world's whoever made it: an audio drama files its music cues as its own
  // (SPEC-057 R-40), and an album may take one. So is a file a person imported, which another
  // album may have imported first: the import finds those bytes already filed and keeps their
  // owner. Anything else another production made stays its own.
  const worlds = keptMusic([artifact]).length > 0 || artifact.origin.by === "user";
  if (artifact.production !== undefined && artifact.production !== productionId && !worlds) throw new MusicRefusal("that take belongs to another production");
  const title = keptMusic([artifact])[0]?.title ?? musicTitleFrom(undefined, artifact.file);
  // A song made in Bench keeps the words it was sung from, as the track's lyrics to start with.
  const generation = artifact.generation;
  const sung = generation !== undefined && "params" in generation && generation.source === "bench" && generation.params.kind === "music" ? generation.params.lyrics.trim() : "";
  let added = "";
  await writeMusic(store, productionId, "music-track-add", (record) => {
    if (record.tracks.length >= MAX_MUSIC_TRACKS) throw new MusicRefusal(`an album holds at most ${MAX_MUSIC_TRACKS} tracks`);
    const single = musicKindOf(production.meta) === "single";
    if (single && record.tracks.length >= 1 && options.makeAlbum !== true) throw new MusicRefusal("a single holds one track · make it an album to add another");
    added = musicTrackId(title, record.tracks.map((track) => track.id));
    return {
      record: { ...record, tracks: [...record.tracks, { id: added, title, source: { artifactId }, takes: [], ...(sung !== "" ? { lyrics: sung } : {}) }] },
      ...(single && record.tracks.length >= 1 ? { kind: "album" as const } : {}),
    };
  }, commit);
  return added;
}

/** A track's title or lyrics (R-7): lyrics are plain text, and an empty string clears them. */
export async function updateMusicTrack(store: WorldStore, productionId: string, trackId: string, change: { title?: string; lyrics?: string }, commit?: MusicCommitOptions): Promise<void> {
  await writeMusic(store, productionId, "music-track-update", (record) => {
    const index = record.tracks.findIndex((track) => track.id === trackId);
    if (index < 0) throw new MusicRefusal("that track is no longer on the album");
    const track = record.tracks[index]!;
    const lyrics = change.lyrics === undefined ? track.lyrics : change.lyrics.trim() === "" ? undefined : change.lyrics;
    const { lyrics: _was, ...rest } = track;
    const next = { ...rest, ...(change.title !== undefined ? { title: change.title.trim() } : {}), ...(lyrics !== undefined ? { lyrics } : {}) };
    return { record: { ...record, tracks: record.tracks.map((entry, at) => (at === index ? next : entry)) } };
  }, commit);
}

/** Remove a track (R-7): its takes stay on the shelf; nothing is deleted but the album's line. */
export async function removeMusicTrack(store: WorldStore, productionId: string, trackId: string, commit?: MusicCommitOptions): Promise<void> {
  await writeMusic(store, productionId, "music-track-remove", (record) => {
    if (!record.tracks.some((track) => track.id === trackId)) throw new MusicRefusal("that track is no longer on the album");
    // A join belongs to the track before it; the last track has nothing to join.
    const tracks = record.tracks.filter((track) => track.id !== trackId);
    const last = tracks.at(-1);
    if (last?.next !== undefined) {
      const { next: _join, ...rest } = last;
      tracks[tracks.length - 1] = rest;
    }
    return { record: { ...record, tracks } };
  }, commit);
}

/** The tracks in a new order (R-5, drag reorders): every track, each once. */
export async function reorderMusicTracks(store: WorldStore, productionId: string, order: readonly string[], commit?: MusicCommitOptions): Promise<void> {
  await writeMusic(store, productionId, "music-tracks-reorder", (record) => {
    const byId = new Map(record.tracks.map((track) => [track.id, track] as const));
    if (order.length !== record.tracks.length || new Set(order).size !== order.length || order.some((id) => !byId.has(id))) {
      throw new MusicRefusal("the album changed · try again");
    }
    return { record: { ...record, tracks: order.map((id) => byId.get(id)!) } };
  }, commit);
}

/** The album's cover (R-5): an image on the shelf, or none. */
export async function setMusicCover(store: WorldStore, productionId: string, artifactId: string | null, commit?: MusicCommitOptions): Promise<void> {
  if (artifactId !== null) {
    const artifact = store.getBundle().artifacts.find((candidate) => candidate.id === artifactId);
    if (artifact === undefined || artifact.retiredAt !== undefined) throw new MusicRefusal("that picture is no longer on the shelf");
    if (artifact.kind !== "image") throw new MusicRefusal("a cover is a picture");
  }
  await writeMusic(store, productionId, "music-set-cover", (record) => {
    const { cover: _was, ...rest } = record;
    return { record: artifactId === null ? rest : { ...rest, cover: artifactId } };
  }, commit);
}

/**
 * The album's own Bench session (R-9, call 9): every take a track's composer makes is a Bench
 * take there, on the world's shelf like any other, made by the Bench's own dispatch and quote. Its
 * subject is the production's music, as World Chat's production audio Bench is, so a take kept
 * from it belongs to the album. Made once, the first time a track asks for takes.
 */
export async function ensureMusicSession(store: WorldStore, productionId: string, at: string): Promise<SessionId> {
  const production = musicProduction(store, productionId);
  const { record } = await readMusicRecord(store, productionId);
  if (record.session !== undefined && (await new BenchStore(sessionDir(store.dir, record.session)).readMeta()) !== null) return record.session;
  // The session, and a take's length, instrumental and track, are fields a build before the
  // composer cannot read; production audio's subject (57) is below it.
  await store.ensureSchemaVersion(MUSIC_COMPOSER_SCHEMA_VERSION, "music-takes");
  const id = SessionIdSchema.parse(`sess_${ulid()}`);
  await store.ownedWrite(async () => {
    await new BenchStore(sessionDir(store.dir, id)).create(id, at, { kind: "production", productionId, productionTitle: production.meta.title, role: "music" });
  });
  let kept: SessionId = id;
  await writeMusic(store, productionId, "music-session", (current) => {
    // Two composers opening at once keep the first session written.
    if (current.session !== undefined) {
      kept = current.session;
      return { record: current };
    }
    return { record: { ...current, session: id } };
  });
  return kept;
}

/**
 * Takes a track's composer asked for (R-9), added to its list in the order they were made. An
 * album with no session yet keeps theirs: World Chat's card makes one on approval, as Bench does.
 */
export async function tagMusicTakes(store: WorldStore, productionId: string, trackId: string, refs: readonly MusicTakeRef[]): Promise<void> {
  if (refs.length === 0) return;
  await writeMusic(store, productionId, "music-takes-tag", (record) => {
    const index = record.tracks.findIndex((track) => track.id === trackId);
    if (index < 0) throw new MusicRefusal("that track is no longer on the album");
    const track = record.tracks[index]!;
    const known = new Set(track.takes.map((take) => take.takeId));
    const takes = [...track.takes, ...refs.filter((ref) => !known.has(ref.takeId))].slice(-200);
    return { record: { ...record, ...(record.session === undefined ? { session: refs[0]!.sessionId } : {}), tracks: record.tracks.map((entry, at) => (at === index ? { ...track, takes } : entry)) } };
  });
}

/**
 * Choose a take as its track's (R-10): it plays from the shelf, where keeping put it. The trim is
 * clipped to the new take's length; the sections are kept as they were.
 */
export async function chooseMusicTake(store: WorldStore, productionId: string, trackId: string, ref: MusicTakeRef, artifactId: string, commit?: MusicCommitOptions): Promise<void> {
  const artifact = store.getBundle().artifacts.find((candidate) => candidate.id === artifactId);
  if (artifact === undefined || artifact.retiredAt !== undefined || artifact.kind !== "audio") throw new MusicRefusal("that take is not on the shelf");
  const lengthMs = artifact.mediaInfo?.durationSec === undefined ? null : Math.round(artifact.mediaInfo.durationSec * 1000);
  await writeMusic(store, productionId, "music-take-choose", (record) => {
    const index = record.tracks.findIndex((track) => track.id === trackId);
    if (index < 0) throw new MusicRefusal("that track is no longer on the album");
    const track = record.tracks[index]!;
    const takes = track.takes.some((take) => take.takeId === ref.takeId) ? track.takes : [...track.takes, ref];
    const { trim: _was, ...rest } = track;
    const trim = clipMusicTrim(track.trim, lengthMs);
    const next: MusicRecordTrack = { ...rest, source: { artifactId }, takes, ...(trim !== undefined ? { trim } : {}) };
    return { record: { ...record, tracks: record.tracks.map((entry, at) => (at === index ? next : entry)) } };
  }, commit);
}

/**
 * The track editor's Save (238j, R-11): a trim inside the source, fades that fit what is left, and
 * sections in order inside it. The take is never touched; the edit is applied at render.
 */
export async function editMusicTrack(store: WorldStore, productionId: string, trackId: string, edit: {
  trim: { startMs: number; endMs: number } | null;
  fadeInMs: number;
  fadeOutMs: number;
  sections: readonly MusicSection[];
}, commit?: MusicCommitOptions): Promise<void> {
  await writeMusic(store, productionId, "music-track-edit", (record) => {
    const index = record.tracks.findIndex((track) => track.id === trackId);
    if (index < 0) throw new MusicRefusal("that track is no longer on the album");
    const track = record.tracks[index]!;
    const sourceId = "artifactId" in track.source ? track.source.artifactId : undefined;
    const artifact = sourceId === undefined ? undefined : store.getBundle().artifacts.find((candidate) => candidate.id === sourceId);
    const lengthMs = artifact?.mediaInfo?.durationSec === undefined ? MAX_MUSIC_TRACK_MS : Math.round(artifact.mediaInfo.durationSec * 1000);
    if (edit.trim !== null && (edit.trim.endMs <= edit.trim.startMs || edit.trim.startMs >= lengthMs)) throw new MusicRefusal("the trim leaves nothing to play");
    const trim = edit.trim === null ? undefined : clipMusicTrim(edit.trim, lengthMs);
    const plays = trim === undefined ? lengthMs : trim.endMs - trim.startMs;
    if (edit.fadeInMs + edit.fadeOutMs > plays) throw new MusicRefusal("the fades are longer than what plays");
    const sections = [...edit.sections].sort((left, right) => left.atMs - right.atMs);
    if (sections.some((section) => section.atMs > lengthMs)) throw new MusicRefusal("a section starts after the take ends");
    const { trim: _trim, fadeInMs: _in, fadeOutMs: _out, sections: _sections, ...rest } = track;
    const next: MusicRecordTrack = {
      ...rest,
      ...(trim !== undefined ? { trim } : {}),
      ...(edit.fadeInMs > 0 ? { fadeInMs: edit.fadeInMs } : {}),
      ...(edit.fadeOutMs > 0 ? { fadeOutMs: edit.fadeOutMs } : {}),
      ...(sections.length > 0 ? { sections } : {}),
    };
    return { record: { ...record, tracks: record.tracks.map((entry, at) => (at === index ? next : entry)) } };
  }, commit);
}

/**
 * The album's sequence (238k, R-13): each track's join to the next, and one loudness target. The
 * last track joins nothing, so whatever is asked of it is not kept.
 */
export async function setMusicSequence(store: WorldStore, productionId: string, sequence: { loudness: number; joins: ReadonlyArray<{ trackId: string; next: MusicJoin | null }> }, commit?: MusicCommitOptions): Promise<void> {
  await writeMusic(store, productionId, "music-sequence-set", (record) => {
    const joins = new Map(sequence.joins.map((join) => [join.trackId, join.next] as const));
    for (const id of joins.keys()) if (!record.tracks.some((track) => track.id === id)) throw new MusicRefusal("the album changed · try again");
    const tracks = record.tracks.map((track, index) => {
      const last = index === record.tracks.length - 1;
      if (!joins.has(track.id) && !last) return track;
      const { next: _was, ...rest } = track;
      const next = last ? null : (joins.get(track.id) ?? null);
      return next === null ? rest : { ...rest, next };
    });
    return { record: { ...record, loudness: sequence.loudness, tracks } };
  }, commit);
}

/** Every take of the album's session, by the track that asked for it (238i): what its composer shows. */
export function musicTakeViews(record: MusicRecord, session: BenchSession | null): MusicTakeView[] {
  if (session === null) return [];
  const owner = new Map<string, string>();
  for (const track of record.tracks) for (const take of track.takes) if (take.sessionId === session.id) owner.set(take.takeId, track.id);
  const tracks = new Set(record.tracks.map((track) => track.id));
  return session.takes.map((take) => ({
    trackId: owner.get(take.id) ?? (take.request.params.kind === "music" && take.request.params.track !== undefined && tracks.has(take.request.params.track) ? take.request.params.track : null),
    sessionId: session.id,
    takeId: take.id,
    n: take.n,
    status: take.status,
    ...(take.media !== undefined ? { file: `.sessions/${session.id}/media/${take.id}/${take.media.file}` } : {}),
    ...(take.media?.info?.durationSec !== undefined ? { durationMs: Math.round(take.media.info.durationSec * 1000) } : {}),
    ...(take.keptArtifactId !== undefined ? { keptArtifactId: take.keptArtifactId } : {}),
    ...(take.error !== undefined ? { error: take.error.slice(0, 500) } : {}),
    createdAt: take.createdAt,
  }));
}

/**
 * Takes whose reservation names a track but whose tagging never landed (SPEC-060 R-9): the process
 * stopped, or the world closed, between the Bench's reservation and the album's write. Found from
 * the session and given to their tracks, so a paid take is never left out of its track's list.
 */
export function untaggedMusicTakes(record: MusicRecord, session: BenchSession): Map<string, MusicTakeRef[]> {
  const tagged = new Set(record.tracks.flatMap((track) => track.takes.map((take) => take.takeId)));
  const tracks = new Set(record.tracks.map((track) => track.id));
  const found = new Map<string, MusicTakeRef[]>();
  for (const take of session.takes) {
    const track = take.request.params.kind === "music" ? take.request.params.track : undefined;
    if (track === undefined || !tracks.has(track) || tagged.has(take.id)) continue;
    found.set(track, [...(found.get(track) ?? []), { sessionId: session.id, takeId: take.id }]);
  }
  return found;
}
