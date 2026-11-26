import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ulid } from "@arke-studio/contracts";
import { toExtendedLength } from "../world/paths.js";
export { exportWorld, WORLD_EXPORT_EXCLUDED } from "./export-world.js";

/**
 * Exports (SPEC-013 §2.10, §2.11): one local encode over accepted material, staged so a
 * cancelled export leaves nothing partial (R-19, R-21, D11); and the world export — a folder
 * that reopens identically elsewhere, history included, caches excluded (R-22, D12).
 */

export interface FfmpegRunner {
  /** Host path to the redistributed font every generated slate uses. */
  slateFont: string;
  /** Stable encoder build identity retained by retryable private editions. */
  identity?(signal: AbortSignal): Promise<string>;
  /** Resolve the installed encoder's supported graph-file option before preparing effects. */
  graphFileOption?(signal: AbortSignal): Promise<"-/filter_complex" | "-filter_complex_script">;
  /**
   * Run one encode; resolve on success, reject on failure, honour the signal for cancel.
   * `onProgress` has only ever had ffmpeg's elapsed seconds, capped at 99; `onSeconds`, where a
   * runner gives it, is the same clock uncapped, which a caller that knows the length can turn
   * into a true percent (design turn 197d).
   */
  run(args: string[], onProgress: (percent: number) => void, signal: AbortSignal, onSeconds?: (seconds: number) => void): Promise<void>;
}

/**
 * Past this many characters of arguments, an encode's filter graph goes to FFmpeg in a file.
 * Windows gives a process 32,767 characters in all, counting the program's own path and every
 * quote and space. A cut of one scene reaches that long before it is large: each sound is a chain
 * in the graph, a gated take's chain spells every stretch it keeps, and a room laid from pieces
 * is a chain a piece. The effects export has always written its graph to a file for this reason;
 * the plain export did not, and failed before it started (`spawn ENAMETOOLONG`).
 */
export const INLINE_ARGUMENTS_MOST = 24_000;

/**
 * The arguments as the encoder should get them: as they were built while they are short, and
 * with the graph in `graphFile` once they are long and the runner can say which option reads
 * one. The graph is local job data, never shell code. The caller removes the file.
 */
export async function graphInFile(args: string[], runner: Pick<FfmpegRunner, "graphFileOption">, graphFile: string, signal: AbortSignal): Promise<string[]> {
  const at = args.indexOf("-filter_complex");
  if (at < 0 || at + 1 >= args.length || !runner.graphFileOption || args.reduce((sum, arg) => sum + arg.length + 3, 0) <= INLINE_ARGUMENTS_MOST) return args;
  const option = await runner.graphFileOption(signal);
  await writeFile(toExtendedLength(graphFile), args[at + 1]!, "utf8");
  return [...args.slice(0, at), option, graphFile, ...args.slice(at + 2)];
}

export interface ExportHandle {
  id: string;
  cancel(): void;
  done: Promise<
    { status: "done"; output: string; sidecar?: string } | { status: "cancelled" } | { status: "failed"; error: string }
  >;
}

/** A subtitle sidecar delivered beside the video (SPEC-038 R-27): its name and its whole text. */
export interface ExportSidecar {
  name: string;
  text: string;
}

/** Host lifecycle for derived rendering that must revalidate sources before publication. */
export interface ExportLifecycle {
  signal: AbortSignal;
  prepare?(): Promise<void>;
  render(stage: string, signal: AbortSignal): Promise<void>;
  publish(write: () => Promise<void>, signal: AbortSignal): Promise<void>;
  cleanup(): Promise<void>;
  cleanupStaging(): Promise<void>;
  rollbackOutput(path: string): Promise<void>;
}

/**
 * Render an export plan to `<world>/exports/` via a staging path (R-21): the output appears
 * whole or not at all, and cancellation deletes the stage.
 */
export function runExport(
  worldDir: string,
  /**
   * The encode, built against the staging path rather than the destination.
   *
   * Taking a builder instead of a plan is what lets a spine production render through its own
   * assembly: the staging discipline here -- whole or not at all -- has nothing to do with which
   * timeline produced the arguments, and there is no reason for it to know.
   */
  buildArgs: (stage: string) => string[],
  outName: string,
  runner: FfmpegRunner,
  onProgress: (percent: number) => void,
  /**
   * A sidecar that lands with the video or not at all (SPEC-038 R-30, A-10): staged beside the
   * encode, renamed after it, removed with it on cancellation or failure.
   */
  sidecar?: ExportSidecar,
  exportId?: string,
  lifecycle?: ExportLifecycle,
): ExportHandle {
  const id = exportId ?? `ex_${ulid()}`;
  if (!/^ex_[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) throw new Error("invalid export id");
  const controller = new AbortController();
  const close = () => controller.abort();
  lifecycle?.signal.addEventListener("abort", close, { once: true });
  if (lifecycle?.signal.aborted) close();
  const stage = join(worldDir, ".cache", "exports", `${id}.mp4`);
  const output = join(worldDir, "exports", outName);
  const sidecarStage = sidecar === undefined ? null : join(worldDir, ".cache", "exports", `${id}-${sidecar.name}`);
  const sidecarOutput = sidecar === undefined ? null : join(worldDir, "exports", sidecar.name);
  // Where a long graph waits while the encoder reads it; gone with the stage, whatever the encode did.
  const graphStage = join(worldDir, ".cache", "exports", `${id}.ffgraph`);
  const done = (async () => {
    try {
      await lifecycle?.prepare?.();
      await mkdir(toExtendedLength(join(worldDir, ".cache", "exports")), { recursive: true });
      await mkdir(toExtendedLength(join(worldDir, "exports")), { recursive: true });
      // A cancel that lands before the encoder starts must still cancel: an already-aborted
      // signal never invokes listeners added later, so the check happens here.
      if (controller.signal.aborted) throw new Error("cancelled before start");
      if (sidecar !== undefined && sidecarStage !== null) await writeFile(toExtendedLength(sidecarStage), sidecar.text, "utf8");
      if (lifecycle) await lifecycle.render(stage, controller.signal);
      else await runner.run(await graphInFile(buildArgs(stage), runner, graphStage, controller.signal), onProgress, controller.signal);
      if (controller.signal.aborted) throw new Error("cancelled");
      const publish = async () => {
      await rename(toExtendedLength(stage), toExtendedLength(output));
      if (sidecar !== undefined && sidecarStage !== null && sidecarOutput !== null) {
        try {
          await rename(toExtendedLength(sidecarStage), toExtendedLength(sidecarOutput));
        } catch (error) {
          // The video is already in exports/. Both or neither: a film without the subtitles it
          // promised is not the export that was asked for, so the video goes too (round three).
          if (lifecycle) await lifecycle.rollbackOutput(output).catch(() => {});
          else await rm(toExtendedLength(output), { force: true }).catch(() => {});
          throw error;
        }
      }
      };
      if (lifecycle) await lifecycle.publish(publish, controller.signal); else await publish();
      if (sidecar) return { status: "done" as const, output: `exports/${outName}`, sidecar: `exports/${sidecar.name}` };
      return { status: "done" as const, output: `exports/${outName}` };
    } catch (err) {
      if (lifecycle) await lifecycle.cleanupStaging().catch(() => {});
      else {
        await rm(toExtendedLength(stage), { force: true }).catch(() => {});
        if (sidecarStage !== null) await rm(toExtendedLength(sidecarStage), { force: true }).catch(() => {});
      }
      if (controller.signal.aborted) return { status: "cancelled" as const };
      return { status: "failed" as const, error: err instanceof Error ? err.message : String(err) };
    } finally {
      lifecycle?.signal.removeEventListener("abort", close);
      if (!lifecycle) await rm(toExtendedLength(graphStage), { force: true }).catch(() => {});
      await lifecycle?.cleanup().catch(() => {});
    }
  })();
  return { id, cancel: () => controller.abort(), done };
}
