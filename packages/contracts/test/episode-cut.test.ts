import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildExportPlan, deriveCut, deriveEpisodeCut, episodeExportRefusals } from "../src/cut.js";
import type { ProductionBundle } from "../src/client-state.js";
import type { Episode } from "../src/world.js";
import type { Scene } from "../src/scene.js";

/**
 * One episode's cut (SPEC-023 R-24, issue #396): the same pure derivation the production-wide
 * cut uses, narrowed to the episode's ordered scenes — and refusals said by name before any
 * encode, never as a score.
 */

const AT = "2026-08-19T12:00:00Z";

function scene(id: string, number: number, order: number | undefined, shotIds: string[]): Scene {
  return {
    id,
    number,
    ...(order !== undefined ? { order } : {}),
    slug: id.replace(/^sc_/, ""),
    title: id,
    status: "accepted",
    version: 1,
    shots: shotIds.map((sid, i) => ({ id: sid, number: i + 1, title: sid, description: "a shot", durationSec: 5 })),
  };
}

function episode(id: string, order: number, scenes: string[], over: Partial<Episode> = {}): Episode {
  return { id, version: 1, order, title: id.replace(/^ep_/, ""), scenes, ...over };
}

function production(over: Partial<ProductionBundle>): ProductionBundle {
  return {
    meta: {
      id: "bell-watch-season-1",
      format: "video",
      medium: "video",
      kind: "microdrama",
      title: "Bell Watch — Season 1",
      status: "in-progress",
      failureModes: [],
      created: AT,
      updated: AT,
    },
    story: null,
    season: null,
    routing: null,
    treatment: null,
    chapters: [],
    scenes: [],
    sceneFiles: {},
    episodes: [],
    episodeFiles: {},
    takes: [],
    reviews: [],
    selections: {},
    spine: null,
    cut: { audio: [], overlays: [] },
    takeMediaInfo: {},
    ...over,
  };
}

describe("episode cuts and refusals (issue 396)", () => {
  it("the episode cut follows the episode's order, not the production's", () => {
    const p = production({
      scenes: [scene("sc_1", 1, 1, ["sh_1"]), scene("sc_2", 2, 2, ["sh_2"]), scene("sc_3", 3, 3, ["sh_3"])],
      episodes: [episode("ep_one", 1, ["sc_3", "sc_1"]), episode("ep_two", 2, ["sc_2"])],
    });
    const cut = deriveEpisodeCut(p, "ep_one");
    assert.deepEqual(
      cut.entries.map((e) => e.shot.id),
      ["sh_3", "sh_1"],
      "within an episode, the episode's scenes array is the order authority (R-12)",
    );
    assert.equal(cut.totalSec, 10, "only that episode's shots are counted");
    const whole = deriveCut(p);
    assert.equal(whole.totalSec, 15, "the production-wide cut still covers everything");
  });

  it("one episode's gaps never misreport another's, and gaps become slates, not refusals", () => {
    const p = production({
      scenes: [scene("sc_1", 1, 1, ["sh_1"]), scene("sc_2", 2, 2, ["sh_2"])],
      episodes: [episode("ep_one", 1, ["sc_1"]), episode("ep_two", 2, ["sc_2"])],
      takes: [
        {
          id: "tk_01J8E0000000000000000000T1",
          jobId: "jb_01J8E0000000000000000000J1",
          coversShots: ["sh_1"],
          kind: "clip",
          provider: "fal",
          model: "seedance-2.0",
          provenance: { canonRevision: 1, sheets: {} },
          prompt: "a shot",
          references: [],
          params: {},
          cost: { estimatedMicroUsd: 1000, actualMicroUsd: null },
          dispatchedAt: AT,
          media: "clip.mp4",
        },
      ],
      selections: { sh_1: { acceptedTakeId: "tk_01J8E0000000000000000000T1", trimInSec: 0 } },
    });
    const one = deriveEpisodeCut(p, "ep_one");
    const two = deriveEpisodeCut(p, "ep_two");
    assert.equal(one.gaps, 0, "the covered episode reports no gap");
    assert.equal(two.gaps, 1, "the uncovered episode reports its own");
    assert.equal(episodeExportRefusals(p, "ep_two"), null, "a gap does not refuse");
    const plan = buildExportPlan(two, "review-cut");
    assert.equal(plan.items[0]!.type, "slate", "the gap exports as a labelled slate, production parity");
  });

  it("refusals are named: unknown episode, empty episode, dangling scene, double-owned scene", () => {
    const p = production({
      scenes: [scene("sc_1", 1, 1, ["sh_1"])],
      episodes: [
        episode("ep_empty", 1, []),
        episode("ep_dangling", 2, ["sc_ghost"]),
        episode("ep_one", 3, ["sc_1"]),
        episode("ep_two", 4, ["sc_1"]),
      ],
    });
    assert.match(episodeExportRefusals(p, "ep_missing")!.detail, /not an episode/);
    assert.match(episodeExportRefusals(p, "ep_empty")!.detail, /no scenes yet/);
    assert.match(episodeExportRefusals(p, "ep_dangling")!.detail, /sc_ghost/);
    assert.match(episodeExportRefusals(p, "ep_one")!.detail, /exactly one episode/);
  });

  it("a spine production refuses episode export until a range authority exists", () => {
    const p = production({
      scenes: [scene("sc_1", 1, 1, ["sh_1"])],
      episodes: [episode("ep_one", 1, ["sc_1"])],
      spine: {
        schemaVersion: 1,
        revision: 1,
        trackArtifactId: "art_track",
        markers: [],
        anchors: {},
        updatedAt: AT,
      },
    });
    assert.match(episodeExportRefusals(p, "ep_one")!.detail, /episode-to-spine range authority/);
  });
});
