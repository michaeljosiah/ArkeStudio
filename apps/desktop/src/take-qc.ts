import { spawn as nodeSpawn } from "node:child_process";
import {
  createBoundaryFrameMaker,
  createTakePosterMaker,
  createTakeQcAnalyzer,
  type BoundaryFrameMaker,
  type MediaProbeRunner,
  type TakePosterMaker,
  type TakeQcAnalyzer,
} from "@arke-studio/coordinator";

/**
 * The host half of arrival-time motion QC (#248).
 *
 * The coordinator owns the command and the metric; what belongs here is the only part that is
 * the host's business — running a subprocess and enforcing the ceilings on it. Kept out of
 * main.ts so both halves are testable: the analyzer against fake output, this against a fake
 * spawn, and neither against whether the machine running the tests happens to have ffmpeg.
 */

type SpawnLike = typeof nodeSpawn;

/** A bounded ffmpeg probe: killed on time or on volume, and never given a shell to interpret. */
export function createFfmpegProbeRunner(ffmpeg: string, spawn: SpawnLike = nodeSpawn): MediaProbeRunner {
  return {
    run: (args, limits) =>
      new Promise((resolve) => {
        const child = spawn(ffmpeg, args as string[], { windowsHide: true });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let settled = false;

        const finish = (code: number | null): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ code, stdout, stderr, timedOut });
        };
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
          finish(null);
        }, limits.timeoutMs);
        // Held in memory, not spooled: the ceiling that stops a runaway file is the same one
        // that stops a runaway probe, and a few KiB of frame hashes is the expected size.
        const capture = (target: "out" | "err") => (chunk: Buffer) => {
          if (target === "out") stdout += chunk.toString();
          else stderr += chunk.toString();
          if (stdout.length + stderr.length > limits.maxOutputBytes) {
            child.kill("SIGKILL");
            finish(null);
          }
        };
        child.stdout?.on("data", capture("out"));
        child.stderr?.on("data", capture("err"));
        child.on("error", () => finish(null));
        child.on("exit", (code) => finish(code));
      }),
  };
}

/**
 * The coordinator options this host contributes, spread into its construction.
 *
 * Empty when there is no ffmpeg — which is most builds, and an ordinary state rather than a
 * degraded one. A take then records no measurement, and "not measured" is a thing the take
 * schema can say (SPEC-013 R-5a).
 */
export function takeQcOptions(
  ffmpeg: string | null,
  spawn: SpawnLike = nodeSpawn,
): { takeQcAnalyzer?: TakeQcAnalyzer } {
  if (ffmpeg === null) return {};
  return { takeQcAnalyzer: createTakeQcAnalyzer(createFfmpegProbeRunner(ffmpeg, spawn)) };
}

/**
 * The poster maker, on the same runner and the same terms (see coordinator takes/poster.ts).
 *
 * It shares `createFfmpegProbeRunner` rather than growing a second spawn: writing one frame to
 * a file needs exactly what a probe needs — a bounded process whose exit code is the answer —
 * and the picture never travels through stdout, so the output ceiling only ever catches
 * diagnostics.
 */
export function takePosterOptions(
  ffmpeg: string | null,
  spawn: SpawnLike = nodeSpawn,
): { takePosterMaker?: TakePosterMaker } {
  if (ffmpeg === null) return {};
  return { takePosterMaker: createTakePosterMaker(createFfmpegProbeRunner(ffmpeg, spawn)) };
}

/**
 * The boundary-frame maker (issue 154), third consumer of the same bounded runner: cutting the
 * still an accepted clip seeds the next shot with is one more "write a frame to a file" job,
 * and it earns a spawn path of its own no more than the poster did.
 */
export function boundaryFrameOptions(
  ffmpeg: string | null,
  spawn: SpawnLike = nodeSpawn,
): { boundaryFrameMaker?: BoundaryFrameMaker } {
  if (ffmpeg === null) return {};
  return { boundaryFrameMaker: createBoundaryFrameMaker(createFfmpegProbeRunner(ffmpeg, spawn)) };
}
