import type { MediaProcessRunner } from "../audio/media-tools.js";
import { ffmpegGraphFileOption } from "./ffmpeg-graph-option.js";

/** Probe the host's actual encoder; graph files keep large exports below Windows argv limits. */
export async function probeFfmpegGraphFileOption(process: MediaProcessRunner, signal: AbortSignal): Promise<ReturnType<typeof ffmpegGraphFileOption>> {
  const result = await process.run("ffmpeg", ["-version"], { signal, timeoutMs: 10_000, maxStdoutBytes: 65_536, maxStderrBytes: 16_384 });
  if (signal.aborted || result.cancelled) throw new Error("Export cancelled while checking FFmpeg graph support");
  if (result.code !== 0 || result.timedOut || result.outputLimitExceeded) throw new Error("Could not determine this FFmpeg encoder's graph-file support");
  return ffmpegGraphFileOption(result.stdout);
}
