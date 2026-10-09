import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProductionTargetSchema, SEASON_EPISODE_MAX, TARGET_PRESETS, presetLine, presetTarget, targetEnds } from "../src/production-target.js";
import { SeasonSchema } from "../src/world.js";
import { ProductionSetupDraftSchema, applyProductionSetupUpdate } from "../src/production-setup.js";

/** Where a micro drama will be watched (design turn 205, SPEC-052 R-6..R-10). */
describe("the Target and its presets", () => {
  it("fills the Nigerian free vertical preset from the research: 50 of about 90 seconds, free, daily, English with Pidgin", () => {
    const { target, defaults } = presetTarget("nigeria-free-vertical");
    assert.deepEqual(target, { audience: "nigeria-free-vertical", free: "all", release: "daily", language: { dialogue: ["English", "Pidgin"], subtitles: true }, episodeSeconds: 90, episodes: 50 });
    assert.deepEqual(defaults, { episodeCount: 50, episodeSecondsMin: 60, episodeSecondsMax: 90 });
    assert.equal(presetLine("nigeria-free-vertical"), "40–60 × 60–90 s · free");
    assert.equal(presetLine("global-app"), "60–100 × 60–120 s · 8 free");
    assert.equal(presetLine("east-africa"), "30–60 × 2–3 min · free");
  });

  it("never plans a season past fifty episodes, and every preset parses", () => {
    for (const key of Object.keys(TARGET_PRESETS) as Array<keyof typeof TARGET_PRESETS>) {
      const { target, defaults } = presetTarget(key);
      assert.ok(defaults.episodeCount <= SEASON_EPISODE_MAX, key);
      assert.ok(ProductionTargetSchema.safeParse(target).success, key);
      assert.ok(target.episodeSeconds >= defaults.episodeSecondsMin && target.episodeSeconds <= defaults.episodeSecondsMax, key);
    }
  });

  it("says what each row comes to: seasons, minutes, the paywall, the weeks of release, subtitles", () => {
    const { target } = presetTarget("nigeria-free-vertical");
    assert.deepEqual(targetEnds(target), { seasons: "1 season", minutes: "75 min", free: "no paywall", weeks: "8 weeks", language: "subtitled" });
    const global = presetTarget("global-app");
    assert.equal(global.target.episodes, 80, "the whole adaptation");
    assert.equal(global.defaults.episodeCount, 50, "a season holds at most fifty");
    assert.deepEqual(targetEnds(global.target), { seasons: "2 seasons", minutes: "120 min", free: "then paid", weeks: "one drop", language: "" });
    assert.equal(targetEnds({ ...global.target, release: "weekly", episodes: 10 }).weeks, "10 weeks");
  });

  it("is carried by a season, and the strict season refuses a malformed one", () => {
    const { target } = presetTarget("south-africa");
    assert.deepEqual(SeasonSchema.parse({ version: 1, target }).target, target);
    assert.throws(() => SeasonSchema.parse({ version: 1, target: { ...target, audience: "lagos" } }));
  });

  it("seeds a draft becoming a micro drama from the global app preset, keeping explicit defaults, and takes a chosen audience", () => {
    const draft = ProductionSetupDraftSchema.parse({
      schemaVersion: 1, setupId: "cv_01J8F3K2QW9VZX4N7M0RTYB6HC", worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC", revision: 1,
      title: "Na love or Juju", kind: "film", aspect: "16:9", frameRate: 24, narrative: {}, arcs: [], references: [], openQuestions: [], episodes: [], scenes: [],
    });
    const seeded = applyProductionSetupUpdate(draft, { expectedRevision: 1, fields: { kind: "microdrama" } });
    assert.equal(seeded.target?.audience, "global-app");
    assert.deepEqual(seeded.defaults, { episodeSecondsMin: 60, episodeSecondsMax: 120, hookWindowSec: 3, exportPreset: "social-1080x1920", episodeCount: 50 });
    const nigeria = presetTarget("nigeria-free-vertical");
    const chosen = applyProductionSetupUpdate(seeded, { expectedRevision: 2, fields: { target: nigeria.target, defaults: nigeria.defaults } });
    assert.equal(chosen.target?.audience, "nigeria-free-vertical");
    assert.deepEqual(chosen.defaults, { ...seeded.defaults, ...nigeria.defaults });
    const kept = applyProductionSetupUpdate({ ...draft, defaults: { episodeSecondsMax: 45 } }, { expectedRevision: 1, fields: { kind: "microdrama" } });
    assert.equal(kept.defaults?.episodeSecondsMax, 45, "an explicit value the author set survives the seeding");
    const told = applyProductionSetupUpdate(draft, { expectedRevision: 1, fields: { kind: "microdrama", target: nigeria.target } });
    assert.equal(told.target?.audience, "nigeria-free-vertical", "a target named with the format wins over the seed");
    assert.equal(applyProductionSetupUpdate(chosen, { expectedRevision: 3, fields: { target: null } }).target, undefined);
  });
});
