import { useEffect, useRef, useState } from "react";
import type { ClientMessage, ProductionBundle, SceneRecord, WorldBundle } from "@arke-studio/contracts";
import { sceneCommand, subscribeSceneRefusals } from "../../lib/store.js";

type Command = Extract<ClientMessage, { kind: "scene-command" }>["command"];

export interface SceneWriter {
  /** The scene's file stem, or undefined for a scene the bundle cannot place on disk. */
  sceneFile: string | undefined;
  /** The latest staged proposal touching this scene, if one is awaiting review. */
  staged: WorldBundle["proposals"][number] | undefined;
  /** The scene as the staged proposal would leave it, or the accepted scene when nothing is staged. */
  workingScene: SceneRecord;
  /** Sends one named, versioned command; false when the page refuses to (staged, no file, one in flight). */
  write: (command: Command) => boolean;
  /** What every editor on the scene already knows: a staged proposal or a command in flight refuses a write. */
  locked: boolean;
  commandPending: boolean;
  /** Counts up on every refused scene write, so a draft can learn its write was turned away. */
  refusalVersion: number;
}

/**
 * One writer per scene, shared by the scene page and the shot page: the same staged-proposal
 * lookup, the same one-command-in-flight guard, and the same refusal counter. The two pages are
 * two views of one record, and a write refused on one must read as refused on the other for the
 * same reason — which is why the guard lives here rather than being copied into each.
 */
export function useSceneWriter(world: WorldBundle, production: ProductionBundle, scene: SceneRecord): SceneWriter {
  const sceneFile = production.sceneFiles[scene.id];
  const scenePath = sceneFile === undefined ? null : `productions/${production.meta.id}/scenes/${sceneFile}.json`;
  const staged = [...world.proposals]
    .filter((entry) => scenePath !== null && entry.proposal.kind === "scene-edit" && entry.scenes?.[scenePath] !== undefined)
    .sort((left, right) =>
      left.proposal.created.localeCompare(right.proposal.created) || left.proposal.id.localeCompare(right.proposal.id),
    )
    .at(-1);
  const workingScene = scenePath === null ? scene : (staged?.scenes?.[scenePath] ?? scene);
  const [commandPending, setCommandPending] = useState(false);
  const [refusalVersion, setRefusalVersion] = useState(0);
  const pendingCommand = useRef(false);
  useEffect(
    () =>
      subscribeSceneRefusals((event) => {
        if (event.productionId === production.meta.id && event.sceneFile === sceneFile) {
          pendingCommand.current = false;
          setCommandPending(false);
          setRefusalVersion((version) => version + 1);
        }
      }),
    [production.meta.id, sceneFile],
  );
  // A landed write moves the version; the next command may go.
  useEffect(() => {
    pendingCommand.current = false;
    setCommandPending(false);
  }, [scene.id, sceneFile, scene.version]);
  const write = (command: Command): boolean => {
    if (sceneFile === undefined || staged !== undefined || pendingCommand.current) return false;
    const sent = sceneCommand({
      worldId: world.meta.worldId,
      productionId: production.meta.id,
      sceneFile,
      sceneId: scene.id,
      baseVersion: scene.version,
      command,
    });
    if (sent) {
      pendingCommand.current = true;
      setCommandPending(true);
    }
    return sent;
  };
  return {
    sceneFile,
    staged,
    workingScene,
    write,
    locked: staged !== undefined || sceneFile === undefined || commandPending,
    commandPending,
    refusalVersion,
  };
}
