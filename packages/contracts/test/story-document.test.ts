import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { LANTERN_ROAD, LOW_WATER, RING_ONCE, STORY_FIXTURES_DIR, storyFixtureDrift, storyFixtures } from "../scripts/story-fixtures.js";
import {
  compileStoryDocument,
  readStory,
  readWorldManifest,
  RoutingSchema,
  storyAssetIds,
  storyFingerprint,
  storyReplay,
  storyRoutes,
  storyVisibleBeats,
  WorldAssetSchema,
  type StoryCompileInput,
  type StoryDocument,
  type WorldAsset,
} from "../src/index.js";

// SPEC-058 R-79 – R-81: the story cases, which contracts writes (scripts/story-fixtures.ts) and Arke
// Player's arke_world copies to packages/arke_world/test/fixtures/story and runs too: a story
// document read against the inventory, a story package's world.json (schema 6), and every route
// through each public story, which its Dart port of SPEC-063's rules must reproduce step by step.
const read = (name: string) => readFileSync(join(STORY_FIXTURES_DIR, name), "utf8");
const assets: Record<string, WorldAsset> = Object.fromEntries(Object.entries(JSON.parse(read("assets.json")) as Record<string, unknown>).map(([id, raw]) => [id, WorldAssetSchema.parse(raw)]));

interface StoryCase {
  file: string;
  reader: "story" | "manifest";
  expect: "ok" | "newerArke" | "notAPackage";
  kind?: string;
  shape?: string;
  start?: string;
  facts?: string[];
  scenes?: string[];
  choices?: string[];
  routes?: string;
  alone?: boolean;
  story?: string;
  tall?: string;
}

const document = (name: string): StoryDocument => {
  const result = readStory(read(name), assets);
  if (!result.ok) assert.fail(result.reason);
  return result.document;
};

describe("the shared story cases (SPEC-058 R-79 – R-81)", () => {
  for (const entry of (JSON.parse(read("cases.json")) as { cases: StoryCase[] }).cases) {
    it(entry.file, () => {
      const expected = entry.expect === "newerArke" ? "newer-arke" : "not-a-package";
      if (entry.reader === "manifest") {
        const result = readWorldManifest(read(entry.file));
        if (entry.expect !== "ok") {
          assert.equal(result.ok, false);
          if (!result.ok) assert.equal(result.refusal, expected, result.reason);
          return;
        }
        if (!result.ok) assert.fail(result.reason);
        assert.equal(result.manifest.alone === true, entry.alone ?? false);
        assert.equal(result.manifest.productions[0]!.story, entry.story);
        assert.equal(result.manifest.productions[0]!.tall, entry.tall);
        return;
      }
      const result = readStory(read(entry.file), assets);
      if (entry.expect !== "ok") {
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.refusal, expected, result.reason);
        return;
      }
      if (!result.ok) assert.fail(result.reason);
      const story = result.document;
      if (entry.kind !== undefined) assert.equal(story.kind, entry.kind);
      if (entry.shape !== undefined) assert.equal(story.shape, entry.shape);
      if (entry.start !== undefined) assert.equal(story.start, entry.start);
      if (entry.facts !== undefined) assert.deepEqual(story.facts.map((fact) => fact.id), entry.facts);
      if (entry.scenes !== undefined) assert.deepEqual(story.scenes.map((scene) => scene.id), entry.scenes);
      if (entry.choices !== undefined) assert.deepEqual(story.choices.map((choice) => choice.id), entry.choices);
      // The route fixture is what the read document walks to, as the Dart reader must.
      if (entry.routes !== undefined) {
        const fixture = JSON.parse(read(entry.routes)) as { document: string; complete: boolean; bound: unknown; routes: unknown };
        assert.equal(fixture.document, entry.file);
        const walked = storyRoutes(story);
        assert.deepEqual({ complete: fixture.complete, bound: fixture.bound, routes: fixture.routes }, JSON.parse(JSON.stringify(walked)));
      }
    });
  }

  it("is the generator's, byte for byte, so a change to the rules regenerates them (R-81)", () => {
    assert.deepEqual(storyFixtureDrift(), [], "run npx tsx packages/contracts/scripts/story-fixtures.ts");
    assert.ok(storyFixtures().size > 0);
  });

  it("walks every route of the public stories to an ending", () => {
    const counts = Object.fromEntries(["low-water.json", "synthetic.json", "lantern-road.json"].map((name) => {
      const routes = storyRoutes(document(name));
      assert.equal(routes.complete, true);
      assert.ok(routes.routes.every((route) => route.ending !== null && route.steps.length === route.choices.length + 1));
      return [name, [routes.routes.length, new Set(routes.routes.map((route) => `${route.ending!.scene} ${route.ending!.variant}`)).size]];
    }));
    assert.deepEqual(counts, { "low-water.json": [5, 2], "synthetic.json": [19, 4], "lantern-road.json": [5, 2] });
  });

  it("shows a closed choice only with its reason, and its own closed label where it has one (R-85)", () => {
    const routes = storyRoutes(document("synthetic.json")).routes;
    const atBell = (choices: string[]) => routes.find((route) => route.choices.slice(0, 2).join() === choices.join())!.steps[2]!;
    // Ring Once with the key left at the weigh house, in the dark: three open, two closed.
    const dark = atBell(["ch_dark", "ch_leave"]);
    assert.deepEqual(dark.open, ["ch_ring", "ch_wait", "ch_swim"]);
    assert.deepEqual(dark.closed, [
      { id: "ch_key", label: "Use the tenth key", reason: "Left at the weigh house" },
      { id: "ch_signal", label: "Signal the boats", reason: "No light to signal with" },
    ]);
    assert.deepEqual(dark.facts, { key: "left", lamp: false, ledger: false });
    // With the lamp lit, the swim has no reason and is hidden: neither open nor closed.
    const lit = atBell(["ch_light", "ch_leave"]);
    assert.deepEqual(lit.open, ["ch_ring", "ch_signal", "ch_wait"]);
    assert.deepEqual(lit.closed.map((choice) => choice.id), ["ch_key"]);
  });
});

describe("compiling a story for Arke Player (SPEC-058 R-80; SPEC-063 R-27)", () => {
  it("compiles legacy routing with no facts, and leaves out what is the author's", () => {
    const result = compileStoryDocument(LOW_WATER);
    assert.ok(result.ok);
    const story = result.document;
    assert.deepEqual(story.facts, []);
    assert.deepEqual(story.presentation, []);
    assert.ok(story.choices.every((choice) => choice.when === undefined && choice.effects.length === 0 && choice.unavailable === undefined));
    assert.deepEqual(story.endings, [{ scene: "sc_pier", title: "The harbour, level" }, { scene: "sc_bell", title: "The Bell Rings Twice" }]);
    // The undertow is excluded, so neither it nor its clip ships; the groups and revision are the map's.
    assert.equal(story.scenes.some((scene) => scene.id === "sc_undertow"), false);
    assert.equal(storyAssetIds(story).has("lw-undertow"), false);
    assert.equal(JSON.stringify(story).includes("grp_harbour"), false);
    assert.equal("version" in story && story.version, 1);
  });

  it("carries no fact label, and nothing of the editor", () => {
    const result = compileStoryDocument(RING_ONCE);
    assert.ok(result.ok);
    const text = JSON.stringify(result.document);
    for (const label of ["The tenth key", "Lamp lit", "Ledger taken", "sh_", "blk_", "sc_cellar", "Saved for a later cut"]) assert.equal(text.includes(label), false, label);
    assert.ok(result.document.facts.every((fact) => !("label" in fact)));
  });

  it("fingerprints what a listener is given, the same every time (SPEC-063 R-14)", () => {
    const once = compileStoryDocument(RING_ONCE);
    const again = compileStoryDocument(RING_ONCE);
    assert.ok(once.ok && again.ok);
    assert.equal(once.document.fingerprint, again.document.fingerprint);
    assert.equal(once.document.fingerprint, storyFingerprint(once.document));
    const relabelled = compileStoryDocument({ ...RING_ONCE, routing: { ...RING_ONCE.routing, choices: RING_ONCE.routing.choices.map((choice) => (choice.id === "ch_ring" ? { ...choice, label: "Ring it once" } : choice)) } });
    const retimed = compileStoryDocument({ ...RING_ONCE, scenes: { ...RING_ONCE.scenes, sc_vault: { title: "The vault under the tower", clips: [{ asset: "ro-vault", from: 0, to: 41_000, shotId: "sh_vault" }] } } });
    // A fact's label is the author's; renaming it never moves the fingerprint (SPEC-063 R-3).
    const renamed = compileStoryDocument({ ...RING_ONCE, routing: { ...RING_ONCE.routing, facts: RING_ONCE.routing.facts!.map((fact) => ({ ...fact, label: `${fact.label}!` })) } });
    assert.ok(relabelled.ok && retimed.ok && renamed.ok);
    assert.notEqual(relabelled.document.fingerprint, once.document.fingerprint);
    assert.notEqual(retimed.document.fingerprint, once.document.fingerprint);
    assert.equal(renamed.document.fingerprint, once.document.fingerprint);
  });

  it("plays what the web player would play, in every state of every route", () => {
    // The compiled rows are the routing's Show when, moved onto the items they guard: each step's
    // projection matches storyVisibleBeats over the source scene and routing.
    for (const source of [RING_ONCE, LANTERN_ROAD]) {
      const result = compileStoryDocument(source);
      assert.ok(result.ok);
      for (const route of storyRoutes(result.document).routes) {
        route.steps.forEach((step, at) => {
          const scene = source.scenes[step.scene]!;
          const items = (scene.clips ?? scene.beats ?? []).map((item, index) => ({ ...item, index }));
          const state = storyReplay(source.routing, route.choices.slice(0, at)).state;
          assert.deepEqual(storyVisibleBeats(source.routing, step.scene, items, state).map((item) => item.index), step.play, `${route.choices.join(" ")} @ ${step.scene}`);
        });
      }
    }
  });

  it("puts a line's and its shot's conditions together on a beat", () => {
    const result = compileStoryDocument(LANTERN_ROAD);
    assert.ok(result.ok);
    assert.deepEqual(result.document.presentation.filter((row) => row.scene === "sc_road"), [
      { scene: "sc_road", index: 1, when: { op: "eq", fact: "lantern", value: true } },
      { scene: "sc_road", index: 2, when: { op: "all", args: [{ op: "eq", fact: "company", value: "mara" }, { op: "eq", fact: "lantern", value: false }] } },
    ]);
    const ford = result.document.scenes.find((scene) => scene.id === "sc_ford")!;
    assert.deepEqual(ford.beats![1], { picture: "lr-ford", tall: "lr-ford-tall", speaker: "Mara", line: "Go on. I'll find the stones." });
    // A picture held alone has no line.
    assert.deepEqual(result.document.scenes[0]!.beats![2], { picture: "lr-stall" });
  });

  it("opens an all when it joins a line's and a shot's conditions, and names a pair too large together", () => {
    const eqs = (count: number) => Array.from({ length: count }, (_, index) => ({ op: "eq" as const, fact: "company", value: index % 2 === 0 ? "mara" : "alone" }));
    const withRoad = (shot: unknown, line: unknown) => ({
      ...LANTERN_ROAD,
      routing: RoutingSchema.parse({ ...LANTERN_ROAD.routing, presentation: [{ sceneId: "sc_road", blocks: [{ blockId: "blk_road-close", when: line }], shots: [{ shotId: "sh_road-3", when: shot }] }, LANTERN_ROAD.routing.presentation![1]!] }),
    });
    // A shot's all of 60 beside a line's all of 60: one all of 120, inside the bounds.
    const opened = compileStoryDocument(withRoad({ op: "all", args: eqs(60) }, { op: "all", args: eqs(60) }));
    assert.ok(opened.ok, opened.ok ? "" : opened.problems.map((problem) => problem.detail).join("; "));
    const row = opened.document.presentation.find((candidate) => candidate.scene === "sc_road" && candidate.index === 2)!;
    assert.equal(row.when.op === "all" && row.when.args.length, 120);
    // Two of 64 each fit alone and are 129 nodes together, which no document can carry.
    const large = compileStoryDocument(withRoad({ op: "all", args: eqs(64) }, { op: "all", args: eqs(64) }));
    assert.equal(large.ok, false);
    if (!large.ok) assert.deepEqual(large.problems, [{ sceneId: "sc_road", detail: "The road out, beat 3's line and shot conditions are too large together — simplify one of them" }]);
  });

  it("names, by scene, what a document cannot say (R-89; SPEC-063 R-9)", () => {
    const problems = (input: StoryCompileInput) => {
      const result = compileStoryDocument(input);
      return result.ok ? [] : result.problems;
    };
    const { sc_vault: _vault, ...withoutVault } = RING_ONCE.scenes;
    assert.deepEqual(problems({ ...RING_ONCE, scenes: withoutVault }), [{ sceneId: "sc_vault", detail: "sc_vault has nothing to play" }]);
    // A clip cannot leave a line out, nor a shot it does not stand for alone.
    const lined = { ...RING_ONCE, routing: { ...RING_ONCE.routing, presentation: [...RING_ONCE.routing.presentation!, { sceneId: "sc_vault", blocks: [{ blockId: "blk_vault-ledger", when: { op: "eq" as const, fact: "ledger", value: true } }], shots: [] }] } };
    assert.match(problems(lined)[0]!.detail, /shows a line only in some states/);
    const whole = { ...RING_ONCE, scenes: { ...RING_ONCE.scenes, sc_bell: { title: "The bell tower", clips: [{ asset: "ro-bell", from: 0, to: 33_000 }] } } };
    assert.deepEqual(problems(whole).map((problem) => problem.sceneId), ["sc_bell", "sc_bell"]);
    // A beat keeping the picture of a shot shown only sometimes would be shown with none.
    const kept = { ...LANTERN_ROAD, scenes: { ...LANTERN_ROAD.scenes, sc_home: { title: "Home", beats: [...LANTERN_ROAD.scenes["sc_home"]!.beats!, { shotId: "sh_home-3", pictureShotId: "sh_home-2", picture: "lr-home-mara", text: "The lamp stays lit." }] } } };
    assert.match(problems(kept)[0]!.detail, /keeps the picture of a shot shown only in some states/);
    // Under the same condition as the shot it keeps, it always has that picture.
    const keptAlike = { ...kept, routing: { ...LANTERN_ROAD.routing, presentation: LANTERN_ROAD.routing.presentation!.map((entry) => (entry.sceneId === "sc_home" ? { ...entry, shots: [...entry.shots, { shotId: "sh_home-3", when: { op: "eq" as const, fact: "company", value: "mara" } }] } : entry)) } };
    assert.deepEqual(problems(keptAlike), []);
    const blank = { ...LANTERN_ROAD, scenes: { ...LANTERN_ROAD.scenes, sc_bridge: { title: "The old bridge", beats: [{ shotId: "sh_bridge-1", pictureShotId: "sh_bridge-1", text: "Half the boards are gone." }] } } };
    assert.deepEqual(problems(blank), [{ sceneId: "sc_bridge", detail: "The old bridge, beat 1 needs a picture" }]);
    // Whatever the reader would refuse is refused here first.
    const ending = { ...LOW_WATER, routing: { ...LOW_WATER.routing, choices: [...LOW_WATER.routing.choices, { id: "ch_again", from: "sc_pier", to: "sc_quarter", label: "Go again" }] } };
    assert.match(problems(ending)[0]!.detail, /offers a choice/);
  });

  it("leaves out a scene no route reaches, whatever the caller resolved", () => {
    const routing = RoutingSchema.parse({ version: 1, start: "sc_a", choices: [{ id: "ch_go", from: "sc_a", label: "Go", to: "sc_b" }, { id: "ch_lost", from: "sc_c", label: "Back", to: "sc_a" }], endings: [{ sceneId: "sc_b", title: "End" }], excluded: [{ sceneId: "sc_c", reason: "Cut" }], groups: [] });
    const result = compileStoryDocument({ routing, kind: "movie", shape: "16:9", scenes: { sc_a: { title: "A", clips: [{ asset: "a", from: 0, to: 1000 }] }, sc_b: { title: "B", clips: [{ asset: "b", from: 0, to: 1000 }] }, sc_c: { title: "C", clips: [{ asset: "c", from: 0, to: 1000 }] } } });
    assert.ok(result.ok);
    assert.deepEqual(result.document.scenes.map((scene) => scene.id), ["sc_a", "sc_b"]);
    assert.deepEqual(result.document.choices.map((choice) => choice.id), ["ch_go"]);
  });

  it("bounds a walk through a loop rather than running forever", () => {
    const routing = RoutingSchema.parse({ version: 1, start: "sc_a", choices: [{ id: "ch_round", from: "sc_a", label: "Round", to: "sc_a" }, { id: "ch_out", from: "sc_a", label: "Out", to: "sc_b" }], endings: [{ sceneId: "sc_b", title: "Out" }], excluded: [], groups: [] });
    const result = compileStoryDocument({ routing, kind: "movie", shape: "16:9", scenes: { sc_a: { title: "A", clips: [{ asset: "a", from: 0, to: 1000 }] }, sc_b: { title: "B", clips: [{ asset: "b", from: 0, to: 1000 }] } } });
    assert.ok(result.ok);
    const walked = storyRoutes(result.document, { choices: 3 });
    assert.equal(walked.complete, false);
    assert.deepEqual(walked.bound, { choices: 3, routes: 100_000 });
    assert.deepEqual(walked.routes.map((route) => [route.choices.join(" "), route.ending?.title ?? null]), [
      ["ch_round ch_round ch_round", null],
      ["ch_round ch_round ch_out", "Out"],
      ["ch_round ch_out", "Out"],
      ["ch_out", "Out"],
    ]);
  });
});
