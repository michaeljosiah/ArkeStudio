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

  it("keeps a skip-layer arc from the first row inside the map, above the cards it skips", () => {
    const arc = geometry.edges.find((edge) => edge.id === "ch_stay")!;
    assert.ok(arc.ly >= 28, "its label sits inside the top of the map, not above y=0");
    assert.ok(arc.ly < at.get("sc_b")!.y, "and still over the causeway's card");
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

  it("bounds the map by its curves too, so a loop back is never clipped", () => {
    const looped: Routing = { ...ROUTING, choices: [...ROUTING.choices, { id: "ch_back", from: "sc_e", label: "Go back", to: "sc_a" }] };
    const g = mapGeometry(looped, scenes, layoutRouting(looped, scenes));
    const back = g.edges.find((edge) => edge.id === "ch_back")!;
    assert.ok(g.trayY > back.ly + 12, "the tray starts under the loop's label, not across it");
    assert.ok(g.width >= back.lx + 64, "and the width holds it");

    // One row and no tray: the loop bows under the only cards there are, and the height holds it.
    const pair = [{ id: "sc_a" }, { id: "sc_b" }];
    const twoWay: Routing = {
      ...ROUTING,
      choices: [
        { id: "ch_there", from: "sc_a", label: "There", to: "sc_b" },
        { id: "ch_back", from: "sc_b", label: "Back", to: "sc_a" },
      ],
      endings: [],
    };
    const small = mapGeometry(twoWay, pair, layoutRouting(twoWay, pair));
    const loop = small.edges.find((edge) => edge.id === "ch_back")!;
    assert.equal(small.tray.length, 0);
    assert.ok(loop.ly > Math.max(...small.nodes.map((node) => node.y + NODE_H)), "the loop bows under the cards");
    assert.ok(small.height >= loop.ly + 12, "and the map's height holds its label");
  });

  it("draws a choice from a tray scene, and holds the whole tray in the map's width", () => {
    // Drawn from the undertow while no route reaches it (the Inspector offers "Draw a choice from here").
    const fromTray: Routing = { ...ROUTING, choices: [...ROUTING.choices, { id: "ch_drift", from: "sc_f", label: "Drift in", to: "sc_e" }] };
    const g = mapGeometry(fromTray, scenes, layoutRouting(fromTray, scenes));
    assert.deepEqual(g.tray, ["sc_f"]);
    const drift = g.edges.find((edge) => edge.id === "ch_drift");
    assert.ok(drift, "the choice is drawn, so it can be seen, walked and removed");
    assert.ok(drift.d.startsWith(`M${g.trayNodes[0]!.x + NODE_W},`), "out of the tray card's port");

    const many = Array.from({ length: 9 }, (_, n) => ({ id: `sc_t${n}` }));
    const wide = mapGeometry(ROUTING, [...scenes, ...many], layoutRouting(ROUTING, [...scenes, ...many]));
    const last = wide.trayNodes[wide.trayNodes.length - 1]!;
    assert.equal(wide.trayNodes.length, 10);
    assert.ok(wide.width >= last.x + NODE_W, "a fit to the map's width holds the last tray card");
  });

  it("stacks several choices over the same skipped layer above it, clear of every card and inside the map", () => {
    const thrice: Routing = {
      ...ROUTING,
      choices: [
        ...ROUTING.choices,
        { id: "ch_row", from: "sc_a", label: "Row across", to: "sc_c" },
        { id: "ch_swim", from: "sc_a", label: "Swim for it", to: "sc_c" },
      ],
    };
    const g = mapGeometry(thrice, scenes, layoutRouting(thrice, scenes));
    const arcs = ["ch_stay", "ch_row", "ch_swim"].map((id) => g.edges.find((edge) => edge.id === id)!);
    // A label pill is at most 112 wide and about 24 tall, centred on its point.
    const overlaps = (lx: number, ly: number) =>
      g.nodes.some((node) => lx + 56 > node.x && lx - 56 < node.x + NODE_W && ly + 12 > node.y && ly - 12 < node.y + NODE_H);
    for (const arc of arcs) {
      assert.ok(arc.ly >= 28, `${arc.label} sits inside the top of the map`);
      assert.ok(!overlaps(arc.lx, arc.ly), `${arc.label} is on no card`);
    }
    const ys = arcs.map((arc) => arc.ly).sort((a, b) => a - b);
    assert.ok(ys[1]! - ys[0]! >= 24 && ys[2]! - ys[1]! >= 24, "a label's height apart, so none covers another");
  });

  it("fans out two choices between the same two scenes, so neither label hides the other", () => {
    const twice: Routing = { ...ROUTING, choices: [...ROUTING.choices, { id: "ch_run", from: "sc_a", label: "Run for the causeway", to: "sc_b" }] };
    const g = mapGeometry(twice, scenes, layoutRouting(twice, scenes));
    const first = g.edges.find((edge) => edge.id === "ch_follow")!;
    const second = g.edges.find((edge) => edge.id === "ch_run")!;
    assert.notEqual(first.d, second.d);
    assert.ok(Math.abs(second.ly - first.ly) >= 30, "a label's height apart");
    const alone = mapGeometry(ROUTING, scenes, layoutRouting(ROUTING, scenes)).edges.find((edge) => edge.id === "ch_follow")!;
    assert.deepEqual(first, alone, "the first of them is drawn where it always was");
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

it('compact map leaves room for readable wrapped cards and routes between the staggered layers',()=>{
 const geometry=mapGeometry(ROUTING,scenes,layoutRouting(ROUTING,scenes),true);
 const nodes=new Map(geometry.nodes.map(node=>[node.id,node]));
 assert.ok(nodes.get('sc_a')!.y>nodes.get('sc_b')!.y);assert.ok(nodes.get('sc_b')!.y>nodes.get('sc_c')!.y);
 for(const node of geometry.nodes){assert.ok(node.y+196<=geometry.trayY);for(const other of geometry.nodes){if(node!==other&&node.x===other.x)assert.ok(Math.abs(node.y-other.y)>=196);}}
 for(const edge of geometry.edges){const from=nodes.get(edge.from);if(from)assert.ok(edge.d.startsWith('M'+(from.x+NODE_W)+','+(from.y+65)));}
});
