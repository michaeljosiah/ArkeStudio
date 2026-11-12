import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RoutingSchema, routingFindings, carryTraversalEvidence } from "../src/routing.js";
import { exploreStory, storyReplay, storyIdentity, storyEnding, storyLinkSteps, storyLinks, storyLoneChoice, storyVisibleBeats } from "../src/story-state.js";

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
  it("identifies an ending with choices as a repairable scene finding (#2238)", () => {
    const r = routing();
    r.endings.push({ sceneId: "sc_bore", title: "Too soon" });
    const finding = routingFindings(r, ["sc_bore", "sc_collar", "sc_escape"].map(id => ({ id }))).find(f => f.kind === "ending-with-choices");
    assert.ok(finding);
    assert.deepEqual(finding.sceneIds, ["sc_bore"]);
    assert.deepEqual(finding.choiceIds, ["ch_save", "ch_seal"]);
    assert.equal(finding.severity, "blocks");
  });
  it("permits authored unavailable reasons only in stateful routing and rejects empty reasons", () => {
    const r=routing();
    r.choices[2]!.unavailable={reason:"Elsie’s measurements are needed."};
    assert.ok(RoutingSchema.safeParse(r).success);
    assert.equal(RoutingSchema.safeParse({...r,schemaVersion:undefined}).success,false);
    r.choices[2]!.unavailable={reason:"   "};
    assert.equal(RoutingSchema.safeParse(r).success,false);
  });
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
  it("bounds retained witness memory before a long state-changing loop can exhaust the heap", () => {
    const facts = Array.from({ length: 17 }, (_, i) => ({ id: `bit-${i}`, label: `Bit ${i}`, type: "boolean", default: false }));
    const program = RoutingSchema.parse({ schemaVersion: 2, version: 1, start: "sc_loop", facts,
      choices: [...facts.map((fact, i) => ({ id: `ch_inc-${i}`, from: "sc_loop", to: "sc_loop", label: `Increment ${i}`,
        when: { op: "all", args: [{ op: "eq", fact: fact.id, value: false }, ...facts.slice(0, i).map(f => ({ op: "eq", fact: f.id, value: true }))] },
        effects: [{ fact: fact.id, value: true }, ...facts.slice(0, i).map(f => ({ fact: f.id, value: false }))] })),
        { id: "ch_exit", from: "sc_loop", to: "sc_end", label: "Exit" }],
      endings: [{ sceneId: "sc_end", title: "Exit" }], excluded: [], groups: [],
    });
    const graph = exploreStory(program, { witnessEntries: 2000 });
    assert.equal(graph.complete, false);
    assert.equal(graph.limit, "witness");
    assert.ok(graph.points.reduce((total, point) => total + point.prefix.length, 0) <= 2000);
    assert.ok(graph.points.length < 200);
  });
  it("one traversal cannot cover the same edge from a different pre-state", () => {
    const r = routing(), prefix = ["ch_save"], before = storyReplay(r, prefix), after = storyReplay(r, [...prefix, "ch_manual"]);
    const evidence = { ts: "2026-10-27T12:00:00.000Z", routingVersion: 1, choiceId: "ch_manual", from: "sc_collar", to: "sc_escape", route: ["sc_bore", "sc_collar"], story: { identity: storyIdentity(r), prefix, before: storyIdentity(before.state), after: storyIdentity(after.state), provenance: "human" as const } };
    const findings = routingFindings(r, ["sc_bore", "sc_collar", "sc_escape"].map(id => ({ id })), [evidence]);
    assert.equal(findings.filter(f => f.kind === "untraversed-edge" && f.choiceIds.includes("ch_manual")).length, 1);
    const uncovered = findings.find(f => f.kind === "untraversed-edge" && f.choiceIds.includes("ch_manual"))!;
    assert.ok(uncovered.witnessPrefix);
    assert.equal(storyReplay(r,uncovered.witnessPrefix).sceneId,"sc_collar");
    assert.notDeepEqual(storyReplay(r,uncovered.witnessPrefix).state,before.state,"the witness represents the other pre-state");
    const stale = { ...r, version: 2 };
    assert.equal(routingFindings(stale, [], [evidence]).filter(f => f.kind === "untraversed-edge" && f.choiceIds.includes("ch_manual")).length, 2);
  });
  it("carries verified walks across unused facts and ending edits, but not changed story rules (#2238)", () => {
    const r = routing(), prefix = ["ch_save"], before = storyReplay(r, prefix), after = storyReplay(r, [...prefix, "ch_manual"]);
    const evidence = { ts: "2026-10-27T12:00:00.000Z", routingVersion: 1, choiceId: "ch_manual", from: "sc_collar", to: "sc_escape", route: ["sc_bore", "sc_collar"], story: { identity: storyIdentity(r), prefix, before: storyIdentity(before.state), after: storyIdentity(after.state), provenance: "human" as const } };
    const current = { ...r, version: 2, endings: [], facts: [...r.facts!, { id: "unused", label: "Unused", type: "boolean" as const, default: false }] };
    const carried = carryTraversalEvidence(evidence, r, current);
    assert.ok(carried);
    assert.equal(carried.story!.provenance, "human");
    assert.equal(carried.routingVersion, 1, "the original walk's version is retained");
    assert.equal(routingFindings(current, [], [carried]).filter(f => f.kind === "untraversed-edge" && f.choiceIds.includes("ch_manual")).length, 1, "the other pre-state still needs its own walk");
    for (const changed of [
      { ...current, start: "sc_collar" },
      { ...current, choices: current.choices.map(c => c.id === "ch_manual" ? { ...c, to: "sc_bore" } : c) },
      { ...current, choices: current.choices.map(c => c.id === "ch_manual" ? { ...c, when: { op: "eq" as const, fact: "unused", value: false } } : c) },
      { ...current, choices: current.choices.map(c => c.id === "ch_save" ? { ...c, effects: [{ fact: "elsie", value: "Lost" }] } : c) },
    ]) assert.equal(carryTraversalEvidence(evidence, r, changed), null);
    assert.equal(carryTraversalEvidence({ ...evidence, story: { ...evidence.story, before: "corrupt" } }, r, current), null);
    assert.equal(carryTraversalEvidence(evidence, current, current), null, "a mismatched historical identity cannot vouch for the original walk");
  });
});

/**
 * A lone way (SPEC-063 R-11a, turn 246): a state with exactly one open choice and no closed choice
 * shown with its reason. The routing below is First Contact's shape in small — scenes that run on
 * by one way each, a crew member's fate decided at a choice of two, and a later scene whose second
 * way opens only while that crew member lives — with First Contact's own words for its ways on.
 */
const firstContact = () => RoutingSchema.parse({
  schemaVersion: 2, version: 4, start: "sc_fc-01", facts: [{ id: "elsie", label: "Elsie Ward", type: "enum", values: ["Alive", "Lost"], default: "Alive" }],
  choices: [
    { id: "ch_markers", from: "sc_fc-01", to: "sc_fc-02", label: "Go to the landing markers" },
    { id: "ch_weeks", from: "sc_fc-02", to: "sc_fc-03", label: "Several weeks later" },
    { id: "ch_wall", from: "sc_fc-03", to: "sc_fc-04", label: "Check the lower inspection wall" },
    { id: "ch_landing", from: "sc_fc-04", to: "sc_fc-05", label: "Reach the evacuation landing" },
    { id: "ch_return", from: "sc_fc-05", to: "sc_fc-06", label: "Return with Ana for Elsie" },
    { id: "ch_seal", from: "sc_fc-05", to: "sc_fc-06", label: "Seal the shaft and leave Elsie", effects: [{ fact: "elsie", value: "Lost" }] },
    { id: "ch_cage", from: "sc_fc-06", to: "sc_fc-07", label: "Check the jammed cage" },
    { id: "ch_ask", from: "sc_fc-07", to: "sc_fc-08", label: "Ask Elsie for the bypass", when: { op: "eq", fact: "elsie", value: "Alive" } },
    { id: "ch_board", from: "sc_fc-07", to: "sc_fc-08", label: "Reach the emergency control board" },
  ],
  endings: [{ sceneId: "sc_fc-08", title: "Above the Quiet" }], excluded: [], groups: [],
});

describe("a lone way plays through (SPEC-063 R-11a)", () => {
  it("is the one open choice, unless a closed one is shown with its reason", () => {
    const r = firstContact();
    const alive = storyReplay(r).state, lost = storyReplay(r, ["ch_markers", "ch_weeks", "ch_wall", "ch_landing", "ch_seal"]).state;
    assert.equal(storyLoneChoice(r.choices, "sc_fc-02", alive)?.id, "ch_weeks", "Several weeks later is the only way on");
    assert.equal(storyLoneChoice(r.choices, "sc_fc-05", alive), undefined, "a choice of two is a decision");
    assert.equal(storyLoneChoice(r.choices, "sc_fc-07", alive), undefined, "two open while Elsie lives");
    assert.equal(storyLoneChoice(r.choices, "sc_fc-07", lost)?.id, "ch_board", "one open, the other hidden: a lone way");
    const shown = r.choices.map(c => c.id === "ch_ask" ? { ...c, unavailable: { reason: "Elsie is lost." } } : c);
    assert.equal(storyLoneChoice(shown, "sc_fc-07", lost), undefined, "a closed choice shown with its reason counts as one of the two");
    assert.equal(storyLoneChoice(r.choices, "sc_fc-08", alive), undefined, "an ending has none");
  });

  it("names the links: lone in every state is a link; lone on some routes keeps its pill", () => {
    const links = storyLinks(firstContact());
    assert.deepEqual(Object.fromEntries([...links].sort()), {
      ch_board: "sometimes", ch_cage: "always", ch_landing: "always", ch_markers: "always", ch_wall: "always", ch_weeks: "always",
    });
    const legacy = RoutingSchema.parse({ version: 1, start: "sc_a", choices: [
      { id: "ch_on", from: "sc_a", to: "sc_b", label: "On" },
      { id: "ch_left", from: "sc_b", to: "sc_c", label: "Left" }, { id: "ch_right", from: "sc_b", to: "sc_c", label: "Right" },
    ], endings: [{ sceneId: "sc_c", title: "End" }], excluded: [], groups: [] });
    assert.deepEqual([...storyLinks(legacy)], [["ch_on", "always"]], "a routing without story rules has links too");
    const graph = exploreStory(firstContact(), { states: 3 });
    assert.equal(graph.complete, false);
    assert.ok(![...storyLinks(firstContact(), graph).values()].includes("always"), "an exploration cut short never vouches for every state");
  });

  it("tells a route's links from its choices in one walk, however long the route (codex on PR 2228)", () => {
    const r = firstContact();
    assert.deepEqual(storyLinkSteps(r, ["ch_markers", "ch_weeks", "ch_wall", "ch_landing", "ch_seal", "ch_cage", "ch_board"]), [true, true, true, true, false, true, true]);
    assert.deepEqual(storyLinkSteps(r, ["ch_markers", "ch_weeks", "ch_wall", "ch_landing", "ch_return", "ch_cage", "ch_board"]).slice(-1), [false], "while Elsie lives the board is a choice");
    assert.throws(() => storyLinkSteps(r, ["ch_weeks"]), /Invalid route/);
    const n = 2000;
    const chain = RoutingSchema.parse({ version: 1, start: "sc_c-0", choices: Array.from({ length: n }, (_, i) => ({ id: `ch_c-${i}`, from: `sc_c-${i}`, to: `sc_c-${i + 1}`, label: "On" })), endings: [{ sceneId: `sc_c-${n}`, title: "End" }], excluded: [], groups: [] });
    const started = performance.now();
    const steps = storyLinkSteps(chain, chain.choices.map((choice) => choice.id));
    assert.equal(steps.length, n);
    assert.ok(steps.every(Boolean));
    assert.ok(performance.now() - started < 2000, "a 2,000-step route does not freeze an ending");
  });

  it("stays a step of the route: a link with effects replays, and its walk counts as a press's", () => {
    const r = firstContact();
    const prefix = ["ch_markers", "ch_weeks", "ch_wall", "ch_landing", "ch_seal", "ch_cage", "ch_board"];
    assert.equal(storyReplay(r, prefix).sceneId, "sc_fc-08", "played-through links replay as steps");
    const before = storyReplay(r, ["ch_markers"]), after = storyReplay(r, ["ch_markers", "ch_weeks"]);
    const evidence = { ts: "2026-10-28T12:00:00.000Z", routingVersion: 4, choiceId: "ch_weeks", from: "sc_fc-02", to: "sc_fc-03", route: ["sc_fc-01", "sc_fc-02"], story: { identity: storyIdentity(r), prefix: ["ch_markers"], before: storyIdentity(before.state), after: storyIdentity(after.state), provenance: "human" as const } };
    const scenes = Array.from({ length: 8 }, (_, i) => ({ id: `sc_fc-0${i + 1}` }));
    const walked = routingFindings(r, scenes, [evidence]);
    assert.ok(!walked.some(f => f.kind === "untraversed-edge" && f.choiceIds.includes("ch_weeks")), "Several weeks later, played through, is walked");
    assert.ok(routingFindings(r, scenes).some(f => f.kind === "untraversed-edge" && f.choiceIds.includes("ch_weeks")), "and not before");
    assert.ok(!walked.some(f => /lone|only one/i.test(f.detail)), "a lone way is not a finding");
  });
});
