import { createHash } from "node:crypto";
import { AGENT_MEDIA_LIMITS, AgentMediaInventorySchema, measureAudioSignal, type AgentMediaInventory, type AudioSignal } from "@arke-studio/contracts";
import type { MediaProcessRunner } from "../audio/media-tools.js";
import { decodePng } from "../references/png.js";
import { writeSpeechWav } from "../audio/speech-wav.js";

export interface AgentMediaTools {
  version(signal: AbortSignal): Promise<string>;
  probeVersion(signal: AbortSignal): Promise<string>;
  probe(path: string, signal: AbortSignal): Promise<AgentMediaInventory>;
  frame(path: string, streamIndex: number, sourceTimeSec: number, endSec: number, signal: AbortSignal): Promise<{
    bytes: Uint8Array; width: number; height: number; sourceTimeSec: number;
  }>;
  audio(path: string, stream: AgentMediaInventory["streams"][number], startSec: number, endSec: number, signal: AbortSignal): Promise<AudioSignal>;
  speechAudio?(path: string, stream: AgentMediaInventory["streams"][number], startSec: number, endSec: number, signal: AbortSignal): Promise<{ bytes: Uint8Array; durationSec: number }>;
}
const FORMATS = "mov,matroska,webm,wav,mp3,ogg,flac,aac,gif,image2,png_pipe,jpeg_pipe,webp_pipe";
const finite = (value: unknown): number | null => {
  if (typeof value !== "number" && (typeof value !== "string" || value.trim() === "")) return null;
  const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null;
};
const positive = (value: unknown): number | undefined => { const parsed = finite(value); return parsed !== null && Number.isInteger(parsed) && parsed > 0 ? parsed : undefined; };
const nonnegative = (value: unknown): number | null => { const parsed = finite(value); return parsed !== null && parsed >= 0 ? parsed : null; };
export function parseAgentMediaProbe(stdout: Uint8Array): AgentMediaInventory {
  const parsed = JSON.parse(new TextDecoder().decode(stdout)) as { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> };
  if (!Array.isArray(parsed.streams) || parsed.streams.length > AGENT_MEDIA_LIMITS.streams) throw new Error("Media stream inventory exceeds its profile");
  return AgentMediaInventorySchema.parse({ durationSec: nonnegative(parsed.format?.["duration"]), streams: parsed.streams.map(stream => ({
    index: finite(stream["index"]), kind: stream["codec_type"] === "audio" ? "audio" : stream["codec_type"] === "video" ? "video" : "other",
    codec: typeof stream["codec_name"] === "string" ? stream["codec_name"] : "unknown",
    ...(positive(stream["width"]) ? { width: positive(stream["width"]) } : {}),
    ...(positive(stream["height"]) ? { height: positive(stream["height"]) } : {}),
    ...(positive(stream["sample_rate"]) ? { sampleRate: positive(stream["sample_rate"]) } : {}),
    ...(positive(stream["channels"]) ? { channels: positive(stream["channels"]) } : {}),
    ...(typeof stream["time_base"] === "string" ? { timeBase: stream["time_base"] } : {}),
    ...(typeof stream["avg_frame_rate"] === "string" ? { frameRate: stream["avg_frame_rate"] } : {}),
    durationSec: nonnegative(stream["duration"]), startTimeSec: finite(stream["start_time"]),
  })) });
}
/** The existing kill-on-abort process boundary owns codecs. Only verified private snapshots enter. */
export function createAgentMediaTools(runner: MediaProcessRunner): AgentMediaTools {
  const run = async (tool: "ffmpeg" | "ffprobe", args: readonly string[], signal: AbortSignal, maxStdoutBytes: number) => {
    signal.throwIfAborted();
    const result = await runner.run(tool, args, { signal, timeoutMs: 20_000, maxStdoutBytes, maxStderrBytes: 65_536 });
    signal.throwIfAborted();
    if (result.cancelled || result.timedOut || result.outputLimitExceeded || result.code !== 0) throw new Error("Bounded media decoder failed or was stopped");
    return result;
  };
  const version = async (tool: "ffmpeg" | "ffprobe", signal: AbortSignal) => {
      const result = await run(tool, ["-version"], signal, 16_384);
      const first = new TextDecoder().decode(result.stdout).split(/\r?\n/)[0] ?? "";
      if (!first.startsWith(`${tool} version `) || first.length > 200) throw new Error("Media tool version is unavailable");
      return first;
  };
  return {
    version: signal => version("ffmpeg", signal),
    probeVersion: signal => version("ffprobe", signal),
    async probe(path, signal) {
      const result = await run("ffprobe", ["-v", "error", "-protocol_whitelist", "file,pipe", "-format_whitelist", FORMATS,
        "-show_entries", "format=duration:stream=index,codec_type,codec_name,width,height,sample_rate,channels,time_base,avg_frame_rate,duration,start_time",
        "-of", "json", path], signal, 65_536);
      return parseAgentMediaProbe(result.stdout);
    },
    async frame(path, streamIndex, atSec, endSec, signal) {
      if (!Number.isInteger(streamIndex) || streamIndex < 0 || streamIndex > 255 || !Number.isFinite(atSec) || atSec < 0 || !Number.isFinite(endSec) || endSec <= atSec) throw new Error("Invalid video sample interval");
      // copyts + start_at_zero preserves media-relative PTS through input seeking:
      // https://ffmpeg.org/ffmpeg.html#Advanced-options ; showinfo reports the decoded PTS.
      const result = await run("ffmpeg", ["-hide_banner", "-loglevel", "info", "-threads", "1", "-copyts", "-start_at_zero",
        "-ss", String(atSec), "-protocol_whitelist", "file,pipe", "-format_whitelist", FORMATS, "-i", path,
        "-map", `0:${streamIndex}`, "-an", "-sn", "-frames:v", "1", "-vf",
        `select=gte(t\\,${atSec}),scale=${AGENT_MEDIA_LIMITS.edge}:${AGENT_MEDIA_LIMITS.edge}:force_original_aspect_ratio=decrease,showinfo`,
        "-fps_mode", "passthrough", "-map_metadata", "-1", "-pix_fmt", "rgba", "-threads", "1", "-c:v", "png", "-f", "image2pipe", "pipe:1"], signal, 5 * 1024 * 1024);
      const value = result.stderr.match(/\bpts_time:([+-]?[\d.]+(?:e[+-]?\d+)?)/i)?.[1], actual = value === undefined ? null : finite(value);
      if (actual === null || actual < atSec - 0.000001 || actual >= endSec) throw new Error("No timestamped frame exists inside the requested interval");
      const image = decodePng(result.stdout, AGENT_MEDIA_LIMITS.edge ** 2);
      return { bytes: result.stdout, width: image.width, height: image.height, sourceTimeSec: actual };
    },
    async audio(path, stream, startSec, endSec, signal) {
      const rate = stream.sampleRate, channels = stream.channels, duration = endSec - startSec;
      if (!rate || !channels || rate > AGENT_MEDIA_LIMITS.sampleRate || channels > AGENT_MEDIA_LIMITS.channels || !Number.isFinite(startSec) || startSec < 0 ||
        duration <= 0 || duration > AGENT_MEDIA_LIMITS.intervalSeconds || Math.ceil(duration * rate) * channels * 4 > AGENT_MEDIA_LIMITS.pcmBytes) throw new Error("Original-channel audio exceeds its decode profile");
      const result = await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-threads", "1", "-protocol_whitelist", "file,pipe", "-format_whitelist", FORMATS,
        "-i", path, "-ss", String(startSec), "-t", String(duration), "-map", `0:${stream.index}`, "-vn", "-sn", "-map_metadata", "-1",
        // No -ac/-ar: downmixing/resampling would conceal original channel/rate defects.
        "-c:a", "pcm_f32le", "-f", "f32le", "pipe:1"], signal, AGENT_MEDIA_LIMITS.pcmBytes);
      const pcmHash = `sha256:${createHash("sha256").update(result.stdout).digest("hex")}`;
      const measured = measureAudioSignal(result.stdout, rate, channels, stream.index, pcmHash);
      if (Math.abs(measured.decodedDurationSec - duration) > 0.05) throw new Error("Decoded audio does not cover the requested interval");
      return measured;
    },
    async speechAudio(path, stream, startSec, endSec, signal) {
      const duration = endSec - startSec;
      if (!stream.sampleRate || !stream.channels || stream.sampleRate > AGENT_MEDIA_LIMITS.sampleRate || stream.channels > AGENT_MEDIA_LIMITS.channels ||
        !Number.isInteger(stream.index) || stream.index < 0 || stream.index > 255 || !Number.isFinite(startSec) || startSec < 0 ||
        !Number.isFinite(duration) || duration <= 0 || duration > AGENT_MEDIA_LIMITS.intervalSeconds) throw new Error("Audio exceeds the speech derivative profile");
      // This separate derivative must never stand in for original-channel signal QC.
      const result = await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-threads", "1", "-protocol_whitelist", "file,pipe", "-format_whitelist", FORMATS,
        "-i", path, "-ss", String(startSec), "-t", String(duration), "-map", `0:${stream.index}`, "-vn", "-sn", "-map_metadata", "-1",
        "-ac", "1", "-ar", "16000", "-c:a", "pcm_f32le", "-f", "f32le", "pipe:1"], signal, 60 * 16000 * 4);
      if (!result.stdout.length || result.stdout.length % 4) throw new Error("Invalid speech PCM");
      const samples = new Float32Array(result.stdout.length / 4), view = new DataView(result.stdout.buffer, result.stdout.byteOffset, result.stdout.byteLength);
      for (let i = 0; i < samples.length; i++) {
        const value = view.getFloat32(i * 4, true);
        if (!Number.isFinite(value)) throw new Error("Non-finite speech PCM");
        samples[i] = value;
      }
      const durationSec = samples.length / 16000;
      if (Math.abs(durationSec - duration) > .025) throw new Error("Speech derivative does not cover the requested interval");
      return { bytes: writeSpeechWav({ rate: 16000, samples }), durationSec };
    },
  };
}
