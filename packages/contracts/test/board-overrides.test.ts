import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SceneRecordSchema,
  SceneSchema,
  migrateLegacyScene,
  packScene,
  projectSceneRecord,
  type Scene,
  type Shot,
} from "../src/index.js";

/**
 * The authored board overrides on the scene record (SPEC-035 R-4, §2.2), and the rule that
 * keeps passes a refinement of boards rather than a rival authority (R-13).
 */

const shot = (n: number, durationSec = 4): Shot => ({
  id: `sh_${n}`,
  number: n,
  title: `Shot ${n}`,
  description: "",
  durationSec,
});

const scene = (over: Partial<Scene> = {}): Scene => ({
  id: "sc_04",
  number: 4,
  slug: "the-verse-rises",
  title: "The verse rises",
  status: "accepted",
  version: 2,
  shots: [shot(1), shot(2), shot(3)],
  ...over,
});

describe("the board overrides are part of the record", () => {
  it("round-trips splits, merges and prompts", () => {
    const parsed = SceneSchema.parse(
      scene({
        boards: {
          splits: ["sh_3"],
          merges: ["sh_2"],
          prompts: [{ members: ["sh_1", "sh_2"], text: "The pier, dusk, blue hour." }],
        },
      }),
    );
    assert.deepEqual(parsed.boards?.splits, ["sh_3"]);
    assert.deepEqual(parsed.boards?.merges, ["sh_2"]);
    assert.equal(parsed.boards?.prompts?.[0]?.text, "The pier, dusk, blue hour.");
  });

  it("reads a scene written before boards existed, unchanged", () => {
    // This schema is a read path: a tightening here deletes scenes from worlds on disk.
    const parsed = SceneSchema.parse(scene());
    assert.equal(parsed.boards, undefined, "absent means empty, never a parse failure");
  });

  it("refuses a shape that could not be honoured", () => {
    assert.throws(() => SceneSchema.parse(scene({ boards: { splits: ["nope"], merges: [] } as never })));
    assert.throws(() =>
      SceneSchema.parse(scene({ boards: { splits: [], merges: [], extra: 1 } as never })),
    );
    assert.throws(() =>
      SceneSchema.parse(
        scene({ boards: { splits: [], merges: [], prompts: [{ members: [], text: "x" }] } as never }),
      ),
      /* a prompt keyed by no members could never match a board */
    );
  });

  it("survives the graph migration and the projection back (SPEC-029)", () => {
    /*
     * Both use rest-spread, so a new field travels without either being taught about it — but
     * a field that silently vanished on the first authored write would take the author's seams
     * with it, so it is asserted rather than assumed.
     */
    const legacy = SceneSchema.parse(scene({ boards: { splits: ["sh_3"], merges: [] } }));
    const graph = migrateLegacyScene(legacy);
    assert.deepEqual(graph.boards?.splits, ["sh_3"], "the migration carries the overrides");
    assert.ok(!("shots" in graph), "and drops exactly the one key it replaces");

    const projected = projectSceneRecord(graph);
    assert.equal(projected.kind, "scene");
    assert.ok(projected.kind === "scene");
    assert.deepEqual(projected.scene.boards?.splits, ["sh_3"], "and the projection carries them back");

    // And the record union parses the graph form with overrides intact.
    const reparsed = SceneRecordSchema.parse(JSON.parse(JSON.stringify(graph)));
    assert.deepEqual(reparsed.boards?.splits, ["sh_3"]);
  });
});

describe("a pass never spans a board boundary (R-13)", () => {
  const shots = [shot(1), shot(2), shot(3), shot(4)];

  it("packs one pass when nothing forces a break", () => {
    const pack = packScene(shots, 60);
    assert.ok(pack.ok);
    assert.equal(pack.passes.length, 1);
    assert.deepEqual(pack.passes[0]!.plan.map((e) => e.shotId), ["sh_1", "sh_2", "sh_3", "sh_4"]);
  });

  it("closes the pass at a boundary the cap would have run straight through", () => {
    const pack = packScene(shots, 60, { forceBreakBefore: new Set(["sh_3"]) });
    assert.ok(pack.ok);
    assert.deepEqual(
      pack.passes.map((p) => p.plan.map((e) => e.shotId)),
      [["sh_1", "sh_2"], ["sh_3", "sh_4"]],
    );
  });

  it("restarts each pass's clock, so segment boundaries stay within their own pass", () => {
    // SPEC-013 cuts per-shot segments from these numbers; a cursor that kept running would
    // name ranges past the end of the media the pass actually returns.
    const pack = packScene(shots, 60, { forceBreakBefore: new Set(["sh_3"]) });
    assert.ok(pack.ok);
    assert.deepEqual(pack.passes[1]!.plan.map((e) => [e.startSec, e.endSec]), [[0, 4], [4, 8]]);
  });

  it("lets the route cap subdivide the shots between two boundaries", () => {
    /*
     * The boundary says where a pass may not RUN THROUGH; the cap says how far it can reach.
     * Four 4-second shots with a boundary at sh_3 and a 4-second cap is four passes, not two:
     * the cap subdivides each board without moving the seam the author or continuity set.
     */
    const pack = packScene(shots, 4, { forceBreakBefore: new Set(["sh_3"]) });
    assert.ok(pack.ok);
    assert.equal(pack.passes.length, 4);
  });

  it("still holds a reference-carrying pass to the shorter route ceiling (issue 390)", () => {
    // The behaviour boards must not cost us: a pass that will take the reference route is
    // packed against that route's ceiling, so a plan cannot price 15s and be refused at 10s.
    const pack = packScene([shot(1, 6), shot(2, 6)], 15, {
      referenceCapSec: 10,
      shotCarriesReferences: (id) => id === "sh_2",
      forceBreakBefore: new Set(),
    });
    assert.ok(pack.ok);
    assert.equal(pack.passes.length, 2, "12s would fit the text cap and not the reference one");
  });

  it("reports an oversize shot in its own shape, whatever the boundaries say", () => {
    const pack = packScene([shot(1, 40)], 30, { forceBreakBefore: new Set(["sh_1"]) });
    assert.equal(pack.ok, false);
    assert.ok(!pack.ok);
    assert.equal(pack.oversizeShot.shotId, "sh_1");
  });
});
