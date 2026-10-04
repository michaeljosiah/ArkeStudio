import { clearBoardOverride, clearBoardPrompt, deleteShot, duplicateShot, editScene, editShot, insertShot, moveShot, moveBoardBoundary, nextShotIdIn, SceneOperationRefused, setBoardOverride, setBoardPrompt, type ShotAnchor } from "./scene-operations.js";
import { orderedShots, type GraphScene, type SceneRecord } from "./scene-flow.js";
import { parseMentions } from "./planning.js";
import { stageProblems, resolvedShotStaging, stagingRetimed } from "./staging.js";
import type { SceneBlocking, SceneCastMember, Shot, ShotStageEdit } from "./scene.js";
import type { WorldBundle } from "./client-state.js";

export type SemanticSceneCommand =
  | {
      kind: "edit-scene";
      title?: string;
      synopsis?: string | null;
      inherits?: { location?: string | null; timeOfDay?: string | null; tone?: string | null };
      cast?: Record<string, SceneCastMember | null>;
    }
  | { kind: "edit-stage"; shotId: string; blocking?: Omit<SceneBlocking, "version"> | null; staging?: ShotStageEdit | null }
  | { kind: "insert-shot"; at: ShotAnchor; shot: Omit<Shot, "id" | "number"> }
  | { kind: "move-shot"; shotId: string; to: ShotAnchor }
  | { kind: "duplicate-shot"; shotId: string }
  | { kind: "edit-shot"; shotId: string; change: Partial<Omit<Shot, "id" | "number" | "staging">> }
  | { kind: "set-prompt-override"; shotId: string; text: string | null; capability?: "image" | "video" }
  | { kind: "delete-shot"; shotId: string }
  | { kind: "set-board-override"; shotId: string; override: "split" | "merge" }
  | { kind: "clear-board-override"; shotId: string; override: "split" | "merge" }
  | { kind: "move-board-boundary"; fromShotId: string; toShotId: string }
  | { kind: "set-board-prompt"; members: string[]; text: string }
  | { kind: "clear-board-prompt"; members: string[] };


/** The same graph candidate for a preview and the locked scene authority (SPEC-051 R-15/R-16).
 * Caller supplies the complete production snapshot, including preceding dry-run commands. */
export function sceneCommandCandidate(bundle: WorldBundle, productionId: string, record: SceneRecord, command: SemanticSceneCommand): GraphScene {
  switch (command.kind) {
    case "edit-scene": {
      return editScene(record, {
        ...(command.title !== undefined ? { title: command.title } : {}),
        // Null on the wire is the clear; the operation reads present-with-undefined as the clear.
        ...(command.synopsis !== undefined ? { synopsis: command.synopsis ?? undefined } : {}),
        ...(command.inherits !== undefined ? { inherits: command.inherits } : {}),
        ...(command.cast !== undefined ? { cast: command.cast } : {}),
      });
    }
    case "edit-stage": {
      if (command.blocking === undefined && command.staging === undefined) {
        throw new SceneOperationRefused(["this Stage edit names neither blocking nor a camera"]);
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
      if (command.staging) {
        const problems = stageProblems(resolvedShotStaging(next, { ...command.staging, version: 1 }), current.durationSec ?? 4);
        if (problems.length) throw new SceneOperationRefused(problems);
      }
      next = command.staging === undefined
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
      if (command.blocking !== undefined) {
        for (const shot of orderedShots(next)) {
          if (!shot.staging || (shot.staging.cast !== undefined && shot.staging.sets !== undefined)) continue;
          const problems = stageProblems(resolvedShotStaging(next, shot.staging), shot.durationSec ?? 4);
          if (problems.length) throw new SceneOperationRefused(problems.map(problem => `Shot ${shot.number}: ${problem}`));
        }
      }
      return next;
    }
    case "insert-shot": {
      const production = bundle.productions.find(p => p.meta.id === productionId);
      if (!production) throw new SceneOperationRefused([`production ${productionId} is not in this world`]);
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
      const production = bundle.productions.find(p => p.meta.id === productionId);
      if (!production) throw new SceneOperationRefused([`production ${productionId} is not in this world`]);
      const taken = production.scenes.flatMap((scene) => orderedShots(scene).map((shot) => shot.id));
      return duplicateShot(record, { shotId: command.shotId, newShotId: nextShotIdIn(taken) });
    }
    case "edit-shot": {
      if ("staging" in command.change) {
        throw new SceneOperationRefused(["Stage state must be changed through edit-stage"]);
      }
      // A retimed shot carries its staging with it: the end key is the end pose and sits at the
      // shot's length, so a duration edit that left the keys alone would leave a staging (and
      // its beats) describing seconds the shot no longer has. The version moves with it, which
      // is what marks a playblast recorded at the old length stale.
      const current = orderedShots(record).find((candidate) => candidate.id === command.shotId);
      const retimed = command.change.durationSec !== undefined && current?.staging !== undefined
        ? stagingRetimed(current.staging, command.change.durationSec, current.durationSec ?? 4)
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
      for (const slug of new Set([...parseMentions(shot.description), ...(record.inherits?.location ? [record.inherits.location] : [])])) {
        const sheet = bundle.sheets.find((candidate) => candidate.id === slug);
        if (sheet !== undefined) sheetVersions[slug] = sheet.version;
      }
      return editShot(record, {
        shotId: command.shotId,
        change: { promptOverride: { text: command.text, sheetVersions, ...(command.capability ? { capability: command.capability } : {}) } },
      });
    }
    case "delete-shot": {
      // The live-dependency blockers were derived before the gate opened; what is left is the
      // graph's own refusal and the selection that must ride this commit.
      const next = deleteShot(record, { shotId: command.shotId });
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

/** One prospective version with production-wide identities reserved by preceding commands. */
export function sceneCommandBatchCandidate(bundle: WorldBundle, productionId: string, record: SceneRecord, commands: readonly SemanticSceneCommand[]): GraphScene {
  if (commands.length === 0 || commands.length > 24) throw new SceneOperationRefused(["A scene batch needs between one and 24 commands."]);
  let next = record;
  for (const command of commands) {
    const working = { ...bundle, productions: bundle.productions.map(p => p.meta.id !== productionId ? p :
      { ...p, scenes: p.scenes.map(s => s.id === record.id ? next : s) }) };
    next = sceneCommandCandidate(working, productionId, next, command);
  }
  // JSON is the durable representation: explicit undefined patches must not make a recovered
  // plan differ from the same resulting record calculated at approval.
  return JSON.parse(JSON.stringify({ ...next, version: record.version + 1 })) as GraphScene;
}
