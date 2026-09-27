import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { layoutRouting, routingFindings, type Routing } from "@arke-studio/contracts";
import {
  choiceIdFor,
  findingCounts,
  findingRows,
  fitScale,
  LAYER_GAP,
  mapGeometry,
  NODE_H,
  NODE_W,
  removalConsequences,
  ROW_GAP,
  unwalkedChoices,
} from "../src/lib/branch-map.js";

/**
 * The branch map's picture as numbers (design turn 157): where cards sit, how a choice is drawn
 * between them, and what findings and removals say in a person's words.
 */

const scenes = ["sc_a", "sc_b", "sc_c", "sc_d", "sc_e", "sc_f"].map((id) => ({ id }));
const TITLES: Record<string, string> = {
  sc_a: "The drowned quarter",
  sc_b: "The causeway",
  sc_c: "The bell towers",
  sc_d: "The Vigil",
  sc_e: "The pier at dusk",
  sc_f: "The undertow",
};
const titleOf = (id: string) => TITLES[id] ?? id;

/** Low Water, as turn 157 draws it: a skip-layer arc, two reconvergences, one scene on no route. */
const ROUTING: Routing = {
  version: 12,
  start: "sc_a",
  choices: [
    { id: "ch_follow", from: "sc_a", label: "Follow the lantern", to: "sc_b" },
    { id: "ch_stay", from: "sc_a", label: "Stay with the boat", to: "sc_c" },
    { id: "ch_cross", from: "sc_b", label: "Cross before the tide", to: "sc_c" },
    { id: "ch_wait", from: "sc_b", label: "Wait for low water", to: "sc_d" },
    { id: "ch_sleep", from: "sc_c", label: "Let it sleep", to: "sc_e" },
    { id: "ch_climb", from: "sc_d", label: "Climb to the lamp", to: "sc_e" },
  ],
  endings: [{ sceneId: "sc_e", title: "The harbour, level" }],
  excluded: [],
  groups: [],
};

describe("where the map puts things", () => {
  const geometry = mapGeometry(ROUTING, scenes, layoutRouting(ROUTING, scenes));
  const at = new Map(geometry.nodes.map((node) => [node.id, node]));

  it("lays layers left to right at one pitch, and a layer's rows top to bottom", () => {
    const pitch = NODE_W + LAYER_GAP;
    assert.equal(at.get("sc_b")!.x - at.get("sc_a")!.x, pitch);
    assert.equal(at.get("sc_c")!.x - at.get("sc_b")!.x, pitch, "the bell towers sit a layer on, by longest path");
    assert.equal(at.get("sc_d")!.x, at.get("sc_c")!.x, "the Vigil shares the bell towers' layer");
    assert.equal(at.get("sc_d")!.y - at.get("sc_c")!.y, NODE_H + ROW_GAP, "one row under it");
  });

  it("arcs a choice that skips a layer over the cards between, never through them", () => {
    const arc = geometry.edges.find((edge) => edge.id === "ch_stay")!;
    const over = at.get("sc_b")!;
    assert.ok(arc.ly < over.y, "the label rides above the causeway's card");
    const controlYs = [...arc.d.matchAll(/C[\d.]+,([\d.-]+) [\d.]+,([\d.-]+)/g)].flatMap((m) => [Number(m[1]), Number(m[2])]);
    assert.ok(controlYs.every((y) => y < over.y), "both control points bow above the card it skips");
  });

  it("puts a scene no route reaches in the tray, and draws no choice to or from it", () => {
    assert.deepEqual(geometry.tray, ["sc_f"]);
    assert.ok(!at.has("sc_f"), "it is not placed on the canvas");
    assert.ok(geometry.trayY > Math.max(...geometry.nodes.map((node) => node.y + NODE_H)), "the tray is under the map");
  });

  it("puts an excluded scene the layout does not place in the tray too, with the unreachable ones", () => {
    const withExcluded: Routing = { ...ROUTING, excluded: [{ sceneId: "sc_f", reason: "kept for the audio" }] };
    const g = mapGeometry(withExcluded, scenes, layoutRouting(withExcluded, scenes));
    assert.deepEqual(g.tray, ["sc_f"], "layoutRouting leaves excluded scenes out; the map still shows them");
  });

  it("fits the map to the window and never enlarges it past actual size", () => {
    assert.equal(fitScale(800, 600, 4000, 3000), 1);
    assert.ok(fitScale(2000, 600, 1000, 800) < 0.5);
    assert.ok(fitScale(100000, 100000, 1000, 800) >= 0.2, "a floor, so a huge map is still a picture");
  });
});

describe("what the findings say", () => {
  const findings = routingFindings(ROUTING, scenes, []);
  const rows = findingRows(findings, titleOf, (id) => ROUTING.choices.find((choice) => choice.id === id)?.label ?? id);

  it("names scenes by title and folds every unwalked choice into one row", () => {
    const unwalked = rows.filter((row) => row.kind === "untraversed-edge");
    assert.equal(unwalked.length, 1, "one row for every choice nobody has walked");
    assert.equal(unwalked[0]!.title, "6 choices not walked");
    assert.ok(unwalked[0]!.evidence.includes("Stay with the boat"), "labels, not ids");
    assert.ok(!rows.some((row) => row.kind === "unvisited-route"), "the unvisited-route warning restates it and is folded in");
    const unreachable = rows.find((row) => row.kind === "unreachable")!;
    assert.equal(unreachable.title, "The undertow");
    assert.equal(unreachable.note, "no way in");
  });

  it("lists blocks before warns, and the header counts the same rows", () => {
    const severities = rows.map((row) => row.severity);
    assert.deepEqual(severities, [...severities].sort((a, b) => (a === b ? 0 : a === "blocks" ? -1 : 1)));
    const counts = findingCounts(findings);
    assert.equal(counts.blocks, 7, "the export's own number: the undertow and six unwalked choices, each a finding");
    assert.equal(counts.warns, 2, "the bell towers and the pier each reached two ways; unvisited routes restate the unwalked");
  });

  it("reads walk evidence off the served findings", () => {
    assert.deepEqual([...unwalkedChoices(findings)].sort(), ROUTING.choices.map((choice) => choice.id).sort());
    assert.equal(unwalkedChoices([]).size, 0);
  });
});

describe("what a removal breaks (157e)", () => {
  it("names the scene that loses its only way in", () => {
    assert.deepEqual(removalConsequences(ROUTING, scenes, "ch_wait", titleOf), ["The Vigil — no way in"]);
  });

  it("says nothing when another route still arrives", () => {
    assert.deepEqual(removalConsequences(ROUTING, scenes, "ch_stay", titleOf), [], "the causeway still reaches the bell towers");
  });

  it("names a scene that can no longer reach an ending", () => {
    assert.deepEqual(removalConsequences(ROUTING, scenes, "ch_climb", titleOf), ["The Vigil — can't reach an ending"]);
  });
});

describe("a new choice's id", () => {
  it("comes from its words, unique by suffix", () => {
    assert.equal(choiceIdFor("Take the bell stair", ROUTING), "ch_take-the-bell-stair");
    const taken: Routing = { ...ROUTING, choices: [...ROUTING.choices, { id: "ch_stay-2", from: "sc_a", label: "x", to: "sc_b" }] };
    assert.equal(choiceIdFor("Stay!", { ...taken, choices: [...taken.choices, { id: "ch_stay", from: "sc_a", label: "y", to: "sc_b" }] }), "ch_stay-3");
    assert.equal(choiceIdFor("…", null), "ch_choice", "words with no letters still make an id");
  });
});
