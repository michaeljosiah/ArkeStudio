/**
 * A video take's poster: its first frame, written beside the clip as `frame.png`.
 *
 * The convention is older than this file. Every place that shows a take as a picture — the
 * strip, the shot cards, the review pane, the cut preview — already asks for `frame.png` next
 * to any `.mp4`, and has done since the production screens were built. Nothing ever wrote one.
 * A tile pointed an `<img>` at an `.mp4`, the decode failed, and the fallback box appeared, so
 * every generated video read on screen as a grey rectangle with a label in it.
 *
 * The posture is `takes/qc.ts`'s, for the same reason: this runs during finalization, which is
 * not replayable (SPEC-013). A thrown exception here would be a paid generation the user cannot
 * recover, so nothing in this file may fail a take. The runner is injected and its absence is
 * ordinary — most builds have no ffmpeg — and a missing poster is exactly the state the readers
 * already handle, because it is the state they have always been in.
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";
import { toExtendedLength } from "../world/paths.js";
import type { MediaProbeRunner } from "./qc.js";

/** The poster's filename, beside the clip. The readers' convention, named once. */
export const POSTER_NAME = "frame.png";

/** Wall clock for the extraction. Past this the process is killed and no poster is written. */
export const POSTER_TIMEOUT_MS = 15_000;
/**
 * ffmpeg writes the picture to a file, so stdout carries only diagnostics. A megabyte of those
 * means something is badly wrong, and the ceiling stops it the same way QC's does.
 */
export const POSTER_MAX_OUTPUT_BYTES = 1_048_576;
/**
 * Long edge, in pixels. Every consumer is a `Portrait` — a tile, a card, a preview — so this is
 * a poster and not a still: the clip itself is there for anyone who wants full resolution.
 * Wide enough for the largest of those at 2x, small enough that a bench session with forty
 * takes does not quietly become a folder of megabytes.
 */
export const POSTER_MAX_WIDTH = 960;

/** Whether a landed file is the kind that needs a poster drawn for it. */
export function isVideoMedia(file: string): boolean {
  return /\.(mp4|webm|mov|m4v)$/i.test(file);
}

/**
 * The poster path for a piece of media, or the media itself when it is already a picture.
 * Mirrors the client's convention exactly; both sides are pinned by tests.
 */
export function posterNameFor(file: string): string {
  return isVideoMedia(file) ? POSTER_NAME : file;
}

/**
 * The command, as an argument array.
 *
 * Paths are arguments handed to the runner, never interpolated into a shell string — world
 * paths carry user-authored names, and a filename is not a place to discover quoting.
 *
 * `-frames:v 1` after the input takes the first decoded frame rather than seeking, which is
 * what "first frame" means and also the cheapest thing to ask for. `-y` overwrites, so a retry
 * after a partial write is ordinary. `min(...)` never upscales: a 320px clip keeps its size
 * instead of being blown up to 960 and stored at four times the bytes for no more detail.
 */
export function posterArgs(input: string, output: string): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    input,
    "-map",
    "0:v:0",
    "-frames:v",
    "1",
    "-vf",
    `scale='min(${POSTER_MAX_WIDTH},iw)':-2`,
    "-y",
    output,
  ];
}

export type TakePosterUnavailableReason = "not-configured" | "timeout" | "process-failed";

export interface TakePosterMaker {
  /**
   * Draw `output` from `input`. Resolves either way — the reason is for the log, and the caller
   * carries on regardless. Both paths are absolute host paths.
   */
  write(input: string, output: string): Promise<{ ok: true } | { ok: false; reason: TakePosterUnavailableReason }>;
}

export function createTakePosterMaker(runner: MediaProbeRunner): TakePosterMaker {
  return {
    write: async (input, output) => {
      let result;
      try {
        result = await runner.run(posterArgs(input, output), {
          timeoutMs: POSTER_TIMEOUT_MS,
          maxOutputBytes: POSTER_MAX_OUTPUT_BYTES,
        });
      } catch {
        return { ok: false, reason: "process-failed" };
      }
      if (result.timedOut) return { ok: false, reason: "timeout" };
      if (result.code !== 0) return { ok: false, reason: "process-failed" };
      return { ok: true };
    },
  };
}

/**
 * Draw the poster for a landed file, if it is a video and there is anything to draw with.
 *
 * The one entry point both landing paths call, so "a video take gets a frame" is stated once
 * rather than twice with a chance of drifting. Total: it reports and never throws.
 */
export async function writePosterFor(
  mediaPath: string,
  maker: TakePosterMaker | undefined,
  onUnavailable?: (reason: TakePosterUnavailableReason) => void,
): Promise<boolean> {
  if (!isVideoMedia(mediaPath)) return false; // A picture is its own poster; nothing was asked.
  const notify = (reason: TakePosterUnavailableReason): void => {
    try {
      onUnavailable?.(reason);
    } catch {
      /* a diagnostic that fails is still only a diagnostic */
    }
  };
  if (maker === undefined) {
    notify("not-configured");
    return false;
  }
  const output = mediaPath.replace(/[^/\\]+$/, POSTER_NAME);
  let outcome;
  try {
    outcome = await maker.write(mediaPath, output);
  } catch {
    notify("process-failed");
    return false;
  }
  if (!outcome.ok) {
    notify(outcome.reason);
    return false;
  }
  return true;
}

/** One piece of landed media that may or may not have a picture beside it yet. */
export interface PosterCandidate {
  /** Absolute directory holding the media. */
  dir: string;
  /** The media's filename within that directory. */
  file: string;
  /** Carried through to the report, so a failure can name what failed. */
  id: string;
}

/**
 * Draw the missing pictures, oldest first, until the budget runs out.
 *
 * Bounded by wall clock rather than by count: a session holding forty old clips draws what it
 * can and leaves the rest for the next open, which is self-healing and never a session that
 * refuses to open. Once drawn, every later pass finds them all present and does nothing.
 *
 * Returns how many were drawn, which is what a caller would want to log.
 */
export async function backfillPosters(
  candidates: readonly PosterCandidate[],
  maker: TakePosterMaker | undefined,
  options: {
    budgetMs: number;
    now?: () => number;
    onUnavailable?: (id: string, reason: TakePosterUnavailableReason) => void;
  },
): Promise<number> {
  if (maker === undefined) return 0;
  const now = options.now ?? Date.now;
  const deadline = now() + options.budgetMs;
  let drawn = 0;
  for (const candidate of candidates) {
    if (!isVideoMedia(candidate.file)) continue;
    if (now() > deadline) break;
    const already = await stat(toExtendedLength(join(candidate.dir, POSTER_NAME))).catch(() => null);
    if (already !== null) continue; // Already drawn: this pass costs one stat and nothing more.
    const made = await writePosterFor(
      toExtendedLength(join(candidate.dir, candidate.file)),
      maker,
      (reason) => options.onUnavailable?.(candidate.id, reason),
    );
    if (made) drawn += 1;
  }
  return drawn;
}
