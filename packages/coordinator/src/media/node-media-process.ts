import { spawn } from "node:child_process";
import type { MediaProcessRunner } from "../audio/media-tools.js";

/** The portable Node host shares the desktop's external-process boundary, never FFmpeg linkage. */
export function createNodeMediaProcessRunner(paths: { ffmpeg: string; ffprobe: string }): MediaProcessRunner {
  return { run: (tool, args, limits) => new Promise(resolve => {
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), timedOut = false, cancelled = limits.signal.aborted, outputLimitExceeded = false;
    const result = (code: number | null) => ({ code, stdout, stderr: stderr.toString("utf8"), timedOut, cancelled, outputLimitExceeded });
    if (cancelled) { resolve(result(null)); return; }
    const child = spawn(paths[tool], [...args], { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const abort = () => { cancelled = true; child.kill("SIGKILL"); };
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, limits.timeoutMs);
    limits.signal.addEventListener("abort", abort, { once: true });
    const capture = (out: boolean) => (chunk: Buffer) => {
      const current = out ? stdout : stderr, ceiling = out ? limits.maxStdoutBytes : limits.maxStderrBytes;
      if (current.length + chunk.length > ceiling || stdout.length + stderr.length + chunk.length > (limits.maxCombinedBytes ?? Infinity)) {
        outputLimitExceeded = true; child.kill("SIGKILL"); return;
      }
      if (out) stdout = Buffer.concat([current, chunk]); else stderr = Buffer.concat([current, chunk]);
    };
    child.stdout.on("data", capture(true)); child.stderr.on("data", capture(false));
    child.once("error", () => {});
    child.once("close", code => { clearTimeout(timer); limits.signal.removeEventListener("abort", abort); resolve(result(timedOut || cancelled || outputLimitExceeded ? null : code)); });
    if (limits.signal.aborted) abort();
  }) };
}

