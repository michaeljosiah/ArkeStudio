import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { applyLookPreset, compilePasses, planScene, type ManifestModel, type ProductionLook, type Scene, type Shot } from "@arke-studio/contracts";
import { setProductionLook, updateProductionMetadata } from "../../src/productions/ops.js";
import { PRODUCTION_LOOK_SCHEMA_VERSION } from "../../src/world/commit.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

/**
 * A production's look (design turns 287 and 288a). Gold on Gold's clips were written "locked off"
 * in a film meant to be handheld, because nothing said how the film is shot; the look says it, and
 * its camera, light, lens and grade reach every prompt beneath the scene's camera.
 */

const CLOCK = () => "2026-11-25T12:00:00.000Z";

const MODEL: ManifestModel = {
  id: "seedance-like",
  provider: "fal",
  capability: "video",
  displayName: "Seedance-like",
  accepts: { referenceImages: 9, startFrame: false, endFrame: false },
  limits: { maxDurationSec: 10, durations: { "5": "5", "10": "10" } },
  pricing: { kind: "perSecond", microUsdPerSecond: 20000 },
};

const GOLD_ON_GOLD: ProductionLook = {
  ...applyLookPreset(undefined, "naturalistic-drama"),
  light: { key: "low", words: "purple from above, the bar's glow, no fill" },
  grade: { words: "35 mm, a little under, grain" },
  checks: ["Ade's watch on his near wrist"],
};

const shot = (n: number, description: string, framing?: Shot["framing"]): Shot => ({
  id: `sh_${n}`, number: n, title: `Shot ${n}`, description, durationSec: 5, ...(framing ? { framing } : {}),
});

async function open() {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir, { clock: CLOCK });
  closeOnCleanup(() => store.close());
  const bundle = store.getBundle();
  return { dir, store, bundle, production: bundle.productions[0]! };
}

describe("a production's look (design turn 287)", () => {
  it("is written whole, raises the world past older builds, and clears with null or nothing in it", async () => {
    const { dir, store, production } = await open();
    await setProductionLook(store, production.meta.id, GOLD_ON_GOLD);
    assert.deepEqual(store.getBundle().productions[0]!.meta.look, GOLD_ON_GOLD);
    const world = JSON.parse(await readFile(join(dir, "world.json"), "utf8")) as { schemaVersion: number };
    assert.ok(world.schemaVersion >= PRODUCTION_LOOK_SCHEMA_VERSION, `world at ${world.schemaVersion}`);

    await setProductionLook(store, production.meta.id, null);
    assert.equal(store.getBundle().productions[0]!.meta.look, undefined);
    const raw = await readFile(join(dir, "productions", production.meta.id, "production.json"), "utf8");
    assert.doesNotMatch(raw, /"look"\s*:/, "a cleared look leaves no key");

    // An empty look is no look: it must not raise a world for nothing.
    await setProductionLook(store, production.meta.id, {});
    assert.equal(store.getBundle().productions[0]!.meta.look, undefined);
  });

  it("Arke's card writes the same field through the metadata path", async () => {
    const { store, production } = await open();
    await updateProductionMetadata(store, production.meta.id, { look: GOLD_ON_GOLD }, {
      source: "world-chat", requestId: "act_01J8E0000000000000000000E1", precondition: () => null });
    assert.equal(store.getBundle().productions[0]!.meta.look?.camera?.kind, "handheld");
    await updateProductionMetadata(store, production.meta.id, { look: null }, {
      source: "world-chat", requestId: "act_01J8E0000000000000000000E2", precondition: () => null });
    assert.equal(store.getBundle().productions[0]!.meta.look, undefined);
  });

  it("its camera reaches every clip's prompt beneath the scene's camera, and a shot's own still wins", async () => {
    const { bundle, production } = await open();
    const scene: Scene = { ...production.scenes[0]!, defaults: { lighting: "one bare bulb" }, shots: [
      shot(1, "@maren-kest waits at the rail"),
      shot(2, "@maren-kest turns", { movement: "locked off on a tripod" }),
    ] };
    const plan = planScene({
      world: bundle.meta, productionId: production.meta.id, sheets: bundle.sheets, kits: bundle.referenceKits, scene,
      selections: {}, model: MODEL, artifacts: [], production: { look: GOLD_ON_GOLD },
    }, "per-shot");
    const [one, two] = plan.shots.map((planned) => planned.prompt.text);
    assert.match(one!, /handheld, gently breathing and drifting/, "the look's camera is said for a shot with none of its own");
    assert.match(one!, /35 mm, a little under, grain/, "and its grade");
    assert.match(one!, /one bare bulb/, "the scene's own light wins over the look's");
    assert.doesNotMatch(one!, /purple from above/);
    assert.match(two!, /locked off on a tripod/, "the shot's own movement wins over both");
    assert.doesNotMatch(two!, /gently breathing/);
    // The words a picture model never needs stay out of the prompt: they are Arke's to keep.
    assert.doesNotMatch(one!, /Ade's watch|split cuts|room tone/);

    // A whole-scene pass rebuilds its beats from the scene when it is compiled for the request: the
    // look must reach the paid request, not only the plan (codex on PR 3302).
    const whole = planScene({
      world: bundle.meta, productionId: production.meta.id, sheets: bundle.sheets, kits: bundle.referenceKits,
      scene: { ...scene, defaults: undefined }, selections: {}, model: MODEL, artifacts: [], production: { look: GOLD_ON_GOLD },
    }, "whole-scene");
    const compiled = compilePasses({ productionId: production.meta.id, scene: { ...scene, defaults: undefined }, plan: whole, model: MODEL,
      world: bundle, look: GOLD_ON_GOLD });
    const sent = compiled.map((pass) => String(pass.params["prompt"])).join("\n");
    assert.match(sent, /gently breathing/, "the paid request carries the look's camera");
    assert.match(sent, /purple from above/, "and its light, where the scene sets none");
    const bare = compilePasses({ productionId: production.meta.id, scene: { ...scene, defaults: undefined }, plan: whole, model: MODEL, world: bundle });
    assert.doesNotMatch(bare.map((pass) => String(pass.params["prompt"])).join("\n"), /purple from above/, "only when the look is given");

    const without = planScene({
      world: bundle.meta, productionId: production.meta.id, sheets: bundle.sheets, kits: bundle.referenceKits, scene,
      selections: {}, model: MODEL, artifacts: [],
    }, "per-shot");
    assert.doesNotMatch(without.shots[0]!.prompt.text, /gently breathing/, "no look adds nothing");
  });
});
