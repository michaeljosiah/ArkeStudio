import { createHash } from "node:crypto";
import { parseFfprobeJson, PublicationFileError, type MediaProcessRunner, type VideoPublicationCompilerOptions } from "@arke-studio/coordinator";

export function publicationMedia(runner: MediaProcessRunner) {
  const run = async (tool: "ffmpeg" | "ffprobe", args: string[], signal = new AbortController().signal, encode = false) => {
    const result = await runner.run(tool, args, { signal, timeoutMs: encode ? 24 * 60 * 60 * 1000 : 30_000,
      maxStdoutBytes: 1024 * 1024, maxStderrBytes: 1024 * 1024 });
    signal.throwIfAborted();
    if (result.code !== 0 || result.outputLimitExceeded || result.timedOut) throw new Error(`${tool} could not process the publication media.`);
    return new TextDecoder().decode(result.stdout);
  };
  const probeArgs = (path: string) => ["-v", "error", "-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,matroska,webm",
    "-show_streams", "-show_format", "-of", "json", path];
  return {
    async compiler(signal: AbortSignal): Promise<Omit<VideoPublicationCompilerOptions, "scratchRoot">> {
      const version = await run("ffmpeg", ["-version"], signal);
      return {
        signal, encoderVersion: `ffmpeg:${createHash("sha256").update(version).digest("hex")}`,
        encoder: { slateFont: "", run: async (args, progress, encodeSignal) => {
          progress(0);
          await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", ...args], encodeSignal, true);
          progress(100);
        } },
        probe: { info: async (path, options) => {
          // Compiler inputs include stills and audio as well as the final movie.
          const json = await run("ffprobe", ["-v", "error", "-protocol_whitelist", "file,pipe", "-show_streams", "-show_format", "-of", "json", path], options?.signal);
          return parseFfprobeJson(json);
        } },
      };
    },
    async playback(path: string, mediaType: string, signal?: AbortSignal) {
      const data = JSON.parse(await run("ffprobe", probeArgs(path), signal)) as {
        format?: { duration?: string; format_name?: string }; streams?: Array<{ codec_type?: string; codec_name?: string; pix_fmt?: string }>;
      };
      const videos = data.streams?.filter(s => s.codec_type === "video") ?? [];
      const audio = data.streams?.filter(s => s.codec_type === "audio") ?? [];
      const video = videos[0];
      const mp4 = mediaType === "video/mp4";
      const format = data.format?.format_name ?? "";
      if (videos.length !== 1 || audio.length > 1 || video?.pix_fmt !== "yuv420p" ||
        (mp4 ? !format.split(",").includes("mp4") || video.codec_name !== "h264" || audio.some(s => s.codec_name !== "aac")
          : !format.split(",").includes("webm") || !["vp8", "vp9"].includes(video.codec_name ?? "") || audio.some(s => !["opus", "vorbis"].includes(s.codec_name ?? "")))) {
        throw new PublicationFileError("unsupported-codec", "Unsupported publication codec. Use H.264/AAC MP4 or VP8/VP9 WebM with Opus/Vorbis, in 8-bit 4:2:0.");
      }
      const codecs = [mp4 ? "avc1" : video.codec_name!, ...audio.map(s => mp4 ? "mp4a.40.2" : s.codec_name!)];
      return { duration: Number(data.format?.duration), mediaType: `${mediaType}; codecs="${codecs.join(", ")}"` };
    },
  };
}
