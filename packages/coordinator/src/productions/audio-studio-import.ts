import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import type { AudioArrangementCommand, AudioStudioImport } from "@arke-studio/contracts";
import { fileArtifact, kindForFile } from "../artifacts/filing.js";
import type { MediaProbe } from "../media/probe.js";
import type { FfmpegRunner } from "../takes/export.js";
import type { WorldStore } from "../world/store.js";
import { audioStudioSource, editAudioStudio } from "./audio-studio.js";

/** Filing is durable before placement is attempted; a stale review never discards imported media. */
export async function importAudioStudioMedia(store: WorldStore, paths: readonly (string | null)[], target: AudioStudioImport, options: {
  mediaProbe?: MediaProbe; ffmpeg?: FfmpegRunner; abandoned: () => boolean;
  confirmLarge?: (file: { name: string; sizeBytes: number }) => Promise<boolean>;
}): Promise<Array<{ index: number; reason: string }>> {
  if (paths.length > 16) throw new Error("Import up to 16 files at a time");
  const production = store.getBundle().productions.find(p => p.meta.id === target.productionId);
  const chapter = production?.chapters.find(c => c.file === target.chapterFile || c.id === target.chapterFile);
  if (!chapter) throw new Error("This chapter is no longer open");
  const failures: Array<{ index: number; reason: string }> = [], placed: number[] = [];
  const commands: AudioArrangementCommand[] = [];
  const destination = target.destination;
  const trackId = destination === "library" ? null : destination.trackId ?? `track-${randomUUID()}`;
  let at = destination === "library" ? 0 : destination.at;
  for (const [index, sourcePath] of paths.entries()) {
    if (options.abandoned()) throw new Error("The world closed during import");
    if (sourcePath === null) { failures.push({ index, reason: "This drop has no local file; save it to disk and import again" }); continue; }
    try {
      if (kindForFile(sourcePath) !== "audio") throw new Error("Choose a supported audio file for Audio Studio");
      let result = await fileArtifact(store, { sourcePath, production: target.productionId, ...options });
      if (result.outcome === "needs-consent" && options.confirmLarge && await options.confirmLarge({ name: basename(sourcePath), sizeBytes: result.sizeBytes })) {
        if (options.abandoned()) throw new Error("The world closed during import");
        result = await fileArtifact(store, { sourcePath, production: target.productionId, ...options, allowLarge: true });
      }
      if (result.outcome !== "filed" && result.outcome !== "deduplicated") throw new Error(result.reason);
      const source = await audioStudioSource(store, target.productionId, `artifacts/${result.artifact.file}`, options);
      if (destination === "library") continue;
      if (commands.length === 0 && destination.trackId === null) commands.push({ kind: "add-track", track: { id: trackId!, name: "Audio", gainDb: 0, muted: false } });
      commands.push({ kind: "add-clip", clip: { id: `clip-${randomUUID()}`, trackId: trackId!, label: source.label, role: "sfx", source,
        sourceIn: 0, sourceOut: source.samples, placement: { kind: "fixed", at }, gainDb: 0, pan: 0, fadeIn: 0, fadeOut: 0,
        loop: false, loopFade: 0, duckDb: 0, protected: false, repeated: false } });
      at += source.samples; placed.push(index);
    } catch (error) { failures.push({ index, reason: `${basename(sourcePath)}: ${error instanceof Error ? error.message : String(error)}` }); }
  }
  if (options.abandoned()) throw new Error("The world closed during import");
  if (commands.length) try {
    await editAudioStudio(store, target.productionId, chapter.id, target.base, { kind: "commands", label: "Import audio to timeline", commands }, options);
  } catch (error) {
    for (const index of placed) failures.push({ index, reason: `Saved to Library; placement was not applied: ${error instanceof Error ? error.message : String(error)}. Use Library → Add to place the file.` });
  }
  return failures;
}
