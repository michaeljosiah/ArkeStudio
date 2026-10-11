import { spawn } from "node:child_process";
import { lstat, open, realpath, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { Worker } from "node:worker_threads";
import { assertEffectRasterSize, EFFECT_RENDER_PROFILE, type EffectClip } from "@arke-studio/contracts";
import type { MediaProcessRunner } from "../audio/media-tools.js";

export const EFFECT_INTERMEDIATE_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;
export const EFFECT_NATIVE_LIMITS = Object.freeze({ maxWallTimeMs: 24 * 60 * 60_000, millisecondsPerFrame: 1500, frameTimeoutMs: 50_000 });
export interface EffectAlphaRequest {
  effects: readonly EffectClip[];
  width: number;
  height: number;
  frameRate: number;
  startFrame: number;
  frameCount: number;
  output: string;
  signal: AbortSignal;
  maxBytes?: number;
  onProgress?: (frame: number) => void;
}
export interface EffectRasterHost {
  renderAlpha(request: EffectAlphaRequest): Promise<void>;
  probePicture(path: string, signal: AbortSignal): Promise<{ width: number; height: number; durationSec?: number }>;
}

/** One worker response and one pipe write in flight. Memory does not grow with film duration. */
export function createNodeEffectRasterHost(options: { ffmpeg: string; workerPath: string; mediaProcess: MediaProcessRunner }): EffectRasterHost {
  return {
    async probePicture(path, signal) {
      const result = await options.mediaProcess.run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,sample_aspect_ratio:stream_side_data=rotation:format=duration", "-of", "json", path],
        { signal, timeoutMs: 30_000, maxStdoutBytes: 65_536, maxStderrBytes: 16_384 });
      if (result.code !== 0) throw new Error("Picture dimensions could not be measured for effect export");
      const parsed = JSON.parse(new TextDecoder().decode(result.stdout)) as { format?: { duration?: string }; streams?: Array<{ width?: number; height?: number; sample_aspect_ratio?: string; side_data_list?: Array<{ rotation?: number }> }> };
      const stream = parsed.streams?.[0];
      if (!stream || !Number.isSafeInteger(stream.width) || !Number.isSafeInteger(stream.height) || stream.width! <= 0 || stream.height! <= 0) throw new Error("Picture dimensions are unavailable for effect export");
      if (stream.sample_aspect_ratio && !["1:1", "0:1", "N/A"].includes(stream.sample_aspect_ratio)) throw new Error("Effect export requires square-pixel media; conform this anamorphic source first.");
      const rotation = stream.side_data_list?.find(data => data.rotation !== undefined)?.rotation ?? 0;
      if (!Number.isFinite(rotation) || rotation % 90 !== 0) throw new Error("Effect export requires media rotated by whole quarter turns; conform this source first.");
      const dimensions = Math.abs(rotation % 180) === 90 ? { width: stream.height!, height: stream.width! } : { width: stream.width!, height: stream.height! };
      const durationSec = Number(parsed.format?.duration);
      return { ...dimensions, ...(Number.isFinite(durationSec) && durationSec > 0 ? { durationSec } : {}) };
    },
    async renderAlpha(request) {
      const { width, height, frameRate, frameCount, signal, output } = request;
      if (signal.aborted) throw new Error("effect render cancelled");
      assertEffectRasterSize(width, height);
      if (![frameCount, request.startFrame].every(Number.isSafeInteger) || frameCount < 1 || frameCount > frameRate * EFFECT_RENDER_PROFILE.maxDurationSeconds || request.startFrame < 0 ||
        ![24, 25, 30].includes(frameRate)) throw new Error("effect render exceeds the supported frame profile");
      if (request.effects.some(effect => effect.reaction.enabled)) throw new Error("enabled audio reaction needs a ready analysis before export");
      const maxBytes = Math.min(EFFECT_INTERMEDIATE_LIMIT_BYTES, request.maxBytes ?? EFFECT_INTERMEDIATE_LIMIT_BYTES);
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024) throw new Error("Effect intermediate disk budget is exhausted");
      const parent = await realpath(dirname(output));
      const reservation = await open(output, "wx"), reserved = await reservation.stat(); await reservation.close();
      const removeReserved = async () => {
        try {
          const current = await lstat(output);
          if (!current.isSymbolicLink() && current.dev === reserved.dev && current.ino === reserved.ino && await realpath(dirname(output)) === parent) await unlink(output);
        } catch { /* A removed or redirected output is no longer this renderer's file. */ }
      };
      let worker: Worker;
      try { worker = new Worker(options.workerPath, { workerData: { effects: request.effects, width, height, frameRate } }); }
      catch (error) { await removeReserved(); throw error; }
      let child: ReturnType<typeof spawn> & { stdin: import("node:stream").Writable; stderr: import("node:stream").Readable };
      try { child = spawn(options.ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", `${width}x${height}`, "-framerate", String(frameRate), "-i", "pipe:0",
        "-an", "-c:v", "ffv1", "-level", "3", "-pix_fmt", "bgra", "-threads", "1", "-map_metadata", "-1",
        "-frames:v", String(frameCount), "-fs", String(maxBytes), "-f", "matroska", output],
      { windowsHide: true, shell: false, stdio: ["pipe", "ignore", "pipe"] }); }
      catch (error) { await worker.terminate(); await removeReserved(); throw error; }
      let stderr = "", failed: Error | null = null, terminating = false;
      const verification = new AbortController();
      let frameTimer: ReturnType<typeof setTimeout> | undefined;
      let pending: { id: number; resolve: (pixels: Uint8Array) => void; reject: (error: Error) => void } | null = null;
      const fail = (error: Error) => { failed ??= error; pending?.reject(error); pending = null; child.kill("SIGKILL"); verification.abort(); terminating = true; void worker.terminate(); };
      const abort = () => fail(new Error("effect render cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => fail(new Error("effect rendering exceeded its time limit")), Math.min(EFFECT_NATIVE_LIMITS.maxWallTimeMs, Math.max(60_000, frameCount * EFFECT_NATIVE_LIMITS.millisecondsPerFrame)));
      child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 16_384) stderr += chunk.toString().slice(0, 16_384 - stderr.length); });
      child.stdin.on("error", error => fail(error));
      worker.on("error", fail);
      worker.on("exit", code => { if (!terminating && !failed) fail(new Error(`effect worker exited ${code}`)); });
      worker.on("message", (message: { id: number; pixels?: ArrayBuffer; error?: string }) => {
        if (!pending || message.id !== pending.id) { fail(new Error("effect worker returned an unexpected frame")); return; }
        const current = pending; pending = null;
        if (message.error || !(message.pixels instanceof ArrayBuffer) || message.pixels.byteLength !== width * height * 4) {
          const error = new Error(message.error ?? "effect worker returned an invalid pixel buffer"); current.reject(error); fail(error);
        } else current.resolve(new Uint8Array(message.pixels));
      });
      const closed = new Promise<void>((resolve, reject) => {
        child.once("error", error => { failed ??= error; });
        child.once("close", code => {
          if (code === 0 && !failed) resolve();
          else { const error = failed ?? new Error(stderr.trim() || `effect encoder exited ${code}`); failed = error; pending?.reject(error); pending = null; reject(error); }
        });
      });
      void closed.catch(() => {});
      try {
        if (signal.aborted) abort();
        for (let index = 0; index < frameCount; index++) {
          if (failed) throw failed;
          frameTimer = setTimeout(() => fail(new Error("effect frame exceeded its worker/encoder time limit")), EFFECT_NATIVE_LIMITS.frameTimeoutMs);
          const pixels = await new Promise<Uint8Array>((resolve, reject) => {
            pending = { id: index, resolve, reject };
            worker.postMessage({ id: index, absoluteFrame: request.startFrame + index }, []);
          });
          await new Promise<void>((resolve, reject) => child.stdin.write(pixels, error => error ? reject(error) : resolve()));
          clearTimeout(frameTimer); frameTimer = undefined;
          request.onProgress?.(index + 1);
        }
        child.stdin.end();
        await closed;
        const info = await stat(output);
        if (info.size < 1 || info.size >= maxBytes) throw new Error("effect intermediate exceeded its disk limit");
        const checked = await options.mediaProcess.run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=width,height,nb_read_frames", "-of", "json", output],
          { signal: verification.signal, timeoutMs: Math.min(60 * 60_000, Math.max(60_000, frameCount * 50)), maxStdoutBytes: 65_536, maxStderrBytes: 16_384 });
        const encoded = checked.code === 0 ? (JSON.parse(new TextDecoder().decode(checked.stdout)) as { streams?: Array<{ width: number; height: number; nb_read_frames: string }> }).streams?.[0] : undefined;
        if (!encoded || encoded.width !== width || encoded.height !== height || Number(encoded.nb_read_frames) !== frameCount) throw new Error("Effect intermediate is incomplete or exceeded its disk budget");
        if (failed) throw failed;
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
        await closed.catch(() => {});
        await removeReserved();
        throw failed;
      } finally {
        clearTimeout(timer); signal.removeEventListener("abort", abort);
        clearTimeout(frameTimer);
        terminating = true;
        await worker.terminate();
      }
    },
  };
}
