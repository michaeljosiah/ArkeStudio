import type { TakeQc } from "@arke-studio/contracts";

/**
 * Arrival-time motion QC (#248).
 *
 * Some providers return a clip that declares 24 fps and contains runs of byte-identical decoded
 * frames — effectively half the motion, and the only thing that notices is the person watching
 * it. This measures that before review rather than after, so nobody spends a careful viewing
 * discovering what a hash comparison could have said.
 *
 * Three properties are load-bearing, and each is a decision rather than an implementation
 * detail:
 *
 * **Best-effort.** ffmpeg is bundled with the packaged desktop build and absent almost
 * everywhere else, so the analyzer is injected and its absence is ordinary. Nothing here may
 * fail a take: finalization is not replayable (SPEC-013), which makes a thrown exception in
 * this file a paid generation the user cannot recover.
 *
 * **Non-authoritative.** Adjacent-frame duplication cannot distinguish a provider's stutter
 * from a deliberately motionless shot, so the record is a signal for a human, never a verdict.
 * It rejects nothing.
 *
 * **Bounded.** A 4K clip fully decoded at arrival would cost more than the review it informs,
 * so the command reads at most the first seconds at thumbnail scale, and the process is capped
 * in wall clock and captured bytes besides.
 */

export type TakeQcUnavailableReason =
  | "not-configured"
  | "timeout"
  | "process-failed"
  | "output-too-large"
  | "malformed-output"
  | "unsupported-media";

export type TakeQcAnalysis = { ok: true; qc: TakeQc } | { ok: false; reason: TakeQcUnavailableReason };

export interface TakeQcAnalyzer {
  analyze(file: string): Promise<TakeQcAnalysis>;
}

/**
 * A bounded subprocess. Deliberately not `FfmpegRunner` (takes/export.ts): that interface encodes
 * and returns nothing readable, and widening it to carry probe output would put a QC concern
 * inside the export path where a failure has completely different consequences.
 */
export interface MediaProbeRunner {
  run(
    args: readonly string[],
    limits: { timeoutMs: number; maxOutputBytes: number },
  ): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>;
}

/** Wall clock for the whole probe. Past this the process is killed and the take records nothing. */
export const QC_TIMEOUT_MS = 15_000;
/** Captured stdout+stderr ceiling. framemd5 for 180 frames is a few KiB; a MiB means something is wrong. */
export const QC_MAX_OUTPUT_BYTES = 1_048_576;
/** Below this share of nominal motion the clip is called degraded. Exactly 0.8 is clean. */
export const QC_THRESHOLD_RATIO = 0.8;

/**
 * The command, as an argument array (#248).
 *
 * The file is one argument handed to the runner and never interpolated into a shell string —
 * world paths contain user-authored names, and a filename is not a place to discover quoting.
 *
 * Bounded three ways at once, because any one of them alone has a clip that defeats it: 8
 * seconds of media, 180 frames, and 320 px wide. `-2` keeps the height even, which some decoders
 * require. framemd5 writes hashes to stdout and no media anywhere.
 */
export function takeQcArgs(file: string): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    file,
    "-map",
    "0:v:0",
    "-t",
    "8",
    "-vf",
    "scale=320:-2",
    "-frames:v",
    "180",
    "-f",
    "framemd5",
    "-",
  ];
}

interface FrameRow {
  pts: number;
  hash: string;
}

interface ParsedFramemd5 {
  timeBaseSeconds: number;
  rows: FrameRow[];
}

/**
 * framemd5's own header and rows. The format states its timebase in a comment line
 * (`#tb 0: 1/24`) and then one row per frame: stream, dts, pts, duration, size, hash.
 *
 * Returns null rather than guessing. A missing timebase or an unreadable row means the
 * measurement was not made, and "not measured" is a representable answer here.
 */
export function parseFramemd5(stdout: string): ParsedFramemd5 | null {
  let timeBaseSeconds: number | null = null;
  const rows: FrameRow[] = [];

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith("#")) {
      // "#tb 0: 1/24" — the first stream's timebase is the one we sampled with -map 0:v:0.
      const tb = /^#tb\s+0:\s*(\d+)\/(\d+)$/.exec(trimmed);
      if (tb) {
        const numerator = Number(tb[1]);
        const denominator = Number(tb[2]);
        if (denominator > 0 && numerator > 0) timeBaseSeconds = numerator / denominator;
      }
      continue;
    }
    const parts = trimmed.split(",").map((part) => part.trim());
    if (parts.length < 6) return null;
    const pts = Number(parts[2]);
    const hash = parts[parts.length - 1]!;
    if (!Number.isFinite(pts) || hash.length === 0) return null;
    rows.push({ pts, hash });
  }

  if (timeBaseSeconds === null || timeBaseSeconds <= 0) return null;
  return { timeBaseSeconds, rows };
}

/** Six decimals: enough to compare two measurements, few enough to stay readable in a take file. */
function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/**
 * The metric, from parsed rows (#248).
 *
 * Counts transitions rather than frames: n rows describe n-1 opportunities for the picture to
 * change, and a duplicate is an opportunity that was not taken. Nominal rate is measured from
 * the sampled span rather than believed from the container, because the container's claim is
 * exactly what is in question.
 *
 * Status compares unrounded values; the stored numbers are rounded for reading. Rounding first
 * would put a clip's verdict at the mercy of the sixth decimal place.
 */
export function measureFramemd5(parsed: ParsedFramemd5): TakeQc | null {
  const { rows, timeBaseSeconds } = parsed;
  if (rows.length < 2) return null;

  let previous = rows[0]!.pts;
  for (let index = 1; index < rows.length; index += 1) {
    const current = rows[index]!.pts;
    if (!(current > previous)) return null; // Presentation order is the one thing we must trust.
    previous = current;
  }

  const sampledSpanSec = (rows[rows.length - 1]!.pts - rows[0]!.pts) * timeBaseSeconds;
  if (!(sampledSpanSec > 0)) return null;

  const totalTransitions = rows.length - 1;
  let duplicateFrames = 0;
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index]!.hash === rows[index - 1]!.hash) duplicateFrames += 1;
  }

  const duplicateRatioRaw = duplicateFrames / totalTransitions;
  const nominalFpsRaw = totalTransitions / sampledSpanSec;
  const effectiveFpsRaw = nominalFpsRaw * (1 - duplicateRatioRaw);
  if (!(nominalFpsRaw > 0)) return null;

  return {
    method: "adjacent-framemd5-v1",
    scope: "source-media",
    status: effectiveFpsRaw < nominalFpsRaw * QC_THRESHOLD_RATIO ? "degraded" : "clean",
    nominalFps: round6(nominalFpsRaw),
    effectiveFps: round6(effectiveFpsRaw),
    duplicateFrames,
    duplicateRatio: round6(duplicateRatioRaw),
    sampledFrames: rows.length,
    thresholdRatio: QC_THRESHOLD_RATIO,
  };
}

/**
 * The analyzer over a bounded runner. Every failure is a named reason rather than an exception:
 * the caller is take finalization, and finalization has nowhere to put a throw.
 */
export function createTakeQcAnalyzer(runner: MediaProbeRunner): TakeQcAnalyzer {
  return {
    async analyze(file: string): Promise<TakeQcAnalysis> {
      let result: Awaited<ReturnType<MediaProbeRunner["run"]>>;
      try {
        result = await runner.run(takeQcArgs(file), {
          timeoutMs: QC_TIMEOUT_MS,
          maxOutputBytes: QC_MAX_OUTPUT_BYTES,
        });
      } catch {
        return { ok: false, reason: "process-failed" };
      }

      if (result.timedOut) return { ok: false, reason: "timeout" };
      if ((result.stdout.length + result.stderr.length) > QC_MAX_OUTPUT_BYTES) {
        return { ok: false, reason: "output-too-large" };
      }
      if (result.code !== 0) return { ok: false, reason: "process-failed" };

      const parsed = parseFramemd5(result.stdout);
      if (parsed === null) return { ok: false, reason: "malformed-output" };

      const qc = measureFramemd5(parsed);
      // Parsed but unmeasurable: one frame, a still, or timestamps that do not advance. The
      // media is readable and the question simply does not apply to it.
      if (qc === null) return { ok: false, reason: "unsupported-media" };
      return { ok: true, qc };
    },
  };
}
