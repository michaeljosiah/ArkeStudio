import { spawn as nodeSpawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { ffmpegFilterPath } from "@arke-studio/contracts";
import type { FfmpegRunner } from "@arke-studio/coordinator";

type SpawnLike = typeof nodeSpawn;
type HashFile = (path: string) => Promise<string>;

const FILTER_OPTIONS = new Set(["-filter_complex", "-vf", "-filter:v"]);
const GEIST_REGULAR_SHA256 = "85a1c6b18a6b0a06dfe9fd4f6d6a5d4979f74ec861eaef4bc7868b5492b8a117";

/** Only filter option values can require drawtext; input paths and metadata are ordinary argv. */
function usesDrawtext(args: readonly string[]): boolean {
  return args.some((arg, index) => {
    const previous = args[index - 1];
    return (
      (previous !== undefined && FILTER_OPTIONS.has(previous) && arg.includes("drawtext=")) ||
      [...FILTER_OPTIONS].some((option) => arg.startsWith(`${option}=`) && arg.includes("drawtext="))
    );
  });
}

const hashFile: HashFile = (path) =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const source = createReadStream(path);
    source.on("data", (chunk) => hash.update(chunk));
    source.on("error", reject);
    source.on("end", () => resolve(hash.digest("hex")));
  });

/** Run desktop exports after proving this binary can draw with the exact bundled font. */
export function createExportFfmpegRunner(
  ffmpeg: string,
  slateFont: string,
  spawn: SpawnLike = nodeSpawn,
  exists: (path: string) => boolean = existsSync,
  digest: HashFile = hashFile,
): FfmpegRunner {
  let slateVerified = false;
  let verification: {
    promise: Promise<void>;
    controller: AbortController;
    waiters: number;
  } | null = null;
  let fontIdentity: Promise<void> | null = null;

  const runProcess = (
    args: string[],
    onProgress: (percent: number) => void,
    signal: AbortSignal,
    slateProbe: boolean,
  ): Promise<void> => {
    if (signal.aborted) return Promise.reject(new Error("cancelled before start"));
    return new Promise((resolve, reject) => {
      let settled = false;
      let abort = (): void => {};
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve();
      };
      let child: ReturnType<SpawnLike>;
      try {
        child = spawn(ffmpeg, ["-hide_banner", ...args], { windowsHide: true });
      } catch (error) {
        finish(
          slateProbe
            ? new Error(`ffmpeg could not verify export slate drawing with the bundled font: ${String(error)}`)
            : error instanceof Error
              ? error
              : new Error(String(error)),
        );
        return;
      }
      abort = () => child.kill("SIGKILL");
      signal.addEventListener("abort", abort, { once: true });
      child.stderr?.on("data", (chunk: Buffer) => {
        const match = /time=(\d+):(\d+):(\d+)/.exec(chunk.toString());
        if (match) {
          onProgress(Math.min(99, Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])));
        }
      });
      child.on("error", (error) =>
        finish(
          slateProbe
            ? new Error(`ffmpeg could not verify export slate drawing with the bundled font: ${error.message}`)
            : error,
        ),
      );
      child.on("exit", (code) =>
        finish(
          code === 0
            ? undefined
            : new Error(
                slateProbe
                  ? "ffmpeg could not draw an export slate with the bundled font"
                  : `ffmpeg exited ${code}`,
              ),
        ),
      );
    });
  };

  const startVerification = (): NonNullable<typeof verification> => {
    const controller = new AbortController();
    const state = { promise: Promise.resolve(), controller, waiters: 0 };
    state.promise = runProcess(
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
      controller.signal,
      true,
    )
      .then(() => {
        slateVerified = true;
      })
      .finally(() => {
        if (verification === state) verification = null;
      });
    verification = state;
    return state;
  };

  const verifyFontIdentity = async (): Promise<void> => {
    if (!exists(slateFont)) {
      throw new Error("export cannot draw slates because the bundled font is missing — reinstall Arke Studio");
    }
    fontIdentity ??= digest(slateFont)
      .then((actual) => {
        if (actual !== GEIST_REGULAR_SHA256) {
          throw new Error("export cannot draw slates because the bundled font is invalid — reinstall Arke Studio");
        }
      })
      .catch((error: unknown) => {
        fontIdentity = null;
        throw error;
      });
    await fontIdentity;
  };

  const verifySlate = (signal: AbortSignal): Promise<void> => {
    if (signal.aborted) return Promise.reject(new Error("cancelled before start"));
    if (slateVerified) return Promise.resolve();
    const state = verification?.controller.signal.aborted ? startVerification() : (verification ?? startVerification());
    state.waiters += 1;
    return new Promise((resolve, reject) => {
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        signal.removeEventListener("abort", cancelled);
        state.waiters -= 1;
      };
      const cancelled = (): void => {
        release();
        if (state.waiters === 0) {
          if (verification === state) verification = null;
          state.controller.abort();
        }
        reject(new Error("cancelled before start"));
      };
      signal.addEventListener("abort", cancelled, { once: true });
      state.promise.then(
        () => {
          release();
          resolve();
        },
        (error: unknown) => {
          release();
          reject(error);
        },
      );
    });
  };

  return {
    slateFont,
    run: async (args, onProgress, signal) => {
      const drawsText = usesDrawtext(args);
      if (drawsText) {
        await verifyFontIdentity();
        await verifySlate(signal);
      }
      await runProcess(args, onProgress, signal, false);
    },
  };
}
