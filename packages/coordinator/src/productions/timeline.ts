import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AUDIO_TRACK_KINDS,
  assembleSceneCommands,
  ProductionTimelineSchema,
  SelectionsSchema,
  TimelineOperationRefused,
  orderedShots,
  applyTimelineCommands,
  describeTimelineCommand,
  historySelectionChanges,
  migrateLegacyCut,
  redoTimelineHistory,
  resolveProductionArtifact,
  seedSpinePictureTimeline,
  seedFirstPictureTimeline,
  sourceLengthFramesFor,
  spineTimelineFingerprint,
  storyTimelineFingerprint,
  undoTimelineHistory,
  type ProductionBundle,
  type ProductionTimeline,
  type ReviewDecision,
  type Selections,
  type ShotSelection,
  type TimelineClipCommand,
  type TimelineClipId,
  type TimelineCommand,
  type TimelineMoveDirection,
  type TimelineSelectionChange,
} from "@arke-studio/contracts";
import { applyTakeAcceptance } from "../takes/review.js";
import { readRequestFile, requestFileInput } from "./editor-request-file.js";
import type { WorldStore } from "../world/store.js";
import type { CommitFileInput } from "../world/commit.js";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import { sha256 } from "../world/text-files.js";

/**
 * What the coordinator will do to a timeline (SPEC-037 §1.8, §1.9).
 *
 * `commands` is the general form: a batch of semantic commands, fenced by revision (or by the
 * source fingerprint when the record does not exist yet), landing as one revision and one Undo
 * entry. `move-picture` is the first slice's spelling of a one-clip batch and is kept for its
 * callers. `undo` and `redo` move one durable entry between the stacks.
 */
export type TimelineWrite =
  | {
      kind: "commands";
      commands: readonly TimelineCommand[];
      baseRevision: number | null;
      sourceFingerprint: string;
      label?: string;
      /** The accepted Arke request this batch lands (SPEC-039 R-30); recorded on the entry. */
      requestId?: string;
      /** What the batch did, in plain lines, for the entry that explains it (Arke's assembly). */
      notes?: readonly string[];
      /** Files that land in the same commit as the timeline — the request's own status change. */
      attach?: readonly CommitFileInput[];
    }
  | {
      kind: "move-picture";
      clipId: TimelineClipId;
      direction: TimelineMoveDirection;
      baseRevision: number | null;
      sourceFingerprint: string;
    }
  | { kind: "undo" | "redo"; baseRevision: number };

export class TimelineCommandRefused extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "TimelineCommandRefused";
  }
}

const missing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";

async function readOptional(store: WorldStore, path: string): Promise<string | null> {
  try {
    return await readFile(toExtendedLength(join(store.dir, fromPortable(path))), "utf8");
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

function fileFor(path: string, raw: string | null, content: string): CommitFileInput {
  return { path, action: raw === null ? "create" : "replace", content, baseHash: raw === null ? null : sha256(raw) };
}

/** Selections after `changes` are applied, writing each `after`; a null `after` clears the shot. */
function applySelectionChanges(selections: Selections, changes: readonly TimelineSelectionChange[]): Selections {
  const next: Selections = { ...selections };
  for (const change of changes) {
    if (change.after === null) delete next[change.shotId];
    else next[change.shotId] = change.after;
  }
  return next;
}

/** Key-order-independent, because a selection read from disk and one that went through the schema spell their keys differently. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameSelection(a: ShotSelection | null | undefined, b: ShotSelection | null | undefined): boolean {
  return canonical(a ?? null) === canonical(b ?? null);
}

/**
 * Run every take switch in the batch through the ordinary acceptance rules (SPEC-037 R-16),
 * collecting the review lines to append and the net selection change per shot. A continuation
 * the switch supersedes is a selection change too, so Undo restores it with the rest.
 */
function planTakeSwitches(
  production: ProductionBundle,
  artifacts: Parameters<typeof applyTakeAcceptance>[1],
  selections: Selections,
  switches: readonly Extract<TimelineCommand, { kind: "switch-take" }>[],
  now: string,
): { decisions: ReviewDecision[]; selections: Selections; changes: TimelineSelectionChange[] } {
  const decisions: ReviewDecision[] = [];
  const before = new Map<string, ShotSelection | null>();
  let current = selections;
  for (const command of switches) {
    let applied: ReturnType<typeof applyTakeAcceptance>;
    try {
      applied = applyTakeAcceptance(production, artifacts, current, {
        takeId: command.takeId,
        shotId: command.shotId,
        by: "user",
        at: now,
      });
    } catch (error) {
      throw new TimelineCommandRefused(error instanceof Error ? error.message : String(error));
    }
    decisions.push(applied.decision);
    for (const shotId of new Set([...Object.keys(current), ...Object.keys(applied.selections)])) {
      if (!before.has(shotId) && !sameSelection(current[shotId], applied.selections[shotId])) {
        before.set(shotId, current[shotId] ?? null);
      }
    }
    current = applied.selections;
  }
  const changes: TimelineSelectionChange[] = [];
  for (const [shotId, previous] of before) {
    const after = current[shotId] ?? null;
    if (!sameSelection(previous, after)) changes.push({ shotId, before: previous, after });
  }
  return { decisions, selections: current, changes };
}

/** Scene assembly plans against the same migrated track identities the write will persist. */
export async function assembleTimelineScene(store: WorldStore, productionId: string, sceneId: string,
  fence: { baseRevision: number | null; sourceFingerprint: string }): Promise<{ dropped: string[] }> {
  const production = store.getBundle().productions.find(candidate => candidate.meta.id === productionId);
  if (!production) throw new TimelineCommandRefused("This production is no longer open");
  if (production.spine !== null) throw new TimelineCommandRefused("this production is cut to a song; open it on the timeline and place its shots there");
  const scene = production.scenes.find(candidate => candidate.id === sceneId);
  if (!scene) throw new TimelineCommandRefused(`${sceneId} is not a scene of this production`);
  const artifacts = store.getBundle().artifacts;
  const seed = production.timeline?.status === "ready" ? production.timeline.timeline : seedFirstPictureTimeline(production);
  const timeline = migrateLegacyCut(seed, production, artifacts).timeline;
  const assembly = assembleSceneCommands({ production, timeline, sceneId, artifacts });
  if ("refused" in assembly) throw new TimelineCommandRefused(assembly.refused);
  return applyTimelineCommand(store, productionId, { kind: "commands", commands: assembly.commands, ...fence,
    label: `Arke assembled ${scene.title}`, notes: assembly.notes });
}

/**
 * Materialise or update one production timeline under the world's existing atomic write gate.
 *
 * Returns what the legacy `cut.json` migration could not carry, when this write was the one that
 * folded it in (SPEC-037 R-30): named placements, never a count, so the caller can say them.
 */
export async function applyTimelineCommand(
  store: WorldStore,
  productionId: string,
  write: TimelineWrite,
  validate?: (production: ProductionBundle) => Promise<void>,
): Promise<{ dropped: string[] }> {
  const timelinePath = `productions/${productionId}/timeline.json`;
  const reviewsPath = `productions/${productionId}/reviews.jsonl`;
  const selectionsPath = `productions/${productionId}/selections.json`;
  const command: TimelineWrite =
    write.kind === "move-picture"
      ? {
          kind: "commands",
          commands: [{ kind: "move-adjacent", clipId: write.clipId, direction: write.direction }],
          baseRevision: write.baseRevision,
          sourceFingerprint: write.sourceFingerprint,
        }
      : write;

  return store.gateOp(async () => {
    const production = store.getBundle().productions.find((candidate) => candidate.meta.id === productionId);
    if (!production) throw new TimelineCommandRefused(`production ${productionId} is not in this world`);

    if (!validate && command.kind === "commands" && command.commands.some(c => c.kind === "place" && c.clip.source.kind === "performance")) {
      throw new TimelineCommandRefused("Use the reviewed selected-performance placement action for exact dialogue.");
    }
    await validate?.(production);
    const raw = await readOptional(store, timelinePath);
    let dropped: string[] = [];

    let current: ProductionTimeline;
    if (raw === null) {
      if (command.kind !== "commands" || command.baseRevision !== null) {
        throw new TimelineCommandRefused("the timeline has not been materialised yet");
      }
      const spine = production.spine;
      if (spine !== null) {
        /*
         * The first music-timed assembly (SPEC-037 R-13, R-32): the anchors as they stand,
         * against the master as measured. The measurement recorded when the track was assigned
         * is the one answer to how long the song is; without it there is no first assembly.
         */
        const measured = store.getBundle().artifacts.find((artifact) => artifact.id === spine.trackArtifactId)?.mediaInfo?.durationSec ?? null;
        if (measured === null) throw new TimelineCommandRefused("measure the master track before editing a music-timed timeline");
        if (spineTimelineFingerprint(production, spine, measured) !== command.sourceFingerprint) {
          throw new TimelineCommandRefused("the spine changed while this edit was being made");
        }
        current = seedSpinePictureTimeline(production, spine, measured);
      } else {
        const fingerprint = storyTimelineFingerprint(production);
        if (fingerprint !== command.sourceFingerprint) {
          throw new TimelineCommandRefused("the story order changed while this move was being made");
        }
        // The first state is empty (decided 2026-09-02): Arke's assembly or a person's own
        // placements fill it, so the story guides the order without writing the cut itself. A
        // production already cut in `cut.json` keeps the story seed its placements anchor to.
        current = seedFirstPictureTimeline(production);
      }
    } else {
      try {
        current = ProductionTimelineSchema.parse(JSON.parse(raw));
      } catch (error) {
        throw new TimelineCommandRefused(
          `timeline.json is invalid: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (command.baseRevision !== current.revision) {
        throw new TimelineCommandRefused(
          `the timeline moved from revision ${command.baseRevision ?? "none"} to ${current.revision} while this edit was being made`,
        );
      }
    }
    /*
     * The legacy placements fold into typed tracks with the first write that reaches a record
     * that has not yet absorbed them (SPEC-037 R-30, R-31): the first materialisation, or the
     * first command against a first-slice timeline. It lands in the same commit as the command,
     * as part of the base the command applies to rather than as a history entry of its own —
     * nobody chose it, so nobody undoes it — and from then on `cut.json` has no writer.
     */
    if (current.migratedCut !== true) {
      const migrated = migrateLegacyCut(current, production, store.getBundle().artifacts);
      current = migrated.timeline;
      dropped = migrated.dropped;
    }

    const files: CommitFileInput[] = [];
    let next: ProductionTimeline;
    try {
      if (command.kind === "commands" && command.commands.length === 0) {
        /*
         * Materialise as it stands (SPEC-037 R-13): the first music-timed assembly opens on the
         * timeline before anyone edits it, so the spine stops ordering the picture from here
         * on. Against a saved record the same batch would change nothing, and says so.
         */
        if (raw !== null) throw new TimelineCommandRefused("an empty batch changes nothing");
        next = current;
      } else if (command.kind === "commands") {
        const switches = command.commands.filter(
          (candidate): candidate is Extract<TimelineCommand, { kind: "switch-take" }> => candidate.kind === "switch-take",
        );
        const clipCommands = command.commands.filter(
          (candidate): candidate is TimelineClipCommand => candidate.kind !== "switch-take",
        );
        let selectionChanges: TimelineSelectionChange[] = [];
        // Trim bounds follow the take this batch commits, not the one it replaces: a switch to a
        // shorter take and a tail trim in one batch must be judged against the shorter source.
        let boundedBy: ProductionBundle = production;
        // Accepting or trimming a take does not advance the timeline revision. Resolve a
        // detachment from selections read under this gate, never from a renderer snapshot.
        if (clipCommands.some(edit => edit.kind === "detach-audio")) {
          boundedBy = { ...production, selections: SelectionsSchema.parse(JSON.parse(await readOptional(store, selectionsPath) ?? "{}")) };
        }
        if (switches.length > 0) {
          const reviewsRaw = await readOptional(store, reviewsPath);
          const selectionsRaw = await readOptional(store, selectionsPath);
          const planned = planTakeSwitches(
            production,
            store.getBundle().artifacts,
            JSON.parse(selectionsRaw ?? "{}") as Selections,
            switches,
            store.now(),
          );
          selectionChanges = planned.changes;
          boundedBy = { ...production, selections: planned.selections };
          files.push(
            fileFor(reviewsPath, reviewsRaw, (reviewsRaw ?? "") + planned.decisions.map((decision) => JSON.stringify(decision)).join("\n") + "\n"),
            fileFor(selectionsPath, selectionsRaw, JSON.stringify(planned.selections, null, 2) + "\n"),
          );
        }
        const label =
          command.label ??
          (command.commands.length === 1 ? describeTimelineCommand(command.commands[0]!) : `${command.commands.length} edits`);
        refuseUnrenderablePlacements(clipCommands, current, boundedBy, store.getBundle().artifacts);
        refuseUnknownLibraryItems(clipCommands, boundedBy, store.getBundle().artifacts);
        next = applyTimelineCommands(current, clipCommands, {
          label,
          selections: selectionChanges,
          sourceLength: sourceLengthFramesFor(boundedBy, store.getBundle().artifacts),
          sources: { production: boundedBy, artifacts: store.getBundle().artifacts },
          ...(command.requestId !== undefined ? { requestId: command.requestId } : {}),
          ...(command.notes !== undefined ? { notes: command.notes } : {}),
        });
      } else {
        const entry = current.history[command.kind].at(-1);
        if (entry === undefined) throw new TimelineCommandRefused(`timeline has nothing to ${command.kind}`);
        next = command.kind === "undo" ? undoTimelineHistory(current) : redoTimelineHistory(current);
        /*
         * An accepted request whose revision is undone stays accepted and says so (SPEC-039
         * R-36), durably: the redo stack is transient — the next edit clears it — so the mark
         * lives on the record, in the same commit as the history move (round eight).
         */
        if (entry.kind === "change" && entry.requestId !== undefined) {
          const requestId = entry.requestId;
          const { raw: requestsRaw, file } = await readRequestFile(store, productionId);
          if (file.requests.some((request) => request.id === requestId)) {
            const marked = file.requests.map((request) => {
              if (request.id !== requestId) return request;
              if (command.kind === "undo") return { ...request, undoneAt: store.now() };
              const { undoneAt: _redone, ...rest } = request;
              return rest;
            });
            files.push(requestFileInput(productionId, requestsRaw, { ...file, requests: marked }));
          }
        }
        // The selection half of a take switch travels with the entry; the review line it appended
        // stays exactly where it is (R-17), which is why nothing here reads reviews.jsonl.
        const changes = historySelectionChanges(entry, command.kind);
        if (changes.length > 0) {
          const selectionsRaw = await readOptional(store, selectionsPath);
          const live = JSON.parse(selectionsRaw ?? "{}") as Selections;
          // The timeline revision fences the timeline; the selection has other writers
          // (accept-take, set-trim) that leave the revision alone. A switch undone over a
          // selection somebody has since changed would silently discard their choice, so each
          // shot must still read as the entry recorded it before anything is written.
          for (const change of changes) {
            if (!sameSelection(live[change.shotId], change.before)) {
              throw new TimelineCommandRefused(
                `shot ${change.shotId}'s selection changed since this take switch was made; ${command.kind} would discard that choice`,
              );
            }
          }
          const selections = applySelectionChanges(live, changes);
          files.push(fileFor(selectionsPath, selectionsRaw, JSON.stringify(selections, null, 2) + "\n"));
        }
      }
    } catch (error) {
      if (error instanceof TimelineOperationRefused) throw new TimelineCommandRefused(error.reason);
      throw error;
    }
    ProductionTimelineSchema.parse(next);

    await store.commitUnserialised({
      kind: "timeline-command",
      source: command.kind,
      // A build that does not understand timeline authority must refuse this world rather than
      // export the old derived order. The boundary lands atomically with first materialisation.
      raiseSchemaVersion: 5,
      files: [fileFor(timelinePath, raw, `${JSON.stringify(next, null, 2)}\n`), ...files, ...(command.kind === "commands" ? (command.attach ?? []) : [])],
    });
    return { dropped };
  });
}

/**
 * Refuse a placement the world could not render (round seven): a source that is not in this
 * world, or one with no picture or sound for the track it lands on. The command layer checks
 * the shape; this is the check against the bundle, run before anything is written, so a
 * timeline never commits a clip every render would then refuse whole.
 */
/**
 * A Library item names something this world has (SPEC-039 R-8): a well-formed id for a shot or
 * artifact that does not exist would persist, count against the limit and sit in Undo with no
 * row to show for it.
 */
export function refuseUnknownLibraryItems(
  commands: readonly TimelineCommand[],
  production: ProductionBundle,
  artifacts: ReadonlyArray<{ id: string; production?: string | null }>,
): void {
  const shots = new Set(production.scenes.flatMap((scene) => orderedShots(scene).map((shot) => shot.id)));
  for (const command of commands) {
    if (command.kind !== "add-to-library") continue;
    for (const item of command.items) {
      if (item.kind === "shot" && !shots.has(item.shotId)) throw new TimelineCommandRefused(`the library cannot hold ${item.shotId}: this production has no such shot`);
      if (item.kind === "artifact") {
        const resolved = resolveProductionArtifact(artifacts, item.artifactId, production.meta.id);
        if (!resolved.ok) throw new TimelineCommandRefused(`the library cannot hold ${resolved.reason}`);
      }
    }
  }
}

export function refuseUnrenderablePlacements(
  commands: readonly TimelineCommand[],
  timeline: Pick<ProductionTimeline, "tracks">,
  production: ProductionBundle,
  artifacts: ReadonlyArray<{ id: string; kind: string; file: string; production?: string | null; mediaInfo?: { hasAudio: boolean; durationSec: number } }>,
): void {
  const kinds = new Map(timeline.tracks.map((track) => [track.id, track.kind] as const));
  const takesById = new Map(production.takes.map((take) => [take.id, take] as const));
  const refuse = (reason: string): never => {
    throw new TimelineCommandRefused(reason);
  };
  for (const command of commands) {
    if (command.kind === "add-track") kinds.set(command.trackId, command.trackKind);
    if (command.kind === "add-subtitle-track") kinds.set(command.trackId, "subtitle");
    if (command.kind !== "place") continue;
    const kind = kinds.get(command.trackId);
    const audio = kind !== undefined && AUDIO_TRACK_KINDS.has(kind);
    const source = command.clip.source;
    if (source.kind === "artifact") {
      const resolved = resolveProductionArtifact(artifacts, source.artifactId, production.meta.id);
      if (!resolved.ok) throw new TimelineCommandRefused(`${command.clip.id} cites ${resolved.reason}`);
      const artifact = resolved.artifact;
      const carriesSound = artifact.kind === "audio" || (artifact.kind === "video" && artifact.mediaInfo?.hasAudio === true);
      const carriesPicture = artifact.kind === "image" || artifact.kind === "board" || artifact.kind === "video";
      if (audio && !carriesSound) refuse(`${command.clip.id} cites ${artifact.file}, which is not known to carry sound`);
      if (!audio && kind !== "subtitle" && !carriesPicture) refuse(`${command.clip.id} cites ${artifact.file}, which is ${artifact.kind} and has no picture`);
    } else if (source.kind === "take") {
      const take = takesById.get(source.takeId);
      const segment = take?.segment;
      const media = take === undefined ? undefined : segment === undefined ? take.media : takesById.get(segment.passTakeId)?.media;
      if (media === undefined) refuse(`${command.clip.id} cites take ${source.takeId}, which has no media`);
    } else if (source.kind === "performance") {
      const performance = production.performances.find(p => p.id === source.performanceId);
      if (!audio || !performance || performance.target.shotId !== source.shotId || performance.provenance.outputHash !== source.sourceHash) refuse(`${command.clip.id}: choose an existing immutable performance for this dialogue shot`);
    } else if (!production.scenes.some((scene) => orderedShots(scene).some((shot) => shot.id === source.shotId))) {
      refuse(`${command.clip.id} cites shot ${source.shotId}, which is not in the story`);
    }
  }
}

/** True once the timeline owns every placement, so a legacy `cut.json` write must refuse (R-30). */
export function placementsLiveOnTimeline(production: ProductionBundle): boolean {
  return production.timeline?.status === "ready" && production.timeline.timeline.migratedCut === true;
}
