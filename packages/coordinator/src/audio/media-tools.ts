import { open, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { AudioRangeSchema, FullSha256Schema, type AudioRange, type AudioTechnical, type AudioQcAnalysis } from "@arke-studio/contracts";
import { analyzePcmWav, audioHash, canonicalWav, MAX_AUDIO_BYTES } from "./qc.js";

export interface MediaProcessRunner {
  run(tool: "ffmpeg" | "ffprobe", args: readonly string[], limits: {
    signal: AbortSignal; timeoutMs: number; maxStdoutBytes: number; maxStderrBytes: number; maxCombinedBytes?: number;
  }): Promise<{ code: number | null; stdout: Uint8Array; stderr: string; timedOut: boolean;
    outputLimitExceeded: boolean; cancelled: boolean }>;
}
export type AudioFailureReason = Extract<AudioQcAnalysis, { status: "unavailable" }>["reason"];
export class AudioMediaError extends Error {
  constructor(readonly reason: AudioFailureReason) { super(reason); this.name = "AudioMediaError"; }
}

/** Video sources can be much larger than their audio clip. Hash in bounded chunks rather
 * than allocating the complete video again for every pre/post-process integrity check. */
export async function hashAudioFile(path: string, signal: AbortSignal): Promise<{ hash: string; sizeBytes: number }> {
  if (signal.aborted) throw new AudioMediaError("cancelled");
  const handle = await open(path, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile() || !before.size || before.size > 512 * 1024 * 1024) throw new AudioMediaError("unsupported-media");
    const chunk = Buffer.alloc(1_048_576), hash = createHash("sha256");
    let offset = 0;
    while (offset < before.size) {
      if (signal.aborted) throw new AudioMediaError("cancelled");
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, before.size - offset), offset);
      if (!bytesRead) throw new AudioMediaError("source-changed");
      hash.update(chunk.subarray(0, bytesRead)); offset += bytesRead;
    }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new AudioMediaError("source-changed");
    return { hash: `sha256:${hash.digest("hex")}`, sizeBytes: before.size };
  } finally { await handle.close(); }
}

export async function readAudioBytes(path: string, signal: AbortSignal, maxBytes = MAX_AUDIO_BYTES): Promise<Uint8Array> {
  if (signal.aborted) throw new AudioMediaError("cancelled");
  const handle = await open(path, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size === 0 || before.size > maxBytes) throw new AudioMediaError("unsupported-media");
    const bytes = new Uint8Array(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      if (signal.aborted) throw new AudioMediaError("cancelled");
      const { bytesRead } = await handle.read(bytes, offset, Math.min(1_048_576, bytes.length - offset), offset);
      if (!bytesRead) throw new AudioMediaError("source-changed");
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new AudioMediaError("source-changed");
    }
    return bytes;
  } finally { await handle.close(); }
}

export interface AudioMediaTools {
  probe(input: { absolutePath: string; expectedHash?: string; signal: AbortSignal }): Promise<{
    sourceHash: string; technical: AudioTechnical; hasAudio: boolean;
  }>;
  preparePcmWav(input: { sourcePath: string; expectedSourceHash: string; destinationPath: string;
    range?: AudioRange; gainDb?: number; signal: AbortSignal }): Promise<{
      outputHash: string; technical: AudioTechnical; toolVersion: string;
  }>;
  analyze(input: { absolutePath: string; expectedHash: string; signal: AbortSignal }): Promise<AudioQcAnalysis>;
}

export function createAudioMediaTools(runner: MediaProcessRunner): AudioMediaTools {
  const run = async (tool: "ffmpeg" | "ffprobe", args: string[], signal: AbortSignal) => {
    const result = await runner.run(tool, args, { signal, timeoutMs: 30_000, maxStdoutBytes: 65_536, maxStderrBytes: 65_536 });
    if (result.cancelled || signal.aborted) throw new AudioMediaError("cancelled");
    if (result.timedOut) throw new AudioMediaError("timeout");
    if (result.outputLimitExceeded) throw new AudioMediaError("output-too-large");
    if (result.code !== 0) throw new AudioMediaError("process-failed");
    return new TextDecoder().decode(result.stdout);
  };
  const verify = async (path: string, expected: string | undefined, signal: AbortSignal) => {
    // Video sources are bounded independently from the smaller canonical audio derivative.
    const { hash } = await hashAudioFile(path, signal);
    if (expected !== undefined && hash !== FullSha256Schema.parse(expected)) throw new AudioMediaError("source-changed");
    return hash;
  };
  const probe: AudioMediaTools["probe"] = async ({ absolutePath, expectedHash, signal }) => {
    const sourceHash = await verify(absolutePath, expectedHash, signal);
    const stdout = await run("ffprobe", ["-v", "error", "-protocol_whitelist", "file,pipe", "-format_whitelist", "wav,mp3,mov,matroska,webm,ogg,flac,aac", "-show_entries",
      "format=duration,format_name,size:stream=codec_type,codec_name,sample_fmt,sample_rate,channels,bits_per_sample,duration",
      "-of", "json", absolutePath], signal);
    let raw: { format?: Record<string, unknown>; streams?: Array<Record<string, unknown>> };
    try { raw = JSON.parse(stdout); } catch { throw new AudioMediaError("malformed-output"); }
    if (!raw || !Array.isArray(raw.streams)) throw new AudioMediaError("malformed-output");
    const streams = raw.streams.filter(s => s?.codec_type === "audio");
    // Selecting one of several streams silently would designate a voice the director did not review.
    if (streams.length > 1) throw new AudioMediaError("unsupported-media");
    const audio = streams[0];
    const number = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
    const str = (v: unknown) => typeof v === "string" && v.length ? v : null;
    const technical: AudioTechnical = { container: str(raw.format?.format_name), codec: str(audio?.codec_name),
      sampleFormat: str(audio?.sample_fmt), sampleRateHz: number(audio?.sample_rate), channels: number(audio?.channels),
      bitDepth: number(audio?.bits_per_sample), durationSec: number(raw.format?.duration) ?? number(audio?.duration),
      sizeBytes: (await hashAudioFile(absolutePath, signal)).sizeBytes };
    await verify(absolutePath, sourceHash, signal);
    return { sourceHash, technical, hasAudio: audio !== undefined };
  };
  return {
    probe,
    async preparePcmWav(input) {
      const { sourcePath, destinationPath, expectedSourceHash, signal } = input;
      if (sourcePath === destinationPath) throw new AudioMediaError("unsupported-media");
      const source = await probe({ absolutePath: sourcePath, expectedHash: expectedSourceHash, signal });
      if (!source.hasAudio || !source.technical.durationSec) throw new AudioMediaError("unsupported-media");
      const range = input.range === undefined ? undefined : AudioRangeSchema.parse(input.range);
      if (range && range.outSec > source.technical.durationSec) throw new AudioMediaError("unsupported-media");
      if (input.gainDb !== undefined && (!Number.isFinite(input.gainDb) || input.gainDb < -60 || input.gainDb > 20)) {
        throw new AudioMediaError("unsupported-media");
      }
      const duration = range ? range.outSec - range.inSec : source.technical.durationSec;
      if (duration * 96_000 > MAX_AUDIO_BYTES - 4096) throw new AudioMediaError("output-too-large");
      // Reserve exclusively before invoking ffmpeg; cleanup must never unlink a pre-existing file.
      const reservation = await open(destinationPath, "wx");
      await reservation.close();
      try {
        const version = await run("ffmpeg", ["-version"], signal);
        const toolVersion = /^ffmpeg version ([^\r\n]+)/.exec(version)?.[1];
        if (!toolVersion) throw new AudioMediaError("malformed-output");
        await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-protocol_whitelist", "file,pipe", "-format_whitelist", "wav,mp3,mov,matroska,webm,ogg,flac,aac", "-i", sourcePath,
          ...(range ? ["-ss", String(range.inSec), "-t", String(duration)] : []),
          "-map", "0:a:0", "-vn", "-map_metadata", "-1",
          ...(input.gainDb === undefined ? [] : ["-af", `volume=${input.gainDb}dB`]),
          "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", "-fs", String(MAX_AUDIO_BYTES), "-f", "wav", destinationPath], signal);
        await verify(sourcePath, source.sourceHash, signal);
        const bytes = await readAudioBytes(destinationPath, signal);
        const { technical } = canonicalWav(bytes);
        if (Math.abs(technical.durationSec! - duration) > 0.025) throw new AudioMediaError("malformed-output");
        return { outputHash: audioHash(bytes), technical, toolVersion };
      } catch (error) { await unlink(destinationPath).catch(() => {}); throw error; }
    },
    async analyze({ absolutePath, expectedHash, signal }) {
      FullSha256Schema.parse(expectedHash);
      try {
        const bytes = await readAudioBytes(absolutePath, signal);
        if (audioHash(bytes) !== expectedHash) throw new AudioMediaError("source-changed");
        return { status: "complete", report: analyzePcmWav(bytes) };
      } catch (error) {
        return { status: "unavailable", sourceHash: expectedHash, analyzerId: "arke-pcm-qc", analyzerVersion: 1,
          policyVersion: 1, reason: error instanceof AudioMediaError ? error.reason : "malformed-output" };
      }
    },
  };
}
