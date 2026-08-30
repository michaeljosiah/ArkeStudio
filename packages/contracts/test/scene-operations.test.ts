import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deleteShot,
  duplicateShot,
  editShot,
  insertShot,
  linearizeSceneFlow,
  migrateLegacyScene,
  moveShot,
  nextShotIdIn,
  orderedShots,
  SceneOperationRefused,
  setBoardOverride,
  type GraphScene,
  type Scene,
  type SceneRecord,
} from "../src/index.js";

/**
 * The pure half of the semantic commands (SPEC-029 R-36, R-61): one named change, a complete
 * validated record, and identity that survives it.
 */

const shot = (id: string, number: number, over: Record<string, unknown> = {}) => ({
  id,
  number,
  title: `Shot ${number}`,
  description: `Beat ${number}.`,
  durationSec: 4,
  ...over,
});

const legacy = (ids: string[]): Scene =>
  ({
    id: "sc_01",
    slug: "the-verse",
    number: 1,
    title: "The verse",
    status: "draft",
    version: 3,
    shots: ids.map((id, index) => shot(id, index + 1)),
  }) as unknown as Scene;

const graph = (ids: string[]): GraphScene => migrateLegacyScene(legacy(ids));

const nodeIdOf = (record: SceneRecord, shotId: string): string => {
  const sequence = linearizeSceneFlow(record);
  assert.ok(sequence.kind === "linear");
  return sequence.shots.find((pair) => pair.shot.id === shotId)!.nodeId;
};

/** A scene whose node ids are not the ones the projection would mint. */
function authored(ids: string[], authoredId = "sfn_authored-by-hand"): GraphScene {
  const base = graph(ids);
  const first = base.flow.nodes.find((node) => node.kind === "shot")!;
  return {
    ...base,
    flow: {
      ...base.flow,
      nodes: base.flow.nodes.map((node) => (node.id === first.id ? { ...node, id: authoredId } : node)),
      edges: base.flow.edges.map((edge) => ({
        ...edge,
        from: edge.from.nodeId === first.id ? { ...edge.from, nodeId: authoredId } : edge.from,
        to: edge.to.nodeId === first.id ? { ...edge.to, nodeId: authoredId } : edge.to,
      })),
    },
  };
}

describe("every operation keeps the node ids the scene already had", () => {
  const AUTHORED = "sfn_authored-by-hand";

  it("a payload edit does not re-mint identity", () => {
    const before = authored(["sh_1", "sh_2", "sh_3"]);
    const after = editShot(before, { shotId: "sh_1", change: { intent: "Held." } });
    assert.equal(nodeIdOf(after, "sh_1"), AUTHORED, "the shot never moved; nor should its identity");
    assert.equal(orderedShots(after)[0]?.intent, "Held.");
  });

  it("an insert beside it leaves it alone, and its edges still reach it", () => {
    const before = authored(["sh_1", "sh_2"]);
    const after = insertShot(before, {
      shot: { ...shot("sh_9", 0), number: undefined } as never,
      at: { after: "sh_1" },
    });
    assert.equal(nodeIdOf(after, "sh_1"), AUTHORED);
    assert.ok(
      after.flow.edges.some((edge) => edge.from.nodeId === AUTHORED),
      "the new shot is wired to the authored node, not to a re-minted twin",
    );
  });

  it("a move keeps it, and a group naming it still resolves", () => {
    const beat = { id: "sbg_the-rail", title: "At the rail", shotNodeIds: [AUTHORED] };
    const before: GraphScene = (() => {
      const base = authored(["sh_1", "sh_2", "sh_3"]);
      return { ...base, flow: { ...base.flow, storyboardGroups: [beat] } };
    })();
    const after = moveShot(before, { shotId: "sh_3", to: { atStart: true } });
    assert.equal(nodeIdOf(after, "sh_1"), AUTHORED);
    assert.deepEqual(after.flow.storyboardGroups, [beat], "which is what the re-mint used to break");
  });
});

describe("an edge id survives as long as its connection does", () => {
  it("a payload edit re-mints no edge at all", () => {
    const before = graph(["sh_1", "sh_2", "sh_3"]);
    const after = editShot(before, { shotId: "sh_2", change: { intent: "Held." } });
    assert.deepEqual(
      after.flow.edges.map((edge) => edge.id).sort(),
      before.flow.edges.map((edge) => edge.id).sort(),
      "nothing about what follows what changed, so no id should have",
    );
  });

  it("keeps authored edge ids whose endpoints still join, and mints only the new connections", () => {
    const base = graph(["sh_1", "sh_2"]);
    const authoredEdge = "sfe_authored-by-hand";
    const target = base.flow.edges.find(
      (edge) => edge.from.nodeId === "sfn_sh-1" && edge.to.nodeId === "sfn_sh-2",
    )!;
    const before: GraphScene = {
      ...base,
      flow: {
        ...base.flow,
        edges: base.flow.edges.map((edge) => (edge.id === target.id ? { ...edge, id: authoredEdge } : edge)),
      },
    };

    // An insert at the END touches nothing about sh_1 → sh_2.
    const after = insertShot(before, {
      shot: { ...shot("sh_9", 0), number: undefined } as never,
      at: { after: "sh_2" },
    });
    assert.ok(
      after.flow.edges.some((edge) => edge.id === authoredEdge),
      "the untouched connection kept the id somebody gave it",
    );
    assert.ok(
      after.flow.edges.some((edge) => edge.from.nodeId === "sfn_sh-2" && edge.to.nodeId === "sfn_sh-9"),
      "and the connection that is genuinely new was minted",
    );
  });
});

describe("a duplicate is the whole authored beat", () => {
  it("keeps script coverage, which is authorship and not output", () => {
    /*
     * `covers` is block ids and their digests (SPEC-023 R-13), not footage — dropping it made a
     * duplicated scripted beat read as covering nothing, and silenced the changed/uncovered
     * diagnostics the original still gets. What actually leaves the output behind is the fresh
     * id: takes and selections key by shot id.
     */
    const base = graph(["sh_1"]);
    const covers = [{ blockId: "b_1", textDigest: `sha256:${"a".repeat(64)}` }];
    const before: SceneRecord = {
      ...base,
      flow: {
        ...base.flow,
        nodes: base.flow.nodes.map((node) =>
          node.kind === "shot" ? { ...node, shot: { ...node.shot, covers } } : node,
        ),
      },
    };
    const after = duplicateShot(before, { shotId: "sh_1", newShotId: "sh_2" });
    const copy = orderedShots(after).find((s) => s.id === "sh_2")!;
    assert.deepEqual(copy.covers, covers);
  });
});

describe("a deleted shot takes its board hints with it, and not its neighbours' text", () => {
  it("drops a consolidated prompt entirely rather than retargeting it at the survivors", () => {
    /*
     * A prompt is keyed by the exact set it was written for. Removing one member turns "A and B
     * together" into the text for B alone, which is then silently applied to a one-shot board —
     * words nobody wrote about that shot.
     */
    const base = graph(["sh_1", "sh_2", "sh_3"]);
    const before: SceneRecord = {
      ...base,
      boards: {
        splits: ["sh_2"],
        merges: [],
        prompts: [
          { members: ["sh_1", "sh_2"], text: "Both of them, in one light." },
          { members: ["sh_3"], text: "The last one alone." },
        ],
      },
    };
    const after = deleteShot(before, { shotId: "sh_2" });
    assert.deepEqual(after.boards?.splits, [], "the split before a shot that is gone is gone too");
    assert.deepEqual(
      after.boards?.prompts,
      [{ members: ["sh_3"], text: "The last one alone." }],
      "the combined prompt went whole; the untouched one stands",
    );
  });

  it("leaves nothing behind at all when the last hint goes", () => {
    const base = graph(["sh_1", "sh_2"]);
    const before: SceneRecord = { ...base, boards: { splits: ["sh_2"], merges: [] } };
    assert.equal(deleteShot(before, { shotId: "sh_2" }).boards, undefined);
  });
});

describe("the operations refuse rather than guess", () => {
  it("names a shot that is not in the scene", () => {
    assert.throws(() => moveShot(graph(["sh_1"]), { shotId: "sh_9", to: { atStart: true } }), SceneOperationRefused);
  });

  it("refuses a shot moving relative to itself", () => {
    assert.throws(
      () => moveShot(graph(["sh_1", "sh_2"]), { shotId: "sh_1", to: { after: "sh_1" } }),
      /relative to itself/,
    );
  });

  it("refuses to edit a shot's identity", () => {
    assert.throws(
      () => editShot(graph(["sh_1"]), { shotId: "sh_1", change: { id: "sh_2" } as never }),
      /identity/,
    );
  });

  it("refuses a break before the first shot", () => {
    assert.throws(
      () => setBoardOverride(graph(["sh_1", "sh_2"]), { shotId: "sh_1", override: "split" }),
      /divide nothing/,
    );
  });
});

describe("ids are minted past everything already taken", () => {
  it("reads the highest number, whatever order it is given in", () => {
    assert.equal(nextShotIdIn(["sh_3", "sh_11", "sh_7"]), "sh_12");
    assert.equal(nextShotIdIn([]), "sh_1");
    assert.equal(nextShotIdIn(["sh_04"]), "sh_5", "a padded id is the same number");
  });

  it("counts past the float range, where rounding would hand back an id already taken", () => {
    // 2^53 is where Number stops being able to tell consecutive integers apart, and the
    // collision check only sees the scene being edited — so a rounded answer commits cleanly.
    assert.equal(nextShotIdIn(["sh_9007199254740992"]), "sh_9007199254740993");
    assert.equal(nextShotIdIn(["sh_1000000000000000000000"]), "sh_1000000000000000000001");
  });

  it("ignores anything that is not a plain sh_<n>", () => {
    assert.equal(nextShotIdIn(["sh_2", "sh_x", "shot_9"]), "sh_3");
  });
});

describe("a legacy group loses its deleted member rather than blocking forever", () => {
  it("drops the member and keeps the beat that still covers something", () => {
    /*
     * SPEC-035 superseded authored groups, so nothing writes or edits one — refusing the delete
     * and saying "take it out of the group first" pointed at an operation that does not exist,
     * which made a grouped shot in an old scene permanently undeletable.
     */
    const base = graph(["sh_1", "sh_2", "sh_3"]);
    const beat = { id: "sbg_the-rail", title: "At the rail", shotNodeIds: ["sfn_sh-1", "sfn_sh-2"] };
    const before: GraphScene = { ...base, flow: { ...base.flow, storyboardGroups: [beat] } };
    const after = deleteShot(before, { shotId: "sh_2" });
    assert.deepEqual(after.flow.storyboardGroups, [{ ...beat, shotNodeIds: ["sfn_sh-1"] }]);
  });

  it("dissolves a group the deletion empties", () => {
    const base = graph(["sh_1", "sh_2"]);
    const beat = { id: "sbg_alone", title: "Alone", shotNodeIds: ["sfn_sh-2"] };
    const before: GraphScene = { ...base, flow: { ...base.flow, storyboardGroups: [beat] } };
    assert.deepEqual(deleteShot(before, { shotId: "sh_2" }).flow.storyboardGroups, []);
  });

  it("finds the member by the node id the scene actually gave it", () => {
    const AUTHORED = "sfn_authored-by-hand";
    const base = authored(["sh_1", "sh_2"]);
    const beat = { id: "sbg_the-rail", title: "At the rail", shotNodeIds: [AUTHORED] };
    const before: GraphScene = { ...base, flow: { ...base.flow, storyboardGroups: [beat] } };
    assert.deepEqual(deleteShot(before, { shotId: "sh_1" }).flow.storyboardGroups, []);
  });
});
