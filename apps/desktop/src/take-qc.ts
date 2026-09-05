import { createMediaProcessRunner } from "./media-tools.js";
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
  const runner = createMediaProcessRunner({ ffmpeg, ffprobe: ffmpeg }, spawn);
  return { async run(args, limits) {
    const result = await runner.run("ffmpeg", args, { signal: new AbortController().signal,
      timeoutMs: limits.timeoutMs, maxStdoutBytes: limits.maxOutputBytes, maxStderrBytes: limits.maxOutputBytes, maxCombinedBytes: limits.maxOutputBytes });
    return { code: result.code, stdout: new TextDecoder().decode(result.stdout), stderr: result.stderr, timedOut: result.timedOut };
  } };
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
