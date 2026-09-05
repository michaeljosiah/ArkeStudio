import { useSyncExternalStore } from "react";

/**
 * One clip sounds at a time, through one element, owned here (SPEC-011, design 25c).
 *
 * The store mirrors the element rather than predicting it: every status change other than the
 * optimistic one in playClip arrives from a media event, so a pause from the OS, an ended clip
 * or a decode failure all reach the UI without anyone having to remember to publish.
 */

export type PlaybackStatus = "idle" | "loading" | "playing" | "paused" | "ended" | "blocked" | "error";

/**
 * A clip is keyed by whatever is stable for its source: a queue requestId for generated audio,
 * an artifact id or world-relative path for a file already on disk. The dock shows title and
 * sub, so a clip that outlives the row it started from can still say what it is.
 */
export interface Clip {
  id: string;
  url: string;
  title: string;
  sub?: string;
  /** Physical source coordinates for an explicitly reviewed excerpt. */
  range?: { inSec: number; outSec: number };
}

export interface PlaybackState {
  clip: Clip | null;
  status: PlaybackStatus;
  /** Seconds. `duration` stays 0 until the metadata says otherwise — streams never report one. */
  currentTime: number;
  duration: number;
  error: string | null;
}

type AudioLike = Pick<
  HTMLAudioElement,
  "src" | "currentTime" | "duration" | "play" | "pause" | "load" | "removeAttribute" | "addEventListener" | "removeEventListener"
> & { playbackRate?: number };

const IDLE: PlaybackState = { clip: null, status: "idle", currentTime: 0, duration: 0, error: null };

let state: PlaybackState = IDLE;
let audio: AudioLike | null = null;
let factory: () => AudioLike = () => new Audio();
let playGeneration = 0;
const listeners = new Set<() => void>();

function publish(next: PlaybackState): void {
  state = next;
  listeners.forEach((listener) => listener());
}

const EVENTS = ["play", "pause", "ended", "timeupdate", "loadedmetadata", "durationchange", "error"] as const;

function handle(event: Event): void {
  // Every handler is a no-op once the clip is gone: dismissing detaches the source, and the
  // abort that follows would otherwise land as a spurious error on an idle dock.
  if (!state.clip || !audio) return;
  switch (event.type) {
    case "play":
      publish({ ...state, status: "playing", error: null });
      return;
    case "pause":
      if (state.status !== "ended") publish({ ...state, status: "paused" });
      return;
    case "ended":
      if (playlist && state.clip.id === playlist.items[playlist.index]?.id) { nextPlaylistLine(); return; }
      /*
       * A queued read walks to its next piece here rather than stopping.
       *
       * `at` advances whether or not the next piece exists yet, because it means "the piece to
       * play now", not "the piece playing". Leaving it where it was would make the next append
       * replay the piece that just finished — which is what the first version of this did.
       * When the queue has run dry the element rests on `ended`, and `enqueueClip` starts it
       * again the moment another piece lands.
       */
      if (queue && state.clip?.id === queue.id) {
        queue.at += 1;
        if (queue.urls[queue.at] !== undefined) {
          void playQueued();
          return;
        }
      }
      publish({ ...state, status: "ended", currentTime: state.duration });
      return;
    case "timeupdate":
      if (state.clip.range && audio.currentTime >= state.clip.range.outSec) {
        audio.pause();
        publish({ ...state, status: "ended", currentTime: state.clip.range.outSec });
        if (playlist && state.clip?.id === playlist.items[playlist.index]?.id) nextPlaylistLine();
        return;
      }
      publish({ ...state, currentTime: audio.currentTime });
      return;
    case "loadedmetadata":
      if (state.clip.range) audio.currentTime = state.clip.range.inSec;
      publish({ ...state, currentTime: audio.currentTime, duration: Number.isFinite(audio.duration) ? audio.duration : 0 });
      return;
    case "durationchange":
      publish({ ...state, duration: Number.isFinite(audio.duration) ? audio.duration : 0 });
      return;
    case "error":
      publish({ ...state, status: "error", error: "This audio could not be played." });
  }
}

function ensureAudio(): AudioLike {
  if (audio) return audio;
  audio = factory();
  for (const name of EVENTS) audio.addEventListener(name, handle);
  return audio;
}

/** Load and play a clip, replacing whatever was sounding. Re-playing the current clip resumes. */
export async function playClip(clip: Clip, playlistOwned = false): Promise<void> {
  if (!playlistOwned && playlist) { playlist = null; publish({ ...state }); }
  const generation = ++playGeneration;
  const element = ensureAudio();
  element.playbackRate = playlistOwned ? playlist?.rate ?? 1 : 1;
  if (state.clip?.url !== clip.url || JSON.stringify(state.clip?.range) !== JSON.stringify(clip.range)) {
    element.pause();
    element.currentTime = 0;
    element.src = clip.url;
    publish({ clip, status: "loading", currentTime: 0, duration: 0, error: null });
  } else {
    if (state.status === "ended") element.currentTime = clip.range?.inSec ?? 0;
    publish({ ...state, clip, error: null });
  }
  try {
    await element.play();
    if (generation !== playGeneration) return;
    if (state.status === "error") return;
    publish({ ...state, status: "playing", error: null });
  } catch {
    if (generation !== playGeneration) return;
    // A source that cannot decode rejects play() *and* fires error, and the error event often
    // lands first. Telling the user to press play would send them at something that cannot work.
    if (state.status === "error") return;
    // Otherwise this is the autoplay policy: the dock is up and its own play button will work.
    publish({ ...state, status: "blocked", error: "Press play to start the ready audio." });
  }
}

/*
 * A read that arrives in pieces (2026-08-24).
 *
 * Local synthesis runs at roughly the speed of speech, so a ten-minute passage is made over ten
 * minutes. Rather than hold the first word until the last one exists, the coordinator sends each
 * piece as it lands and they queue here: the first plays immediately, each following one is
 * appended, and `ended` advances to the next. When the queue runs dry mid-read the element simply
 * stops on `ended`, and the next append starts it again — which is why nothing here polls or
 * guesses at how long a piece takes.
 *
 * Keyed by the request that owns the read. A second read replaces the first outright: two voices
 * over one another is never what anybody meant.
 */
let queue: { id: string; urls: string[]; at: number; title: string; sub?: string } | null = null;

/** Start a queued read, or append to the one already running under this id. */
export async function enqueueClip(clip: Clip & { part: number }): Promise<void> {
  if (!queue || queue.id !== clip.id) {
    queue = { id: clip.id, urls: [], at: 0, title: clip.title, ...(clip.sub ? { sub: clip.sub } : {}) };
  }
  queue.urls[clip.part] = clip.url;
  // Nothing sounding for this read yet — start it. `ended` carries the rest.
  const idle = state.clip?.id !== clip.id || state.status === "ended" || state.status === "idle";
  if (idle && queue.urls[queue.at] !== undefined) await playQueued();
}

async function playQueued(): Promise<void> {
  if (!queue) return;
  const url = queue.urls[queue.at];
  if (url === undefined) return; // the next piece is still being made; `enqueueClip` resumes us
  await playClip({ id: queue.id, url, title: queue.title, ...(queue.sub ? { sub: queue.sub } : {}) });
}

/** Stop and forget a queued read — a new read, or the dock being dismissed. */
export function clearQueue(): void {
  queue = null;
}

/** The dock's play/pause. Rows use it too, so the same clip toggles from either place. */
export function togglePlayback(): void {
  if (!state.clip) return;
  if (state.status === "playing") {
    audio?.pause();
    return;
  }
  void playClip(state.clip, playlist !== null);
}

export function seekTo(seconds: number): void {
  if (!audio || !state.clip) return;
  const end = state.clip.range?.outSec ?? state.duration;
  const bounded = Math.max(state.clip.range?.inSec ?? 0, end > 0 ? Math.min(seconds, end) : seconds);
  audio.currentTime = bounded;
  publish({ ...state, currentTime: bounded, status: state.status === "ended" ? "paused" : state.status });
}

/** Stop, detach the source and take the dock down. */
export function dismissPlayback(): void {
  playlist = null;
  playGeneration += 1;
  const element = audio;
  publish(IDLE);
  if (element) {
    element.pause();
    element.currentTime = 0;
    // Not `src = ""` — that resolves against the document and fails to load, which used to
    // arrive as an error event a tick after the dock had already gone idle.
    element.removeAttribute("src");
    element.load();
  }
}

/** The same value `usePlayback` reads, for callers outside a render. */
export function playbackSnapshot(): PlaybackState {
  return state;
}

export function usePlayback(): PlaybackState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
    () => state,
  );
}

export function setAudioFactoryForTest(next: (() => AudioLike) | null): void {
  dismissPlayback();
  if (audio) for (const name of EVENTS) audio.removeEventListener(name, handle);
  audio = null;
  factory = next ?? (() => new Audio());
}

/** Drive the store from a test's fake element without going through the DOM. */
export function emitForTest(type: (typeof EVENTS)[number]): void {
  handle({ type } as Event);
}


export interface PlaylistItem extends Clip { lineId: string; speakerSheetId: string }
export interface PlaylistState { items: PlaylistItem[]; index: number; rate: 0.75 | 1 | 1.25 | 1.5; soloSheetId: string | null; notice: string }
let playlist: PlaylistState | null = null;
export function playlistSnapshot(): PlaylistState | null { return playlist; }
export function usePlaylist(): PlaylistState | null {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, () => playlist, () => playlist);
}
function updatePlaylist(next: PlaylistState | null) { playlist = next; publish({ ...state }); }
export function loadPlaylist(items: PlaylistItem[]): void {
  dismissPlayback(); clearQueue();
  updatePlaylist({ items: [...items], index: 0, rate: 1, soloSheetId: null, notice: items.length ? "Table read ready." : "No playable lines." });
}
export function clearPlaylist(): void {
  const owns = playlist?.items[playlist.index]?.id === state.clip?.id;
  updatePlaylist(null);
  if (owns) dismissPlayback();
}
export async function playPlaylistLine(index = playlist?.index ?? 0): Promise<void> {
  const current = playlist;
  const item = current?.items[index];
  if (!current || !item || (current.soloSheetId && item.speakerSheetId !== current.soloSheetId)) return;
  updatePlaylist({ ...current, index, notice: `${state.status === "error" ? "Skipped the line that could not be decoded. " : ""}Playing ${item.title}` });
  await playClip(item, true);
}
export function nextPlaylistLine(direction: 1 | -1 = 1): void {
  if (!playlist) return;
  let index = playlist.index + direction;
  while (index >= 0 && index < playlist.items.length && playlist.soloSheetId && playlist.items[index]?.speakerSheetId !== playlist.soloSheetId) index += direction;
  if (index < 0 || index >= playlist.items.length) {
    audio?.pause(); updatePlaylist({ ...playlist, notice: "End of table read." });
    publish({ ...state, status: "ended" }); return;
  }
  updatePlaylist({ ...playlist, notice: state.status === "error" ? "Skipped the line that could not be decoded." : "Moving to the next line." });
  void playPlaylistLine(index);
}
export function restartPlaylistLine(): void {
  if (!playlist) return;
  seekTo(playlist.items[playlist.index]?.range?.inSec ?? 0); void playPlaylistLine();
}
export function setPlaylistRate(rate: PlaylistState["rate"]): void {
  if (!playlist || ![0.75, 1, 1.25, 1.5].includes(rate)) return;
  updatePlaylist({ ...playlist, rate }); if (audio) audio.playbackRate = rate;
}
export function setPlaylistSolo(sheetId: string | null): void {
  if (!playlist) return;
  updatePlaylist({ ...playlist, soloSheetId: sheetId });
  if (!sheetId || playlist.items[playlist.index]?.speakerSheetId === sheetId) return;
  const index = playlist.items.findIndex(item => item.speakerSheetId === sheetId);
  if (index === -1) { audio?.pause(); updatePlaylist({ ...playlist, notice: "This character has no playable lines." }); return; }
  void playPlaylistLine(index);
}
