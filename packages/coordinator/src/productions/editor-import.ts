import { basename } from "node:path";
import {
  AUDIO_TRACK_KINDS, laneRefusal, mediaPlacementCommands, migrateLegacyCut, resolveProductionArtifact, seedFirstPictureTimeline,
  type ArtifactSidecar, type ClientMessage,
} from "@arke-studio/contracts";
import { randomUUID } from "node:crypto";
import { fileArtifact } from "../artifacts/filing.js";
import { writeArtifactPoster } from "../artifacts/poster.js";
import type { MediaProbe } from "../media/probe.js";
import type { TakePosterMaker, TakePosterUnavailableReason } from "../takes/poster.js";
import type { WorldStore } from "../world/store.js";
import { applyTimelineCommand } from "./timeline.js";

export type EditorImport = NonNullable<Extract<ClientMessage, { kind: "upload-artifacts" }>["editor"]>;

/**
 * How long one import spends drawing posters, all files together. The maker allows fifteen
 * seconds a file, and the import's answer — and with it every Cut command — waits for the loop;
 * sixteen videos ffmpeg cannot read would have held both for four minutes over a derived cache
 * the next open backfills anyway.
 */
const IMPORT_POSTER_BUDGET_MS = 20_000;

/** Filing survives a stale edit; only placement and Library membership form the timeline transaction. */
export async function importEditorMedia(store: WorldStore, sources: readonly (string | null)[], editor: EditorImport, options: {
  mediaProbe?: MediaProbe;
  /** Draws a video artifact's picture as it lands (issue 1037); absent on a build without ffmpeg. */
  poster?: TakePosterMaker;
  onPosterUnavailable?: (artifactId: string, reason: TakePosterUnavailableReason) => void;
  /** Where a borrow came from (`world:<slug>`), recorded on the sidecar as filing's provenance (issue 1033). */
  importedFrom?: string;
  abandoned: () => boolean;
  confirmLarge?: (file: { name: string; sizeBytes: number }) => Promise<boolean>;
}): Promise<Array<{ index: number; reason: string }>> {
  if (sources.length > 16) throw new Error("Import up to 16 files at a time");
  const production = store.getBundle().productions.find(candidate => candidate.meta.id === editor.productionId);
  if (!production) throw new Error("This production is no longer open");
  if (production.timeline?.status === "invalid") throw new Error(production.timeline.message);
  if (production.timeline?.status !== "ready" && production.spine) throw new Error("Open this production on the timeline before importing");
  const seed = production.timeline?.status === "ready" ? production.timeline.timeline : seedFirstPictureTimeline(production);
  const timeline = migrateLegacyCut(seed, production, store.getBundle().artifacts).timeline;
  const destination = editor.destination;
  // A drop on a named lane is checked file by file, so one wrong file is reported and the rest
  // still land (SPEC-043 R-4); a lane that has gone is refused once, below, by the placement.
  const lane = typeof destination === "object" && "trackId" in destination
    ? timeline.tracks.find(track => track.id === destination.trackId) ?? null : null;
  const artifacts: ArtifactSidecar[] = [], failures: Array<{ index: number; reason: string }> = [];
  const posterDeadline = Date.now() + IMPORT_POSTER_BUDGET_MS;
  for (const [index, sourcePath] of sources.entries()) {
    if (options.abandoned()) throw new Error("The world closed during import");
    if (sourcePath === null) { failures.push({ index, reason: `File ${index + 1}: this drop has no local file; save it to disk and import it again` }); continue; }
    try {
      let result = await fileArtifact(store, { sourcePath, production: null, ...options });
      if (result.outcome === "needs-consent" && options.confirmLarge &&
          await options.confirmLarge({ name: basename(sourcePath), sizeBytes: result.sizeBytes })) {
        if (options.abandoned()) throw new Error("The world closed during import");
        result = await fileArtifact(store, { sourcePath, production: null, ...options, allowLarge: true });
      }
      if (result.outcome === "filed" || result.outcome === "deduplicated") {
        // Filing measures after its first commit; the return value predates that sidecar update.
        const id = result.artifact.id;
        const artifact = store.getBundle().artifacts.find(artifact => artifact.id === id) ?? result.artifact;
        // Before the snapshot that carries the artifact, so the Library's first row already has
        // its picture; a poster that could not be drawn leaves the row as it was before posters,
        // and one the batch has no time left for is the next open's to draw.
        const posterMs = posterDeadline - Date.now();
        if (posterMs > 0) await writeArtifactPoster(store, artifact, options.poster, (reason) => options.onPosterUnavailable?.(artifact.id, reason), { timeoutMs: posterMs });
        const laneRefused = lane === null ? null : laneRefusal(artifact, AUDIO_TRACK_KINDS.has(lane.kind));
        /*
         * Dedup is by bytes across the world and keeps the owner (PR 1039): a file — or a borrow
         * — whose bytes another production already holds comes back as that production's, which
         * this one's Library may not hold. Said here, by file, rather than as the placement's
         * refusal of the whole batch with a recovery that cannot recover it.
         */
        const owner = resolveProductionArtifact([artifact], artifact.id, editor.productionId);
        if (!owner.ok) {
          failures.push({ index, reason: `${basename(sourcePath)}: already in this world as another production's file; share it from Artifacts first` });
        } else if (!["audio", "video", "image", "board"].includes(artifact.kind)) {
          failures.push({ index, reason: `${basename(sourcePath)}: this file has no playable picture or sound` });
        } else if (typeof destination === "number" && artifact.kind === "audio") {
          failures.push({ index, reason: `${basename(sourcePath)}: this file has no picture; use Import media to add it to an audio track` });
        } else if (laneRefused !== null) {
          failures.push({ index, reason: `${basename(sourcePath)}: saved, but ${laneRefused}; ${lane!.name} takes ${AUDIO_TRACK_KINDS.has(lane!.kind) ? "sound" : "picture"}` });
        } else if (destination !== "library" && (artifact.kind === "audio" || artifact.kind === "video") &&
            !(artifact.mediaInfo && artifact.mediaInfo.durationSec > 0)) {
          failures.push({ index, reason: `${basename(sourcePath)}: saved, but needs a measured duration before placement; recover it through Library → Add` });
        } else artifacts.push(artifact);
      }
      else failures.push({ index, reason: `${basename(sourcePath)}: ${result.reason}` });
    } catch (error) {
      failures.push({ index, reason: `${basename(sourcePath)}: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  if (options.abandoned()) throw new Error("The world closed during import");
  if (artifacts.length) {
    try {
      const commands = mediaPlacementCommands(timeline, artifacts, destination, () => `cl_${randomUUID()}`);
      if (!commands.length) return failures;
      await applyTimelineCommand(store, editor.productionId, {
        kind: "commands", commands, baseRevision: editor.baseRevision, sourceFingerprint: editor.sourceFingerprint,
        label: destination === "library" ? "Import to Library" : "Import media to timeline",
      });
    } catch (error) {
      throw new Error(`Files were saved, but the timeline was unchanged: ${error instanceof Error ? error.message : String(error)}. Use Library → Add to recover the imported files.`);
    }
  }
  return failures;
}
