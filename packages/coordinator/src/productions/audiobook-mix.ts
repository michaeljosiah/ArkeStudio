import { mkdir, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { bedFade, duckEnvelope, isWorldAudioPath, mixKey, ulid, type ChapterMix } from "@arke-studio/contracts";
import { integratedLoudness, loudnessGain, readSpeechWav, writeSpeechWav, type SpeechPcm } from "../audio/speech-wav.js";
import type { FfmpegRunner } from "../takes/export.js";
import { atomicWriteFile } from "../world/atomic.js";
import { fromPortable, toExtendedLength } from "../world/paths.js";

/**
 * The one renderer (design turn 187, SPEC-047 R-85): a chapter's mix plan — its takes at their
 * places with their trims and nudges, the reactions under their hosts, the beds faded and ducked
 * under speech, the sounds at their blocks — turned into one file, then brought to one loudness
 * after the mix (185). The chapter's Play, the player (186) and the exports all hear this; none
 * of them joins takes its own way.
 *
 * It mixes here, on samples, rather than in an ffmpeg graph: a chapter is a hundred or more
 * pieces, and the duck under speech is computed from the plan's own speech, not guessed from the
 * signal. ffmpeg, where the host has one, only decodes what is not a plain WAV at the mix's rate.
 * The render is kept under the plan's name in the world's `.cache`, so the same timing plays again
 * without a render, and the folder holds a chapter's last few.
 */

/** The mix's rate: the readers' own (Gemini and Voxa speak at 24 kHz), so a take is mixed as it was made. */
export const MIX_RATE = 24_000;
/** The mix sits under the take target's ceiling with this much room, as a take is filed (185). */
const CEILING_DBFS = -1.5;
/** Renders a chapter keeps: its last Play, a window around a block or two, and the one before. */
const KEPT = 4;
/**
 * The renderer's own version, in a render's name beside its plan's (codex on PR 1503): the same
 * plan rendered by an earlier renderer is not this one's — the first cut a trailing sound at the
 * last voice — so a change to how a plan sounds moves this, and old renders are never reused.
 */
export const RENDER_VERSION = 2;

export function mixFolder(productionId: string, chapterFile: string): string {
  return `.cache/audiobook-mix/${productionId}/${chapterFile}`;
}

export class MixRefusal extends Error {}

/** A file's samples at the mix's rate: a 16-bit WAV read here, anything else through ffmpeg. */
async function decode(dir: string, file: string, ffmpeg: FfmpegRunner | undefined, signal: AbortSignal): Promise<SpeechPcm> {
  // Only audio inside the world is ever read (codex on PR 1497): a world carried in could name
  // `../../private.wav`, and the render lands in a cache the media route serves. The address is
  // checked as written, then the resolved file — a link out of the world is no better than `..`.
  if (!isWorldAudioPath(file)) throw new MixRefusal(`${file.split("/").pop()} is not in this world`);
  const absolute = join(dir, fromPortable(file));
  let bytes: Uint8Array;
  try {
    const root = await realpath(toExtendedLength(dir));
    const target = await realpath(toExtendedLength(absolute));
    const inside = relative(root, target);
    if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) throw new MixRefusal(`${file.split("/").pop()} is not in this world`);
    bytes = new Uint8Array(await readFile(target));
  } catch (err) {
    if (err instanceof MixRefusal) throw err;
    throw new MixRefusal(`${file.split("/").pop()} is not on this machine`);
  }
  if (file.toLowerCase().endsWith(".wav")) {
    try {
      const pcm = readSpeechWav(bytes);
      if (pcm.rate === MIX_RATE || ffmpeg === undefined) return resample(pcm, MIX_RATE);
    } catch {
      // A WAV this reader does not take (24-bit, float): ffmpeg, where there is one.
    }
  }
  if (ffmpeg === undefined) throw new MixRefusal(`mixing ${file.split(".").pop()} needs ffmpeg on this machine`);
  const scratch = join(dir, ".cache", "audiobook-mix", "decode");
  await mkdir(toExtendedLength(scratch), { recursive: true });
  const out = join(scratch, `${ulid()}.wav`);
  try {
    await ffmpeg.run(["-y", "-v", "error", "-i", absolute, "-vn", "-ac", "1", "-ar", String(MIX_RATE), "-c:a", "pcm_s16le", out], () => {}, signal);
    return readSpeechWav(new Uint8Array(await readFile(toExtendedLength(out))));
  } finally {
    await rm(toExtendedLength(out), { force: true }).catch(() => {});
  }
}
export { decode as decodeAudiobookAudio };

/** Linear interpolation to another rate: only for a plain WAV on a machine with no ffmpeg. */
export function resample(pcm: SpeechPcm, rate: number): SpeechPcm {
  if (pcm.rate === rate) return pcm;
  const length = Math.max(0, Math.round((pcm.samples.length * rate) / pcm.rate));
  const out = new Float32Array(length);
  const step = pcm.rate / rate;
  for (let i = 0; i < length; i++) {
    const at = i * step;
    const low = Math.floor(at);
    const high = Math.min(pcm.samples.length - 1, low + 1);
    const frac = at - low;
    out[i] = (pcm.samples[low] ?? 0) * (1 - frac) + (pcm.samples[high] ?? 0) * frac;
  }
  return { rate, samples: out };
}

const amp = (db: number): number => 10 ** (db / 20);

/**
 * Peaks held under the ceiling without a hard clip: two voices over one another sum past a take's
 * peak, and the mix keeps them under it with a soft knee rather than gaining the whole chapter down
 * for one shout.
 */
export function softLimit(samples: Float32Array, ceilingDb = CEILING_DBFS): void {
  const ceiling = amp(ceilingDb);
  const knee = ceiling * 0.7;
  const room = ceiling - knee;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i]!;
    const level = Math.abs(x);
    if (level <= knee) continue;
    samples[i] = Math.sign(x) * (knee + room * Math.tanh((level - knee) / room));
  }
}

/**
 * The mix as samples (R-85): `window` renders only from `from` to `to` on the chapter's clock —
 * a block with its neighbours — and is measured for loudness on its own.
 */
export async function mixSamples(
  dir: string,
  mix: ChapterMix,
  options: { ffmpeg?: FfmpegRunner; window?: { from: number; to: number }; signal?: AbortSignal } = {},
): Promise<SpeechPcm> {
  const signal = options.signal ?? new AbortController().signal;
  const from = Math.max(0, options.window?.from ?? 0);
  const windowTo = Math.min(mix.seconds, options.window?.to ?? mix.seconds);
  if (!(windowTo > from)) throw new MixRefusal("nothing to play there");
  // Sounds first, measured from their files (codex on PR 1497): a sound past the last voice runs
  // the chapter on to its own end rather than being cut at the plan's. One that starts after a
  // window is never read, so a later file cannot hold up or refuse a preview of an early block.
  // Only their lengths are kept here, a file at a time (codex on PR 1503): a chapter of many or
  // long sounds must not hold every one decoded while the voices and beds are mixed. Each file is
  // read again when it is placed, at the end, and let go after.
  const lengths = new Map<string, number>();
  const sounds: Array<{ at: number; levelDb: number; file: string; seconds: number }> = [];
  for (const sound of mix.sounds) {
    if (sound.at >= windowTo) continue;
    let seconds = lengths.get(sound.file);
    if (seconds === undefined) {
      seconds = (await decode(dir, sound.file, options.ffmpeg, signal)).samples.length / MIX_RATE;
      lengths.set(sound.file, seconds);
    }
    if (sound.at + seconds <= from) continue;
    sounds.push({ at: sound.at, levelDb: sound.levelDb, file: sound.file, seconds });
  }
  const to = options.window !== undefined ? windowTo : Math.max(windowTo, ...sounds.map((sound) => sound.at + sound.seconds));
  const out = new Float32Array(Math.ceil((to - from) * MIX_RATE));
  const inside = (at: number, seconds: number) => at < to && at + seconds > from;

  // Each file read once, and let go once no later piece plays it: the takes run in order, so a
  // long chapter never holds all of them.
  const cache = new Map<string, SpeechPcm>();
  const voices = mix.voices.filter((voice) => inside(voice.at, voice.segments.reduce((sum, segment) => sum + segment.to - segment.from, 0)));
  const lastUse = new Map<string, number>();
  voices.forEach((voice, index) => voice.segments.forEach((segment) => lastUse.set(segment.file, index)));
  const load = async (file: string): Promise<SpeechPcm> => {
    const held = cache.get(file);
    if (held !== undefined) return held;
    if (signal.aborted) throw new MixRefusal("stopped");
    const pcm = await decode(dir, file, options.ffmpeg, signal);
    cache.set(file, pcm);
    return pcm;
  };
  const place = (source: Float32Array, sourceFrom: number, sourceTo: number, at: number, gain: (t: number) => number = () => 1): void => {
    const start = Math.round((at - from) * MIX_RATE);
    const first = Math.round(sourceFrom * MIX_RATE);
    const last = Math.min(source.length, Math.round(sourceTo * MIX_RATE));
    for (let i = first; i < last; i++) {
      const target = start + (i - first);
      if (target < 0) continue;
      if (target >= out.length) break;
      out[target]! += source[i]! * gain(target);
    }
  };

  for (const [index, voice] of voices.entries()) {
    let at = voice.at;
    for (const segment of voice.segments) {
      const pcm = await load(segment.file);
      place(pcm.samples, segment.from, segment.to, at);
      at += segment.to - segment.from;
    }
    for (const segment of voice.segments) if (lastUse.get(segment.file) === index) cache.delete(segment.file);
  }

  // Beds: looped across their run, faded at either end, ducked under every voice by the plan's speech.
  const frameSec = 0.01;
  const duck = mix.beds.length > 0 ? duckEnvelope(mix.speech, mix.seconds, frameSec) : new Float32Array(0);
  for (const bed of mix.beds) {
    if (!inside(bed.at, bed.seconds)) continue;
    const pcm = await decode(dir, bed.file, options.ffmpeg, signal);
    const length = pcm.samples.length;
    if (length === 0) continue;
    const level = bed.levelDb;
    const firstSample = Math.max(0, Math.round((bed.at - from) * MIX_RATE));
    const lastSample = Math.min(out.length, Math.round((bed.at + bed.seconds - from) * MIX_RATE));
    // The gain is worked out a frame at a time and eased across it, so a ten-minute bed is not
    // ten million powers of ten.
    const frameSamples = Math.round(frameSec * MIX_RATE);
    const gainAt = (t: number): number => {
      const frame = Math.min(duck.length - 1, Math.floor(t / frameSec));
      const ducked = frame >= 0 ? duck[frame]! : 0;
      return amp(level - bed.duckDb * ducked) * bedFade(t, bed);
    };
    let sourceAt = Math.max(0, Math.round((from + firstSample / MIX_RATE - bed.at) * MIX_RATE)) % length;
    for (let frameStart = firstSample; frameStart < lastSample; frameStart += frameSamples) {
      const frameEnd = Math.min(lastSample, frameStart + frameSamples);
      const g0 = gainAt(from + frameStart / MIX_RATE);
      const g1 = gainAt(from + frameEnd / MIX_RATE);
      for (let target = frameStart; target < frameEnd; target++) {
        const gain = g0 + ((g1 - g0) * (target - frameStart)) / frameSamples;
        out[target]! += pcm.samples[sourceAt]! * gain;
        sourceAt += 1;
        if (sourceAt >= length) sourceAt = 0;
      }
    }
  }

  // A file at a time: each decoded once, placed wherever the chapter plays it, then let go.
  for (const file of new Set(sounds.map((sound) => sound.file))) {
    const pcm = await decode(dir, file, options.ffmpeg, signal);
    for (const sound of sounds) {
      if (sound.file !== file) continue;
      const gain = amp(sound.levelDb);
      place(pcm.samples, 0, pcm.samples.length / MIX_RATE, sound.at, () => gain);
    }
  }

  // One loudness after the mix (185): the whole brought to the take target, then held under the ceiling.
  const pcm: SpeechPcm = { rate: MIX_RATE, samples: out };
  const gainDb = loudnessGain(integratedLoudness(pcm), null);
  // A window is measured on its own; a few blocks are not a chapter, so it moves only a little.
  const applied = options.window !== undefined ? Math.max(-6, Math.min(6, gainDb)) : gainDb;
  if (applied !== 0) {
    const factor = amp(applied);
    for (let i = 0; i < out.length; i++) out[i]! *= factor;
  }
  softLimit(out);
  return pcm;
}

/**
 * The mix rendered into the world's cache and named by its plan, reused when the same plan is
 * asked for again. Returns the world-relative file the media route serves.
 */
export async function renderChapterMix(
  dir: string,
  productionId: string,
  chapterFile: string,
  mix: ChapterMix,
  options: { ffmpeg?: FfmpegRunner; window?: { from: number; to: number }; signal?: AbortSignal } = {},
): Promise<{ file: string; seconds: number; from: number }> {
  const folder = mixFolder(productionId, chapterFile);
  const window = options.window === undefined ? null : { from: Math.max(0, options.window.from), to: Math.min(mix.seconds, options.window.to) };
  const name = `r${RENDER_VERSION}-${mixKey(mix)}${window === null ? "" : `-${Math.round(window.from * 1000)}-${Math.round(window.to * 1000)}`}.wav`;
  const file = `${folder}/${name}`;
  const absolute = join(dir, fromPortable(file));
  // The render's own length, not the plan's: a sound may run past the last voice. A kept render's
  // is read off its size — the renderer writes a 16-bit mono WAV with a 44-byte header.
  const held = await stat(toExtendedLength(absolute)).then((s) => (s.isFile() ? s.size : null), () => null);
  let seconds: number;
  if (held === null) {
    const pcm = await mixSamples(dir, mix, { ...options, ...(window !== null ? { window } : {}) });
    await mkdir(toExtendedLength(join(dir, fromPortable(folder))), { recursive: true });
    await atomicWriteFile(absolute, writeSpeechWav(pcm));
    await prune(join(dir, fromPortable(folder)), name);
    seconds = pcm.samples.length / MIX_RATE;
  } else seconds = Math.max(0, held - 44) / 2 / MIX_RATE;
  return { file, seconds: Math.round(seconds * 1000) / 1000, from: window?.from ?? 0 };
}

/** The folder down to its newest few renders, never the one just made. */
async function prune(folder: string, keep: string): Promise<void> {
  const names = (await readdir(toExtendedLength(folder)).catch(() => [] as string[])).filter((name) => name.endsWith(".wav") && name !== keep);
  const dated = await Promise.all(names.map(async (name) => ({ name, at: (await stat(toExtendedLength(join(folder, name))).catch(() => null))?.mtimeMs ?? 0 })));
  dated.sort((a, b) => b.at - a.at);
  for (const old of dated.slice(KEPT - 1)) await rm(toExtendedLength(join(folder, old.name)), { force: true }).catch(() => {});
}
