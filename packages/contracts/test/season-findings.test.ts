import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { seasonFindings, type SeasonFinding } from "../src/season-findings.js";
import type { ProductionBundle } from "../src/client-state.js";
import type { Episode, Sheet } from "../src/world.js";
import type { Scene } from "../src/scene.js";

/**
 * The eight season findings (Scope §04; SPEC-023 R-16): each names what it is about and the
 * evidence it stands on, and there is no score anywhere — the shape itself has no number to
 * aggregate.
 */

const AT = "2026-08-19T12:00:00Z";

function scene(id: string, number: number, shots: Array<{ id: string; description: string; durationSec?: number }>): Scene {
  return {
    id,
    number,
    slug: id.replace(/^sc_/, ""),
    title: id,
    status: "accepted",
    version: 1,
    shots: shots.map((s, i) => ({ id: s.id, number: i + 1, title: s.id, description: s.description, ...(s.durationSec !== undefined ? { durationSec: s.durationSec } : {}) })),
  };
}

function episode(id: string, order: number, over: Partial<Episode> = {}): Episode {
  return { id, version: 1, order, title: id.replace(/^ep_/, ""), scenes: [], ...over };
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
    cut: { audio: [] },
    takeMediaInfo: {},
    ...over,
  };
}

const kindsOf = (findings: SeasonFinding[]) => findings.map((f) => f.kind).sort();

describe("season findings (issue 397)", () => {
  it("finds every membership contradiction by name", () => {
    const p = production({
      scenes: [scene("sc_1", 1, []), scene("sc_2", 2, []), scene("sc_3", 3, [])],
      episodes: [
        episode("ep_one", 1, { scenes: ["sc_1", "sc_2", "sc_ghost"] }),
        episode("ep_two", 2, { scenes: ["sc_2"], linked: { opensFrom: "ep_missing" } }),
      ],
    });
    const findings = seasonFindings(p);
    const contradictions = findings.filter((f) => f.kind === "continuity-contradiction");
    assert.equal(contradictions.length, 4, "ghost scene, dangling link, double-owned, unassigned");
    assert.ok(contradictions.some((f) => f.evidence.includes("sc_ghost")));
    assert.ok(contradictions.some((f) => f.evidence.includes("ep_missing")));
    assert.ok(contradictions.some((f) => f.about === "sc_2"), "the double-owned scene is named");
    assert.ok(contradictions.some((f) => f.about === "sc_3"), "the unassigned scene is named");
  });

  it("repeated hooks and cliffhangers name every episode that shares them", () => {
    const p = production({
      episodes: [
        episode("ep_one", 1, { promise: { opens: "The bell rings.", closes: "The water answers." } }),
        episode("ep_two", 2, { promise: { opens: "the bell rings.", closes: "The water answers." } }),
        episode("ep_three", 3, { promise: { opens: "Something else.", closes: "A door." } }),
      ],
    });
    const findings = seasonFindings(p);
    assert.ok(findings.some((f) => f.kind === "repeated-hook" && f.evidence.length === 2));
    assert.ok(findings.some((f) => f.kind === "repetitive-cliffhanger" && f.evidence.length === 2));
  });

  it("an episode that opens and never closes is an unresolved promise", () => {
    const p = production({ episodes: [episode("ep_one", 1, { promise: { opens: "The page is gone." } })] });
    assert.deepEqual(kindsOf(seasonFindings(p)), ["unresolved-promise"]);
  });

  it("an arc with setup and no payoff is stalled; leads never staged are absent", () => {
    const p = production({
      episodes: [episode("ep_one", 1, { scenes: ["sc_1"] })],
      scenes: [scene("sc_1", 1, [{ id: "sh_1", description: "@maren-kest opens the ledger." }])],
      season: {
        version: 1,
        arcs: [{ id: "arc-debt", title: "What Maren owes", setup: "ep_one" }],
      },
    });
    const sheets: Sheet[] = [
      {
        id: "maren-kest",
        type: "character",
        name: "Maren Kest",
        billing: "lead",
        version: 1,
        status: "locked",
        canonRules: [],
        links: [],
        created: "2026-08-01",
        updated: "2026-08-01",
        sections: [],
      },
      {
        id: "bray-half-hitch",
        type: "character",
        name: "Bray Half-Hitch",
        billing: "lead",
        version: 1,
        status: "locked",
        canonRules: [],
        links: [],
        created: "2026-08-01",
        updated: "2026-08-01",
        sections: [],
      },
    ];
    const findings = seasonFindings(p, sheets);
    assert.ok(findings.some((f) => f.kind === "stalled-arc" && f.about === "arc-debt"));
    const absent = findings.filter((f) => f.kind === "absent-character");
    assert.deepEqual(absent.map((f) => f.about), ["bray-half-hitch"], "the mentioned lead is not flagged");
  });

  it("new-entity budget and the cost envelope each name their episode", () => {
    const crowded = scene("sc_1", 1, [
      { id: "sh_1", description: "@a-one and @b-two meet @c-three while @d-four watches.", durationSec: 200 },
    ]);
    const p = production({
      scenes: [crowded],
      episodes: [episode("ep_one", 1, { scenes: ["sc_1"] })],
      season: { version: 1, defaults: { episodeSecondsMin: 45, episodeSecondsMax: 75 } },
    });
    const findings = seasonFindings(p);
    assert.ok(findings.some((f) => f.kind === "new-entity-budget" && f.about === "ep_one" && f.evidence.length === 4));
    assert.ok(findings.some((f) => f.kind === "cost-pattern" && f.about === "ep_one" && f.evidence.includes("200s")));
  });

  it("a clean season has nothing to flag, and no finding carries a score", () => {
    const p = production({
      scenes: [scene("sc_1", 1, [{ id: "sh_1", description: "@maren-kest waits.", durationSec: 60 }])],
      episodes: [
        episode("ep_one", 1, {
          scenes: ["sc_1"],
          promise: { opens: "The bell.", closes: "The answer." },
        }),
      ],
      season: { version: 1, defaults: { episodeSecondsMin: 45, episodeSecondsMax: 75 } },
    });
    const findings = seasonFindings(p);
    assert.deepEqual(findings, [], "clean is said by emptiness, never by a percentage");
  });

  it("a non-episodic production yields no findings at all", () => {
    const p = production({ scenes: [scene("sc_1", 1, [])] });
    assert.deepEqual(seasonFindings(p), [], "no fake season intelligence for a film");
  });
});
