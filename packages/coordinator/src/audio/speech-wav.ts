import { TAKE_LOUDNESS_TARGET, type AudiobookLoudness } from "@arke-studio/contracts";

/**
 * A speech WAV as samples, and back (design turn 185): what a grouped read is cut, measured and
 * gained by. Readers return 16-bit PCM — Gemini 24 kHz mono, Voxa 24 kHz — and this reads any
 * 16-bit PCM WAV with its chunks located rather than assumed, folding channels to one.
 */
export interface SpeechPcm {
  rate: number;
  /** Mono samples in −1..1. */
  samples: Float32Array;
}

export function readSpeechWav(bytes: Uint8Array): SpeechPcm {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
  if (bytes.length < 44 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a WAV");
  let rate = 0;
  let channels = 0;
  let data: { at: number; size: number } | null = null;
  for (let at = 12; at + 8 <= bytes.length;) {
    const size = view.getUint32(at + 4, true);
    if (tag(at) === "fmt ") {
      if (view.getUint16(at + 8, true) !== 1 || view.getUint16(at + 22, true) !== 16) throw new Error("not 16-bit PCM");
      channels = view.getUint16(at + 10, true);
      rate = view.getUint32(at + 12, true);
    }
    if (tag(at) === "data") data = { at: at + 8, size: Math.min(size, bytes.length - at - 8) };
    at += 8 + size + (size % 2);
  }
  if (rate <= 0 || channels <= 0 || data === null) throw new Error("not a readable WAV");
  const frames = Math.floor(data.size / (2 * channels));
  const samples = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel++) sum += view.getInt16(data.at + (frame * channels + channel) * 2, true);
    samples[frame] = sum / channels / 32768;
  }
  return { rate, samples };
}

/** Mono 16-bit PCM WAV of these samples; clipped, never wrapped. */
export function writeSpeechWav(pcm: SpeechPcm): Uint8Array {
  const out = Buffer.alloc(44 + pcm.samples.length * 2);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(36 + pcm.samples.length * 2, 4);
  out.write("WAVEfmt ", 8, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(pcm.rate, 24);
  out.writeUInt32LE(pcm.rate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(pcm.samples.length * 2, 40);
  for (let i = 0; i < pcm.samples.length; i++) {
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm.samples[i]! * 32768))), 44 + i * 2);
  }
  return new Uint8Array(out);
}

/** The samples from `start` to `end` seconds, clamped to the audio. */
export function sliceSpeech(pcm: SpeechPcm, start: number, end: number): SpeechPcm {
  const from = Math.max(0, Math.min(pcm.samples.length, Math.round(start * pcm.rate)));
  const to = Math.max(from, Math.min(pcm.samples.length, Math.round(end * pcm.rate)));
  return { rate: pcm.rate, samples: pcm.samples.slice(from, to) };
}

/** Seconds of audio. */
export function speechSeconds(pcm: SpeechPcm): number {
  return pcm.samples.length / pcm.rate;
}

/**
 * Each 10 ms frame's level in dBFS (RMS), the measure silence and pauses are found by. Digital
 * silence reads −120 rather than −Infinity so a threshold compares with it.
 */
export function frameLevels(pcm: SpeechPcm, frameSec = 0.01): Float32Array {
  const size = Math.max(1, Math.round(pcm.rate * frameSec));
  const count = Math.ceil(pcm.samples.length / size);
  const levels = new Float32Array(count);
  for (let frame = 0; frame < count; frame++) {
    let squares = 0;
    const end = Math.min(pcm.samples.length, (frame + 1) * size);
    for (let i = frame * size; i < end; i++) squares += pcm.samples[i]! * pcm.samples[i]!;
    const rms = Math.sqrt(squares / Math.max(1, end - frame * size));
    levels[frame] = rms > 1e-6 ? 20 * Math.log10(rms) : -120;
  }
  return levels;
}

/** Where speech is quiet enough to be a pause: 35 dB under the loudest frame, never louder than −40 dBFS. */
export function silenceThreshold(levels: Float32Array): number {
  let loudest = -120;
  for (const level of levels) loudest = Math.max(loudest, level);
  return Math.min(-40, loudest - 35);
}

/** A pause long enough to be between sentences or turns, not inside a word (SPEC-047 R-60). */
export const PAUSE_SEC = 0.15;

/** The runs of sound between pauses, in seconds, as heard: nothing merged, nothing split. */
export function soundSpans(pcm: SpeechPcm): Array<{ start: number; end: number }> {
  const levels = frameLevels(pcm);
  const threshold = silenceThreshold(levels);
  const frame = 0.01;
  const minPause = Math.round(PAUSE_SEC / frame);
  const spans: Array<{ start: number; end: number }> = [];
  let open = -1;
  let quiet = 0;
  for (let i = 0; i < levels.length; i++) {
    if (levels[i]! >= threshold) {
      if (open < 0) open = i;
      quiet = 0;
    } else if (open >= 0) {
      quiet += 1;
      if (quiet >= minPause) {
        spans.push({ start: open * frame, end: (i - quiet + 1) * frame });
        open = -1;
        quiet = 0;
      }
    }
  }
  if (open >= 0) spans.push({ start: open * frame, end: (levels.length - quiet) * frame });
  return spans;
}

/** The quiet between and around the spans of sound, in order, the last running to the end. */
export function speechPauses(pcm: SpeechPcm): Array<{ start: number; end: number }> {
  const spans = soundSpans(pcm);
  const seconds = speechSeconds(pcm);
  const pauses: Array<{ start: number; end: number }> = [];
  let at = 0;
  for (const span of spans) {
    if (span.start > at) pauses.push({ start: at, end: span.start });
    at = span.end;
  }
  if (seconds > at) pauses.push({ start: at, end: seconds });
  return pauses;
}

/** A blip of a runaway tail: Gemini's ran ~0.1 s a blip; a spoken word is longer. */
const TAIL_BLIP_SEC = 0.25;
/** As many blips as make a tail, and as long as it runs, so a last short word or a breath is not one. */
const TAIL_BLIPS = 3;
const TAIL_RUN_SEC = 1.5;
/** The most quiet a take keeps after its last word (design turn 185 follow-up): a pause, not a tail. */
export const TAIL_KEEP_SEC = 0.8;

/**
 * Where a runaway non-speech tail is cut, or null when the audio has none. A Gemini read can run
 * on past its words: the turn 185 probe's merged request ended its speech at 27.9 s and then
 * gave 26 s of short blips, one every 0.7 s, after a `<chuckle>`. A trailing run of at least
 * three blips of a quarter-second or less, over a second and a half, after sound that is longer,
 * is that tail; the cut is the middle of the pause before it, held to `TAIL_KEEP_SEC`.
 */
export function runawayTailAt(pcm: SpeechPcm): number | null {
  const spans = soundSpans(pcm);
  const first = runawayTailIndex(spans);
  if (first < 0) return null;
  const speechEnd = spans[first - 1]!.end;
  return speechEnd + Math.min(TAIL_KEEP_SEC, (spans[first]!.start - speechEnd) / 2);
}

/** The first of `soundSpans` that is a runaway tail, or −1. */
export function runawayTailIndex(spans: ReadonlyArray<{ start: number; end: number }>): number {
  let first = spans.length;
  while (first > 0 && spans[first - 1]!.end - spans[first - 1]!.start <= TAIL_BLIP_SEC) first -= 1;
  const blips = spans.length - first;
  if (first === 0 || blips < TAIL_BLIPS || spans.at(-1)!.end - spans[first]!.start < TAIL_RUN_SEC) return -1;
  return first;
}

/** A take with a runaway tail cut off, or the take as it came. */
export function dropRunawayTail(pcm: SpeechPcm): SpeechPcm {
  const at = runawayTailAt(pcm);
  return at === null ? pcm : sliceSpeech(pcm, 0, at);
}

/**
 * A take alone trimmed to a grouped take's pause (design turn 185): leading and trailing quiet
 * past `keepSec` is cut, so a block re-read without neighbours does not stand out between takes
 * that share their pauses. A runaway tail goes first, so its blips do not count as the last sound.
 */
export function trimSpeech(pcm: SpeechPcm, keepSec = 0.25): SpeechPcm {
  const tail = runawayTailAt(pcm);
  const levels = frameLevels(pcm);
  const threshold = silenceThreshold(levels);
  const first = levels.findIndex((level) => level >= threshold);
  if (first < 0) return pcm;
  let last = tail === null ? levels.length - 1 : Math.min(levels.length - 1, Math.floor(tail / 0.01));
  while (last > first && levels[last]! < threshold) last -= 1;
  return sliceSpeech(pcm, Math.max(0, first * 0.01 - keepSec), (last + 1) * 0.01 + keepSec);
}

/**
 * Integrated loudness (ITU-R BS.1770-4): K-weighted, 400 ms blocks at 75% overlap, gated at −70
 * LUFS and then 10 LU under the ungated mean. Null when nothing passes the gate — silence, or a
 * take too quiet to measure. A take under one block long is measured as one block.
 */
export function integratedLoudness(pcm: SpeechPcm): number | null {
  const weighted = kWeight(pcm);
  const block = Math.round(0.4 * pcm.rate);
  const step = Math.round(0.1 * pcm.rate);
  const powers: number[] = [];
  const meanSquare = (from: number, to: number) => {
    let sum = 0;
    for (let i = from; i < to; i++) sum += weighted[i]! * weighted[i]!;
    return sum / Math.max(1, to - from);
  };
  if (weighted.length < block) powers.push(meanSquare(0, weighted.length));
  else for (let from = 0; from + block <= weighted.length; from += step) powers.push(meanSquare(from, from + block));
  const lufs = (power: number) => -0.691 + 10 * Math.log10(power);
  const absolute = powers.filter((power) => power > 0 && lufs(power) > -70);
  if (absolute.length === 0) return null;
  const relative = lufs(absolute.reduce((sum, power) => sum + power, 0) / absolute.length) - 10;
  const gated = absolute.filter((power) => lufs(power) > relative);
  return lufs(gated.reduce((sum, power) => sum + power, 0) / gated.length);
}

/** The K-weighting pre-filter and high-pass at any sample rate (the coefficients libebur128 derives). */
function kWeight(pcm: SpeechPcm): Float32Array {
  const biquad = (input: Float32Array, b: number[], a: number[]) => {
    const out = new Float32Array(input.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < input.length; i++) {
      const x = input[i]!;
      const y = b[0]! * x + b[1]! * x1 + b[2]! * x2 - a[1]! * y1 - a[2]! * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      out[i] = y;
    }
    return out;
  };
  let f0 = 1681.974450955533, gain = 3.999843853973347, q = 0.7071752369554196;
  let k = Math.tan((Math.PI * f0) / pcm.rate);
  const vh = 10 ** (gain / 20);
  const vb = vh ** 0.4996667741545416;
  let a0 = 1 + k / q + k * k;
  const shelf = biquad(pcm.samples, [(vh + (vb * k) / q + k * k) / a0, (2 * (k * k - vh)) / a0, (vh - (vb * k) / q + k * k) / a0], [1, (2 * (k * k - 1)) / a0, (1 - k / q + k * k) / a0]);
  f0 = 38.13547087602444; q = 0.5003270373238773;
  k = Math.tan((Math.PI * f0) / pcm.rate);
  a0 = 1 + k / q + k * k;
  return biquad(shelf, [1, -2, 1], [1, (2 * (k * k - 1)) / a0, (1 - k / q + k * k) / a0]);
}

/** The loudest sample in dBFS, or null for silence. */
export function samplePeak(pcm: SpeechPcm): number | null {
  let peak = 0;
  for (const sample of pcm.samples) peak = Math.max(peak, Math.abs(sample));
  return peak > 0 ? 20 * Math.log10(peak) : null;
}

/**
 * The gain that brings a measured loudness to the take target (design turn 185), held so the
 * sample peak stays half a decibel under −1 dBFS: a true peak between samples can run that much
 * over a sample peak, and the coordinator measures here without ffmpeg, which is not always on hand.
 */
export function loudnessGain(measured: number | null, peak: number | null): number {
  if (measured === null) return 0;
  const wanted = TAKE_LOUDNESS_TARGET.integratedLufs - measured;
  const room = peak === null ? wanted : TAKE_LOUDNESS_TARGET.peakDbfs - 0.5 - peak;
  return Math.min(wanted, room);
}

/** These samples at a gain, and the loudness record a take keeps of it. */
export function applyGain(pcm: SpeechPcm, gainDb: number): SpeechPcm {
  if (gainDb === 0) return pcm;
  const factor = 10 ** (gainDb / 20);
  return { rate: pcm.rate, samples: pcm.samples.map((sample) => sample * factor) };
}

/** A take's samples brought to the target, measured as it stood: the measure and gain may be its request's. */
export function normaliseSpeech(pcm: SpeechPcm, measuredFrom: SpeechPcm = pcm): { pcm: SpeechPcm; loudness: AudiobookLoudness } {
  const integratedLufs = integratedLoudness(measuredFrom);
  const gainDb = loudnessGain(integratedLufs, samplePeak(measuredFrom));
  const gained = applyGain(pcm, gainDb);
  const round = (value: number | null) => (value === null ? null : Math.round(value * 100) / 100);
  return { pcm: gained, loudness: { integratedLufs: round(integratedLufs), gainDb: Math.round(gainDb * 100) / 100, peakDbfs: round(samplePeak(gained)) } };
}
