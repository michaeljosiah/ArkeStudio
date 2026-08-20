import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  aspectSupport,
  estimateMicroUsd,
  normalizeAspect,
  planScene,
  productionAspect,
  storyboardUsable,
  type ArtifactSidecar,
  type ManifestModel,
  type Scene,
  type Shot,
} from "@arke-studio/contracts";
import {
  composeDispatches,
  createProduction,
  setProductionAspect,
} from "../../src/productions/ops.js";
import { storyboardRequest } from "../../src/productions/storyboard.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld, WORLD_ID } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

/**
 * The production aspect, end to end (issue 389): written normalized at creation, editable
 * through a durable command, shaping stills and storyboards, riding video dispatch in the
 * studio's own key, and refused by name where the selected route cannot make the shape.
 */

const CLOCK = () => "2026-08-01T12:00:00.000Z";

const VIDEO: ManifestModel = {
  id: "seedance-like",
  provider: "fal",
  capability: "video",
  displayName: "Seedance-like",
  accepts: { referenceImages: 9, startFrame: false, endFrame: false },
  limits: { maxDurationSec: 15, durations: { "5": "5", "10": "10", "15": "15" }, aspects: ["16:9", "9:16"] },
  pricing: { kind: "perSecond", microUsdPerSecond: 20000 },
  modes: {
    "first-frame": { route: "acme/i2v", locked: ["aspect"] },
  },
};

const STILLS: ManifestModel = {
  id: "flux-like",
  provider: "fal",
  capability: "image",
  displayName: "Flux-like",
  accepts: { referenceImages: 4, referenceRoles: false, startFrame: false, endFrame: false },
  limits: { tiers: { "1K": "1MP" } },
  pricing: { kind: "perMegapixel", microUsdPerMegapixel: 30_000 },
};

const shot = (n: number, description = `Shot ${n}`): Shot => ({
  id: `sh_${n}`,
  number: n,
  title: `Shot ${n}`,
  description,
  durationSec: 5,
});

async function open() {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir, { clock: CLOCK });
  closeOnCleanup(() => store.close());
  return { dir, store, bundle: store.getBundle() };
}

describe("the production aspect end to end (issue 389)", () => {
  it("creation normalizes the chosen shape and refuses one no route can parse", async () => {
    const { dir, store } = await open();
    const slug = await createProduction(store, {
      title: "Vertical Tale",
      format: "video",
      aspect: " 9 : 16 ",
    });
    const meta = JSON.parse(await readFile(join(dir, "productions", slug, "production.json"), "utf8")) as {
      aspect?: string;
    };
    assert.equal(meta.aspect, "9:16", "stored in the one canonical spelling");
    await assert.rejects(
      () => createProduction(store, { title: "Broken", format: "video", aspect: "vertical" }),
      /not an aspect/,
    );
  });

  it("the aspect is editable through a durable command with the same refusal", async () => {
    const { dir, store, bundle } = await open();
    const production = bundle.productions[0]!;
    assert.equal(production.meta.aspect, undefined, "the fixture predates aspect");
    assert.equal(productionAspect(production.meta), "16:9", "the documented default, never silence");

    const stored = await setProductionAspect(store, production.meta.id, "9:16");
    assert.equal(stored, "9:16");
    const meta = JSON.parse(
      await readFile(join(dir, "productions", production.meta.id, "production.json"), "utf8"),
    ) as { aspect?: string; updated: string };
    assert.equal(meta.aspect, "9:16");
    assert.equal(meta.updated, CLOCK(), "the change is dated");
    const changes = (await readFile(join(dir, "changes.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { entity?: string; fieldsChanged?: string[] });
    assert.ok(
      changes.some(
        (line) =>
          line.entity === `productions/${production.meta.id}/production` &&
          line.fieldsChanged?.includes("aspect"),
      ),
      "history is the change log — production meta is unversioned",
    );

    await assert.rejects(() => setProductionAspect(store, production.meta.id, "wide"), /not an aspect/);
  });

  it("video dispatch carries the shape in both modes, and the prompt states it for a pass", async () => {
    const { bundle } = await open();
    const production = bundle.productions[0]!;
    const base = production.scenes[0]!;
    const scene: Scene = { ...base, shots: [shot(1), shot(2)] };
    const input = {
      world: bundle.meta,
      productionId: production.meta.id,
      sheets: bundle.sheets,
      kits: bundle.referenceKits,
      scene,
      selections: {},
      model: VIDEO,
      aspect: "9:16",
    };
    const perShot = planScene(input, "per-shot");
    assert.equal(perShot.aspect, "9:16", "the plan carries what it was shaped at");
    const shots = composeDispatches(WORLD_ID, production.meta.id, scene, perShot, VIDEO, bundle);
    for (const request of shots) assert.equal(request.params["aspect"], "9:16");

    const wholeScene = planScene(input, "whole-scene");
    const [pass] = composeDispatches(WORLD_ID, production.meta.id, scene, wholeScene, VIDEO, bundle);
    assert.equal(pass!.params["aspect"], "9:16");
    assert.match(String(pass!.params["prompt"]), /9:16/, "the prompt and the parameters state one shape");

    // A production that never chose a shape dispatches exactly as before — no aspect key at all.
    const legacy = planScene({ ...input, aspect: undefined }, "per-shot");
    const [plain] = composeDispatches(WORLD_ID, production.meta.id, scene, legacy, VIDEO, bundle);
    assert.equal(plain!.params["aspect"], undefined);
  });

  it("an impossible shape is refused by name before enqueue, in the dialog's words and the server's", async () => {
    const { bundle } = await open();
    const production = bundle.productions[0]!;
    const scene: Scene = { ...production.scenes[0]!, shots: [shot(1)] };
    const plan = planScene(
      {
        world: bundle.meta,
        productionId: production.meta.id,
        sheets: bundle.sheets,
        kits: bundle.referenceKits,
        scene,
        selections: {},
        model: VIDEO,
        aspect: "4:3",
      },
      "per-shot",
    );
    assert.deepEqual(plan.warnings.aspectUnsupported, {
      aspect: "4:3",
      model: "Seedance-like",
      supported: ["16:9", "9:16"],
    });
    assert.throws(
      () => composeDispatches(WORLD_ID, production.meta.id, scene, plan, VIDEO, bundle),
      /cannot deliver 4:3 — it offers 16:9, 9:16/,
    );
  });

  it("a framed shot on a mode that locks aspect sends the frame's shape, not a chosen one", async () => {
    const { bundle } = await open();
    const production = bundle.productions[0]!;
    const scene: Scene = { ...production.scenes[0]!, shots: [shot(1)] };
    const artifact: ArtifactSidecar = {
      id: "ar_01J8E0000000000000000000A9",
      kind: "image",
      file: "boundary-sh_1-x.png",
      hash: "sha256:0011223344556677",
      origin: { by: "system", producedBy: "boundary-frame:tk_01J8E0000000000000000000T1" },
      links: [],
      created: CLOCK(),
    };
    const plan = planScene(
      {
        world: bundle.meta,
        productionId: production.meta.id,
        sheets: bundle.sheets,
        kits: bundle.referenceKits,
        scene,
        selections: { sh_1: { trimInSec: 0, startFrameArtifactId: artifact.id } },
        model: VIDEO,
        aspect: "9:16",
        artifacts: [artifact],
      },
      "per-shot",
    );
    assert.ok(plan.shots[0]!.frame !== undefined, "the frame travels");
    const [request] = composeDispatches(WORLD_ID, production.meta.id, scene, plan, VIDEO, bundle);
    assert.equal(request!.params["taskMode"], "first-frame");
    assert.equal(request!.params["aspect"], undefined, "the locked ratio never rides beside the frame");
  });

  it("stills and storyboards are drawn in the delivery shape, and priced at those pixels", async () => {
    const { bundle } = await open();
    const production = bundle.productions[0]!;
    const scene: Scene = { ...production.scenes[0]!, shots: [shot(1)] };
    const plan = planScene(
      {
        world: bundle.meta,
        productionId: production.meta.id,
        sheets: bundle.sheets,
        kits: bundle.referenceKits,
        scene,
        selections: {},
        model: STILLS,
        tier: "1K",
        aspect: "9:16",
      },
      "per-shot",
    );
    const [still] = composeDispatches(WORLD_ID, production.meta.id, scene, plan, STILLS, bundle);
    const output = still!.params["output"] as {
      width: number;
      height: number;
      aspect: string;
      resolution?: string;
    };
    assert.ok(output.height > output.width, "a 9:16 still is portrait, not the old landscape habit");
    assert.equal(output.aspect, "9:16");
    assert.equal(
      still!.estimatedMicroUsd,
      estimateMicroUsd(STILLS, {
        images: 1,
        referenceImages: 0,
        megapixels: (output.width * output.height) / 1_000_000,
        ...(output.resolution !== undefined ? { resolution: output.resolution } : {}),
      }),
      "billed at the pixels actually requested",
    );

    const vertical = {
      ...bundle,
      productions: bundle.productions.map((p) => ({ ...p, meta: { ...p.meta, aspect: "9:16" } })),
    };
    const request = storyboardRequest(vertical, production.meta.id, scene, STILLS, VIDEO);
    const board = request.input.params["output"] as { width: number; height: number };
    assert.ok(board.height > board.width, "the board is drawn in the shape it will steer");
    const frozen = request.input.params["provenance"] as { aspect?: string };
    assert.equal(frozen.aspect, "9:16", "the drawn shape is frozen with the rest");
  });

  it("a continuous range verdicts by ratio, and silence is a pass, not a refusal", () => {
    const ranged: ManifestModel = {
      ...VIDEO,
      id: "ranged",
      limits: { maxDurationSec: 15 },
      aspectRange: { min: 0.5, max: 2 },
    };
    assert.ok(aspectSupport(ranged, "9:16").ok, "0.5625 sits inside the declared range");
    const refused = aspectSupport(ranged, "21:9");
    assert.ok(!refused.ok && refused.supported.length > 0, "past the range, with real offers named");
    const silent: ManifestModel = { ...VIDEO, id: "silent", limits: { maxDurationSec: 15 } };
    assert.ok(aspectSupport(silent, "9:16").ok, "a row with no opinion refuses nothing");
    assert.ok(!aspectSupport(silent, "vertical").ok, "but a malformed shape is never a pass");
  });

  it("a board drawn for another shape cannot steer, legacy landscape boards included", async () => {
    const { bundle } = await open();
    const base = bundle.productions[0]!.scenes[0]!;
    const drawn: Scene = {
      ...base,
      shots: [shot(1)],
      storyboard: {
        file: "storyboards/sc-x.png",
        sceneVersion: base.version,
        panels: ["sh_1"],
        aspect: "16:9",
        drawnAt: CLOCK(),
        sourceJobId: "jb_x",
        accepted: true,
        acceptedAt: CLOCK(),
      },
    };
    assert.equal(storyboardUsable(drawn, "16:9").usable, true);
    const verdict = storyboardUsable(drawn, "9:16");
    assert.equal(verdict.usable, false);
    assert.match(verdict.reason!, /drawn at 16:9 and this production delivers 9:16/);
    // A board from before aspect reached storyboards was always landscape, and says so.
    const legacy: Scene = { ...drawn, storyboard: { ...drawn.storyboard!, aspect: undefined } };
    assert.equal(storyboardUsable(legacy, "9:16").usable, false);
    assert.equal(normalizeAspect(" 16 : 9 "), "16:9", "and every comparison is in one spelling");
  });
});
