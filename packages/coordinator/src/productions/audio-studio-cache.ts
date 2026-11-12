import { AudioArrangementRefusal } from "@arke-studio/contracts";
import { DerivedCache, type DerivedCacheProblem } from "../media/derived-cache.js";

const refusals: Record<DerivedCacheProblem, string> = {
  "too-large": "This audio render exceeds the cache and scratch space budget; shorten the arrangement before rendering",
  unsafe: "The audio cache contains an unsafe file",
  changed: "The audio cache changed during cleanup",
  full: "Audio cache is full of recent or playing mixes; stop auditions or reopen the world before preparing more audio",
};

/** Recent exports get a copy grace period; active auditions and Listen are pinned explicitly. */
const mixes = new DerivedCache(".cache/audio-studio/mix", {
  owns: /^[a-f0-9]{64}\.(wav|json)$/,
  budget: { bytes: 8 * 1024 ** 3, files: 256, graceMs: 10 * 60 * 1000 },
  label: "audio cache",
  refuse: (problem) => new AudioArrangementRefusal(refusals[problem]),
});

/** A pin covers the WAV and its receipt. Playback pins last until Stop or world close. */
export const holdAudioStudioCache = (dir: string, file: string) => mixes.hold(dir, file);
export const retainAudioStudioCache = (dir: string, file: string, signal?: AbortSignal) => mixes.retain(dir, file, signal);
export const touchAudioStudioCache = (dir: string, file: string) => mixes.touch(dir, file);

/** Reserve output and temporary scratch space before rendering; if recent and playing mixes fill the budget, refuse more work. */
export const reserveAudioStudioCache = (dir: string, bytes: number, files: number, signal: AbortSignal, budget?: { bytes: number; files: number; graceMs: number }) =>
  mixes.reserve(dir, bytes, files, signal, budget);
