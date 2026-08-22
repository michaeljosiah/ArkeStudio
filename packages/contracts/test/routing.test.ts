import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  layoutRouting,
  productionShape,
  publicationBlockers,
  routingFindings,
  RoutingSchema,
  type Routing,
  type TraversalEvidence,
} from "../src/index.js";

/**
 * Interactive video's routing contracts (epic 401; brief §1–§4). Test names carry the brief's
 * IV-C/IV-M numbers.
 */

const routing = (over: Partial<Routing> = {}): Routing => ({
  version: 1,
  start: "sc_1",
  choices: [
    { id: "ch_wait", from: "sc_1", label: "Wait for dawn", to: "sc_2" },
    { id: "ch_dive", from: "sc_1", label: "Dive now", to: "sc_3" },
  ],
  endings: [
    { sceneId: "sc_2", title: "Dawn" },
    { sceneId: "sc_3", title: "The deep" },
  ],
  excluded: [],
  groups: [],
  ...over,
});

const scenes = (...ids: string[]) => ids.map((id) => ({ id }));

const evidenceFor = (r: Routing): TraversalEvidence[] =>
  r.choices.map((choice) => ({
    ts: "2026-08-20T12:00:00.000Z",
    routingVersion: r.version,
    choiceId: choice.id,
    from: choice.from,
    to: choice.to,
    route: [choice.from],
  }));

describe("routing contracts (epic 401)", () => {
  it("IV-C1: state and logic are unrepresentable — a condition key fails parse by name", () => {
    assert.throws(
      () => RoutingSchema.parse({ ...routing(), choices: [{ id: "ch_x", from: "sc_1", to: "sc_2", label: "x", condition: "gold > 3" }] }),
      /condition/,
      "a choice cannot carry a condition",
    );
    assert.throws(() => RoutingSchema.parse({ ...routing(), variables: {} }), /variables/);
    assert.throws(
      () => RoutingSchema.parse({ ...routing(), groups: [{ id: "grp_act-1", title: "Act I", scenes: [], unlocks: "sc_9" }] }),
      /unlocks/,
      "groups are presentation only",
    );
    // And the honest shape parses.
    assert.equal(RoutingSchema.parse(routing()).choices.length, 2);
  });

  it("IV-C2: every finding is named with evidence and its publication severity — never a score", () => {
    const tangled = routing({
      choices: [
        { id: "ch_wait", from: "sc_1", label: "Wait", to: "sc_2" },
        { id: "ch_loop-a", from: "sc_4", label: "Round", to: "sc_5" },
        { id: "ch_loop-b", from: "sc_5", label: "Again", to: "sc_4" },
        { id: "ch_into-loop", from: "sc_1", label: "Descend", to: "sc_4" },
        { id: "ch_ghost", from: "sc_2", label: "Beyond", to: "sc_ghost" },
      ],
      endings: [{ sceneId: "sc_2", title: "Dawn" }],
    });
    const found = routingFindings(tangled, scenes("sc_1", "sc_2", "sc_4", "sc_5", "sc_6"), []);
    const kinds = new Map(found.map((finding) => [finding.kind, finding]));
    assert.match(kinds.get("invalid-destination")!.detail, /ch_ghost.*sc_ghost/);
    assert.equal(kinds.get("invalid-destination")!.severity, "blocks");
    assert.match(kinds.get("unreachable")!.detail, /sc_6/);
    assert.match(kinds.get("cannot-reach-ending")!.detail, /sc_[45]/);
    assert.match(kinds.get("unintended-loop")!.detail, /sc_4|sc_5/);
    assert.match(kinds.get("ending-with-choices")!.detail, /sc_2.*ch_ghost/);
    assert.equal(kinds.get("untraversed-edge")!.severity, "blocks");
    assert.equal(kinds.get("unvisited-route")!.severity, "warns");
    assert.ok(found.every((finding) => finding.severity === "blocks" || finding.severity === "warns"));
    assert.ok(!found.some((finding) => /\d+\s*%/.test(finding.detail)), "no percentage anywhere");
  });

  it("IV-C2b: a clean, fully traversed graph reports only its reconvergence — and nothing blocks", () => {
    const converging = routing({
      choices: [
        { id: "ch_wait", from: "sc_1", label: "Wait", to: "sc_2" },
        { id: "ch_dive", from: "sc_1", label: "Dive", to: "sc_3" },
        { id: "ch_meet-a", from: "sc_2", label: "Meet", to: "sc_4" },
        { id: "ch_meet-b", from: "sc_3", label: "Meet", to: "sc_4" },
      ],
      endings: [{ sceneId: "sc_4", title: "The bell" }],
    });
    const found = routingFindings(converging, scenes("sc_1", "sc_2", "sc_3", "sc_4"), evidenceFor(converging));
    assert.deepEqual(
      found.map((finding) => finding.kind),
      ["reconvergence"],
      "reconvergence is the one honest remainder",
    );
    assert.match(found[0]!.detail, /sc_4 reconverges.*ch_meet-a and ch_meet-b/);
    assert.equal(publicationBlockers(found).length, 0);
  });

  it("IV-C3: evidence is version-scoped by identity — a retargeted edge sheds its traversals", () => {
    const before = routing({
      choices: [{ id: "ch_wait", from: "sc_1", label: "Wait", to: "sc_2" }],
      endings: [{ sceneId: "sc_2", title: "Dawn" }],
    });
    const walked = evidenceFor(before);
    assert.ok(
      !routingFindings(before, scenes("sc_1", "sc_2"), walked).some((f) => f.kind === "untraversed-edge"),
      "the traversal counts while the edge stands",
    );
    const retargeted: Routing = {
      ...before,
      version: 2,
      choices: [{ id: "ch_wait", from: "sc_1", label: "Wait", to: "sc_3" }],
      endings: [{ sceneId: "sc_3", title: "Elsewhere" }],
    };
    const found = routingFindings(retargeted, scenes("sc_1", "sc_2", "sc_3"), walked);
    assert.ok(
      found.some((f) => f.kind === "untraversed-edge" && f.choiceIds.includes("ch_wait")),
      "the old traversal no longer describes this edge",
    );
  });

  it("IV-C4: the interactive kind is branching and never episodic", () => {
    // Both spellings: what turn 100 writes, and what a world written before it holds.
    for (const meta of [
      { format: "video", medium: "video", kind: "interactive" },
      { format: "video", medium: "interactive-video" },
    ] as const) {
      const shape = productionShape(meta);
      assert.equal(shape.isBranching, true);
      assert.equal(shape.isEpisodic, false, "SPEC-023 R-11's ownership rule is not inherited");
      assert.equal(shape.kind, "interactive");
    }
    assert.equal(productionShape({ format: "video" }).isBranching, false, "linear video never branches");
  });

  it("IV-M1: the same graph always draws the same picture, and unplaced scenes trail", () => {
    const graph = routing({
      choices: [
        { id: "ch_wait", from: "sc_1", label: "Wait", to: "sc_2" },
        { id: "ch_dive", from: "sc_1", label: "Dive", to: "sc_3" },
        { id: "ch_meet", from: "sc_2", label: "Meet", to: "sc_4" },
      ],
      endings: [{ sceneId: "sc_4", title: "End" }],
    });
    const once = layoutRouting(graph, scenes("sc_1", "sc_2", "sc_3", "sc_4", "sc_lost"));
    const twice = layoutRouting(graph, scenes("sc_1", "sc_2", "sc_3", "sc_4", "sc_lost"));
    assert.deepEqual(twice, once, "deterministic — no force simulation to jiggle it");
    assert.deepEqual(once.layers[0], ["sc_1"]);
    assert.deepEqual(once.layers[1], ["sc_2", "sc_3"], "in-layer order is authored choice order");
    assert.deepEqual(once.layers[2], ["sc_4"]);
    assert.deepEqual(once.unplaced, ["sc_lost"]);
  });
});
