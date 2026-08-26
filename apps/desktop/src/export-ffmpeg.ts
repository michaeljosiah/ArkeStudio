import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { ffmpegFilterPath } from "@arke-studio/contracts";
import type { FfmpegRunner } from "@arke-studio/coordinator";

type SpawnLike = typeof nodeSpawn;

/** Run desktop exports after proving this binary can draw with the exact bundled font. */
export function createExportFfmpegRunner(
  ffmpeg: string,
  slateFont: string,
  spawn: SpawnLike = nodeSpawn,
  exists: (path: string) => boolean = existsSync,
): FfmpegRunner {
  let slateVerified = false;

  const runProcess = (
    args: string[],
    onProgress: (percent: number) => void,
    signal: AbortSignal,
    slateProbe: boolean,
  ): Promise<void> =>
    new Promise((resolve, reject) => {
      const child = spawn(ffmpeg, ["-hide_banner", ...args], { windowsHide: true });
      const abort = () => child.kill("SIGKILL");
      signal.addEventListener("abort", abort, { once: true });
      child.stderr.on("data", (chunk: Buffer) => {
        const match = /time=(\d+):(\d+):(\d+)/.exec(chunk.toString());
        if (match) {
          onProgress(Math.min(99, Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])));
        }
      });
      child.on("error", (error) => {
        signal.removeEventListener("abort", abort);
        reject(
          slateProbe
            ? new Error(`ffmpeg could not verify export slate drawing with the bundled font: ${error.message}`)
            : error,
        );
      });
      child.on("exit", (code) => {
        signal.removeEventListener("abort", abort);
        if (code === 0) resolve();
        else if (slateProbe) reject(new Error("ffmpeg could not draw an export slate with the bundled font"));
        else reject(new Error(`ffmpeg exited ${code}`));
      });
    });

  return {
    slateFont,
    run: async (args, onProgress, signal) => {
      const drawsText = args.some((arg) => arg.includes("drawtext="));
      if (drawsText && !exists(slateFont)) {
        throw new Error("export cannot draw slates because the bundled font is missing — reinstall Arke Studio");
      }
      if (drawsText && !slateVerified) {
        await runProcess(
          [
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=black:s=16x16:r=1",
            "-frames:v",
            "1",
            "-vf",
            `drawtext=expansion=none:fontfile=${ffmpegFilterPath(slateFont)}:text=probe:fontcolor=white:fontsize=8`,
            "-f",
            "null",
            "-",
          ],
          () => {},
          signal,
          true,
        );
        slateVerified = true;
      }
      await runProcess(args, onProgress, signal, false);
    },
  };
}
