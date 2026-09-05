import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createAudioMediaTools, type AudioMediaTools, type MediaProcessRunner } from "@arke-studio/coordinator";

/** Shared byte-bounded process boundary for audio and video QC. Completion follows close,
 * not exit: cleanup must not race a child whose output/file handles are still open. */
export function createMediaProcessRunner(paths: { ffmpeg: string; ffprobe: string }, spawn = nodeSpawn): MediaProcessRunner {
  return {
    run: (tool, args, limits) => new Promise(resolve => {
      let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0);
      let timedOut = false, outputLimitExceeded = false, cancelled = limits.signal.aborted;
      const result = (code: number | null) => ({ code, stdout, stderr: stderr.toString("utf8"),
        timedOut, outputLimitExceeded, cancelled });
      if (cancelled) { resolve(result(null)); return; }
      let child: ReturnType<typeof nodeSpawn>;
      try { child = spawn(paths[tool], [...args], { windowsHide: true, shell: false }); }
      catch { resolve(result(null)); return; }
      let settled = false;
      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        limits.signal.removeEventListener("abort", abort);
        resolve(result(timedOut || cancelled || outputLimitExceeded ? null : code));
      };
      const abort = () => { cancelled = true; child.kill("SIGKILL"); };
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, limits.timeoutMs);
      limits.signal.addEventListener("abort", abort, { once: true });
      const capture = (out: boolean) => (chunk: Buffer) => {
        if (settled || outputLimitExceeded) return;
        const current = out ? stdout : stderr;
        const ceiling = out ? limits.maxStdoutBytes : limits.maxStderrBytes;
        if (current.length + chunk.length > ceiling ||
          stdout.length + stderr.length + chunk.length > (limits.maxCombinedBytes ?? Infinity)) {
          outputLimitExceeded = true;
          child.kill("SIGKILL");
          return;
        }
        if (out) stdout = Buffer.concat([current, chunk]);
        else stderr = Buffer.concat([current, chunk]);
      };
      child.stdout?.on("data", capture(true));
      child.stderr?.on("data", capture(false));
      child.on("error", () => finish(null));
      child.on("close", finish);
      if (limits.signal.aborted) abort();
    }),
  };
}

export function audioMediaOptions(ffmpeg: string | null, ffprobe: string | null): { audioMediaTools?: AudioMediaTools } {
  if (!ffmpeg || !ffprobe || !existsSync(ffmpeg) || !existsSync(ffprobe)) return {};
  return { audioMediaTools: createAudioMediaTools(createMediaProcessRunner({ ffmpeg, ffprobe })) };
}
