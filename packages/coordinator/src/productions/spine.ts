import {
  AudioSpineOperationRefused,
  ProductionSpineSchema,
  anchorProblems,
  applyAudioSpineCommand,
  describeAudioSpineCommand,
  orderedShots,
  type AudioSpineModelAction,
  type ProductionSpine,
  type WorldBundle,
} from "@arke-studio/contracts";
import type { CommitResult } from "../world/commit.js";
import type { WorldStatePrecondition, WorldStore } from "../world/store.js";
import { toExtendedLength } from "../world/paths.js";
import { sha256 } from "../world/text-files.js";

export class AudioSpineCommandRefused extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "AudioSpineCommandRefused";
  }
}

function visibleToProduction(artifact: { production?: string }, productionId: string): boolean {
  return artifact.production === undefined || artifact.production === productionId;
}

function validatedNext(
  bundle: WorldBundle,
  action: Pick<AudioSpineModelAction, "productionId" | "baseRevision" | "command">,
  at: string,
): { current: ProductionSpine | null; next: ProductionSpine | null; durationSec: number | null } {
  const production = bundle.productions.find((candidate) => candidate.meta.id === action.productionId);
  if (production === undefined) throw new AudioSpineCommandRefused(`production ${action.productionId} is not in this world`);
  const current = production.spine;
  if (action.command.kind === "create") {
    if (action.baseRevision !== null) throw new AudioSpineCommandRefused("creating an audio spine requires a null base revision");
  } else if (current === null) {
    throw new AudioSpineCommandRefused("the production has no audio spine");
  } else if (action.baseRevision !== current.revision) {
    throw new AudioSpineCommandRefused(`the audio spine moved from revision ${action.baseRevision ?? "none"} to ${current.revision}`);
  }

  let next: ProductionSpine | null;
  try {
    next = applyAudioSpineCommand(current, action.command, at);
  } catch (error) {
    if (error instanceof AudioSpineOperationRefused) throw new AudioSpineCommandRefused(error.reason);
    throw error;
  }
  if (next === null) return { current, next, durationSec: null };

  const artifact = bundle.artifacts.find((candidate) => candidate.id === next!.trackArtifactId);
  if (artifact === undefined || !visibleToProduction(artifact, action.productionId)) {
    throw new AudioSpineCommandRefused(`master track ${next.trackArtifactId} is not available to this production`);
  }
  const carriesSound = artifact.kind === "audio" || (artifact.kind === "video" && artifact.mediaInfo?.hasAudio === true);
  if (!carriesSound) throw new AudioSpineCommandRefused(`artifact ${artifact.id} is not known to carry sound`);
  const durationSec = artifact.mediaInfo?.durationSec;
  if (durationSec === undefined) throw new AudioSpineCommandRefused(`master track ${artifact.id} has not been measured`);

  const late = next.markers.find((marker) => marker.atSec > durationSec);
  if (late !== undefined) throw new AudioSpineCommandRefused(`marker ${late.id} at ${late.atSec}s is past the track's ${durationSec}s`);
  const shotIds = new Set(production.scenes.flatMap((scene) => orderedShots(scene).map((shot) => shot.id)));
  const problem = anchorProblems(next, durationSec, shotIds)[0];
  if (problem !== undefined) throw new AudioSpineCommandRefused(`${problem.shotId} ${problem.detail}`);
  return { current, next, durationSec };
}

function clipped(value: unknown): string {
  const shown = JSON.stringify(value);
  return shown.length <= 4_000 ? shown : `${shown.slice(0, 3_999)}...`;
}

export interface AudioSpineCommandPreview {
  readonly title: string;
  readonly authorityRevision: number;
  readonly commands: Array<{ label: string; detail?: string }>;
  readonly expectedResult: string;
  readonly next: ProductionSpine | null;
}

/** The exact net authored effects used by both initial preparation and preview revalidation. */
export function previewAudioSpineCommand(
  bundle: WorldBundle,
  action: Pick<AudioSpineModelAction, "productionId" | "baseRevision" | "command">,
  at: string,
): AudioSpineCommandPreview {
  const { current, next, durationSec } = validatedNext(bundle, action, at);
  const commands: Array<{ label: string; detail?: string }> = [];
  if (current === null && next !== null) {
    commands.push({ label: `Assign master track ${next.trackArtifactId}`, detail: `${durationSec}s measured audio` });
  } else if (current !== null && next === null) {
    commands.push({ label: "Delete the audio spine", detail: `Revision ${current.revision}, ${current.markers.length} markers, ${Object.keys(current.anchors).length} anchors` });
  } else if (current !== null && next !== null) {
    if (current.trackArtifactId !== next.trackArtifactId) {
      commands.push({ label: "Change master track", detail: `${current.trackArtifactId} -> ${next.trackArtifactId} (${durationSec}s)` });
    }
    const beforeMarkers = new Map(current.markers.map((marker) => [marker.id, marker]));
    const afterMarkers = new Map(next.markers.map((marker) => [marker.id, marker]));
    for (const id of new Set([...beforeMarkers.keys(), ...afterMarkers.keys()])) {
      const before = beforeMarkers.get(id);
      const after = afterMarkers.get(id);
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      commands.push({
        label: `${before === undefined ? "Add" : after === undefined ? "Remove" : "Change"} marker ${id}`,
        detail: `${before === undefined ? "not present" : clipped(before)} -> ${after === undefined ? "not present" : clipped(after)}`,
      });
    }
    for (const shotId of new Set([...Object.keys(current.anchors), ...Object.keys(next.anchors)])) {
      const before = current.anchors[shotId];
      const after = next.anchors[shotId];
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      commands.push({
        label: `${before === undefined ? "Add" : after === undefined ? "Remove" : "Change"} anchor ${shotId}`,
        detail: `${before === undefined ? "not present" : clipped(before)} -> ${after === undefined ? "not present" : clipped(after)}`,
      });
    }
  }
  if (commands.length === 0) throw new AudioSpineCommandRefused("the command changes nothing");
  return {
    title: describeAudioSpineCommand(action.command),
    authorityRevision: current?.revision ?? 0,
    commands,
    expectedResult: next === null ? "The production no longer has an audio spine." : `The audio spine advances to revision ${next.revision}.`,
    next,
  };
}

export async function applyProductionSpineCommand(
  store: WorldStore,
  action: Pick<AudioSpineModelAction, "productionId" | "baseRevision" | "command">,
  options: { source: string; requestId?: string; precondition?: WorldStatePrecondition },
): Promise<{ commit: CommitResult; spine: ProductionSpine | null }> {
  return store.gateOp(async () => {
    const path = `productions/${action.productionId}/spine.json`;
    const raw = await readFile(
      toExtendedLength(join(store.dir, "productions", action.productionId, "spine.json")),
      "utf8",
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    let disk: ProductionSpine | null = null;
    if (raw !== null) {
      try {
        disk = ProductionSpineSchema.parse(JSON.parse(raw));
      } catch (error) {
        throw new AudioSpineCommandRefused(`spine.json is invalid: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const scanned = store.getBundle().productions.find((candidate) => candidate.meta.id === action.productionId)?.spine ?? null;
    if (JSON.stringify(disk) !== JSON.stringify(scanned)) throw new AudioSpineCommandRefused("the audio spine changed while this command was being prepared");
    const { next } = validatedNext(store.getBundle(), action, store.now());
    const commit = await store.commitUnserialised({
      kind: "audio-spine-command",
      source: options.source,
      ...(options.requestId ? { requestId: options.requestId } : {}),
      files: [{
        path,
        action: next === null ? "delete" : raw === null ? "create" : "replace",
        ...(next === null ? {} : { content: `${JSON.stringify(next, null, 2)}\n` }),
        baseHash: raw === null ? null : sha256(raw),
      }],
    });
    return { commit, spine: next };
  }, options.precondition);
}
import { readFile } from "node:fs/promises";
import { join } from "node:path";
