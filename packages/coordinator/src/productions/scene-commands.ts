import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  clearBoardOverride,
  deleteShot,
  duplicateShot,
  editShot,
  insertShot,
  moveShot,
  nextShotIdIn,
  orderedShots,
  SceneOperationRefused,
  setBoardOverride,
  shotDeleteBlockers,
  type GraphScene,
  type SceneRecord,
  type Shot,
  type ShotAnchor,
} from "@arke-studio/contracts";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import { sha256 } from "../world/text-files.js";
import { parseSceneRecord } from "./scene-record.js";
import type { CommitFileInput } from "../world/commit.js";
import type { WorldStore } from "./../world/store.js";

/**
 * The one way a scene's structure changes (SPEC-029 R-36, R-61, R-62).
 *
 * `saveScene` writes a whole document and works out the difference; that is how a migration
 * behaves, and it is why a structural edit could not say what happened. These commands each name
 * ONE change, carry the scene version they were composed against, and commit exactly one
 * validated record — or write nothing at all.
 *
 * The layering is deliberate: `scene-operations.ts` in contracts owns the graph (pure, no disk,
 * refuses by name), and this file owns everything the graph cannot see — which version is on
 * disk, what a deletion would strand, and the selection that must go in the same commit as the
 * shot it belonged to.
 */

export type SceneCommand =
  | { kind: "insert-shot"; at: ShotAnchor; shot: Omit<Shot, "id" | "number"> }
  | { kind: "move-shot"; shotId: string; to: ShotAnchor }
  | { kind: "duplicate-shot"; shotId: string }
  | { kind: "edit-shot"; shotId: string; change: Partial<Shot> }
  | { kind: "delete-shot"; shotId: string }
  | { kind: "set-board-override"; shotId: string; override: "split" | "merge" }
  | { kind: "clear-board-override"; shotId: string; override: "split" | "merge" };

/** A refusal that names what stands in the way, never a code (R-39, R-59). */
export class SceneCommandRefused extends Error {
  constructor(readonly reasons: string[]) {
    super(reasons.join(" · "));
    this.name = "SceneCommandRefused";
  }
}

/** The scene moved under the command; it is refused against the version, never merged (R-62). */
export class SceneVersionMoved extends Error {
  constructor(
    readonly expected: number,
    readonly found: number,
  ) {
    super(
      `the scene moved from v${expected} to v${found} while this edit was being made — it was not overwritten`,
    );
    this.name = "SceneVersionMoved";
  }
}

/**
 * What the command needs that only the coordinator can answer.
 *
 * `activePlans` names the nonterminal dispatch plans for this production. It is injected rather
 * than read here because plan status is FOLDED from the journal joined with live queue facts
 * (SPEC-024 R-10) — there is no stored status to consult, and reaching for the queue from a
 * write path would put the whole dispatcher behind every scene edit. A caller that supplies
 * nothing gets no plan blocker, which is right for the callers that have no queue at all.
 */
export interface SceneCommandDeps {
  activePlans?: (productionId: string) => Promise<Array<{ planId: string; sceneId: string; status: string }>>;
}

export interface SceneCommandInput {
  productionId: string;
  /** A file stem, never a path — the same rule `save-scene` follows, for the same reason. */
  sceneFile: string;
  /** The version the caller composed against. Refused if the file has moved past it (R-62). */
  baseVersion: number;
  command: SceneCommand;
}

/**
 * Apply one command: read, check the version, construct, validate, commit once (R-61).
 *
 * Every failure path here leaves the world byte-identical. Nothing is written before the
 * candidate has been built and validated in full, and the deletion blockers are derived before
 * any of that — so a refusal costs a read and nothing else: no version, no selection cleanup,
 * no schema raise, no plan, no job, no spend.
 */
export async function applySceneCommand(
  store: WorldStore,
  input: SceneCommandInput,
  deps: SceneCommandDeps = {},
): Promise<void> {
  const stem = stemOrThrow(input.sceneFile);
  const path = `productions/${input.productionId}/scenes/${stem}.json`;
  const raw = await readFile(toExtendedLength(join(store.dir, fromPortable(path))), "utf8");
  const record = parseSceneRecord(raw);

  if (record.version !== input.baseVersion) {
    throw new SceneVersionMoved(input.baseVersion, record.version);
  }

  const files: CommitFileInput[] = [];
  const next = await candidateFor(store, input, record, files, deps);

  files.unshift({
    path,
    action: "replace",
    content: `${JSON.stringify(next, null, 2)}\n`,
    baseHash: sha256(raw),
  });
  await store.commit({ kind: "scene-command", source: input.command.kind, files });
}

/**
 * The validated candidate, plus any file that has to land in the SAME commit as it.
 *
 * A deleted shot's selection is the case that matters: written separately, a crash between the
 * two leaves a selection keyed by a shot that no longer exists — bookkeeping about nothing,
 * which is exactly what R-39's "removes its selection in the same commit" prevents.
 */
async function candidateFor(
  store: WorldStore,
  input: SceneCommandInput,
  record: SceneRecord,
  files: CommitFileInput[],
  deps: SceneCommandDeps,
): Promise<GraphScene> {
  const command = input.command;
  switch (command.kind) {
    case "insert-shot": {
      const production = productionOrThrow(store, input.productionId);
      // Ids clear the WHOLE production, never just this scene: takes and selections key by bare
      // shot id, so a per-scene number would collide with another scene's shot 3.
      const taken = production.scenes.flatMap((scene) => orderedShots(scene).map((shot) => shot.id));
      return insertShot(record, {
        shot: { ...command.shot, id: nextShotIdIn(taken) } as Omit<Shot, "number">,
        at: command.at,
      });
    }
    case "move-shot":
      return moveShot(record, { shotId: command.shotId, to: command.to });
    case "duplicate-shot": {
      const production = productionOrThrow(store, input.productionId);
      const taken = production.scenes.flatMap((scene) => orderedShots(scene).map((shot) => shot.id));
      return duplicateShot(record, { shotId: command.shotId, newShotId: nextShotIdIn(taken) });
    }
    case "edit-shot":
      return editShot(record, { shotId: command.shotId, change: command.change });
    case "delete-shot": {
      const production = productionOrThrow(store, input.productionId);
      const blockers = shotDeleteBlockers(
        production,
        record,
        command.shotId,
        await (deps.activePlans?.(input.productionId) ?? Promise.resolve([])),
      );
      if (blockers.length > 0) throw new SceneCommandRefused(blockers);
      const next = deleteShot(record, { shotId: command.shotId });
      await appendSelectionCleanup(store, input.productionId, command.shotId, files);
      return next;
    }
    case "set-board-override":
      return setBoardOverride(record, { shotId: command.shotId, override: command.override });
    case "clear-board-override":
      return clearBoardOverride(record, { shotId: command.shotId, override: command.override });
  }
}

/**
 * The selection the deleted shot carried, dropped in the deletion's own commit.
 *
 * An accepted take is a blocker, so what is dropped here is never a decision — a trim, a pinned
 * frame, a cleared slot. Absent selections and an absent file are both ordinary: a shot nobody
 * has generated for has no row, and a production nobody has selected in has no file.
 */
async function appendSelectionCleanup(
  store: WorldStore,
  productionId: string,
  shotId: string,
  files: CommitFileInput[],
): Promise<void> {
  const path = `productions/${productionId}/selections.json`;
  let raw: string;
  try {
    raw = await readFile(toExtendedLength(join(store.dir, fromPortable(path))), "utf8");
  } catch {
    return;
  }
  const selections = JSON.parse(raw) as Record<string, unknown>;
  if (!(shotId in selections)) return;
  delete selections[shotId];
  files.push({
    path,
    action: "replace",
    content: `${JSON.stringify(selections, null, 2)}\n`,
    baseHash: sha256(raw),
  });
}

function productionOrThrow(store: WorldStore, productionId: string) {
  const production = store.getBundle().productions.find((p) => p.meta.id === productionId);
  if (!production) throw new SceneCommandRefused([`production ${productionId} is not in this world`]);
  return production;
}

function stemOrThrow(sceneFile: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sceneFile) || sceneFile === "." || sceneFile === "..") {
    throw new SceneCommandRefused([`"${sceneFile}" is not a scene file name`]);
  }
  return sceneFile;
}

export { SceneOperationRefused };
