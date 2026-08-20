import { copyFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  imageConstraintSuffix,
  estimateMicroUsd,
  planStoryboard,
  sceneImageOutput,
  SceneSchema,
  storyboardUsable,
  type Job,
  type ManifestModel,
  type Scene,
  type SceneStoryboard,
  type StoryboardPlan,
  type WorldBundle,
} from "@arke-studio/contracts";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import { JsonFile, sha256 } from "../world/text-files.js";
import type { WorldStore } from "../world/store.js";
import type { EnqueueInput } from "../queue/dispatcher.js";

/**
 * Storyboards drawn to be read (SPEC-019 §2.12, T-15, T-16).
 *
 * Dispatched, priced and recorded like any other generation (R-25), and accepted before it may
 * steer one — the accept gate is what decides which images drive generation, and a board nobody
 * looked at silently steering a scene is that gate inverted.
 */

/**
 * A scene by id, with the raw file behind it. Scene files are named by number and slug, and a
 * job only carries the scene id — so the bundle is what resolves one to the other. Returns null
 * rather than throwing: a scene deleted while its board was drawing is an ordinary race, not a
 * fault, and landing quietly does nothing.
 */
async function readSceneById(
  store: WorldStore,
  productionId: string,
  sceneId: string,
): Promise<{ scene: Scene; raw: string; path: string } | null> {
  const production = store.getBundle().productions.find((entry) => entry.meta.id === productionId);
  const known = production?.scenes.find((entry) => entry.id === sceneId);
  // The stem captured at scan is the address (issue #387) — a reconstruction would go blind the
  // moment a file's name stopped matching its number and slug.
  const stem = known ? production?.sceneFiles[known.id] : undefined;
  if (!known || stem === undefined) return null;
  const path = `productions/${productionId}/scenes/${stem}.json`;
  try {
    const raw = await readFile(toExtendedLength(join(store.dir, fromPortable(path))), "utf8");
    return { scene: SceneSchema.parse(JSON.parse(raw)), raw, path };
  } catch {
    return null;
  }
}

export interface StoryboardRequest {
  plan: StoryboardPlan;
  input: EnqueueInput;
  estimatedMicroUsd: number;
}

/**
 * Compose the drawing job.
 *
 * Two models are in play and they are not interchangeable. `drawnBy` is an image model and pays
 * for the board; `target` is the video model that will read it, and owns the panel cap — past
 * that cap the documented failure is a still output or panels out of order, so the excess is
 * named before commit rather than drawn (R-23).
 */
export function storyboardRequest(
  world: WorldBundle,
  productionId: string,
  scene: Scene,
  drawnBy: ManifestModel,
  target: ManifestModel,
): StoryboardRequest {
  if (scene.shots.length === 0) {
    throw new Error(`scene ${scene.number} has no shots to draw`);
  }
  if (drawnBy.capability !== "image") {
    throw new Error(`${drawnBy.displayName} cannot draw a storyboard — it is not an image model`);
  }
  const planned = planStoryboard({
    world: world.meta,
    sheets: world.sheets,
    scene,
    target,
    ...(world.artDirection.description !== undefined
      ? { artDirection: world.artDirection.description }
      : {}),
  });
  // Standing failure modes ride the board too (#244, round 2): "hands stay whole" fails in line
  // art as readily as in a render. Appended onto the plan rather than at params, so the prompt a
  // reviewer reads is the prompt the model gets. Production constraints included — a board is
  // production work, unlike a kit, which belongs to the world.
  const production = world.productions.find((candidate) => candidate.meta.id === productionId)?.meta;
  const plan = {
    ...planned,
    prompt: `${planned.prompt}${imageConstraintSuffix(
      world.artDirection,
      production
        ? {
            ...(production.musicPolicy !== undefined ? { musicPolicy: production.musicPolicy } : {}),
            failureModes: production.failureModes,
          }
        : null,
    )}`,
  };
  // Drawn in the shape it will steer (issue 389): a landscape board read by a 9:16 dispatch
  // frames every panel the wrong way round, and the estimate prices the pixels actually asked.
  const aspect = production?.aspect;
  const output = sceneImageOutput(drawnBy, undefined, aspect);
  const estimatedMicroUsd = estimateMicroUsd(drawnBy, {
    images: 1,
    referenceImages: 0,
    megapixels: (output.width * output.height) / 1_000_000,
    ...(output.resolution !== undefined ? { resolution: output.resolution } : {}),
  });
  return {
    plan,
    estimatedMicroUsd,
    input: {
      worldId: world.meta.worldId,
      productionId,
      target: { kind: "storyboard", id: scene.id, coversShots: plan.panels.map((panel) => panel.shotId) },
      capability: "image",
      provider: drawnBy.provider,
      model: drawnBy.id,
      params: {
        prompt: plan.prompt,
        // Nothing is carried in. A board conditioned on rendered references stops being line
        // art, which is the one property it exists to have.
        references: [],
        output,
        // Frozen at dispatch, as everywhere else: the scene version is what makes a board's
        // staleness computable once the shots move on (R-27).
        provenance: {
          canonRevision: world.meta.canonRevision,
          artDirectionVersion: world.artDirection.version,
          sceneId: scene.id,
          sceneVersion: scene.version,
          panels: plan.panels.map((panel) => panel.shotId),
          // The shape the panels were drawn at (issue 389), frozen with the rest so the landed
          // record can say it and staleness against a changed aspect is computable.
          ...(aspect !== undefined ? { aspect } : {}),
        },
      },
      estimatedMicroUsd,
      landing: {
        dir: `productions/${productionId}/storyboards/incoming`,
        name: `${scene.id}-v${scene.version}.png`,
      },
    },
  };
}

/**
 * Land a drawn board on its scene, unaccepted (R-25).
 *
 * Idempotent by job id: a re-delivered completion must not produce a second record, and must
 * never quietly re-open an acceptance the user already gave.
 */
export async function recordStoryboard(
  store: WorldStore,
  productionId: string,
  job: Job,
): Promise<SceneStoryboard | null> {
  const landed = job.landedFiles?.[0];
  const sceneId = job.target.id;
  if (!landed || !sceneId) return null;
  const frozen = job.params["provenance"] as
    | { sceneVersion?: number; panels?: string[]; aspect?: string }
    | undefined;
  // Captured, not re-read: the narrowing does not survive into the async callback below, and a
  // board filed against the wrong version is a staleness check that silently never fires.
  const sceneVersion = frozen?.sceneVersion;
  const panels = frozen?.panels ?? [];
  const drawnAspect = frozen?.aspect;
  if (sceneVersion === undefined) return null;

  return store.gateOp(async () => {
    const found = await readSceneById(store, productionId, sceneId);
    if (!found) return null;
    if (found.scene.storyboard?.sourceJobId === job.id) return found.scene.storyboard;
    const file = `${sceneId}-v${sceneVersion}.png`;
    const dir = join(store.dir, "productions", productionId, "storyboards");
    await mkdir(toExtendedLength(dir), { recursive: true });
    await copyFile(toExtendedLength(join(store.dir, fromPortable(landed))), toExtendedLength(join(dir, file)));
    const storyboard: SceneStoryboard = {
      file: `storyboards/${file}`,
      sceneVersion,
      panels: panels as SceneStoryboard["panels"],
      // The delivery aspect the panels were drawn at (issue 389), from the frozen provenance.
      ...(drawnAspect !== undefined ? { aspect: drawnAspect } : {}),
      drawnAt: store.now(),
      sourceJobId: job.id,
      // Never true here. Landing is not approval, and the one thing this record gates is whether
      // an image may steer a generation.
      accepted: false,
    };
    const doc = JsonFile.parse(found.raw);
    doc.set({ storyboard });
    await store.commitUnserialised({
      kind: "storyboard-landed",
      source: "form",
      files: [
        { path: found.path, action: "replace", content: doc.serialize(), baseHash: sha256(found.raw), preserveVersion: true },
      ],
    });
    return storyboard;
  });
}

/**
 * Accept a landed board, which is what lets it steer (R-25).
 *
 * Refuses a board drawn from a scene that has since moved: accepting a stale board would put the
 * contradiction R-24 exists to prevent back into the world by hand.
 */
export async function acceptStoryboard(
  store: WorldStore,
  productionId: string,
  sceneId: string,
): Promise<SceneStoryboard> {
  return store.gateOp(async () => {
    const found = await readSceneById(store, productionId, sceneId);
    if (!found) throw new Error(`scene ${sceneId} was not found`);
    const board = found.scene.storyboard;
    if (!board) throw new Error("there is no storyboard to accept");
    if (board.sceneVersion !== found.scene.version) {
      throw new Error(
        `that storyboard was drawn from v${board.sceneVersion} and the scene is at v${found.scene.version} — redraw it`,
      );
    }
    const accepted: SceneStoryboard = { ...board, accepted: true, acceptedAt: store.now() };
    const doc = JsonFile.parse(found.raw);
    doc.set({ storyboard: accepted });
    await store.commitUnserialised({
      kind: "storyboard-accept",
      source: "form",
      files: [
        { path: found.path, action: "replace", content: doc.serialize(), baseHash: sha256(found.raw), preserveVersion: true },
      ],
    });
    return accepted;
  });
}

export { planStoryboard, storyboardUsable };
