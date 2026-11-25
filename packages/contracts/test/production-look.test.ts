import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyLookPreset,
  effectiveFraming,
  LOOK_PRESETS,
  lookBrief,
  lookFraming,
  ProductionLookInputSchema,
  ProductionLookSchema,
  ProductionSchema,
  sceneUnderLook,
  type ProductionLook,
} from "../src/index.js";

/** A production's look (design turns 287 and 288a). */

describe("a production's look", () => {
  it("reads anything it finds and bounds only what is written", () => {
    const long = "x".repeat(400);
    assert.ok(ProductionLookSchema.safeParse({ grade: { words: long }, checks: [long] }).success, "the read path never deletes a production");
    assert.equal(ProductionLookInputSchema.safeParse({ grade: { words: long } }).success, false);
    assert.equal(ProductionLookInputSchema.safeParse({ checks: Array.from({ length: 13 }, (_, i) => `check ${i}`) }).success, false);
    assert.equal(ProductionLookInputSchema.safeParse({ camera: { kind: "dolly" } }).success, false);
    assert.equal(ProductionLookInputSchema.safeParse({ camera: { kind: "handheld", tripod: true } }).success, false, "strict parts");
  });

  it("sits on the production record beside styleOverride", () => {
    const production = {
      id: "the-film", format: "video", title: "The Film", status: "in-progress", failureModes: [],
      created: "2026-11-25T00:00:00.000Z", updated: "2026-11-25T00:00:00.000Z",
      styleOverride: "a film of the night", look: { preset: "thriller", camera: { kind: "handheld" } },
    };
    assert.ok(ProductionSchema.safeParse(production).success);
  });

  it("a preset fills the choices and keeps the words and the production's own checks", () => {
    const before: ProductionLook = { camera: { kind: "locked", words: "eye level, breathes" }, checks: ["Ade's watch on his near wrist"] };
    const after = applyLookPreset(before, "found-footage");
    assert.equal(after.preset, "found-footage");
    assert.equal(after.camera?.kind, "shaky");
    assert.equal(after.camera?.words, "eye level, breathes");
    assert.deepEqual(after.checks, ["Ade's watch on his near wrist"]);
    for (const preset of LOOK_PRESETS) assert.ok(ProductionLookInputSchema.safeParse(applyLookPreset(undefined, preset)).success, preset);
  });

  it("says its camera, light, lens and grade as a shot's framing, and nothing it leaves unsaid", () => {
    assert.deepEqual(lookFraming(undefined), {});
    assert.deepEqual(lookFraming({ checks: ["a"] }), {});
    const framing = lookFraming({
      camera: { kind: "handheld", strength: "gentle", pushOnBeat: true, words: "eye level, breathes" },
      light: { key: "low", words: "purple from above" },
      lens: { length: "long", focus: "shallow" },
      grade: { words: "35 mm, grain" },
    });
    assert.equal(framing.movement, "handheld, gently breathing and drifting; easing a little closer on the beat that matters; eye level, breathes");
    assert.equal(framing.lighting, "low key: purple from above");
    assert.equal(framing.lens, "long lens");
    assert.equal(framing.focus, "shallow focus");
    assert.equal(framing.grade, "35 mm, grain");
    // A locked camera never eases closer.
    assert.equal(lookFraming({ camera: { kind: "locked", pushOnBeat: true } }).movement, "locked off on a tripod");
  });

  it("lies beneath the scene's camera, which a shot's own framing still overrides", () => {
    const look: ProductionLook = { camera: { kind: "handheld" }, light: { key: "low" } };
    const scene = sceneUnderLook({ defaults: { lighting: "one bare bulb" } }, look);
    assert.equal(effectiveFraming(scene, {}).lighting, "one bare bulb");
    assert.match(effectiveFraming(scene, {}).movement ?? "", /^handheld/);
    assert.equal(effectiveFraming(scene, { framing: { movement: "slow push-in" } }).movement, "slow push-in");
    const untouched = { defaults: { lens: "35mm" } };
    assert.equal(sceneUnderLook(untouched, undefined), untouched, "no look, the same scene");
  });

  it("reads to Arke as one paragraph, its own checks included", () => {
    assert.equal(lookBrief(undefined), null);
    const brief = lookBrief({ ...applyLookPreset(undefined, "naturalistic-drama"), checks: ["Ife in her October look"] })!;
    assert.match(brief, /^The production's look \(Naturalistic drama\): camera handheld/);
    assert.match(brief, /split cuts/);
    assert.match(brief, /one room tone for each place/);
    assert.match(brief, /Its own checks, to hold in every shot: Ife in her October look\./);
    assert.match(brief, /write every shot's movement to match it/);
  });
});
