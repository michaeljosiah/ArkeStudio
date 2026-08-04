import { useSyncExternalStore } from "react";

export type PlaybackStatus = "idle" | "loading" | "playing" | "paused" | "ended" | "blocked" | "error";
export interface PlaybackState {
  requestId: string | null;
  url: string | null;
  status: PlaybackStatus;
  error: string | null;
}

type AudioLike = Pick<HTMLAudioElement, "src" | "currentTime" | "play" | "pause" | "addEventListener" | "removeEventListener">;

let state: PlaybackState = { requestId: null, url: null, status: "idle", error: null };
let audio: AudioLike | null = null;
let factory: () => AudioLike = () => new Audio();
let playGeneration = 0;
const listeners = new Set<() => void>();

function publish(next: PlaybackState): void {
  state = next;
  listeners.forEach((listener) => listener());
}

function ensureAudio(): AudioLike {
  if (audio) return audio;
  audio = factory();
  audio.addEventListener("ended", onEnded);
  audio.addEventListener("error", onError);
  return audio;
}

function onEnded(): void {
  publish({ ...state, status: "ended" });
}

function onError(): void {
  publish({ ...state, status: "error", error: "This audio could not be played." });
}

export async function playAudio(requestId: string, url: string): Promise<void> {
  const generation = ++playGeneration;
  const element = ensureAudio();
  if (state.url !== url) {
    element.pause();
    element.currentTime = 0;
    element.src = url;
  }
  publish({ requestId, url, status: "loading", error: null });
  try {
    await element.play();
    if (generation !== playGeneration) return;
    publish({ requestId, url, status: "playing", error: null });
  } catch {
    if (generation !== playGeneration) return;
    publish({ requestId, url, status: "blocked", error: "Press Play to start the ready audio." });
  }
}

export function pauseAudio(): void {
  audio?.pause();
  if (state.requestId) publish({ ...state, status: "paused" });
}

export function stopAudio(): void {
  playGeneration += 1;
  if (audio) {
    audio.pause();
    audio.currentTime = 0;
    audio.src = "";
  }
  publish({ requestId: null, url: null, status: "idle", error: null });
}

export function usePlayback(): PlaybackState {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    () => state,
    () => state,
  );
}

export function setAudioFactoryForTest(next: (() => AudioLike) | null): void {
  stopAudio();
  if (audio) {
    audio.removeEventListener("ended", onEnded);
    audio.removeEventListener("error", onError);
  }
  audio = null;
  factory = next ?? (() => new Audio());
}
