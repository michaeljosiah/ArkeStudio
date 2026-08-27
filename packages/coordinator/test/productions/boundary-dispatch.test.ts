import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  planScene,
  START_FRAME_PREAMBLE,
  type ArtifactSidecar,
  type ManifestModel,
  type Scene,
  type Shot,
} from "@arke-studio/contracts";
import { compileBoard, composeDispatches } from "../../src/productions/ops.js";
import { recordTakesFromJob } from "../../src/takes/arrival.js";
import { decodePng, encodePng, solidImage } from "../../src/references/png.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld, WORLD_ID } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";
import type { Job } from "@arke-studio/contracts";

/**
 * The strict frame dispatch (issue 154): a durable boundary still travels on the model's own
 * first-frame route, the plan and the request agree about it, stale selections refuse before
 * money moves, and the board never decodes footage as a picture.
 */

const CLOCK = () => "2026-08-01T12:00:00.000Z";

/** A Wan/seedance-shaped row: frames live in task modes, never in the accepts flags. */
const FRAME_MODEL: ManifestModel = {
  id: "seedance-like",
  provider: "fal",
  capability: "video",
  displayName: "Seedance-like",
  accepts: { referenceImages: 9, startFrame: false, endFrame: false },
  limits: { maxDurationSec: 15, durations: { "5": "5", "10": "10", "15": "15" } },
  pricing: { kind: "perSecond", microUsdPerSecond: 20000 },
  modes: {
    "first-frame": { route: "acme/seedance-like/image-to-video", locked: ["aspect"] },
    "first-and-last-frame": { route: "acme/seedance-like/image-to-video", locked: ["aspect"] },
  },
};

/** The same model with no frame route at all — veo/kling-shaped. */
const TEXT_ONLY_MODEL: ManifestModel = { ...FRAME_MODEL, id: "text-only", displayName: "Text only", modes: undefined };

const shot = (n: number, description: string): Shot => ({
  id: `sh_${n}`,
  number: n,
  title: `Shot ${n}`,
  description,
  durationSec: 5,
});

const boundaryArtifact = (id: string, over: Partial<ArtifactSidecar> = {}): ArtifactSidecar => ({
  id,
  kind: "image",
  file: "boundary-sh_2-20260801.png",
  hash: "sha256:00112233445566778899aabbccddeeff".slice(0, 23),
  origin: { by: "system", producedBy: "boundary-frame:tk_01J8E0000000000000000000T1" },
  links: [],
  created: CLOCK(),
  ...over,
});

async function open() {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir, { clock: CLOCK });
  closeOnCleanup(() => store.close());
  return { dir, store, bundle: store.getBundle() };
}

describe("boundary frames through dispatch (issue 154)", () => {
  it("the frame travels on the first-frame route and the references step aside, named", async () => {
    const { bundle } = await open();
    const production = bundle.productions[0]!;
    const base = production.scenes[0]!;
    const artifact = boundaryArtifact("ar_01J8E0000000000000000000A1");
    const scene: Scene = { ...base, shots: [shot(1, "@maren-kest waits at the rail")] };
    const plan = planScene(
      {
        world: bundle.meta,
        productionId: production.meta.id,
        sheets: bundle.sheets,
        kits: bundle.referenceKits,
        scene,
        selections: { sh_1: { trimInSec: 0, startFrameArtifactId: artifact.id } },
        model: FRAME_MODEL,
        artifacts: [artifact],
      },
      "per-shot",
    );
    const entry = plan.shots[0]!;
    assert.equal(entry.frame?.artifactId, artifact.id);
    assert.deepEqual(entry.bound, [], "the frame route takes one image; nothing rides along");
    assert.equal(entry.parts.preamble, START_FRAME_PREAMBLE, "the words say what the one image is");
    assert.equal(plan.warnings.framedShots.length, 1);
    assert.deepEqual(plan.warnings.framedShots[0]!.setAside, ["maren-kest"], "what stepped aside is named");
    assert.deepEqual(plan.warnings.staleFrames, []);

    const [request] = composeDispatches(WORLD_ID, production.meta.id, scene, plan, FRAME_MODEL, bundle);
    assert.deepEqual(request!.params["references"], [`artifacts/${artifact.file}`]);
    assert.equal(request!.params["taskMode"], "first-frame");
    assert.equal(request!.params["route"], "acme/seedance-like/image-to-video");
    assert.equal(request!.params["startFrame"], `artifacts/${artifact.file}`);
    assert.deepEqual(request!.params["frameArtifact"], { id: artifact.id, hash: artifact.hash });
  });

  it("a stale frame selection is named three ways and cannot dispatch", async () => {
    const { bundle } = await open();
    const production = bundle.productions[0]!;
    const base = production.scenes[0]!;
    const scene: Scene = { ...base, shots: [shot(1, "an empty pier")] };
    const input = (artifacts: ArtifactSidecar[], id: string) =>
      planScene(
        {
          world: bundle.meta,
          productionId: production.meta.id,
          sheets: bundle.sheets,
          kits: bundle.referenceKits,
          scene,
          selections: { sh_1: { trimInSec: 0, startFrameArtifactId: id } },
          model: FRAME_MODEL,
          artifacts,
        },
        "per-shot",
      );

    const missing = input([], "ar_01J8E0000000000000000000A2");
    assert.match(missing.warnings.staleFrames[0]!.detail, /not in this world/);

    const clip = boundaryArtifact("ar_01J8E0000000000000000000A3", { kind: "video", file: "clip.mp4" });
    const wrongKind = input([clip], clip.id);
    assert.match(wrongKind.warnings.staleFrames[0]!.detail, /video, not an image/);

    const old = boundaryArtifact("ar_01J8E0000000000000000000A4");
    const replacement = boundaryArtifact("ar_01J8E0000000000000000000A5", { supersedes: old.id });
    const superseded = input([old, replacement], old.id);
    assert.match(superseded.warnings.staleFrames[0]!.detail, /superseded/);

    const predecessor = "tk_01J8E0000000000000000000T1";
    const staleSource = boundaryArtifact("ar_01J8E0000000000000000000A9", {
      boundaryExtraction: {
        sourceTakeId: predecessor,
        mediaTakeId: predecessor,
        atSec: null,
        method: "ffmpeg-frame/1",
      },
    });
    const changedPredecessor = planScene(
      {
        world: bundle.meta,
        productionId: production.meta.id,
        sheets: bundle.sheets,
        kits: bundle.referenceKits,
        scene: { ...base, shots: [shot(1, "first"), shot(2, "second")] },
        selections: {
          sh_1: { trimInSec: 0, acceptedTakeId: "tk_01J8E0000000000000000000T2" },
          sh_2: { trimInSec: 0, startFrameArtifactId: staleSource.id },
        },
        model: FRAME_MODEL,
        artifacts: [staleSource],
      },
      "per-shot",
    );
    assert.match(changedPredecessor.warnings.staleFrames[0]!.detail, /footage no longer selected/);

    assert.throws(
      () => composeDispatches(WORLD_ID, production.meta.id, scene, missing, FRAME_MODEL, bundle),
      /start frame is unusable/,
    );
  });

  it("no frame route means no carriage, no promise, and the references stay", async () => {
    const { bundle } = await open();
    const production = bundle.productions[0]!;
    const base = production.scenes[0]!;
    const artifact = boundaryArtifact("ar_01J8E0000000000000000000A6");
    const scene: Scene = { ...base, shots: [shot(1, "@maren-kest waits at the rail")] };
    const common = {
      world: bundle.meta,
      productionId: production.meta.id,
      sheets: bundle.sheets,
      kits: bundle.referenceKits,
      scene,
      selections: { sh_1: { trimInSec: 0, startFrameArtifactId: artifact.id } },
      artifacts: [artifact],
    };
    const textOnly = planScene({ ...common, model: TEXT_ONLY_MODEL }, "per-shot");
    assert.equal(textOnly.shots[0]!.frame, undefined);
    assert.ok(textOnly.shots[0]!.bound.length > 0, "the sheet references still travel");
    assert.deepEqual(textOnly.warnings.framedShots, []);
    const [request] = composeDispatches(WORLD_ID, production.meta.id, scene, textOnly, TEXT_ONLY_MODEL, bundle);
    assert.equal(request!.params["taskMode"], undefined);

    // A whole-scene pass covers many shots and the route takes one picture: nothing travels.
    const wholeScene = planScene({ ...common, model: FRAME_MODEL }, "whole-scene");
    assert.deepEqual(wholeScene.warnings.framedShots, []);
    assert.equal(wholeScene.shots[0]!.frame, undefined);

    // And a caller that cannot supply the shelf gets the pre-154 behaviour exactly.
    const noShelf = planScene({ ...common, artifacts: undefined, model: FRAME_MODEL }, "per-shot");
    assert.equal(noShelf.shots[0]!.frame, undefined);
    assert.deepEqual(noShelf.warnings.staleFrames, []);
  });

  it("the board draws the boundary still, and footage only through its poster", async () => {
    const { dir, store, bundle } = await open();
    const production = bundle.productions[0]!;
    const base = production.scenes[0]!;
    const scene: Scene = { ...base, shots: [shot(1, "a shot"), shot(2, "another")] };

    // Shot 1: a video take whose poster exists — the cell must come from frame.png, because
    // handing mp4 bytes to the PNG decoder is how chained shots silently became gaps.
    const takeId = "tk_01J8E0000000000000000000D1";
    const takeDir = join(dir, "productions", production.meta.id, "takes", takeId);
    await mkdir(takeDir, { recursive: true });
    await writeFile(join(takeDir, "clip.mp4"), Buffer.from("not-a-png"));
    await writeFile(join(takeDir, "frame.png"), encodePng(solidImage(8, 8, [255, 0, 0, 255])));

    // Shot 2: a durable boundary still on the shelf.
    const artifact = boundaryArtifact("ar_01J8E0000000000000000000A7", { file: "boundary-sh_2-x.png" });
    await mkdir(join(dir, "artifacts"), { recursive: true });
    await writeFile(join(dir, "artifacts", artifact.file), encodePng(solidImage(8, 8, [0, 255, 0, 255])));

    const withTakes = {
      ...production,
      takes: [
        {
          id: takeId,
          coversShots: ["sh_1"],
          kind: "clip" as const,
          provider: "fal",
          model: "seedance-2.0",
          provenance: { canonRevision: 1, sheets: {} },
          references: [],
          params: {},
          cost: { estimatedMicroUsd: 1000, actualMicroUsd: null },
          dispatchedAt: CLOCK(),
          media: "clip.mp4",
        },
      ],
      selections: {
        sh_1: { trimInSec: 0, startFrameTakeId: takeId },
        sh_2: { trimInSec: 0, startFrameArtifactId: artifact.id },
      },
    };
    const png = await compileBoard(store, withTakes, scene, [artifact]);
    const board = decodePng(png);
    const pixel = (x: number, y: number) => {
      const i = (y * board.width + x) * 4;
      return [board.pixels[i], board.pixels[i + 1], board.pixels[i + 2]];
    };
    // Cells are 320px with 12px gaps: cell 0 starts at (12,12), cell 1 at (344,12).
    assert.deepEqual(pixel(20, 20), [255, 0, 0], "shot 1's cell is the poster, not a gap");
    assert.deepEqual(pixel(352, 20), [0, 255, 0], "shot 2's cell is the boundary still");
  });

  it("the landed take records the frame it opened on (§10.4)", async () => {
    const { dir, store } = await open();
    const landingDir = "productions/saltlight/incoming/sh_1";
    await mkdir(join(dir, landingDir), { recursive: true });
    await writeFile(join(dir, landingDir, "output-1.mp4"), Buffer.from("fake-mp4"));
    const job: Job = {
      id: "jb_01J8E0000000000000000000F1",
      idempotencyKey: "01J8E1000000000000000000F1",
      worldId: WORLD_ID,
      productionId: "saltlight",
      target: { kind: "shot", id: "sh_1", coversShots: ["sh_1"] },
      capability: "video",
      provider: "fal",
      model: "seedance-like",
      params: {
        prompt: "the opening",
        references: ["artifacts/boundary-sh_1-x.png"],
        taskMode: "first-frame",
        route: "acme/seedance-like/image-to-video",
        startFrame: "artifacts/boundary-sh_1-x.png",
        frameArtifact: { id: "ar_01J8E0000000000000000000A8", hash: "sha256:0011223344556677" },
        provenance: { canonRevision: 1, sheets: {} },
      },
      estimatedMicroUsd: 100000,
      status: "succeeded",
      providerJobId: "fal_f1",
      attempt: 1,
      landing: { dir: landingDir },
      landedFiles: [`${landingDir}/output-1.mp4`],
      error: null,
      createdAt: "2026-08-01T11:00:00Z",
      updatedAt: "2026-08-01T11:05:00Z",
    };
    const [take] = await recordTakesFromJob(store, job, null);
    assert.equal(take!.startFrame, "artifacts/boundary-sh_1-x.png", "the seeding frame is the take's own field");
    assert.deepEqual(
      take!.params["frameArtifact"],
      { id: "ar_01J8E0000000000000000000A8", hash: "sha256:0011223344556677" },
      "the exact asset identity is preserved on the take",
    );
    assert.equal(take!.params["startFrame"], undefined, "not duplicated into settings");
  });
});
