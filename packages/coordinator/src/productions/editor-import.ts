import { basename } from "node:path";
import {
  mediaPlacementCommands, migrateLegacyCut, seedFirstPictureTimeline, type ArtifactSidecar, type ClientMessage,
} from "@arke-studio/contracts";
import { randomUUID } from "node:crypto";
import { fileArtifact } from "../artifacts/filing.js";
import type { MediaProbe } from "../media/probe.js";
import type { WorldStore } from "../world/store.js";
import { applyTimelineCommand } from "./timeline.js";

export type EditorImport = NonNullable<Extract<ClientMessage, { kind: "upload-artifacts" }>["editor"]>;

/** Filing survives a stale edit; only placement and Library membership form the timeline transaction. */
export async function importEditorMedia(store: WorldStore, sources: readonly string[], editor: EditorImport, options: {
  mediaProbe?: MediaProbe;
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
  const artifacts: ArtifactSidecar[] = [], failures: Array<{ index: number; reason: string }> = [];
  for (const [index, sourcePath] of sources.entries()) {
    if (options.abandoned()) throw new Error("The world closed during import");
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
        artifacts.push(store.getBundle().artifacts.find(artifact => artifact.id === id) ?? result.artifact);
      }
      else failures.push({ index, reason: `${basename(sourcePath)}: ${result.reason}` });
    } catch (error) {
      failures.push({ index, reason: `${basename(sourcePath)}: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  if (options.abandoned()) throw new Error("The world closed during import");
  if (artifacts.length) {
    try {
      const commands = mediaPlacementCommands(timeline, artifacts, editor.destination, () => `cl_${randomUUID()}`);
      if (!commands.length) return failures;
      await applyTimelineCommand(store, editor.productionId, {
        kind: "commands", commands, baseRevision: editor.baseRevision, sourceFingerprint: editor.sourceFingerprint,
        label: editor.destination === "library" ? "Import to Library" : "Import media to timeline",
      });
    } catch (error) {
      throw new Error(`Files were saved, but the timeline was unchanged: ${error instanceof Error ? error.message : String(error)}. Use Library → Add to recover the imported files.`);
    }
  }
  return failures;
}
