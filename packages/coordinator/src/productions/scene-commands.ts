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

/**
 * The wire command as the operations take it: `clear` becomes the explicit `undefined` that
 * `editShot` reads as "remove this key".
 *
 * JSON cannot carry `undefined` and an omitted key means "leave it", so the transport names the
 * fields to drop instead of sending a value for them. Translating here keeps the operations
 * working in one vocabulary — a patch where present-with-undefined clears — rather than
 * teaching every one of them about a wire shape.
 */
export function sceneCommandFrom(wire: WireSceneCommand): SceneCommand {
  if (wire.kind !== "edit-shot") return wire as SceneCommand;
  const change: Record<string, unknown> = { ...wire.change };
  for (const field of wire.clear ?? []) change[field] = undefined;
  return { kind: "edit-shot", shotId: wire.shotId, change: change as Partial<Shot> };
}

/** The wire shape, structurally — the frame owns its schema; this is what reaches the command. */
type WireSceneCommand =
  | Exclude<SceneCommand, { kind: "edit-shot" }>
  | { kind: "edit-shot"; shotId: string; change: Partial<Shot>; clear?: readonly string[] };

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
  /**
   * The scene the caller composed against, by id.
   *
   * The version alone cannot tell a scene from its replacement: deleting a scene frees both its
   * id and its stem, a new scene can be drafted at the same path, and a delayed command
   * composed against v1 of the old one would pass a v1 check and land in the new one.
   */
  sceneId: string;
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

  /*
   * The fence answers first, twice, for two different reasons.
   *
   * Here, because a command composed against a scene that has since moved should say so rather
   * than report on a world it was never looking at — deriving blockers for a stale edit reads
   * the wrong scene and names the wrong reasons. Again inside the gate below, because this
   * check can go stale between here and the write, and only the one inside the lock cannot.
   */
  const opening = await readFile(toExtendedLength(join(store.dir, fromPortable(path))), "utf8");
  fenceOrThrow(input, parseSceneRecord(opening), stem);

  // Blockers are derived OUTSIDE the gate deliberately: reading plan journals is I/O with
  // nothing to do with this scene's bytes, and holding the write lock across it would put every
  // other writer behind it. Anything that could race it edits this same scene, and that is what
  // the fence inside the gate catches.
  const blockers =
    input.command.kind === "delete-shot"
      ? await deletionBlockers(store, input, input.command.shotId, deps)
      : [];
  if (blockers.length > 0) throw new SceneCommandRefused(blockers);

  /*
   * Read, mint, validate and commit inside ONE serialised region.
   *
   * Shot ids are unique per production, not per scene, and minting one means looking at every
   * scene. Two inserts into DIFFERENT scenes therefore read the same snapshot, mint the same
   * id, and both commit cleanly — their base hashes never collide, because they replace
   * different files. The result is two shots with one id, and selections and takes keyed by the
   * bare id then alias the wrong one. The gate is what makes the read and the write one act.
   */
  await store.gateOp(async () => {
    const raw = await readFile(toExtendedLength(join(store.dir, fromPortable(path))), "utf8");
    const record = parseSceneRecord(raw);
    fenceOrThrow(input, record, stem);

    const files: CommitFileInput[] = [];
    const next = await candidateFor(store, input, record, files);

    files.unshift({
      path,
      action: "replace",
      content: `${JSON.stringify(next, null, 2)}\n`,
      baseHash: sha256(raw),
    });
    await store.commitUnserialised({ kind: "scene-command", source: input.command.kind, files });
  });
}

/**
 * Is this the scene the command was composed against, as it was composed against it?
 *
 * The id first, because the version alone cannot tell a scene from its replacement: deleting a
 * scene frees both its id and its stem, a new scene can be drafted at the same path, and a
 * delayed command composed against v1 of the old one would sail through a version check and
 * land in the new one.
 */
function fenceOrThrow(input: SceneCommandInput, record: SceneRecord, stem: string): void {
  if (record.id !== input.sceneId) {
    throw new SceneCommandRefused([
      `${stem}.json holds scene ${record.id}, not ${input.sceneId} — this edit was composed against a different scene`,
    ]);
  }
  if (record.version !== input.baseVersion) {
    throw new SceneVersionMoved(input.baseVersion, record.version);
  }
}

/**
 * What a deletion would strand (R-39), refusing rather than guessing when it cannot be read.
 *
 * An unreadable plan journal is not "no active plans": it is the coordinator being unable to
 * prove the deletion is safe, which is exactly when it must not proceed. "I could not look"
 * belongs on the blocker list beside the blockers themselves.
 */
async function deletionBlockers(
  store: WorldStore,
  input: SceneCommandInput,
  shotId: string,
  deps: SceneCommandDeps,
): Promise<string[]> {
  const production = store.getBundle().productions.find((p) => p.meta.id === input.productionId);
  if (!production) return [`production ${input.productionId} is not in this world`];
  const scene = production.scenes.find((candidate) => candidate.id === input.sceneId);
  if (!scene) return [`scene ${input.sceneId} is not in ${input.productionId}`];
  let plans: Array<{ planId: string; sceneId: string; status: string }>;
  try {
    plans = (await deps.activePlans?.(input.productionId)) ?? [];
  } catch (error) {
    return [
      `the dispatch plans for this production could not be read, so a running one cannot be ruled out: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ];
  }
  return shotDeleteBlockers(production, scene, shotId, plans);
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
      // The live-dependency blockers were derived before the gate opened; what is left is the
      // graph's own refusal and the selection that must ride this commit.
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
  } catch (error) {
    // Only "there is no file" is ordinary — a production nobody has selected in has none. Any
    // other read failure means the file may hold a selection for this shot that this commit
    // would then fail to remove, so the deletion is refused rather than left half-done.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new SceneCommandRefused([
      `the selections for ${productionId} could not be read, so this shot's selection cannot be removed with it: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ]);
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
