import { createHash } from "node:crypto";
import { AudioQcReportSchema, FullSha256Schema, type AudioQcReport, type AudioTechnical } from "@arke-studio/contracts";

export const AUDIO_ANALYZER_VERSION = 1;
export const AUDIO_POLICY_VERSION = 1;
export const MAX_AUDIO_BYTES = 64 * 1024 * 1024;
export function audioHash(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
export function audioQcCacheKey(hash: string): string {
  return `${FullSha256Schema.parse(hash).slice(7)}/arke-pcm-qc-v${AUDIO_ANALYZER_VERSION}-p${AUDIO_POLICY_VERSION}.json`;
}

/** Parse RIFF chunks, including ffmpeg's optional LIST chunk. Never reinterpret another format as PCM. */
export function canonicalWav(bytes: Uint8Array): { pcm: DataView; technical: AudioTechnical } {
  if (bytes.length < 44 || bytes.length > MAX_AUDIO_BYTES) throw new Error("unsupported-media");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE" || view.getUint32(4, true) + 8 !== bytes.length) {
    throw new Error("malformed-output");
  }
  let format = false;
  let pcm: DataView | undefined;
  for (let at = 12; at + 8 <= bytes.length;) {
    const size = view.getUint32(at + 4, true);
    const start = at + 8;
    if (start + size > bytes.length) throw new Error("malformed-output");
    if (tag(at) === "fmt ") {
      if (format || size < 16 || view.getUint16(start, true) !== 1 ||
        view.getUint16(start + 2, true) !== 1 || view.getUint32(start + 4, true) !== 48_000 ||
        view.getUint32(start + 8, true) !== 96_000 || view.getUint16(start + 12, true) !== 2 ||
        view.getUint16(start + 14, true) !== 16) throw new Error("unsupported-media");
      format = true;
    }
    if (tag(at) === "data") {
      if (pcm || size === 0 || size % 2 !== 0) throw new Error("malformed-output");
      pcm = new DataView(bytes.buffer, bytes.byteOffset + start, size);
    }
    at = start + size + (size % 2);
  }
  if (!format || !pcm) throw new Error("unsupported-media");
  return { pcm, technical: { container: "wav", codec: "pcm_s16le", sampleFormat: "s16",
    sampleRateHz: 48_000, channels: 1, bitDepth: 16, durationSec: pcm.byteLength / 96_000, sizeBytes: bytes.length } };
}

/** Sample measurements only. Silence has no finite dB value, so JSON uses null, never -Infinity. */
export function analyzePcmWav(bytes: Uint8Array, analyzedAt = new Date().toISOString()): AudioQcReport {
  const { pcm, technical } = canonicalWav(bytes);
  const count = pcm.byteLength / 2;
  let peak = 0, squares = 0, sum = 0, clipped = 0;
  let run = 0, leading = 0, longestInternal = 0, heard = false;
  for (let i = 0; i < count; i++) {
    const raw = pcm.getInt16(i * 2, true);
    const value = raw / 32768;
    peak = Math.max(peak, Math.abs(value));
    squares += value * value;
    sum += value;
    if (raw === -32768 || raw === 32767) clipped++;
    if (Math.abs(value) <= 0.001) run++;
    else {
      if (!heard) leading = run;
      else longestInternal = Math.max(longestInternal, run);
      heard = true;
      run = 0;
    }
  }
  if (!heard) leading = run;
  const rms = Math.sqrt(squares / count);
  const check = (outcome: AudioQcReport["checks"]["decode"]["outcome"], code: string) => ({ outcome, code });
  const unavailable = check("unavailable", "not-measured-v1");
  return AudioQcReportSchema.parse({
    schemaVersion: 1, sourceHash: audioHash(bytes),
    analyzer: { id: "arke-pcm-qc", version: AUDIO_ANALYZER_VERSION, policyVersion: AUDIO_POLICY_VERSION },
    analyzedAt, technical,
    measurements: { samplePeakDbfs: peak ? 20 * Math.log10(peak) : null,
      rmsDbfs: rms ? 20 * Math.log10(rms) : null, fullScaleSampleCount: clipped,
      leadingSilenceSec: leading >= 48_000 ? leading / 48_000 : 0,
      trailingSilenceSec: run >= 48_000 ? run / 48_000 : 0,
      longestInternalSilenceSec: longestInternal / 48_000, dcOffset: sum / count },
    checks: { decode: check("pass", "decoded"), duration: check("pass", "nonempty"),
      technicalFormat: check("pass", "canonical-pcm"),
      clipping: check(clipped ? "warning" : "pass", clipped ? "full-scale-samples" : "no-full-scale-samples"),
      silence: check(rms <= 0.001 || leading >= 48_000 || run >= 48_000 ? "warning" : "pass",
        rms <= 0.001 ? "whole-clip-silence" : leading >= 48_000 || run >= 48_000 ? "boundary-silence" : "no-silence-warning"),
      dcOffset: check("informational", "measured-dc-offset"), truePeak: unavailable, lufs: unavailable,
      noiseFloor: unavailable, snr: unavailable, speechPresence: unavailable, musicLikelihood: unavailable,
      multipleSpeakers: unavailable, transcriptMatch: check("not-applicable", "separate-text-comparison") },
  });
}
