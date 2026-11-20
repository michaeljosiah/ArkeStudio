import {
  AudioSpineOperationRefused,
  ProductionSpineSchema,
  anchorProblems,
  applyAudioSpineCommand,
  newId,
  orderedShots,
  sceneSectionMarkers,
  songTime,
  type AudioSpineCommand,
  type AudioSpineModelAction,
  type ProductionSpine,
  type SpineAnchor,
  type SpineMarker,
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

/**
 * One command applied to a spine as its production stands. The scenes are read here, where they
 * are: `mark-sections-from-scenes` carries no markers, so a caller that applied it without them
 * would be refused for having no scenes with a place in the song, whatever the scenes say.
 */
export function applySpineCommand(
  production: Pick<WorldBundle["productions"][number], "scenes"> | undefined,
  current: ProductionSpine | null,
  command: AudioSpineCommand,
  at: string,
): ProductionSpine | null {
  return applyAudioSpineCommand(current, command, at,
    command.kind === "mark-sections-from-scenes" ? sceneSectionMarkers(production?.scenes ?? [], () => newId("mk")) : []);
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
    if (action.baseRevision !== null) throw new AudioSpineCommandRefused("creating an audio spine needs baseRevision null");
  } else if (current === null) {
    throw new AudioSpineCommandRefused("the production has no audio spine yet: create it first, with baseRevision null");
  } else if (action.baseRevision !== current.revision) {
    throw new AudioSpineCommandRefused(`the audio spine moved from revision ${action.baseRevision ?? "none"} to ${current.revision}`);
  }

  let next: ProductionSpine | null;
  try {
    next = applySpineCommand(production, current, action.command, at);
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
  // A scene's section is named as the scene is: its marker id was minted a moment ago and names nothing a person has seen.
  if (late !== undefined && action.command.kind === "mark-sections-from-scenes" && late.kind === "section") {
    throw new AudioSpineCommandRefused(`${late.label} starts at ${songTime(late.atSec)}, past the song's ${songTime(Math.floor(durationSec))}`);
  }
  if (late !== undefined) throw new AudioSpineCommandRefused(`marker ${late.id} at ${late.atSec}s is past the track's ${durationSec}s`);
  const shotIds = new Set(production.scenes.flatMap((scene) => orderedShots(scene).map((shot) => shot.id)));
  const problem = anchorProblems(next, durationSec, shotIds)[0];
  if (problem !== undefined) throw new AudioSpineCommandRefused(`${problem.shotId} ${problem.detail}`);
  return { current, next, durationSec };
}

// The song's clock is the contracts' now, so a scene's window on the page reads as its card does.
export { songTime };

function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * The words a spine card uses (issue 3092): the song by its file name and length, a shot by its
 * number and scene, a marker by what it says. The card was written in the authority's words —
 * "Create the audio spine with ar_01M7E6…", "227.639979s measured audio", a marker as its JSON —
 * and a person approving it could not tell which song, or which part of it, they were agreeing to.
 */
function spineWords(bundle: WorldBundle, productionId: string) {
  const production = bundle.productions.find((candidate) => candidate.meta.id === productionId);
  const file = (artifactId: string) => bundle.artifacts.find((artifact) => artifact.id === artifactId)?.file.split(/[\\/]/).at(-1) ?? artifactId;
  const shot = (shotId: string) => {
    for (const scene of production?.scenes ?? []) {
      const found = orderedShots(scene).find((candidate) => candidate.id === shotId);
      if (found !== undefined) return `shot ${found.number} of ${scene.title}`;
    }
    return shotId;
  };
  // Several shots as a count, with their scene when they share one: "4 shots of Intro". Each is
  // named on its own row below the title, so the title only has to say how many and where.
  const shots = (shotIds: readonly string[]) => {
    if (shotIds.length === 1) return shot(shotIds[0]!);
    const scenes = new Set(shotIds.map((shotId) =>
      production?.scenes.find((scene) => orderedShots(scene).some((candidate) => candidate.id === shotId)) ?? null));
    const [only] = [...scenes];
    return `${shotIds.length} shots${scenes.size === 1 && only ? ` of ${only.title}` : ""}`;
  };
  const marker = (one: SpineMarker) => one.kind === "section" ? one.label : `“${one.text}”`;
  const markerAt = (one: SpineMarker) => `${one.kind} at ${songTime(one.atSec)}`;
  const anchor = (one: SpineAnchor) => `${songTime(one.startSec)}–${songTime(one.endSec)}${
    one.clipAudio.mode === "keep-diegetic" ? ` · own sound at ${one.clipAudio.gainDb} dB` : ""}`;
  return { file, shot, shots, marker, markerAt, anchor };
}

function spineTitle(
  command: AudioSpineCommand,
  current: ProductionSpine | null,
  next: ProductionSpine | null,
  durationSec: number | null,
  words: ReturnType<typeof spineWords>,
): string {
  const onSpine = (markerId: string) => current?.markers.find((one) => one.id === markerId);
  switch (command.kind) {
    case "create":
    case "assign-track":
      // Whole seconds, as a player shows a song's length: 227.64s is 3:47, never 3:48.
      return `Use ${words.file(command.trackArtifactId)} as the song${durationSec === null ? "" : ` · ${songTime(Math.floor(durationSec))}`}`;
    case "add-marker":
      return `Mark ${words.marker(command.marker)} at ${songTime(command.marker.atSec)}`;
    case "import-markers": {
      const sections = command.markers.filter((one) => one.kind === "section").length;
      const lyrics = command.markers.length - sections;
      const parts = [...(sections > 0 ? [counted(sections, "section")] : []), ...(lyrics > 0 ? [counted(lyrics, "lyric")] : [])];
      return parts.length === 0 ? (command.format === "lrc" ? "Clear the song's lyrics" : "Clear the song's marks") : `Mark ${parts.join(" and ")}`;
    }
    case "edit-marker": {
      const marker = onSpine(command.markerId);
      return `Change ${marker === undefined ? command.markerId : words.marker(marker)}`;
    }
    case "delete-marker": {
      const marker = onSpine(command.markerId);
      return `Remove ${marker === undefined ? command.markerId : words.marker(marker)}`;
    }
    case "set-anchor":
      return `Pin ${words.shot(command.shotId)} to ${words.anchor(command.anchor)}`;
    case "set-anchor-audio":
      return command.clipAudio.mode === "mute"
        ? `Mute ${words.shot(command.shotId)}'s own sound`
        : `Keep ${words.shot(command.shotId)}'s own sound at ${command.clipAudio.gainDb} dB`;
    case "delete-anchor":
      return `Unpin ${words.shot(command.shotId)}`;
    case "delete-anchors":
      return `Unpin ${words.shots(command.shotIds)}`;
    case "mark-sections-from-scenes":
      // The words the Cut's own press uses, with the count the scenes give now.
      return `Mark ${counted((next?.markers.length ?? 0) - (current?.markers.length ?? 0), "section")} from the scenes`;
    case "delete-spine":
      return "Remove the song";
  }
}

function spineConsequence(command: AudioSpineCommand): string {
  switch (command.kind) {
    case "create": return "The Cut plays to this song.";
    case "assign-track": return "The Cut plays to this song. Marks and pinned shots keep their times.";
    case "add-marker":
    case "import-markers":
    case "edit-marker":
    case "delete-marker": return "Changes the song's sections and lyrics.";
    case "mark-sections-from-scenes": return "Each scene's place in the song becomes a section. Shots stay where they are pinned.";
    case "set-anchor":
    case "set-anchor-audio":
    case "delete-anchor":
    case "delete-anchors": return "Changes where shots sit in the song.";
    case "delete-spine": return "Removes the song, its marks and every pinned shot.";
  }
}

export interface AudioSpineCommandPreview {
  readonly title: string;
  readonly consequence: string;
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
  const words = spineWords(bundle, action.productionId);
  const commands: Array<{ label: string; detail?: string }> = [];
  if (current === null && next !== null) {
    commands.push({ label: `Use ${words.file(next.trackArtifactId)} as the song`, ...(durationSec === null ? {} : { detail: songTime(Math.floor(durationSec)) }) });
  } else if (current !== null && next === null) {
    const sections = current.markers.filter((one) => one.kind === "section").length;
    const pinned = Object.keys(current.anchors).length;
    commands.push({ label: `Remove ${words.file(current.trackArtifactId)}`, detail: [counted(sections, "section"),
      counted(current.markers.length - sections, "lyric"), counted(pinned, "pinned shot")].join(" · ") });
  } else if (current !== null && next !== null) {
    if (current.trackArtifactId !== next.trackArtifactId) {
      commands.push({ label: `Use ${words.file(next.trackArtifactId)} as the song`,
        detail: `${durationSec === null ? "" : `${songTime(Math.floor(durationSec))} · `}was ${words.file(current.trackArtifactId)}` });
    }
    const beforeMarkers = new Map(current.markers.map((marker) => [marker.id, marker]));
    const afterMarkers = new Map(next.markers.map((marker) => [marker.id, marker]));
    for (const id of new Set([...beforeMarkers.keys(), ...afterMarkers.keys()])) {
      const before = beforeMarkers.get(id);
      const after = afterMarkers.get(id);
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      if (before === undefined) commands.push({ label: words.marker(after!), detail: words.markerAt(after!) });
      else if (after === undefined) commands.push({ label: `Remove ${words.marker(before)}`, detail: words.markerAt(before) });
      else commands.push({ label: `Change ${words.marker(before)}`, detail: `${words.marker(before)} at ${songTime(before.atSec)} → ${words.marker(after)} at ${songTime(after.atSec)}` });
    }
    for (const shotId of new Set([...Object.keys(current.anchors), ...Object.keys(next.anchors)])) {
      const before = current.anchors[shotId];
      const after = next.anchors[shotId];
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      if (before === undefined) commands.push({ label: `Pin ${words.shot(shotId)}`, detail: words.anchor(after!) });
      else if (after === undefined) commands.push({ label: `Unpin ${words.shot(shotId)}`, detail: `was ${words.anchor(before)}` });
      else commands.push({ label: `Change ${words.shot(shotId)}`, detail: `${words.anchor(before)} → ${words.anchor(after)}` });
    }
  }
  if (commands.length === 0) throw new AudioSpineCommandRefused("the command changes nothing");
  return {
    title: spineTitle(action.command, current, next, durationSec, words),
    consequence: spineConsequence(action.command),
    authorityRevision: current?.revision ?? 0,
    commands,
    expectedResult: next === null ? "The production has no song." : `Saved as revision ${next.revision} of the song.`,
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
