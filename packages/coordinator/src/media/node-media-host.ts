import { spawn } from "node:child_process";
import { createNodeMediaProcessRunner } from "./node-media-process.js";
export { createNodeMediaProcessRunner } from "./node-media-process.js";
import { hashMediaFile } from "./media-file-hash.js";
export { hashMediaFile } from "./media-file-hash.js";
import { createNodeEffectAudioAnalysisHost } from "./node-effect-audio.js";
import { createAudioMediaTools } from "../audio/media-tools.js";
import { createAgentMediaTools } from "./agent-media-tools.js";
import { ffprobeArgs, parseFfprobeJson, type MediaProbe } from "./probe.js";
import { createNodeEffectRasterHost } from "./node-effect-renderer.js";
import type { FfmpegRunner } from "../takes/export.js";
import { probeFfmpegGraphFileOption } from "./ffmpeg-graph-probe.js";

export function createNodeFfmpegRunner(ffmpeg: string, slateFont: string): FfmpegRunner {
  let fontVerified = false;
  const mediaProcess = createNodeMediaProcessRunner({ ffmpeg, ffprobe: "" });
  return { slateFont, graphFileOption: signal => probeFfmpegGraphFileOption(mediaProcess, signal), async run(args, onProgress, signal, onSeconds) {
    if (signal.aborted) throw new Error("export cancelled");
    if (!fontVerified && (args.includes("-/filter_complex") || args.includes("-filter_complex_script") || args.some(arg => arg.includes("drawtext=")))) {
      const hash = await hashMediaFile(slateFont, signal);
      if (hash !== "85a1c6b18a6b0a06dfe9fd4f6d6a5d4979f74ec861eaef4bc7868b5492b8a117") throw new Error("export requires the bundled Geist font");
      fontVerified = true;
    }
    await new Promise<void>((resolve, reject) => {
      const child = spawn(ffmpeg, ["-hide_banner", "-nostdin", ...args], { shell: false, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "", failure: Error | null = null;
      const abort = () => { failure = new Error("export cancelled"); child.kill("SIGKILL"); };
      const timer = setTimeout(() => { failure = new Error("export exceeded its time limit"); child.kill("SIGKILL"); }, 30 * 60_000);
      signal.addEventListener("abort", abort, { once: true });
      child.stderr.on("data", (bytes: Buffer) => {
        const text = bytes.toString(); stderr = (stderr + text).slice(-16_384);
        const match = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
        if (match) { const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]); onProgress(Math.min(99, Math.floor(seconds))); onSeconds?.(seconds); }
      });
      child.once("error", error => { failure = error; });
      child.once("close", code => { clearTimeout(timer); signal.removeEventListener("abort", abort);
        if (code === 0 && !failure) resolve(); else reject(failure ?? new Error(stderr.trim() || `ffmpeg exited ${code}`)); });
      if (signal.aborted) abort();
    });
  } };
}

export function createNodeMediaHost(options: { ffmpeg: string; ffprobe: string; slateFont: string; workerPath: string }) {
  const process = createNodeMediaProcessRunner(options);
  const probe = async (path: string, signal: AbortSignal) => {
    const result = await process.run("ffprobe", ffprobeArgs(path), { signal, timeoutMs: 30_000, maxStdoutBytes: 65_536, maxStderrBytes: 16_384 });
    return result.code === 0 ? parseFfprobeJson(new TextDecoder().decode(result.stdout)) : null;
  };
  const mediaProbe: MediaProbe = {
    info: (path, opts) => probe(path, opts?.signal ?? new AbortController().signal),
    durationSec: async (path, opts) => (await probe(path, opts?.signal ?? new AbortController().signal))?.durationSec ?? null,
  };
  return { ffmpeg: createNodeFfmpegRunner(options.ffmpeg, options.slateFont), mediaProbe,
    audioMediaTools: createAudioMediaTools(process), agentMediaTools: createAgentMediaTools(process), effectAudioAnalysisHost: createNodeEffectAudioAnalysisHost({ ffmpeg: options.ffmpeg }), effectRasterHost: createNodeEffectRasterHost({ ...options, mediaProcess: process }) };
}
