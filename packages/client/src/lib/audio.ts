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
>;

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
      publish({ ...state, status: "ended", currentTime: state.duration });
      return;
    case "timeupdate":
      publish({ ...state, currentTime: audio.currentTime });
      return;
    case "loadedmetadata":
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
export async function playClip(clip: Clip): Promise<void> {
  const generation = ++playGeneration;
  const element = ensureAudio();
  if (state.clip?.url !== clip.url) {
    element.pause();
    element.currentTime = 0;
    element.src = clip.url;
    publish({ clip, status: "loading", currentTime: 0, duration: 0, error: null });
  } else {
    if (state.status === "ended") element.currentTime = 0;
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

/** The dock's play/pause. Rows use it too, so the same clip toggles from either place. */
export function togglePlayback(): void {
  if (!state.clip) return;
  if (state.status === "playing") {
    audio?.pause();
    return;
  }
  void playClip(state.clip);
}

export function seekTo(seconds: number): void {
  if (!audio || !state.clip) return;
  const bounded = Math.max(0, state.duration > 0 ? Math.min(seconds, state.duration) : seconds);
  audio.currentTime = bounded;
  publish({ ...state, currentTime: bounded, status: state.status === "ended" ? "paused" : state.status });
}

/** Stop, detach the source and take the dock down. */
export function dismissPlayback(): void {
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
