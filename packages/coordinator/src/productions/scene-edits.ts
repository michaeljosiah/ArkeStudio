import type { ModelSceneEdit, WorldChatContext } from "@arke-studio/contracts";
import { applySceneCommand, SceneCommandRefused, SceneVersionMoved } from "./scene-commands.js";
import type { WorldStore } from "../world/store.js";

/**
 * Arke's scene edits, landed (SPEC-036 R-38).
 *
 * The model describes the edit in a typed field of its turn result; this is the one path that
 * writes it, and it is the header's own path — `edit-scene`, version-fenced, one validated
 * record or nothing. No card and no proposal: a title is a label, and the person is looking at
 * it. What makes that safe is the fence: `baseVersion` is the scene as the prompt showed it, so
 * a scene that moved while the model was answering is refused back as a corrective problem
 * rather than overwritten — the bible-edit discipline, one record over.
 */

/** A refusal worded for the one corrective turn: what to do, never what the world contains. */
export class SceneEditRefused extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "SceneEditRefused";
  }
}

/** The scene a thread is about, or null for a thread that is not about one. */
export function sceneOfContext(context: WorldChatContext | undefined): { productionId: string; sceneId: string } | null {
  return context?.kind === "scene" ? { productionId: context.productionId, sceneId: context.sceneId } : null;
}

/** The version the prompt shows the model, so the edit it returns is fenced by what it saw. */
export function sceneVersionFor(store: WorldStore, context: WorldChatContext | undefined): number | null {
  const about = sceneOfContext(context);
  if (about === null) return null;
  const production = store.getBundle().productions.find((candidate) => candidate.meta.id === about.productionId);
  return production?.scenes.find((candidate) => candidate.id === about.sceneId)?.version ?? null;
}

export async function applySceneEdits(
  store: WorldStore,
  input: { entryContext: WorldChatContext | undefined; edits: readonly ModelSceneEdit[]; baseVersion: number | null },
): Promise<void> {
  if (input.edits.length === 0) return;
  const about = sceneOfContext(input.entryContext);
  if (about === null) throw new SceneEditRefused("A scene can only be renamed from its own scene thread. Answer without renaming it.");
  const production = store.getBundle().productions.find((candidate) => candidate.meta.id === about.productionId);
  const sceneFile = production?.sceneFiles[about.sceneId];
  if (production === undefined || sceneFile === undefined || input.baseVersion === null) {
    throw new SceneEditRefused("The scene this thread is about could not be found, so it was left alone. Answer without renaming it.");
  }
  for (const edit of input.edits) {
    try {
      await applySceneCommand(store, {
        productionId: about.productionId,
        sceneFile,
        sceneId: about.sceneId,
        baseVersion: input.baseVersion,
        command: { kind: "edit-scene", title: edit.title },
      });
    } catch (error) {
      if (error instanceof SceneVersionMoved) {
        throw new SceneEditRefused("The scene changed while you were answering, so it was left alone. Answer without renaming it this turn.");
      }
      if (error instanceof SceneCommandRefused) {
        throw new SceneEditRefused(`The rename was refused: ${error.reasons.join(" · ").slice(0, 200)}. Answer without renaming it this turn.`);
      }
      throw error;
    }
  }
}
