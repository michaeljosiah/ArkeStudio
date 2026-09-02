import { cp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ulid } from "@arke-studio/contracts";
import { toExtendedLength } from "../world/paths.js";

/**
 * Exports (SPEC-013 §2.10, §2.11): one local encode over accepted material, staged so a
 * cancelled export leaves nothing partial (R-19, R-21, D11); and the world export — a folder
 * that reopens identically elsewhere, history included, caches excluded (R-22, D12).
 */

export interface FfmpegRunner {
  /** Host path to the redistributed font every generated slate uses. */
  slateFont: string;
  /** Run one encode; resolve on success, reject on failure, honour the signal for cancel. */
  run(args: string[], onProgress: (percent: number) => void, signal: AbortSignal): Promise<void>;
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
): ExportHandle {
  const id = `ex_${ulid()}`;
  const controller = new AbortController();
  const stage = join(worldDir, ".cache", "exports", `${id}.mp4`);
  const output = join(worldDir, "exports", outName);
  const sidecarStage = sidecar === undefined ? null : join(worldDir, ".cache", "exports", `${id}-${sidecar.name}`);
  const sidecarOutput = sidecar === undefined ? null : join(worldDir, "exports", sidecar.name);
  const done = (async () => {
    try {
      await mkdir(toExtendedLength(join(worldDir, ".cache", "exports")), { recursive: true });
      await mkdir(toExtendedLength(join(worldDir, "exports")), { recursive: true });
      // A cancel that lands before the encoder starts must still cancel: an already-aborted
      // signal never invokes listeners added later, so the check happens here.
      if (controller.signal.aborted) throw new Error("cancelled before start");
      if (sidecar !== undefined && sidecarStage !== null) await writeFile(toExtendedLength(sidecarStage), sidecar.text, "utf8");
      await runner.run(buildArgs(stage), onProgress, controller.signal);
      if (controller.signal.aborted) throw new Error("cancelled");
      await rename(toExtendedLength(stage), toExtendedLength(output));
      if (sidecar !== undefined && sidecarStage !== null && sidecarOutput !== null) {
        try {
          await rename(toExtendedLength(sidecarStage), toExtendedLength(sidecarOutput));
        } catch (error) {
          // The video is already in exports/. Both or neither: a film without the subtitles it
          // promised is not the export that was asked for, so the video goes too (round three).
          await rm(toExtendedLength(output), { force: true }).catch(() => {});
          throw error;
        }
        return { status: "done" as const, output: `exports/${outName}`, sidecar: `exports/${sidecar.name}` };
      }
      return { status: "done" as const, output: `exports/${outName}` };
    } catch (err) {
      await rm(toExtendedLength(stage), { force: true }).catch(() => {});
      if (sidecarStage !== null) await rm(toExtendedLength(sidecarStage), { force: true }).catch(() => {});
      if (controller.signal.aborted) return { status: "cancelled" as const };
      return { status: "failed" as const, error: err instanceof Error ? err.message : String(err) };
    }
  })();
  return { id, cancel: () => controller.abort(), done };
}

/** What a world export leaves behind (D12): caches and locks; never the version record. */
export const WORLD_EXPORT_EXCLUDED = [
  ".index",
  ".commit",
  ".proposals",
  // Unfinished thinking, like .proposals. A world archive carries it; an export does not.
  ".conversations",
  // Bench sessions are operational history too (issue 305 §6). What a session KEPT is an
  // ordinary artifact and exports with the world; the takes it did not keep do not.
  ".sessions",
  ".staging",
  ".cache",
  "world.lock",
];

/**
 * Copy the world for another machine (R-22): `.history/` IS included — it is the version
 * record, not a cache, and a world that cannot explain how it got here is not the same world.
 */
export async function exportWorld(worldDir: string, targetDir: string): Promise<void> {
  await cp(worldDir, targetDir, {
    recursive: true,
    filter: (source) => {
      const rel = source.slice(worldDir.length).replace(/\\/g, "/").replace(/^\//, "");
      if (rel === "") return true;
      const head = rel.split("/")[0]!;
      return !WORLD_EXPORT_EXCLUDED.includes(head) && !/\.tmp-[0-9A-Z]+$/i.test(rel);
    },
  });
}
