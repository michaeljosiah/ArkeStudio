import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyTimelineCommands,
  episodeTimelineRange,
  migrateLegacyCut,
  seedStoryPictureTimeline,
  type Episode,
  type ProductionBundle,
  type Scene,
} from "../src/index.js";

/**
 * Round four of PR 696: an episode range refuses a shot no episode owns, and a legacy lane's
 * stacking survives migration onto typed tracks.
 */

const AT = "2026-09-02T10:00:00Z";
const PLATE = "ar_01J8G0000000000000000000A1";

function scene(id: string, order: number, shots: Array<{ id: string; durationSec?: number }>): Scene {
  return {
    id,
    number: order,
    order,
    slug: id.replace(/^sc_/, ""),
    title: id,
    status: "accepted",
    version: 1,
    shots: shots.map((shot, index) => ({
      id: shot.id,
      number: index + 1,
      title: shot.id,
      description: `Story beat ${shot.id}`,
      ...(shot.durationSec === undefined ? {} : { durationSec: shot.durationSec }),
    })),
  };
}

function episode(id: string, order: number, scenes: string[]): Episode {
  return { id, version: 1, order, title: id.replace(/^ep_/, ""), scenes };
}

function production(over: Partial<ProductionBundle> = {}): ProductionBundle {
  return {
    performances: [], performanceReview: { reviews: [], selections: {}, reviewHash: null, selectionHash: null },
    meta: { id: "bell-watch", format: "video", medium: "video", kind: "microdrama", title: "Bell Watch", status: "in-progress", frameRate: 25, failureModes: [], created: AT, updated: AT },
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
    editorRequests: [],
    takeMediaInfo: {},
    ...over,
  };
}

describe("codex round four", () => {
  it("refuses a shot no episode owns inside an episode range, by name", () => {
    const value = production({
      scenes: [
        scene("sc_a", 1, [{ id: "sh_1", durationSec: 2 }, { id: "sh_2", durationSec: 2 }]),
        scene("sc_b", 2, [{ id: "sh_3", durationSec: 2 }]),
        scene("sc_c", 3, [{ id: "sh_5", durationSec: 2 }]),
      ],
      episodes: [episode("ep_one", 1, ["sc_a"]), episode("ep_two", 2, ["sc_b"])],
    });
    const seeded = seedStoryPictureTimeline(value);
    assert.equal(episodeTimelineRange(value, seeded, "ep_one").ok, true);
    // sh_5 belongs to no episode; between sh_1 and sh_2 it is as much an intruder as sh_3 would be.
    const moved = applyTimelineCommands(seeded, [{ kind: "move-to-order", clipId: "cl_sh-5", index: 1 }]);
    const range = episodeTimelineRange(value, moved, "ep_one");
    assert.equal(range.ok, false);
    if (!range.ok) assert.match(range.reason, /sh_5.*no episode/);
  });

  it("keeps a lane's stacking order when overlapping placements spread onto typed tracks", () => {
    const value = production({
      cut: {
        audio: [],
        overlays: [
          { id: "ov_01J8G0000000000000000000B1", artifactId: PLATE, startSec: 0, endSec: 3, lane: 0, audio: "keep" },
          { id: "ov_01J8G0000000000000000000B2", artifactId: PLATE, startSec: 1, endSec: 10, lane: 0, audio: "keep" },
          { id: "ov_01J8G0000000000000000000B3", artifactId: PLATE, startSec: 4, endSec: 5, lane: 0, audio: "keep" },
        ],
      },
    });
    const { timeline, dropped } = migrateLegacyCut(seedStoryPictureTimeline(value), value, [{ id: PLATE, file: "plate.png", kind: "image" }]);
    assert.deepEqual(dropped, []);
    const trackOf = (clipId: string) => timeline.tracks.find((track) => track.clips.some((clip) => clip.id === clipId));
    const a = trackOf("cl_ov-01J8G0000000000000000000B1")!;
    const b = trackOf("cl_ov-01J8G0000000000000000000B2")!;
    const c = trackOf("cl_ov-01J8G0000000000000000000B3")!;
    // The legacy lane drew the later start on top: B over A, C over B. First-fit would have put C
    // back on A's track, under B.
    assert.ok(a.order < b.order, "B composites over A");
    assert.ok(b.order < c.order, "C composites over B");
    assert.notEqual(b.id, c.id);
  });
});
