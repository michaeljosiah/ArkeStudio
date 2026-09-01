import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ProductionTimelineSchema,
  TimelineOperationRefused,
  applyTimelineCommands,
  describeTimelineCommand,
  historySelectionChanges,
  redoTimelineHistory,
  seedStoryPictureTimeline,
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

function sameSelection(a: ShotSelection | null | undefined, b: ShotSelection | null | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
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

/** Materialise or update one production timeline under the world's existing atomic write gate. */
export async function applyTimelineCommand(
  store: WorldStore,
  productionId: string,
  write: TimelineWrite,
): Promise<void> {
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

  await store.gateOp(async () => {
    const production = store.getBundle().productions.find((candidate) => candidate.meta.id === productionId);
    if (!production) throw new TimelineCommandRefused(`production ${productionId} is not in this world`);
    if (production.spine) {
      throw new TimelineCommandRefused("music-timed timeline editing is not in this first Picture slice");
    }

    const raw = await readOptional(store, timelinePath);

    let current: ProductionTimeline;
    if (raw === null) {
      if (command.kind !== "commands" || command.baseRevision !== null) {
        throw new TimelineCommandRefused("the timeline has not been materialised yet");
      }
      const fingerprint = storyTimelineFingerprint(production);
      if (fingerprint !== command.sourceFingerprint) {
        throw new TimelineCommandRefused("the story order changed while this move was being made");
      }
      current = seedStoryPictureTimeline(production);
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

    const files: CommitFileInput[] = [];
    let next: ProductionTimeline;
    try {
      if (command.kind === "commands") {
        const switches = command.commands.filter(
          (candidate): candidate is Extract<TimelineCommand, { kind: "switch-take" }> => candidate.kind === "switch-take",
        );
        const clipCommands = command.commands.filter(
          (candidate): candidate is TimelineClipCommand => candidate.kind !== "switch-take",
        );
        let selectionChanges: TimelineSelectionChange[] = [];
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
          files.push(
            fileFor(reviewsPath, reviewsRaw, (reviewsRaw ?? "") + planned.decisions.map((decision) => JSON.stringify(decision)).join("\n") + "\n"),
            fileFor(selectionsPath, selectionsRaw, JSON.stringify(planned.selections, null, 2) + "\n"),
          );
        }
        const label =
          command.label ??
          (command.commands.length === 1 ? describeTimelineCommand(command.commands[0]!) : `${command.commands.length} edits`);
        next = applyTimelineCommands(current, clipCommands, {
          label,
          selections: selectionChanges,
          ...(command.requestId !== undefined ? { requestId: command.requestId } : {}),
        });
      } else {
        const entry = current.history[command.kind].at(-1);
        if (entry === undefined) throw new TimelineCommandRefused(`timeline has nothing to ${command.kind}`);
        next = command.kind === "undo" ? undoTimelineHistory(current) : redoTimelineHistory(current);
        // The selection half of a take switch travels with the entry; the review line it appended
        // stays exactly where it is (R-17), which is why nothing here reads reviews.jsonl.
        const changes = historySelectionChanges(entry, command.kind);
        if (changes.length > 0) {
          const selectionsRaw = await readOptional(store, selectionsPath);
          const selections = applySelectionChanges(JSON.parse(selectionsRaw ?? "{}") as Selections, changes);
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
      files: [fileFor(timelinePath, raw, `${JSON.stringify(next, null, 2)}\n`), ...files],
    });
  });
}
