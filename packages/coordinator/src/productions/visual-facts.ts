import { readFile } from "node:fs/promises";
import { SceneRecordSchema, orderedShots, editShot, type ClientMessage } from "@arke-studio/contracts";
import { ProposalManager } from "../gate/proposals.js";
import { audioWorldPath } from "../audio/storage.js";
import { sha256 } from "../world/text-files.js";
import type { WorldStore } from "../world/store.js";

export async function proposeShotVisualFacts(store: WorldStore, request: Extract<ClientMessage, { kind: "propose-shot-visual-facts" }>) {
  const world = store.getBundle(), production = world.productions.find(p => p.meta.id === request.productionId);
  const scene = production?.scenes.find(s => s.id === request.sceneId), stem = production?.sceneFiles[request.sceneId];
  if (!scene || !stem || scene.version !== request.expectedSceneVersion) throw new Error("The scene changed. Review its current authored facts.");
  if (request.visualFacts?.onScreenCharacters.some(c => !world.sheets.some(s => s.id === c.characterId && s.type === "character" && !s.retired)))
    throw new Error("Authored on-screen cast must name current character sheets.");
  const path = `productions/${request.productionId}/scenes/${stem}.json`;
  const raw = await readFile(await audioWorldPath(store.dir, path), "utf8");
  const record = SceneRecordSchema.parse(JSON.parse(raw));
  if (record.version !== request.expectedSceneVersion || !orderedShots(record).some(s => s.id === request.shotId)) throw new Error("The authored shot changed.");
  const next = editShot(record, { shotId: request.shotId, change: { visualFacts: request.visualFacts ?? undefined } });
  return new ProposalManager(store).stage({ kind: "scene-edit", summary: `Review authored visual facts for ${request.shotId}`,
    source: "dialogue-guidance", production: request.productionId,
    targets: [{ path, content: JSON.stringify(next, null, 2) + "\n", expectedBaseHash: sha256(raw) }] });
}
