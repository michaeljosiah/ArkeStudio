import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  expandStageSet,
  STAGE_CAST_COLOURS,
  STAGE_MATERIAL_LOOKS,
  STAGE_MATERIALS,
  stageAtmosphereLook,
  stageKelvinColour,
  stageMaterialOf,
  StagingSetSchema,
  type StagingSet,
} from "../src/index.js";

/** The Stage's looks (issue 1825, design turn 229a/229e). */

describe("the Lit look's materials", () => {
  it("draws every material it can be given", () => {
    for (const material of STAGE_MATERIALS) assert.ok(STAGE_MATERIAL_LOOKS[material], material);
  });

  it("chooses a part's material by its wall, then its surface, then the item's, then the surface default", () => {
    const lobby: StagingSet = {
      name: "lobby", x: 0, z: 0, w: 8, h: 5, d: 12, material: "concrete",
      surfaces: { "right wall": "wood", glass: "glass", floor: "marble" },
      kit: { kind: "room", open: ["front"] },
    };
    const of = (part: string) => stageMaterialOf(lobby, expandStageSet(lobby).find((candidate) => candidate.name === `lobby · ${part}`)!);
    assert.equal(of("right wall"), "wood", "a wall by its side");
    assert.equal(of("floor"), "marble", "a surface by name");
    assert.equal(of("back wall"), "concrete", "the item's own material for an unnamed wall");
    const plain: StagingSet = { name: "desk", x: 0, z: 0, w: 1, h: .75, d: .6 };
    assert.equal(stageMaterialOf(plain, expandStageSet(plain)[0]!), "concrete", "an unmarked plain set");
    assert.equal(stageMaterialOf({ ...plain, material: "wood" }, expandStageSet(plain)[0]!), "wood");
    const sofa: StagingSet = { name: "sofa", x: 0, z: 0, w: 2, h: .85, d: .9, kit: { kind: "sofa" } };
    assert.equal(stageMaterialOf(sofa, expandStageSet(sofa)[0]!), "leather", "a kit surface's default");
    assert.ok(StagingSetSchema.safeParse(lobby).success);
    assert.equal(StagingSetSchema.safeParse({ ...plain, material: "velvet" }).success, false);
  });
});

describe("light and atmosphere", () => {
  it("turns a colour temperature into the colour a lamp gives", () => {
    const warm = stageKelvinColour(3200), daylight = stageKelvinColour(6500);
    const [r1, , b1] = [1, 3, 5].map((i) => Number.parseInt(warm.slice(i, i + 2), 16));
    const [r2, g2, b2] = [1, 3, 5].map((i) => Number.parseInt(daylight.slice(i, i + 2), 16));
    assert.match(warm, /^#[0-9a-f]{6}$/);
    assert.ok(r1! > b1!, "tungsten is warm");
    assert.ok(Math.abs(r2! - b2!) < 20 && g2! > 230, "daylight is near white");
  });

  it("dresses an unset scene as a neutral interior and a night as a night", () => {
    assert.equal(stageAtmosphereLook(undefined).shading, true);
    const night = stageAtmosphereLook({ time: "night" });
    assert.ok(night.haze > 0.01, "night carries haze");
    assert.ok(night.exposure > 1);
    assert.equal(stageAtmosphereLook({ time: "night", shading: "off" }).shading, false);
  });

  it("gives the cast six strong colours, none of the old warm ones", () => {
    assert.equal(STAGE_CAST_COLOURS.length, 6);
    assert.equal(STAGE_CAST_COLOURS.includes(0xb08c2e), false, "ochre sat in a warm set");
  });
});
