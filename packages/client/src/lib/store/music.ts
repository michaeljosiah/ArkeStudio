import { type ClientMessage, ulid } from "@arke-studio/contracts";
import { send } from "./core.js";
import { queueRequest } from "./events.js";

// ---- SPEC-060: a music production's album (design turn 238) ---------------

/** A kept take as the album's last track (238d, R-6); a Single's second asks for `makeAlbum`. */
export function addMusicTrack(worldId: string, productionId: string, artifactId: string, makeAlbum = false): boolean {
  return send({ kind: "music-track-add", worldId, productionId, artifactId, ...(makeAlbum ? { makeAlbum: true } : {}) });
}

/** A track's title or lyrics (238e, R-7); empty lyrics clear them. */
export function updateMusicTrack(worldId: string, productionId: string, trackId: string, change: { title?: string; lyrics?: string }): boolean {
  return send({ kind: "music-track-update", worldId, productionId, trackId, ...change });
}

/** Remove from album (R-7): the take stays on the shelf. */
export function removeMusicTrack(worldId: string, productionId: string, trackId: string): boolean {
  return send({ kind: "music-track-remove", worldId, productionId, trackId });
}

/** The tracks in a new order (R-5), every one, each once. */
export function reorderMusicTracks(worldId: string, productionId: string, order: readonly string[]): boolean {
  return send({ kind: "music-tracks-reorder", worldId, productionId, order: [...order] });
}

/** The album's cover (R-5): a picture on the shelf, or none. */
export function setMusicCover(worldId: string, productionId: string, artifactId: string | null): boolean {
  return send({ kind: "music-set-cover", worldId, productionId, artifactId });
}

/** Draft with Arke on a track (R-7): answered as `music.lyrics-drafted` under the id returned. */
export function draftMusicLyrics(worldId: string, productionId: string, trackId: string, description: string): string | null {
  const requestId = ulid();
  return send({ kind: "music-draft-lyrics", worldId, productionId, trackId, requestId, description }) ? requestId : null;
}

/** Heard in (R-14), read each time: answered as `music.heard-in` under the id returned. */
export function readMusicHeardIn(worldId: string, productionId: string): string | null {
  const requestId = ulid();
  return send({ kind: "read-music-heard-in", worldId, productionId, requestId }) ? requestId : null;
}

/** Play all (R-8): answered as `music.rendered` under the id returned. */
export function renderMusic(worldId: string, productionId: string): string | null {
  const requestId = ulid();
  return send({ kind: "render-music", worldId, productionId, requestId }) ? requestId : null;
}

/**
 * Make takes for a track (238i, R-9): the Bench's own dispatch in the album's session, so its
 * answer is a Bench dispatch's `queue.enqueue-result` under the id returned.
 */
export function makeMusicTakes(worldId: string, productionId: string, trackId: string, composer: Extract<ClientMessage, { kind: "music-track-make" }>["composer"]): string | null {
  const requestId = queueRequest("bench-dispatch");
  return send({ kind: "music-track-make", worldId, productionId, trackId, requestId, composer }) ? requestId : null;
}

/** Choose a take as its track's (238i, R-10). */
export function chooseMusicTake(worldId: string, productionId: string, trackId: string, sessionId: string, takeId: string): boolean {
  return send({ kind: "music-track-choose", worldId, productionId, trackId, sessionId, takeId, requestId: ulid() });
}

/** The track editor's Save (238j, R-11): its trim, fades and sections. */
export function editMusicTrack(worldId: string, productionId: string, trackId: string, edit: Omit<Extract<ClientMessage, { kind: "music-track-edit" }>, "kind" | "worldId" | "productionId" | "trackId">): boolean {
  return send({ kind: "music-track-edit", worldId, productionId, trackId, ...edit });
}

/** The album's sequence (238k, R-13): every join and the loudness target. */
export function setMusicSequence(worldId: string, productionId: string, loudness: number, joins: Extract<ClientMessage, { kind: "music-sequence-set" }>["joins"]): boolean {
  return send({ kind: "music-sequence-set", worldId, productionId, loudness, joins: [...joins] });
}

/** The album's takes by track (238i): answered as `music.takes` under the id returned. */
export function readMusicTakes(worldId: string, productionId: string): string | null {
  const requestId = ulid();
  return send({ kind: "read-music-takes", worldId, productionId, requestId }) ? requestId : null;
}

/** A world audio file's waveform (238j, 238k): answered as `music.waveform` under the id returned. */
export function readMusicWaveform(worldId: string, file: string): string | null {
  const requestId = ulid();
  return send({ kind: "read-music-waveform", worldId, file, requestId }) ? requestId : null;
}
