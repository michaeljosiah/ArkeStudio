import { createHash } from "node:crypto";
import {
  AUDIO_STUDIO_RATE,
  type AudioArrangementCommand, type AudioArrangementState, type AudioHeardNote, type ResolvedAudioArrangement, type ResolvedAudioClip,
} from "@arke-studio/contracts";
import type { FfmpegRunner } from "../takes/export.js";
import type { StereoPcm } from "../audio/stereo-wav.js";
import { mixAudioStudioChunk } from "./audio-studio-mix.js";
import { readAudioStudioSource } from "./audio-studio-source.js";

/**
 * What of an episode's mix was heard, and what hearing it showed (design turn 230o, issue 1882).
 * An audio note rests only on an interval actually heard, so it is made here, from what the
 * studio played whole, and never from the script.
 */

/** How far above what plays under it a line must sit to be followed by ear; under that is a note. */
export const INTELLIGIBLE_MARGIN_DB = 6;

/**
 * Spans in seconds, clamped to the mix and merged: two listens a quarter of a second apart are
 * one, since the player reports its clock a few times a second and a seam is not a gap heard.
 */
export function mergeHeardSpans(spans: ReadonlyArray<readonly [number, number]>, seconds: number): Array<[number, number]> {
  const clamped = spans
    .map(([from, to]) => [Math.max(0, Math.min(from, to, seconds)), Math.max(0, Math.min(Math.max(from, to), seconds))] as [number, number])
    .filter(([from, to]) => to - from > 0)
    .sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const span of clamped) {
    const last = merged.at(-1);
    if (last && span[0] <= last[1] + 0.25) last[1] = Math.max(last[1], span[1]);
    else merged.push([...span]);
  }
  return merged.map(([from, to]) => [round(from), round(to)] as [number, number]).slice(0, 500);
}

const round = (value: number) => Math.round(value * 10) / 10;
const heardWhole = (spans: ReadonlyArray<readonly [number, number]>, entry: ResolvedAudioClip) => {
  const from = entry.at / AUDIO_STUDIO_RATE, to = (entry.at + entry.samples) / AUDIO_STUDIO_RATE;
  return spans.some(([start, end]) => start <= from + 0.1 && end >= to - 0.1);
};
const level = (mix: { left: Float32Array; right: Float32Array }) => {
  let power = 0;
  for (let i = 0; i < mix.left.length; i++) power += (mix.left[i]! ** 2 + mix.right[i]! ** 2) / 2;
  return power > 0 ? 10 * Math.log10(power / Math.max(1, mix.left.length)) : null;
};
const listed = (names: readonly string[]) => names.length < 2 ? names[0] ?? "" : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/**
 * Each line heard whole, measured against what plays under it as the mix plays both — gains,
 * fades and the ducking under speech — and noted where it sits less than the margin above. A
 * line under nothing, or one already measured in `skip`, is left. Its fix ducks what plays under
 * it by what is missing, for Current and Suggested; a line no duck can lift gets no fix.
 */
export async function heardIntelligibility(dir: string, input: {
  state: AudioArrangementState; plan: ResolvedAudioArrangement; base: string;
  passages: ReadonlyArray<{ key: string; text: string }>; spans: ReadonlyArray<readonly [number, number]>;
  skip?: (entry: ResolvedAudioClip) => boolean;
}, options: { ffmpeg?: FfmpegRunner; signal?: AbortSignal } = {}): Promise<AudioHeardNote[]> {
  const playable = input.plan.clips.filter((entry) => entry.clip.source && !entry.muted);
  const speech = playable.filter((entry) => entry.clip.role === "speech").map((entry) => ({ at: entry.at, samples: entry.samples }));
  const track = (id: string) => input.state.tracks.find((candidate) => candidate.id === id)?.name ?? id;
  const decoded = new Map<string, StereoPcm | null>();
  const pcm = async (entry: ResolvedAudioClip) => {
    const source = entry.clip.source!;
    if (!decoded.has(source.file)) {
      decoded.set(source.file, await readAudioStudioSource(dir, source.file, { ...options, expectedHash: source.hash }).then((read) => read.pcm, () => {
        options.signal?.throwIfAborted();
        return null;
      }));
    }
    return decoded.get(source.file) ?? null;
  };
  const notes: AudioHeardNote[] = [];
  for (const entry of playable) {
    options.signal?.throwIfAborted();
    if (entry.clip.role !== "speech" || !heardWhole(input.spans, entry) || input.skip?.(entry)) continue;
    const under = playable.filter((other) => other.clip.role !== "speech" && other.at < entry.at + entry.samples && other.at + other.samples > entry.at);
    if (under.length === 0) continue;
    const sources = new Map<string, StereoPcm>();
    for (const other of [entry, ...under]) { const read = await pcm(other); if (read) sources.set(other.clip.source!.file, read); }
    if (!sources.has(entry.clip.source!.file)) continue;
    const line = level(mixAudioStudioChunk([entry], sources, entry.at, entry.samples, speech));
    const bed = level(mixAudioStudioChunk(under, sources, entry.at, entry.samples, speech));
    if (line === null || bed === null || line - bed >= INTELLIGIBLE_MARGIN_DB) continue;
    const margin = line - bed, who = track(entry.clip.trackId), names = [...new Set(under.map((other) => track(other.clip.trackId)))];
    const needed = Math.ceil(INTELLIGIBLE_MARGIN_DB - margin);
    const commands: AudioArrangementCommand[] = [...new Map(under.map((other) => [other.clip.id, other.clip])).values()]
      .filter((clip) => clip.duckDb < 30)
      .map((clip) => ({ kind: "set-clip", id: clip.id, changes: { duckDb: Math.min(30, clip.duckDb + needed) } }));
    const passage = input.state.passages.find((candidate) => candidate.id === entry.clip.passageId);
    const block = passage?.key ?? entry.clip.id;
    const from = round(entry.at / AUDIO_STUDIO_RATE), to = round((entry.at + entry.samples) / AUDIO_STUDIO_RATE);
    notes.push({
      key: createHash("sha256").update(JSON.stringify({ base: input.base, block, from, to })).digest("hex").slice(0, 32),
      check: "intelligibility", block,
      quote: (input.passages.find((candidate) => candidate.key === block)?.text ?? entry.clip.label).slice(0, 300),
      from, to,
      observed: (margin < 0 ? `${who} ${Math.round(-margin)} dB under ${listed(names)}` : `${who} only ${Math.round(margin)} dB over ${listed(names)}`).slice(0, 300),
      ...(commands.length > 0 ? { fix: { label: `Duck ${listed(names)} ${needed} dB more under ${who}`.slice(0, 200), commands: commands.slice(0, 20) } } : {}),
    });
  }
  return notes;
}
