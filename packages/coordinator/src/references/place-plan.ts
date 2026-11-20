import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_SHOT_SEC, editScene, orderedShots, PlacePlanRefused, PlacePlanSchema, placePlanAfter, resolvedShotStaging, sameStageSets,
  SceneOperationRefused, stageProblems,
  type PlacePlan, type PlacePlanChange, type PlacePlanSource, type SceneRecord, type StagingSet,
} from "@arke-studio/contracts";
import { parseSceneRecord } from "../productions/scene-record.js";
import type { CommitFileInput } from "../world/commit.js";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import type { WorldStore } from "../world/store.js";
import { sha256 } from "../world/text-files.js";

/**
 * A place's plan (design turn 285, issue 2302): `references/<sheetId>/plan.json`, the place's set
 * and its numbered camera positions.
 *
 * Two rules live here, and both are about the set being one thing in many files. The plan owns the
 * set; every staged scene set in the place carries the same pieces as `blocking.sets`, so the
 * Stage, the playblast's fingerprint and the bench's brief read the scene they have always read.
 * Those copies are written in the commit that changes the set, never after it: a crash between two
 * commits would leave a scene showing a room that no longer exists, with nothing on any screen
 * saying so. And because every copy moves in that commit, each scene's own version moves with
 * it, which is what refuses a Keep composed against the set as it was.
 */

const planPath = (sheetId: string): string => `references/${sheetId}/plan.json`;

const serialise = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/**
 * The plan as it is on disk, or null when the place has none. A file that is there and cannot be
 * read is not "no plan": writing over it would throw away positions somebody set, so it throws.
 */
export async function readPlacePlan(store: WorldStore, sheetId: string): Promise<{ plan: PlacePlan; raw: string } | null> {
  let raw: string;
  try {
    raw = await readFile(toExtendedLength(join(store.dir, fromPortable(planPath(sheetId)))), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return { plan: PlacePlanSchema.parse(JSON.parse(raw)), raw };
}

function planFile(plan: PlacePlan, baseRaw: string | null): CommitFileInput {
  return { path: planPath(plan.sheetId), action: baseRaw === null ? "create" : "replace", content: serialise(plan), baseHash: baseRaw === null ? null : sha256(baseRaw) };
}

const scenePath = (productionId: string, stem: string): string => `productions/${productionId}/scenes/${stem}.json`;

/**
 * Every other staged scene set in the place, rewritten to carry `sets`. A scene nobody has staged
 * has no blocking to hold a set and is left alone; it takes the place's set with its first Stage
 * edit (`followPlacePlan`). Each is read from disk, not from the bundle, so its base hash is the
 * bytes this commit replaces.
 */
async function scenesFollowing(store: WorldStore, sheetId: string, sets: readonly StagingSet[], except: string | null, refuse: (reasons: string[]) => Error): Promise<CommitFileInput[]> {
  const files: CommitFileInput[] = [];
  const stuck: string[] = [];
  for (const production of store.getBundle().productions) {
    for (const scene of production.scenes) {
      if (scene.inherits?.location !== sheetId || scene.blocking === undefined) continue;
      const stem = production.sceneFiles[scene.id];
      if (stem === undefined) continue;
      const path = scenePath(production.meta.id, stem);
      if (path === except) continue;
      const raw = await readFile(toExtendedLength(join(store.dir, fromPortable(path))), "utf8");
      const record = parseSceneRecord(raw);
      // Read again here: the bundle can be a beat behind the file, and a scene moved elsewhere
      // since must keep its own set.
      if (record.inherits?.location !== sheetId || record.blocking === undefined || sameStageSets(record.blocking.sets, sets)) continue;
      const next = editScene(record, { blocking: { ...record.blocking, sets: [...sets], version: record.blocking.version + 1 } });
      // A camera, a figure or a moving piece in that scene may ride a piece only its old set had
      // (codex on PR 3270). Written anyway, the scene would draw an anchored camera at the origin
      // and then refuse every later Stage edit over a target that is gone. Only what the new set
      // breaks counts: a fault the scene already had is not this change's to refuse.
      for (const shot of orderedShots(next)) {
        if (!shot.staging || (shot.staging.cast !== undefined && shot.staging.sets !== undefined)) continue;
        const duration = shot.durationSec ?? DEFAULT_SHOT_SEC;
        const had = new Set(stageProblems(resolvedShotStaging(record, shot.staging), duration));
        const broken = stageProblems(resolvedShotStaging(next, shot.staging), duration).filter((problem) => !had.has(problem));
        if (broken.length > 0) stuck.push(`${production.meta.title} · ${record.title}, shot ${shot.number}: ${broken.join(" ")}`);
      }
      files.push({ path, action: "replace", content: serialise(next), baseHash: sha256(raw) });
    }
  }
  if (stuck.length > 0) throw refuse(["Another scene set in this place rides a piece this set does not have.", ...stuck]);
  return files;
}

/**
 * One change to a place's positions, as one commit. A place's first plan takes its set from the
 * scene the change was made in, and every other staged scene set there takes it in the same
 * commit. Without a plan and without a scene that has a set, there is nothing to stand a camera
 * in, and the change is refused by name.
 */
export async function applyPlacePlanChange(store: WorldStore, input: { sheetId: string; from?: PlacePlanSource | undefined; change: PlacePlanChange }): Promise<PlacePlan> {
  if (!store.getBundle().sheets.some((sheet) => sheet.id === input.sheetId && sheet.type === "location")) {
    throw new PlacePlanRefused(`${input.sheetId} is not a location in this world.`);
  }
  let landed: PlacePlan | undefined;
  await store.gateOp(async () => {
    const found = await readPlacePlan(store, input.sheetId);
    const files: CommitFileInput[] = [];
    let base: PlacePlan;
    if (found) base = found.plan;
    else {
      if (input.from === undefined) throw new PlacePlanRefused("This place has no set yet. Build one on the Stage of a scene set here.");
      const path = scenePath(input.from.productionId, input.from.sceneFile);
      const record = parseSceneRecord(await readFile(toExtendedLength(join(store.dir, fromPortable(path))), "utf8"));
      if (record.id !== input.from.sceneId || record.inherits?.location !== input.sheetId) throw new PlacePlanRefused("That scene is no longer set in this place.");
      const sets = record.blocking?.sets ?? [];
      if (sets.length === 0) throw new PlacePlanRefused("This place has no set yet. Build one on the Stage of a scene set here.");
      base = { sheetId: input.sheetId, version: 1, sets, positions: [], next: 1 };
      files.push(...(await scenesFollowing(store, input.sheetId, sets, path, (reasons) => new PlacePlanRefused(reasons.join(" ")))));
    }
    const next = PlacePlanSchema.parse(placePlanAfter(base, input.change));
    files.unshift(planFile(next, found?.raw ?? null));
    await store.commitUnserialised({ kind: "place-plan", source: input.change.op, files });
    landed = next;
  });
  return landed!;
}

/**
 * What a scene command owes the place its scene is set in, decided inside the command's gate and
 * landing in its commit. Returns the scene to write, and pushes any other file onto `files`.
 *
 * - The scene carried the place's set and a Stage edit changed it: the place takes the new set,
 *   its version moves, and every other staged scene set there follows.
 * - The scene did not carry the place's set (it was set here after the plan was made, or has just
 *   been moved here): it takes the place's, whatever the command said about sets. Its own were
 *   never the place's to overwrite.
 *
 * A scene with no blocking after the command has nowhere to hold a set and is returned as it is.
 * So is a scene whose bytes were fixed before a person approved them (`fixed`, a reviewed batch):
 * what was approved is what lands, and the scene takes the place's set with its next command.
 */
export async function followPlacePlan<T extends SceneRecord>(
  store: WorldStore,
  input: { path: string; before: SceneRecord; after: T; commands: ReadonlyArray<{ kind: string }>; fixed?: boolean },
  files: CommitFileInput[],
): Promise<T> {
  const place = input.after.inherits?.location;
  const blocking = input.after.blocking;
  if (place === undefined || blocking === undefined) return input.after;
  // A plan that cannot be read is reported by the scan, by the path a person can open. It must
  // not also stop every edit to every scene set there: a retitled shot has nothing to do with it.
  // The scene is written as the command left it, and takes the place's set once the plan reads.
  const found = await readPlacePlan(store, place).catch(() => null);
  if (found === null || sameStageSets(blocking.sets, found.plan.sets)) return input.after;
  const followed = input.before.inherits?.location === place && input.before.blocking !== undefined && sameStageSets(input.before.blocking.sets, found.plan.sets);
  if (followed && input.commands.some((command) => command.kind === "edit-stage")) {
    files.push(planFile({ ...found.plan, sets: blocking.sets, version: found.plan.version + 1 }, found.raw));
    files.push(...(await scenesFollowing(store, place, blocking.sets, input.path, (reasons) => new SceneOperationRefused(reasons))));
    return input.after;
  }
  if (input.fixed) return input.after;
  // The set under the marks has changed, so the blocking's version moves once, whether or not the
  // command already moved it: a playblast pinned to the old one must read as stale.
  const version = blocking.version === input.before.blocking?.version ? blocking.version + 1 : blocking.version;
  const next = { ...input.after, blocking: { ...blocking, sets: found.plan.sets, version } };
  // A camera or a figure may ride a piece only the scene's old set had. Refused by name here
  // rather than written as a scene the Stage could not then open.
  for (const shot of orderedShots(next)) {
    if (!shot.staging || (shot.staging.cast !== undefined && shot.staging.sets !== undefined)) continue;
    const problems = stageProblems(resolvedShotStaging(next, shot.staging), shot.durationSec ?? DEFAULT_SHOT_SEC);
    if (problems.length > 0) throw new SceneOperationRefused(problems.map((problem) => `Shot ${shot.number}, on this place's set: ${problem}`));
  }
  return next;
}
