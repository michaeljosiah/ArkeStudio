import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ProductionSetupDraftSchema, applyProductionSetupUpdate, productionSetupProblems, adaptableStories,
  PRODUCTION_SETUP_BOUNDS, type ProductionSetupDraft,
} from "../src/production-setup.js";
import { AudioDramaPlanSchema } from "../src/audio-drama.js";

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
  // The seeded numbers are the global app preset's since SPEC-052 R-6 amended R-VSETUP-5.
  it("seeds missing microdrama delivery fields while preserving explicit values and clearing", () => {
    const seeded = applyProductionSetupUpdate(draft(), { expectedRevision: 1, fields: { kind: "microdrama" } });
    assert.deepEqual(seeded.defaults, { episodeSecondsMin: 60, episodeSecondsMax: 120, hookWindowSec: 3, exportPreset: "social-1080x1920", episodeCount: 50 });
    const explicit = applyProductionSetupUpdate({ ...draft(), defaults: { hookWindowSec: 2 } }, {
      expectedRevision: 1, fields: { kind: "microdrama", defaults: { episodeSecondsMin: 30, episodeSecondsMax: 45 } },
    });
    assert.deepEqual(explicit.defaults, { episodeSecondsMin: 30, episodeSecondsMax: 45, hookWindowSec: 2, exportPreset: "social-1080x1920", episodeCount: 50 });
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

  it("never offers an audio drama as a story to adapt (SPEC-057 R-82)", () => {
    const withDrama = [...(productions as unknown as unknown[]), {
      meta: { id: "juju-drama", title: "Juju, for the ear", format: "story", medium: "story", kind: "audio-drama" },
      chapters: [chapter("stray", 1, 100)],
    }] as never;
    assert.deepEqual(adaptableStories(withDrama).map((story) => story.id), ["juju"]);
  });

  it("starts an audio drama from the default plan, and keeps the plan Arke proposes (SPEC-057 D-2, R-7)", () => {
    const becoming = applyProductionSetupUpdate(draft(), { expectedRevision: 1, fields: { kind: "audio-drama" } });
    assert.deepEqual(becoming.audioDrama, { episodes: 6, minutes: 25, keptFromListener: [] });
    const planned = applyProductionSetupUpdate(becoming, { expectedRevision: 2, fields: { audioDrama: {
      episodes: 6, minutes: 25, narrator: "narrated",
      keptFromListener: [{ fact: "Ilo is alive", revealEpisode: 5 }],
      pilot: { title: "The tide turns", chapters: [3] },
    } } });
    assert.equal(planned.audioDrama?.narrator, "narrated");
    assert.equal(planned.audioDrama?.keptFromListener[0]?.revealEpisode, 5);
    const retitled = applyProductionSetupUpdate(planned, { expectedRevision: 3, fields: { title: "Low Water" } });
    assert.deepEqual(retitled.audioDrama, planned.audioDrama, "other edits keep the plan");
    assert.equal(applyProductionSetupUpdate(retitled, { expectedRevision: 4, fields: { audioDrama: null } }).audioDrama, undefined);
    assert.throws(() => applyProductionSetupUpdate(planned, { expectedRevision: 3, fields: { audioDrama: { episodes: 0, minutes: 25, keptFromListener: [] } } }));
  });

  it("holds the narrator question's two samples while it is asked, and lets them go with the kind or the story (230c, issue 1882)", () => {
    const samples = {
      narrated: [{ speaker: "Narrator", words: "Far off, the harbour bell struck once." }, { speaker: "Maren", words: "The log said two hours." }],
      inTheRoom: [{ speaker: "Sound", words: "One stroke of the harbour bell.", cue: true as const }, { speaker: "Maren", words: "The log said two hours." }],
    };
    const drama = applyProductionSetupUpdate(draft(), { expectedRevision: 1, fields: { kind: "audio-drama" } });
    const asked = applyProductionSetupUpdate(drama, { expectedRevision: 2, fields: { narratorSamples: samples } });
    assert.deepEqual(asked.narratorSamples, samples);
    assert.deepEqual(applyProductionSetupUpdate(asked, { expectedRevision: 3, fields: { title: "Low Water" } }).narratorSamples, samples, "other edits keep them");
    assert.equal(applyProductionSetupUpdate(asked, { expectedRevision: 3, fields: { narratorSamples: null } }).narratorSamples, undefined);
    assert.equal(applyProductionSetupUpdate(asked, { expectedRevision: 3, fields: { kind: "film" } }).narratorSamples, undefined, "a film asks no narrator question");
    assert.throws(() => applyProductionSetupUpdate(drama, { expectedRevision: 2, fields: { narratorSamples: { narrated: [samples.narrated[0]!], inTheRoom: samples.inTheRoom } } }), "two lines at least, each way");
  });

  it("an audio drama's pilot names chapters its story has, and an original names none (SPEC-057 R-7)", () => {
    const plan = (chapters: number[]) => ({ episodes: 6, minutes: 25, keptFromListener: [], pilot: { title: "The tide turns", chapters } });
    const adapting = { ...draft(), kind: "audio-drama" as const, scenes: [], source: { productionId: "juju" } };
    assert.deepEqual(productionSetupProblems({ ...adapting, audioDrama: plan([2]) }, [], productions), []);
    assert.match(productionSetupProblems({ ...adapting, audioDrama: plan([3, 999]) }, [], productions).join(" "),
      /pilot names chapter 3, 999, which the story does not have/, "a retired chapter is no longer the story's");
    const original = { ...draft(), kind: "audio-drama" as const, scenes: [] };
    assert.deepEqual(productionSetupProblems({ ...original, audioDrama: plan([]) }, []), []);
    assert.match(productionSetupProblems({ ...original, audioDrama: plan([1]) }, []).join(" "), /original drama's pilot names no chapters/);
  });

  it("a changed Adapt from returns an audio drama to the default plan; the same one keeps it", () => {
    const planned = { episodes: 4, minutes: 30, narrator: "narrated" as const, keptFromListener: [{ fact: "Ilo is alive", revealEpisode: 3 }], pilot: { title: "Gold", chapters: [1] } };
    const drama = { ...draft(), kind: "audio-drama" as const, scenes: [], source: { productionId: "juju" }, audioDrama: planned };
    assert.deepEqual(applyProductionSetupUpdate(drama, { expectedRevision: 1, fields: { source: { productionId: "other" } } }).audioDrama,
      { episodes: 6, minutes: 25, keptFromListener: [] }, "a plan read from one story is not a plan for another");
    assert.deepEqual(applyProductionSetupUpdate(drama, { expectedRevision: 1, fields: { source: null } }).audioDrama,
      { episodes: 6, minutes: 25, keptFromListener: [] });
    assert.deepEqual(applyProductionSetupUpdate(drama, { expectedRevision: 1, fields: { source: { productionId: "juju" } } }).audioDrama, planned);
    assert.deepEqual(applyProductionSetupUpdate(drama, { expectedRevision: 1, fields: { source: { productionId: "other" }, audioDrama: planned } }).audioDrama,
      planned, "a plan sent with the new story is that story's");
  });

  it("a secret is revealed in one of the plan's episodes, even when the count is lowered", () => {
    assert.throws(() => AudioDramaPlanSchema.parse({ episodes: 6, minutes: 25, keptFromListener: [{ fact: "Ilo is alive", revealEpisode: 200 }] }),
      /revealed in episode 200, but the plan has 6/);
    const planned = { episodes: 6, minutes: 25, keptFromListener: [{ fact: "Ilo is alive", revealEpisode: 5 }] };
    const drama = { ...draft(), kind: "audio-drama" as const, scenes: [], audioDrama: planned };
    assert.throws(() => applyProductionSetupUpdate(drama, { expectedRevision: 1, fields: { audioDrama: { ...planned, episodes: 4 } } }), /revealed in episode 5/);
    assert.equal(applyProductionSetupUpdate(drama, { expectedRevision: 1, fields: { audioDrama: { ...planned, episodes: 5 } } }).audioDrama?.episodes, 5);
  });

  it("a pilot names each chapter once", () => {
    assert.throws(() => AudioDramaPlanSchema.parse({ episodes: 6, minutes: 25, pilot: { title: "Gold", chapters: [3, 3] } }), /each chapter once/);
    assert.deepEqual(AudioDramaPlanSchema.parse({ episodes: 6, minutes: 25, pilot: { title: "Gold", chapters: [3, 4] } }).pilot?.chapters, [3, 4]);
  });

  it("an audio drama holds no video scenes, episodes, arcs or Series (SPEC-057 R-7)", () => {
    const drama = { ...draft(), kind: "audio-drama" as const, scenes: [] };
    assert.deepEqual(productionSetupProblems(drama, []), []);
    const withScene = { ...drama, scenes: [{ key: "s1", title: "One" }] };
    assert.match(productionSetupProblems(withScene, []).join(" "), /audio drama plans its episodes in its own plan/);
    assert.doesNotMatch(productionSetupProblems(withScene, []).join(" "), /owns scenes directly/);
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
    assert.match(productionSetupProblems({ ...sourced, kind: "music-video" }, [], productions).join(" "), /Adapt from is for a micro drama, a film or an audio drama/);
    assert.deepEqual(productionSetupProblems({ ...sourced, kind: "audio-drama", scenes: [] }, [], productions), [], "an audio drama adapts a story too (SPEC-057 R-2)");
    assert.match(productionSetupProblems({ ...sourced, source: { productionId: "empty-book" } }, [], productions).join(" "), /no longer in this world/);
    // Without the world's productions only the format is checked: the client may not hold them yet.
    assert.deepEqual(productionSetupProblems({ ...sourced, source: { productionId: "gone" } }, []), []);
  });
});
