import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { FfmpegRunner } from "@arke-studio/coordinator";

type SpawnLike = typeof nodeSpawn;

const DRAWTEXT_FAILURE =
  /(?:error|failed|unable|cannot|could not|no such file|invalid).*(?:drawtext|fontconfig|fontfile|freetype|font)|(?:drawtext|fontconfig|fontfile|freetype|font).*(?:error|failed|unable|cannot|could not|no such file|invalid)/i;

/** Run desktop exports and retain enough diagnostics to name a slate-font failure. */
export function createExportFfmpegRunner(
  ffmpeg: string,
  slateFont: string,
  spawn: SpawnLike = nodeSpawn,
  exists: (path: string) => boolean = existsSync,
): FfmpegRunner {
  return {
    slateFont,
    run: (args, onProgress, signal) =>
      new Promise<void>((resolve, reject) => {
        const drawsText = args.some((arg) => arg.includes("drawtext="));
        if (drawsText && !exists(slateFont)) {
          reject(new Error("export cannot draw slates because the bundled font is missing — reinstall Arke Studio"));
          return;
        }
        const child = spawn(ffmpeg, ["-hide_banner", ...args], { windowsHide: true });
        let drawtextFailed = false;
        signal.addEventListener("abort", () => child.kill("SIGKILL"));
        child.stderr.on("data", (chunk: Buffer) => {
          const text = chunk.toString();
          drawtextFailed ||= drawsText && DRAWTEXT_FAILURE.test(text);
          const match = /time=(\d+):(\d+):(\d+)/.exec(text);
          if (match) {
            onProgress(Math.min(99, Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])));
          }
        });
        child.on("error", reject);
        child.on("exit", (code) => {
          if (code === 0) resolve();
          else if (drawtextFailed || (code === 3221225477 && drawsText)) {
            reject(new Error("ffmpeg could not draw an export slate with the bundled font"));
          } else reject(new Error(`ffmpeg exited ${code}`));
        });
      }),
  };
}
