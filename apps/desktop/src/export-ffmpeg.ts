import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { FfmpegRunner } from "@arke-studio/coordinator";

type SpawnLike = typeof nodeSpawn;

function isDrawtextFailure(line: string): boolean {
  return (
    /^fontconfig error:/i.test(line.trimStart()) ||
    /\[(?:Parsed_)?drawtext[^\]]*\].*(?:error|failed|unable|cannot|could not|invalid)/i.test(line) ||
    /(?:error|failed|invalid).*(?:option ['"]?fontfile|filter ['"]?drawtext)/i.test(line) ||
    /(?:cannot|could not|failed to) load font(?:file|face)?(?:\s|$)/i.test(line)
  );
}

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
        let stderrLine = "";
        signal.addEventListener("abort", () => child.kill("SIGKILL"));
        child.stderr.on("data", (chunk: Buffer) => {
          const text = chunk.toString();
          const lines = `${stderrLine}${text}`.split(/\r?\n/);
          stderrLine = lines.pop()!.slice(-16_384);
          drawtextFailed ||= drawsText && lines.some(isDrawtextFailure);
          const match = /time=(\d+):(\d+):(\d+)/.exec(text);
          if (match) {
            onProgress(Math.min(99, Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])));
          }
        });
        child.on("error", reject);
        child.on("exit", (code) => {
          drawtextFailed ||= drawsText && isDrawtextFailure(stderrLine);
          if (code === 0) resolve();
          else if (drawtextFailed || (code === 3221225477 && drawsText)) {
            reject(new Error("ffmpeg could not draw an export slate with the bundled font"));
          } else reject(new Error(`ffmpeg exited ${code}`));
        });
      }),
  };
}
