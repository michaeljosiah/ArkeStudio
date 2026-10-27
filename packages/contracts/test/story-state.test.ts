import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RoutingSchema, routingFindings } from "../src/routing.js";
import { exploreStory, storyReplay, storyIdentity, storyEnding, storyVisibleBeats } from "../src/story-state.js";

const routing = () => RoutingSchema.parse({
  schemaVersion: 2, version: 1, start: "sc_bore", facts: [{ id: "elsie", label: "Elsie Ward", type: "enum", values: ["Alive", "Lost"], default: "Alive" }],
  choices: [
    { id: "ch_save", from: "sc_bore", to: "sc_collar", label: "Rescue Elsie" },
    { id: "ch_seal", from: "sc_bore", to: "sc_collar", label: "Seal the bore", effects: [{ fact: "elsie", value: "Lost" }] },
    { id: "ch_aux", from: "sc_collar", to: "sc_escape", label: "Ask Elsie", when: { op: "eq", fact: "elsie", value: "Alive" } },
    { id: "ch_manual", from: "sc_collar", to: "sc_escape", label: "Manual release" },
  ],
  presentation: [{ sceneId: "sc_collar", shots: [], blocks: [{ blockId: "blk_elsie", when: { op: "eq", fact: "elsie", value: "Alive" } }] }],
  endings: [{ sceneId: "sc_escape", title: "Above the Quiet", variants: [
    { id: "together", title: "Together", text: "Elsie is aboard.", when: { op: "eq", fact: "elsie", value: "Alive" } },
    { id: "empty", title: "An empty seat", text: "Elsie was lost at the bore.", fallback: true },
  ] }], excluded: [], groups: [],
});

describe("remembered story rules (SPEC-063)", () => {
  it("fingerprints canonical UTF-8 content with the same SHA-256 as Node", () => {
    for (const value of [null, "", "林 · Ana Lucía", "a".repeat(1000), { a: [true, "Alive"], z: "Lost" }]) {
      const expected = "sha256:" + createHash("sha256").update(JSON.stringify(value)).digest("hex");
      assert.equal(storyIdentity(value), expected);
    }
    assert.equal(storyIdentity({ b: 2, a: 1 }), storyIdentity({ a: 1, b: 2 }));
  });
  it("rejoins one scene with different facts; rewinding restores defaults and origins", () => {
    const r = routing();
    assert.deepEqual(storyReplay(r, ["ch_seal"]).state, { elsie: "Lost" });
    assert.equal(storyReplay(r, ["ch_seal"]).origins.elsie, "ch_seal");
    assert.throws(() => storyReplay(r, ["ch_seal", "ch_aux"]), /Invalid route/);
    assert.deepEqual(storyReplay(r, ["ch_save", "ch_aux"]).state, { elsie: "Alive" });
    assert.equal(storyReplay(r).origins.elsie, null);
    assert.throws(() => storyReplay(r, ["ch_manual"]), /Invalid route/);
  });
  it("hides an inactive block, its caption and its voice as one beat", () => {
    const r = routing();
    const beats = [{ blockId: "blk_elsie", text: "I can help", audio: "elsie.mp3" }, { blockId: "blk_imani", text: "Move" }];
    assert.deepEqual(storyVisibleBeats(r, "sc_collar", beats, { elsie: "Lost" }), [beats[1]]);
    assert.equal(storyVisibleBeats(r, "sc_collar", beats, { elsie: "Alive" }).length, 2);
    r.presentation![0]!.shots = [{ shotId: "sh_portrait", when: { op: "eq", fact: "elsie", value: "Alive" } }];
    const kept = storyVisibleBeats(r, "sc_collar", [{ shotId: "sh_next", pictureShotId: "sh_portrait", picture: "elsie.png", keep: true, text: "Imani speaks", audio: "imani.mp3" }], { elsie: "Lost" });
    assert.equal(kept[0]!.picture, undefined);
    assert.equal(kept[0]!.keep, undefined);
    assert.equal(kept[0]!.audio, "imani.mp3", "the active line keeps its own voice");
    assert.equal(storyEnding(r, "sc_escape", { elsie: "Lost" })?.title, "An empty seat");
  });
  it("refuses unknown facts, invalid enum values, duplicate writes and unversioned rules", () => {
    const r = routing();
    for (const bad of [
      { ...r, schemaVersion: undefined },
      { ...r, facts: [] },
      { ...r, choices: [{ ...r.choices[1], effects: [{ fact: "elsie", value: "dead" }] }] },
      { ...r, choices: [{ ...r.choices[1], effects: [{ fact: "elsie", value: "Lost" }, { fact: "elsie", value: "Alive" }] }] },
    ]) assert.equal(RoutingSchema.safeParse(bad).success, false);
    let when: unknown = { op: "eq", fact: "elsie", value: "Alive" };
    for (let i = 0; i < 9; i++) when = { op: "not", arg: when };
    assert.equal(RoutingSchema.safeParse({ ...r, choices: [{ ...r.choices[0], when }] }).success, false);
  });
  it("explores scene/state pairs and reports bounded incompleteness", () => {
    const r = routing(), graph = exploreStory(r);
    assert.equal(graph.complete, true);
    assert.equal(graph.points.filter(p => p.sceneId === "sc_collar").length, 2);
    assert.deepEqual(graph.problems, []);
    assert.equal(exploreStory(r, { states: 2 }).complete, false);
    assert.equal(exploreStory(r, { transitions: 1 }).complete, false);
    const overlap = { ...r, endings: [{ ...r.endings[0]!, variants: [r.endings[0]!.variants![0]!, { ...r.endings[0]!.variants![0]!, id: "duplicate" }] }] };
    assert.ok(exploreStory(overlap).problems.some(p => p.detail.includes("Overlapping")));
  });
  it("one traversal cannot cover the same edge from a different pre-state", () => {
    const r = routing(), prefix = ["ch_save"], before = storyReplay(r, prefix), after = storyReplay(r, [...prefix, "ch_manual"]);
    const evidence = { ts: "2026-10-27T12:00:00.000Z", routingVersion: 1, choiceId: "ch_manual", from: "sc_collar", to: "sc_escape", route: ["sc_bore", "sc_collar"], story: { identity: storyIdentity(r), prefix, before: storyIdentity(before.state), after: storyIdentity(after.state), provenance: "human" as const } };
    const findings = routingFindings(r, ["sc_bore", "sc_collar", "sc_escape"].map(id => ({ id })), [evidence]);
    assert.equal(findings.filter(f => f.kind === "untraversed-edge" && f.choiceIds.includes("ch_manual")).length, 1);
    const stale = { ...r, version: 2 };
    assert.equal(routingFindings(stale, [], [evidence]).filter(f => f.kind === "untraversed-edge" && f.choiceIds.includes("ch_manual")).length, 2);
  });
});
