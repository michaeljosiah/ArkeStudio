import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  clearBoardOverride,
  clearBoardPrompt,
  deleteShot,
  duplicateShot,
  editScene,
  editShot,
  insertShot,
  moveShot,
  moveBoardBoundary,
  nextShotIdIn,
  orderedShots,
  parseMentions,
  SceneOperationRefused,
  setBoardOverride,
  setBoardPrompt,
  shotDeleteBlockers,
  stagingRetimed,
  type GraphScene,
  type SceneRecord,
  type SceneBlocking,
  type Shot,
  type ShotAnchor,
  type ShotStageEdit,
} from "@arke-studio/contracts";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import { sha256 } from "../world/text-files.js";
import { parseSceneRecord } from "./scene-record.js";
import type { CommitFileInput } from "../world/commit.js";
import type { WorldStore } from "./../world/store.js";

/**
 * The one way a scene's structure changes (SPEC-029 R-36, R-61, R-62).
 *
 * These commands each name ONE change, carry the scene version they were composed against, and commit exactly one
 * validated record — or write nothing at all.
 *
 * The layering is deliberate: `scene-operations.ts` in contracts owns the graph (pure, no disk,
 * refuses by name), and this file owns everything the graph cannot see — which version is on
 * disk, what a deletion would strand, and the selection that must go in the same commit as the
 * shot it belonged to.
 */

export type SceneCommand =
  | { kind: "edit-scene"; title?: string; synopsis?: string | null }
  | { kind: "edit-stage"; shotId: string; blocking?: Omit<SceneBlocking, "version"> | null; staging?: ShotStageEdit | null }
  | { kind: "insert-shot"; at: ShotAnchor; shot: Omit<Shot, "id" | "number"> }
  | { kind: "move-shot"; shotId: string; to: ShotAnchor }
  | { kind: "duplicate-shot"; shotId: string }
  | { kind: "edit-shot"; shotId: string; change: Partial<Omit<Shot, "id" | "number" | "staging">> }
  | { kind: "set-prompt-override"; shotId: string; text: string | null }
  | { kind: "delete-shot"; shotId: string }
  | { kind: "set-board-override"; shotId: string; override: "split" | "merge" }
  | { kind: "clear-board-override"; shotId: string; override: "split" | "merge" }
  | { kind: "move-board-boundary"; fromShotId: string; toShotId: string }
  | { kind: "set-board-prompt"; members: string[]; text: string }
  | { kind: "clear-board-prompt"; members: string[] };

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
  return {
    kind: "edit-shot",
    shotId: wire.shotId,
    change: change as Partial<Omit<Shot, "id" | "number" | "staging">>,
  };
}

/** The wire shape, structurally — the frame owns its schema; this is what reaches the command. */
type WireSceneCommand =
  | Exclude<SceneCommand, { kind: "edit-shot" }>
  | { kind: "edit-shot"; shotId: string; change: Partial<Omit<Shot, "id" | "number" | "staging">>; clear?: readonly string[] };

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
  /** A file stem, never a path. */
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
 * Every failure path leaves the world byte-identical: nothing is written before the candidate
 * has been built and validated in full, so a refusal costs reads and nothing else — no version,
 * no selection cleanup, no schema raise, no plan, no job, no spend.
 */
export async function applySceneCommand(
  store: WorldStore,
  input: SceneCommandInput,
  deps: SceneCommandDeps = {},
): Promise<void> {
  const stem = stemOrThrow(input.sceneFile);
  const path = `productions/${input.productionId}/scenes/${stem}.json`;

  /*
   * A cheap first look, so a command composed against a scene that has since moved says so
   * rather than reporting on a world it was never looking at. The authoritative fence is the
   * one inside the gate; this one only saves the work.
   */
  const opening = await readFile(toExtendedLength(join(store.dir, fromPortable(path))), "utf8");
  fenceOrThrow(input, parseSceneRecord(opening), stem);

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

    /*
     * Blockers are derived INSIDE the gate, immediately before the commit is built.
     *
     * The version fence cannot stand in for them: accepting a take does not touch the scene's
     * version, so an accept landing between an out-of-gate check and this write would sail
     * through the fence — and the deletion would then remove the selection that accept had just
     * written, leaving paid footage with no shot to belong to. Reading a plan journal under the
     * lock costs a little; orphaning footage is not a thing to be a little fast about.
     */
    if (input.command.kind === "delete-shot") {
      const blockers = await deletionBlockers(store, input, input.command.shotId, deps);
      if (blockers.length > 0) throw new SceneCommandRefused(blockers);
    }

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
    case "edit-scene": {
      // A command that names nothing is refused rather than committed as a version cut over
      // an unchanged record — the schema cannot say "at least one", so this is where it is said.
      if (command.title === undefined && command.synopsis === undefined) {
        throw new SceneCommandRefused(["this edit names neither a title nor a synopsis"]);
      }
      return editScene(record, {
        ...(command.title !== undefined ? { title: command.title } : {}),
        // Null on the wire is the clear; the operation reads present-with-undefined as the clear.
        ...(command.synopsis !== undefined ? { synopsis: command.synopsis ?? undefined } : {}),
      });
    }
    case "edit-stage": {
      if (command.blocking === undefined && command.staging === undefined) {
        throw new SceneCommandRefused(["this Stage edit names neither blocking nor a camera"]);
      }
      const current = orderedShots(record).find((shot) => shot.id === command.shotId);
      if (current === undefined) {
        throw new SceneOperationRefused([`shot ${command.shotId} is not in this scene`]);
      }
      let next = editScene(record, {});
      if (command.blocking !== undefined) {
        next = editScene(next, {
          blocking: command.blocking === null
            ? undefined
            : { ...command.blocking, version: (record.blocking?.version ?? 0) + 1 },
        });
      }
      return command.staging === undefined
        ? next
        : editShot(next, {
          shotId: command.shotId,
          change: {
            staging: command.staging === null
              ? undefined
              : {
                ...command.staging,
                version: (current.staging?.version ?? 0) + 1,
                ...(current.staging?.playblast === undefined ? {} : { playblast: current.staging.playblast }),
              },
          },
        });
    }
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
    case "edit-shot": {
      if ("staging" in command.change) {
        throw new SceneCommandRefused(["Stage state must be changed through edit-stage"]);
      }
      // A retimed shot carries its staging with it: the end key is the end pose and sits at the
      // shot's length, so a duration edit that left the keys alone would leave a staging (and
      // its beats) describing seconds the shot no longer has. The version moves with it, which
      // is what marks a playblast recorded at the old length stale.
      const current = orderedShots(record).find((candidate) => candidate.id === command.shotId);
      const retimed = command.change.durationSec !== undefined && current?.staging !== undefined
        ? stagingRetimed(current.staging, command.change.durationSec)
        : undefined;
      const change = retimed === undefined || retimed === current?.staging
        ? command.change
        : { ...command.change, staging: { ...retimed, version: retimed.version + 1 } };
      return editShot(record, { shotId: command.shotId, change });
    }
    case "set-prompt-override": {
      const shot = orderedShots(record).find((candidate) => candidate.id === command.shotId);
      if (shot === undefined) throw new SceneOperationRefused([`shot ${command.shotId} is not in this scene`]);
      if (command.text === null) {
        return editShot(record, { shotId: command.shotId, change: { promptOverride: undefined } });
      }
      const sheetVersions: Record<string, number> = {};
      for (const slug of parseMentions(shot.description)) {
        const sheet = store.getBundle().sheets.find((candidate) => candidate.id === slug);
        if (sheet !== undefined) sheetVersions[slug] = sheet.version;
      }
      return editShot(record, {
        shotId: command.shotId,
        change: { promptOverride: { text: command.text, sheetVersions } },
      });
    }
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
    case "move-board-boundary":
      return moveBoardBoundary(record, command);
    case "set-board-prompt":
      return setBoardPrompt(record, command);
    case "clear-board-prompt":
      return clearBoardPrompt(record, command);
  }
}

/**
 * The selection the deleted shot carried, dropped in the deletion's own commit — and the
 * selections file claimed as a write dependency even when it carries no row for this shot.
 *
 * An accepted take is a blocker, so what is dropped here is never a decision: a trim, a pinned
 * frame, a cleared slot. Selection writers now validate under the same gate, but claiming the
 * file here also protects this commit from any writer that still carries an optimistic base
 * hash. Whichever operation reaches the gate second must observe the deletion or a changed hash;
 * neither order can leave bookkeeping keyed to a shot that no longer exists.
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
  // No early return when the row is absent: the point is to claim the file, not only to edit it.
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

export function stemOrThrow(sceneFile: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sceneFile) || sceneFile === "." || sceneFile === "..") {
    throw new SceneCommandRefused([`"${sceneFile}" is not a scene file name`]);
  }
  return sceneFile;
}

export { SceneOperationRefused };
