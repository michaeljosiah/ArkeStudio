import { createHash } from "node:crypto";
import { open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { MUSIC_AAC_KBPS, musicTrackArtifact, musicTrackEdges, ulid, type ArtifactSidecar, type MusicRecord } from "@arke-studio/contracts";
import { StereoLoudness } from "../audio/stereo-loudness.js";
import { renameWithRetry } from "../world/atomic.js";
import { containedWorldFilePath } from "../world/contained-file.js";
import { toExtendedLength } from "../world/paths.js";
import type { WorldStore } from "../world/store.js";
import type { FfmpegRunner } from "../takes/export.js";
import { containedWorldFile } from "./interactive.js";

/**
 * A music production's render (SPEC-060 R-8, R-16): each track from its source, with its trim and
 * fades, its loudness brought to the album's target, and its sequence applied to its tail, as AAC
 * in M4A at 256 kbps. Play all and the export are this one render, made on demand and cached by
 * what it was made from, so pressing Play all twice, or exporting after it, makes nothing again.
 *
 * Loudness is two passes, as EBU R128 is (R-16): the trimmed and faded track is measured, then the
 * one gain that takes it to the target — held under a −1 dB peak, so a quiet master is never
 * clipped to reach it — is applied as it is encoded. The measure is made here rather than by
 * ffmpeg's loudnorm because the runner hands back no output, and on the decode ffmpeg wrote, so
 * the meter hears what the encoder will.
 *
 * Everything the editor and the sequence set (task 3) is already read: `trim`, `fadeInMs`,
 * `fadeOutMs` and each join's `next`. They change the render's key, so an edit renders anew and
 * the take on the shelf is never touched (R-11).
 */

/** Raised with what changes the bytes of a render, so a cached one is never stale. */
const MUSIC_RENDERER = 1;
const RATE = 48_000;
const CEILING_DB = -1;
const CHUNK = RATE;
const CACHE = ".cache/music";

export class MusicRenderRefusal extends Error {}

/** One track as it renders: its source, and the edges the editor and the sequence give it. */
export interface MusicRenderTrack {
  trackId: string;
  title: string;
  artifactId: string;
  /** World-relative. */
  file: string;
  /** The source's content hash, which the cache is keyed on with everything below. */
  hash: string;
  startMs: number;
  /** Null plays to the source's end. */
  endMs: number | null;
  fadeInMs: number;
  fadeOutMs: number;
  /** Silence after the track (R-16). */
  gapMs: number;
}

/** What each track of the record renders from (R-16), or why one cannot. */
export function musicRenderPlan(record: Pick<MusicRecord, "tracks">, artifacts: readonly ArtifactSidecar[]): { ok: true; tracks: MusicRenderTrack[] } | { ok: false; blockers: string[] } {
  const tracks: MusicRenderTrack[] = [];
  const blockers: string[] = [];
  for (const [index, track] of record.tracks.entries()) {
    const artifact = musicTrackArtifact(track, artifacts);
    // Retired is off the shelf for a new choice, never out of a track that already plays it.
    if (artifact === undefined || artifact.kind !== "audio") {
      blockers.push(`Track ${index + 1} · ${track.title} · its take is no longer on the shelf`);
      continue;
    }
    tracks.push({
      trackId: track.id,
      title: track.title,
      artifactId: artifact.id,
      file: `artifacts/${artifact.file}`,
      hash: artifact.hash,
      startMs: track.trim?.startMs ?? 0,
      endMs: track.trim?.endMs ?? null,
      ...musicTrackEdges(record, index),
    });
  }
  return blockers.length > 0 ? { ok: false, blockers } : { ok: true, tracks };
}

export interface MusicRenderOptions {
  ffmpeg: FfmpegRunner;
  signal?: AbortSignal;
}

export interface MusicRenderedTrack {
  trackId: string;
  /** World-relative, under `.cache/music/`, which the media route serves. */
  file: string;
  /** Absolute, for the export to copy. */
  path: string;
  /** As it plays, its gap included. */
  durationMs: number;
  lufs: number | null;
  gainDb: number;
}

const seconds = (ms: number) => (ms / 1000).toFixed(3);
const keyOf = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Two windows asking for one render share it rather than racing to write the same file. */
const making = new Map<string, Promise<unknown>>();
function once<T>(key: string, make: () => Promise<T>): Promise<T> {
  const held = making.get(key) as Promise<T> | undefined;
  if (held !== undefined) return held;
  const run = make().finally(() => making.delete(key));
  making.set(key, run);
  return run;
}

async function cacheDir(dir: string): Promise<string> {
  return join(await containedWorldFilePath(dir, `${CACHE}/placeholder`, true, "music cache", true), "..");
}

async function readReceipt<T>(path: string, media: string, valid: (value: Partial<T>) => boolean): Promise<T | null> {
  try {
    const receipt = JSON.parse(await readFile(toExtendedLength(path), "utf8")) as Partial<T>;
    if (!valid(receipt)) return null;
    if ((await stat(toExtendedLength(media))).size === 0) return null;
    return receipt as T;
  } catch {
    // A missing or damaged derived file is made again.
    return null;
  }
}

/** The PCM frames of a 16-bit stereo WAV ffmpeg wrote, read a second at a time. */
async function measure(path: string, edges: { fadeInMs: number; fadeOutMs: number }, signal: AbortSignal): Promise<{ frames: number; lufs: number | null; peakDb: number | null }> {
  const file = await open(toExtendedLength(path), "r");
  try {
    const head = Buffer.alloc(12);
    await file.read(head, 0, 12, 0);
    if (head.toString("ascii", 0, 4) !== "RIFF" || head.toString("ascii", 8, 12) !== "WAVE") throw new MusicRenderRefusal("the track could not be decoded");
    let at = 12;
    let data: { at: number; size: number } | null = null;
    const size = (await file.stat()).size;
    while (at + 8 <= size) {
      const chunk = Buffer.alloc(8);
      await file.read(chunk, 0, 8, at);
      const length = chunk.readUInt32LE(4);
      if (chunk.toString("ascii", 0, 4) === "data") {
        data = { at: at + 8, size: Math.min(length, size - at - 8) };
        break;
      }
      at += 8 + length + (length % 2);
    }
    if (data === null) throw new MusicRenderRefusal("the track could not be decoded");
    const frames = Math.floor(data.size / 4);
    const fadeIn = Math.min(frames, Math.round((edges.fadeInMs * RATE) / 1000));
    const fadeOut = Math.min(frames, Math.round((edges.fadeOutMs * RATE) / 1000));
    // The meter hears the fades as afade will make them, a straight line, so a long fade does not
    // read as a quieter song and get pushed up for it.
    const meter = new StereoLoudness(RATE);
    const bytes = Buffer.alloc(CHUNK * 4);
    for (let from = 0; from < frames; from += CHUNK) {
      signal.throwIfAborted();
      const length = Math.min(CHUNK, frames - from);
      await file.read(bytes, 0, length * 4, data.at + from * 4);
      const left = new Float32Array(length), right = new Float32Array(length);
      for (let index = 0; index < length; index++) {
        const frame = from + index;
        const gain = Math.min(1, fadeIn > 0 ? frame / fadeIn : 1, fadeOut > 0 ? (frames - frame) / fadeOut : 1);
        left[index] = (bytes.readInt16LE(index * 4) / 32768) * gain;
        right[index] = (bytes.readInt16LE(index * 4 + 2) / 32768) * gain;
      }
      meter.add(left, right);
      await setImmediate();
    }
    return { frames, ...meter.measure() };
  } finally {
    await file.close();
  }
}

/** One track rendered (R-16), or the cached render of the same source, edges and target. */
export async function renderMusicTrack(dir: string, track: MusicRenderTrack, loudness: number, options: MusicRenderOptions): Promise<MusicRenderedTrack> {
  const signal = options.signal ?? new AbortController().signal;
  const identity = options.ffmpeg.identity !== undefined ? await options.ffmpeg.identity(signal) : "ffmpeg";
  const key = keyOf({ renderer: MUSIC_RENDERER, identity, hash: track.hash, startMs: track.startMs, endMs: track.endMs, fadeInMs: track.fadeInMs, fadeOutMs: track.fadeOutMs, gapMs: track.gapMs, loudness, kbps: MUSIC_AAC_KBPS });
  return once(`${dir}|${key}`, async () => {
    const folder = await cacheDir(dir);
    const file = `${CACHE}/${key}.m4a`;
    const path = join(folder, `${key}.m4a`);
    const cached = await readReceipt<{ durationMs: number; lufs: number | null; gainDb: number }>(join(folder, `${key}.json`), path, (receipt) => Number.isInteger(receipt.durationMs) && Number.isFinite(receipt.gainDb));
    if (cached !== null) return { trackId: track.trackId, file, path, ...cached };

    const source = await containedWorldFile(dir, track.file);
    if (source === null) throw new MusicRenderRefusal(`${track.title} · its take is outside this world`);
    const id = ulid();
    const decoded = join(folder, `${id}.wav`);
    const encoded = join(folder, `${id}.m4a`);
    try {
      const trim = `atrim=start=${seconds(track.startMs)}${track.endMs !== null ? `:end=${seconds(track.endMs)}` : ""},asetpts=PTS-STARTPTS`;
      await options.ffmpeg.run(["-y", "-v", "error", "-i", source, "-vn", "-map_metadata", "-1", "-af", trim, "-ac", "2", "-ar", String(RATE), "-c:a", "pcm_s16le", decoded], () => {}, signal);
      const measured = await measure(decoded, track, signal);
      if (measured.frames === 0) throw new MusicRenderRefusal(`${track.title} · nothing is left inside its trim`);
      const wanted = measured.lufs === null ? 0 : loudness - measured.lufs;
      const gainDb = Math.round(Math.min(wanted, measured.peakDb === null ? wanted : CEILING_DB - measured.peakDb) * 100) / 100;
      const lengthSec = measured.frames / RATE;
      const fadeIn = Math.min(track.fadeInMs / 1000, lengthSec);
      const fadeOut = Math.min(track.fadeOutMs / 1000, lengthSec);
      const filters = [
        ...(fadeIn > 0 ? [`afade=t=in:st=0:d=${fadeIn.toFixed(3)}`] : []),
        ...(fadeOut > 0 ? [`afade=t=out:st=${(lengthSec - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}`] : []),
        `volume=${gainDb.toFixed(2)}dB`,
        ...(track.gapMs > 0 ? [`apad=pad_dur=${seconds(track.gapMs)}`] : []),
      ];
      await options.ffmpeg.run(["-y", "-v", "error", "-i", decoded, "-af", filters.join(","), "-c:a", "aac", "-b:a", `${MUSIC_AAC_KBPS}k`, "-movflags", "+faststart", encoded], () => {}, signal);
      signal.throwIfAborted();
      const durationMs = Math.round(lengthSec * 1000) + track.gapMs;
      await renameWithRetry(encoded, path);
      await writeFile(toExtendedLength(join(folder, `${key}.json`)), JSON.stringify({ durationMs, lufs: measured.lufs, gainDb }), "utf8");
      return { trackId: track.trackId, file, path, durationMs, lufs: measured.lufs, gainDb };
    } finally {
      await Promise.all([decoded, encoded].map((temp) => rm(toExtendedLength(temp), { force: true }).catch(() => {})));
    }
  });
}

export interface MusicAlbumRender {
  /** World-relative, under `.cache/music/`. */
  file: string;
  durationMs: number;
  /** Where each track starts in the album's file, for Play through from any track (R-13). */
  starts: Array<{ trackId: string; atMs: number }>;
  tracks: MusicRenderedTrack[];
}

/**
 * Play all (R-8): every track rendered as the export renders it, then joined back to back into
 * one file in the album's order. The tracks already carry their gaps and fades, so the join adds
 * nothing and copies the AAC as it is.
 */
export async function renderMusicAlbum(store: WorldStore, record: MusicRecord, options: MusicRenderOptions & { onTrack?: (index: number, total: number) => void }): Promise<MusicAlbumRender> {
  const signal = options.signal ?? new AbortController().signal;
  if (record.tracks.length === 0) throw new MusicRenderRefusal("there are no tracks to play yet");
  const plan = musicRenderPlan(record, store.getBundle().artifacts);
  if (!plan.ok) throw new MusicRenderRefusal(plan.blockers.join("; "));
  const rendered: MusicRenderedTrack[] = [];
  for (const [index, track] of plan.tracks.entries()) {
    signal.throwIfAborted();
    options.onTrack?.(index, plan.tracks.length);
    rendered.push(await renderMusicTrack(store.dir, track, record.loudness, options));
  }
  const starts: MusicAlbumRender["starts"] = [];
  let at = 0;
  for (const track of rendered) {
    starts.push({ trackId: track.trackId, atMs: at });
    at += track.durationMs;
  }
  if (rendered.length === 1) return { file: rendered[0]!.file, durationMs: at, starts, tracks: rendered };
  const key = keyOf({ renderer: MUSIC_RENDERER, album: rendered.map((track) => track.file) });
  return once(`${store.dir}|${key}`, async () => {
    const folder = await cacheDir(store.dir);
    const file = `${CACHE}/album-${key}.m4a`;
    const path = join(folder, `album-${key}.m4a`);
    const cached = await readReceipt<{ durationMs: number }>(join(folder, `album-${key}.json`), path, (receipt) => Number.isInteger(receipt.durationMs));
    if (cached !== null) return { file, durationMs: cached.durationMs, starts, tracks: rendered };
    const id = ulid();
    const list = join(folder, `${id}.txt`);
    const joined = join(folder, `${id}.m4a`);
    try {
      await writeFile(toExtendedLength(list), rendered.map((track) => `file '${track.path.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n") + "\n", "utf8");
      await options.ffmpeg.run(["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", joined], () => {}, signal);
      signal.throwIfAborted();
      await renameWithRetry(joined, path);
      await writeFile(toExtendedLength(join(folder, `album-${key}.json`)), JSON.stringify({ durationMs: at }), "utf8");
      return { file, durationMs: at, starts, tracks: rendered };
    } finally {
      await Promise.all([list, joined].map((temp) => rm(toExtendedLength(temp), { force: true }).catch(() => {})));
    }
  });
}
