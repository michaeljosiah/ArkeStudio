/**
 * WAV for Voxa's whisper (SPEC-011 R-17): `/stt` takes 16 kHz mono 16-bit PCM and answers 415 to
 * anything else. Gemini speech arrives at 24 kHz, prepared takes at 48 kHz and a dropped-in file at
 * whatever it was recorded at, so every one of them was refused — the grouped split heard nothing,
 * and recorded and kept performances filed `stt-failed` under a catch that said nothing (found by
 * the turn 185 probe, 2026-10-03). The client converts at the one boundary every caller crosses.
 *
 * Pure TypeScript, because the coordinator does not always have ffmpeg. The resample is band-limited
 * (a Kaiser-windowed sinc): decimating 48 kHz to 16 kHz by interpolation alone folds everything
 * between 8 and 24 kHz back over the speech band, which is the hiss whisper hears as words.
 */

export const TRANSCRIPTION_RATE = 16_000;

export interface DecodedWav {
  rate: number;
  channels: number;
  /** What the file stores: `pcm16` only when it is already 16-bit integer PCM. */
  encoding: "pcm8" | "pcm16" | "pcm24" | "pcm32" | "float32" | "float64";
  /** The channels folded to one, in −1..1. */
  mono: Float32Array;
}

const WAV_TYPES = new Set(["audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave", "audio/x-pn-wav"]);

/** Whether a content type names WAV, whatever its case or parameters. */
export function isWavContentType(contentType: string): boolean {
  return WAV_TYPES.has(contentType.split(";")[0]!.trim().toLowerCase());
}

/**
 * Any integer or float PCM WAV, its chunks located rather than assumed. Null for what is not a
 * WAV this can read — compressed formats, a truncated header — which the caller sends on as it
 * came, so the sidecar's own refusal is what the user sees, as before.
 */
export function decodeWav(bytes: Uint8Array): DecodedWav | null {
  if (bytes.length < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let format: { code: number; channels: number; rate: number; bits: number } | null = null;
  let data: { at: number; size: number } | null = null;
  for (let at = 12; at + 8 <= bytes.length;) {
    const declared = view.getUint32(at + 4, true);
    const size = Math.min(declared, bytes.length - at - 8);
    if (tag(at) === "fmt " && size >= 16) {
      let code = view.getUint16(at + 8, true);
      // WAVE_FORMAT_EXTENSIBLE carries the real format in the first two bytes of its sub-format GUID.
      if (code === 0xfffe && size >= 40) code = view.getUint16(at + 8 + 24, true);
      format = { code, channels: view.getUint16(at + 10, true), rate: view.getUint32(at + 12, true), bits: view.getUint16(at + 22, true) };
    }
    if (tag(at) === "data") {
      data = { at: at + 8, size };
      break;
    }
    at += 8 + declared + (declared % 2);
  }
  if (format === null || data === null || format.channels < 1 || format.rate < 1) return null;
  const encoding: DecodedWav["encoding"] | null =
    format.code === 1
      ? format.bits === 8 ? "pcm8" : format.bits === 16 ? "pcm16" : format.bits === 24 ? "pcm24" : format.bits === 32 ? "pcm32" : null
      : format.code === 3
        ? format.bits === 32 ? "float32" : format.bits === 64 ? "float64" : null
        : null;
  if (encoding === null) return null;
  const width = format.bits / 8;
  const stride = width * format.channels;
  const frames = Math.floor(data.size / stride);
  const read = (at: number): number => {
    switch (encoding) {
      case "pcm8": return (bytes[at]! - 128) / 128;
      case "pcm16": return view.getInt16(at, true) / 32768;
      case "pcm24": return ((bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16)) << 8 >> 8) / 8388608;
      case "pcm32": return view.getInt32(at, true) / 2147483648;
      case "float32": return view.getFloat32(at, true);
      case "float64": return view.getFloat64(at, true);
    }
  };
  const mono = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0;
    for (let channel = 0; channel < format.channels; channel++) sum += read(data.at + frame * stride + channel * width);
    mono[frame] = sum / format.channels;
  }
  return { rate: format.rate, channels: format.channels, encoding, mono };
}

/** Mono 16-bit PCM WAV; clipped, never wrapped. */
export function encodePcm16Wav(samples: Float32Array, rate: number): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(out.buffer);
  const ascii = (at: number, text: string) => { for (let i = 0; i < text.length; i++) out[at + i] = text.charCodeAt(i); };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const value = Number.isFinite(samples[i]!) ? samples[i]! : 0;
    view.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(value * 32768))), true);
  }
  return out;
}

/** Stopband attenuation of the anti-alias filter, in dB. */
const STOPBAND_DB = 70;
/** The transition band, as a share of the lower rate's Nyquist: 6.5–8 kHz at a 16 kHz output. */
const TRANSITION = 0.1875;

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** The zeroth-order modified Bessel function, for the Kaiser window. */
function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 64; k++) {
    term *= (x / (2 * k)) * (x / (2 * k));
    sum += term;
    if (term < sum * 1e-12) break;
  }
  return sum;
}

/**
 * A resampler from one rate to another, as rational polyphase: output sample n sits at input
 * position n·M/L, and its coefficients depend only on (n·M) mod L, so each phase is computed once.
 * The low-pass is at the lower rate's Nyquist, stopband from there down to 81% of it — speech
 * keeps its band to 6.5 kHz at 16 kHz, and nothing above 8 kHz folds back under it.
 */
export class Resampler {
  readonly outputLength: number;
  private readonly up: number;
  private readonly down: number;
  private readonly half: number;
  private readonly cutoff: number;
  private readonly beta: number;
  private readonly phases: Array<Float32Array | undefined>;

  constructor(
    private readonly input: Float32Array,
    readonly fromRate: number,
    readonly toRate: number,
  ) {
    const divisor = gcd(fromRate, toRate);
    this.up = toRate / divisor;
    this.down = fromRate / divisor;
    this.outputLength = Math.floor((input.length * this.up) / this.down);
    const nyquist = Math.min(fromRate, toRate) / 2;
    const transition = (nyquist * TRANSITION) / fromRate;
    this.cutoff = (nyquist - (nyquist * TRANSITION) / 2) / fromRate;
    this.beta = 0.1102 * (STOPBAND_DB - 8.7);
    // Kaiser's estimate of the taps the attenuation and transition need.
    const taps = Math.ceil((STOPBAND_DB - 8) / (2.285 * 2 * Math.PI * transition)) + 1;
    this.half = Math.max(2, Math.ceil(taps / 2));
    this.phases = Array.from({ length: this.up }, () => undefined);
  }

  /** Output samples [from, to) into `out`. */
  run(out: Float32Array, from: number, to: number): void {
    const { input, up, down, half } = this;
    for (let n = from; n < to; n++) {
      const position = n * down;
      const base = Math.floor(position / up);
      const coefficients = this.phase(position - base * up);
      let sum = 0;
      const first = base - half + 1;
      const lo = Math.max(0, -first);
      const hi = Math.min(coefficients.length, input.length - first);
      for (let j = lo; j < hi; j++) sum += coefficients[j]! * input[first + j]!;
      out[n] = sum;
    }
  }

  private phase(index: number): Float32Array {
    const cached = this.phases[index];
    if (cached !== undefined) return cached;
    const { half, cutoff, beta } = this;
    const fraction = index / this.up;
    const coefficients = new Float32Array(2 * half);
    const norm = besselI0(beta);
    let total = 0;
    for (let j = 0; j < 2 * half; j++) {
      const distance = j - half + 1 - fraction;
      const x = 2 * cutoff * distance;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const u = distance / half;
      const window = Math.abs(u) >= 1 ? 0 : besselI0(beta * Math.sqrt(1 - u * u)) / norm;
      coefficients[j] = 2 * cutoff * sinc * window;
      total += coefficients[j]!;
    }
    // Unity gain at DC for every phase, so a level does not ripple at the phase rate.
    if (total !== 0) for (let j = 0; j < coefficients.length; j++) coefficients[j] = coefficients[j]! / total;
    this.phases[index] = coefficients;
    return coefficients;
  }
}

/** Mono samples at another rate. */
export function resample(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return samples;
  const resampler = new Resampler(samples, fromRate, toRate);
  const out = new Float32Array(resampler.outputLength);
  resampler.run(out, 0, out.length);
  return out;
}

/** About a second of output between yields, so a ten-minute take does not hold the main process. */
const SLICE = 16_384;

/**
 * Bytes as whisper takes them: a WAV at another rate, in stereo, or at another depth becomes
 * 16 kHz mono 16-bit PCM; one already so, and anything this cannot read as WAV, is returned as it
 * came. Times measured on the original stay the caller's: only what is heard is converted.
 */
export async function transcriptionWav(bytes: Uint8Array): Promise<Uint8Array> {
  const decoded = decodeWav(bytes);
  if (decoded === null) return bytes;
  if (decoded.rate === TRANSCRIPTION_RATE && decoded.channels === 1 && decoded.encoding === "pcm16") return bytes;
  if (decoded.rate === TRANSCRIPTION_RATE) return encodePcm16Wav(decoded.mono, TRANSCRIPTION_RATE);
  const resampler = new Resampler(decoded.mono, decoded.rate, TRANSCRIPTION_RATE);
  const out = new Float32Array(resampler.outputLength);
  for (let from = 0; from < out.length; from += SLICE) {
    resampler.run(out, from, Math.min(out.length, from + SLICE));
    if (from + SLICE < out.length) await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return encodePcm16Wav(out, TRANSCRIPTION_RATE);
}
