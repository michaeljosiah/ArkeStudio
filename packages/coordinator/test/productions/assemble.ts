import {
  assembleSceneCommands,
  orderedShots,
  seedEmptyPictureTimeline,
  sortScenes,
  storyTimelineFingerprint,
  type ProductionBundle,
  type ProductionTimeline,
  type SceneAssembly,
} from "@arke-studio/contracts";
import { applyTimelineCommand } from "../../src/productions/timeline.js";
import type { WorldStore } from "../../src/world/store.js";

/**
 * The first timeline is empty (decided 2026-09-02), so a test that needs clips on the base puts
 * them there the way the coordinator's `timeline-assemble` does: Arke's assembly of one scene
 * against the record as it stands, landed as one revision, the first write fenced by the story
 * fingerprint. Scene by scene in story order this lays exactly the clips the story seed used to
 * — same ids, same order, same frames — which is what the expectations that use it were
 * written against; the subtitle track and Library entries come along as they would in the app.
 */

function productionOf(store: WorldStore, productionId: string): ProductionBundle {
  const production = store.getBundle().productions.find((candidate) => candidate.meta.id === productionId);
  if (production === undefined) throw new Error(`production ${productionId} is not in this world`);
  return production;
}

/** What Arke would do for one scene against the record as it stands, or throw with the refusal. */
export function sceneAssembly(store: WorldStore, productionId: string, sceneId: string): SceneAssembly {
  const production = productionOf(store, productionId);
  const assembly = assembleSceneCommands({
    production,
    timeline: production.timeline?.status === "ready" ? production.timeline.timeline : seedEmptyPictureTimeline(production),
    sceneId,
    artifacts: store.getBundle().artifacts,
  });
  if ("refused" in assembly) throw new Error(assembly.refused);
  return assembly;
}

/** One scene's assembly, applied: the saved record after it, and what the first write's migration could not carry. */
export async function assembleScene(
  store: WorldStore,
  productionId: string,
  sceneId: string,
): Promise<{ timeline: ProductionTimeline; dropped: string[] }> {
  const production = productionOf(store, productionId);
  const scene = production.scenes.find((candidate) => candidate.id === sceneId);
  if (scene === undefined) throw new Error(`${sceneId} is not a scene of ${productionId}`);
  const saved = production.timeline?.status === "ready" ? production.timeline.timeline : null;
  const assembly = sceneAssembly(store, productionId, sceneId);
  const { dropped } = await applyTimelineCommand(store, productionId, {
    kind: "commands",
    commands: assembly.commands,
    baseRevision: saved === null ? null : saved.revision,
    sourceFingerprint: storyTimelineFingerprint(production),
    label: `Arke assembled ${scene.title}`,
    notes: assembly.notes,
  });
  const state = productionOf(store, productionId).timeline;
  if (state?.status !== "ready") throw new Error(`assembling ${sceneId} left the timeline ${state?.status ?? "absent"}`);
  return { timeline: state.timeline, dropped };
}

/** Every scene with shots, in story order, one revision each; the base Picture track then holds every story shot once. */
export async function assembleStory(store: WorldStore, productionId: string): Promise<ProductionTimeline> {
  let timeline: ProductionTimeline | null = null;
  for (const scene of sortScenes(productionOf(store, productionId).scenes)) {
    if (orderedShots(scene).length === 0) continue;
    ({ timeline } = await assembleScene(store, productionId, scene.id));
  }
  if (timeline === null) throw new Error(`${productionId} has no shots to assemble`);
  return timeline;
}
