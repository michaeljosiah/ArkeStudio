import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ProductionSetupDraftSchema, applyProductionSetupUpdate, productionSetupProblems, adaptableStories,
  PRODUCTION_SETUP_BOUNDS, type ProductionSetupDraft,
} from "../src/production-setup.js";

export function draft(): ProductionSetupDraft {
  return ProductionSetupDraftSchema.parse({
    schemaVersion: 1, setupId: "cv_01J8F3K2QW9VZX4N7M0RTYB6HC",
    worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC", revision: 1,
    title: "The crossing", kind: "film", aspect: "16:9", frameRate: 24,
    narrative: { direction: "A return home becomes a decision to leave." },
    arcs: [], references: [], openQuestions: ["Who stays behind?"],
    episodes: [], scenes: [{ key: "arrival", title: "Arrival", synopsis: "The boat returns." }, { key: "departure", title: "Departure" }],
  });
}

describe("conversational production setup (SPEC-012 §4)", () => {
  it("seeds missing microdrama delivery fields while preserving explicit values and clearing", () => {
    const seeded = applyProductionSetupUpdate(draft(), { expectedRevision: 1, fields: { kind: "microdrama" } });
    assert.deepEqual(seeded.defaults, { episodeSecondsMin: 45, episodeSecondsMax: 75, hookWindowSec: 3, exportPreset: "social-1080x1920" });
    const explicit = applyProductionSetupUpdate({ ...draft(), defaults: { hookWindowSec: 2 } }, {
      expectedRevision: 1, fields: { kind: "microdrama", defaults: { episodeSecondsMin: 30, episodeSecondsMax: 45 } },
    });
    assert.deepEqual(explicit.defaults, { episodeSecondsMin: 30, episodeSecondsMax: 45, hookWindowSec: 2, exportPreset: "social-1080x1920" });
    const edited = applyProductionSetupUpdate(explicit, { expectedRevision: 2, fields: { defaults: { episodeSecondsMax: 40 } } });
    assert.deepEqual(edited.defaults, { ...explicit.defaults, episodeSecondsMax: 40 });
    const cleared = applyProductionSetupUpdate(edited, { expectedRevision: 3, fields: { kind: "microdrama", defaults: null } });
    assert.equal(cleared.defaults, undefined);
    assert.equal(applyProductionSetupUpdate(cleared, { expectedRevision: 4, fields: { kind: "microdrama", title: "A new title" } }).defaults, undefined);
    assert.equal(applyProductionSetupUpdate(draft(), { expectedRevision: 1, fields: { kind: "film" } }).defaults, undefined);
  });

  it("retains unmentioned episode promise and scene inheritance fields", () => {
    const before = { ...draft(), episodes: [{ key: "one", title: "One", scenes: ["arrival"],
      promise: { opens: "Return", turn: "Revelation" } }], scenes: [{ key: "arrival", title: "Arrival",
        inherits: { location: "dock", timeOfDay: "Dusk" } }] };
    const after = applyProductionSetupUpdate(before, { expectedRevision: 1,
      episodes: [{ key: "one", promise: { turn: "Departure" } }], scenes: [{ key: "arrival", inherits: { timeOfDay: "Dawn" } }] });
    assert.deepEqual(after.episodes[0]!.promise, { opens: "Return", turn: "Departure" });
    assert.deepEqual(after.scenes[0]!.inherits, { location: "dock", timeOfDay: "Dawn" });
    const unbound = applyProductionSetupUpdate(after, { expectedRevision: 2,
      fields: { openQuestions: ["Where is the crossing?"] }, scenes: [{ key: "arrival", inherits: { location: null } }] });
    assert.deepEqual(unbound.scenes[0]!.inherits, { timeOfDay: "Dawn" });
    assert.equal(unbound.scenes[0]!.key, "arrival");
    assert.deepEqual(unbound.openQuestions, ["Where is the crossing?"]);
    assert.match(productionSetupProblems({ ...draft(), scenes: before.scenes }, []).join(" "), /location/);
    assert.deepEqual(productionSetupProblems({ ...draft(), scenes: unbound.scenes }, []), []);
    const cleared = applyProductionSetupUpdate(unbound, { expectedRevision: 3, scenes: [{ key: "arrival", inherits: null }] });
    assert.equal(cleared.scenes[0]!.inherits, undefined);
    assert.equal(cleared.scenes[0]!.title, "Arrival");
  });

  it("retains unrelated work and stable keys when a scene is revised or renamed", () => {
    const before = draft();
    const after = applyProductionSetupUpdate(before, {
      expectedRevision: 1, scenes: [{ key: before.scenes[0]!.key, title: "A late arrival" }],
    });
    assert.equal(after.revision, 2);
    assert.equal(after.scenes[0]!.key, "arrival");
    assert.equal(after.scenes[0]!.synopsis, "The boat returns.");
    assert.deepEqual(after.scenes[1], before.scenes[1]);
    assert.deepEqual(after.narrative, before.narrative);
    assert.deepEqual(after.openQuestions, before.openQuestions);
    assert.throws(() => applyProductionSetupUpdate(after, { expectedRevision: 1 }), /changed/);
  });

  it("keeps dangling membership visible after withdrawal and refuses review", () => {
    const before = { ...draft(), kind: "microdrama" as const,
      episodes: [{ key: "one", title: "One", scenes: ["arrival", "departure"] }],
      arcs: [{ id: "return", title: "Return", payoff: "one" }],
    };
    const after = applyProductionSetupUpdate(before, { expectedRevision: 1, removeScenes: ["arrival"] });
    assert.match(productionSetupProblems(after, []).join(" "), /removed: arrival/);
    assert.throws(() => applyProductionSetupUpdate(before, { expectedRevision: 1, sceneOrder: ["arrival"] }), /every remaining item/);
    assert.match(productionSetupProblems({ ...before, kind: "film" }, []).join(" "), /owns scenes directly/);
  });

  it("allows partial narrative but blocks guessed dialogue bindings and duplicate scripts", () => {
    assert.deepEqual(productionSetupProblems(draft(), []), []);
    const scene = { ...draft().scenes[0]!, scriptBlocks: [
      { id: "blk_one", kind: "dialogue" as const, speaker: "invented", text: "Hello." },
      { id: "blk_one", kind: "action" as const, text: "Silence." },
    ] };
    const errors = productionSetupProblems({ ...draft(), scenes: [scene] }, []).join(" ");
    assert.match(errors, /speaker/);
    assert.match(errors, /repeats script block/);
  });

  it("accepts the scene cap and refuses one more without truncation", () => {
    const scenes = Array.from({ length: PRODUCTION_SETUP_BOUNDS.scenes }, (_, i) => ({ key: `scene-${i}`, title: `Scene ${i}` }));
    assert.equal(ProductionSetupDraftSchema.parse({ ...draft(), scenes }).scenes.length, scenes.length);
    assert.throws(() => ProductionSetupDraftSchema.parse({ ...draft(), scenes: [...scenes, { key: "extra", title: "Extra" }] }));
    assert.throws(() => ProductionSetupDraftSchema.parse({ ...draft(), scenes: scenes.map(scene => ({ ...scene, synopsis: "界".repeat(2000) })) }), /1 MiB/);
  });

  // Adapt from (design turn 205, SPEC-052 R-1..R-2): the world's stories with chapters, and the
  // one a setup names, kept, cleared and checked.
  const chapter = (id: string, order: number, words: number, retired?: boolean) =>
    ({ id, file: id, order, title: id, status: "draft", version: 1, words, ...(retired ? { retired } : {}) });
  const productions = [
    { meta: { id: "juju", title: "Na love or Juju", format: "story", medium: "story" }, chapters: [chapter("gold", 1, 4000), chapter("suya", 2, 3500), chapter("old", 3, 900, true)] },
    { meta: { id: "empty-book", title: "An empty book", format: "story", medium: "story" }, chapters: [] },
    { meta: { id: "short", title: "A short", format: "video", medium: "video", kind: "film" }, chapters: [chapter("x", 1, 10)] },
  ] as never;

  it("lists the stories with chapters as Adapt from offers them, retired chapters left out", () => {
    assert.deepEqual(adaptableStories(productions), [{ id: "juju", title: "Na love or Juju", kind: "book", chapters: 2, words: 7500 }]);
  });

  it("keeps the source a setup names across other edits, and clears it on null", () => {
    const named = applyProductionSetupUpdate({ ...draft(), kind: "microdrama" }, { expectedRevision: 1, fields: { source: { productionId: "juju" } } });
    assert.deepEqual(named.source, { productionId: "juju" });
    const retitled = applyProductionSetupUpdate(named, { expectedRevision: 2, fields: { title: "Na love or Juju · the drama" } });
    assert.deepEqual(retitled.source, { productionId: "juju" });
    assert.equal(applyProductionSetupUpdate(retitled, { expectedRevision: 3, fields: { source: null } }).source, undefined);
    assert.throws(() => applyProductionSetupUpdate(named, { expectedRevision: 2, fields: { source: { productionId: "Not a slug!" } } }));
  });

  it("names a source on the wrong format, or one no longer in the world, as a problem", () => {
    const sourced = { ...draft(), source: { productionId: "juju" } };
    assert.deepEqual(productionSetupProblems(sourced, [], productions), []);
    assert.match(productionSetupProblems({ ...sourced, kind: "music-video" }, [], productions).join(" "), /Adapt from is for a micro drama or a film/);
    assert.match(productionSetupProblems({ ...sourced, source: { productionId: "empty-book" } }, [], productions).join(" "), /no longer in this world/);
    // Without the world's productions only the format is checked: the client may not hold them yet.
    assert.deepEqual(productionSetupProblems({ ...sourced, source: { productionId: "gone" } }, []), []);
  });
});
