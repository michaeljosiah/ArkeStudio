import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyTimelineCommands,
  buildRenderPlan,
  seedStoryPictureTimeline,
  windowPlan,
  type ProductionBundle,
  type RenderArtifact,
  type Scene,
} from "../src/index.js";

/**
 * Round five of PR 696: an episode window keeps the speech regions whose look-ahead or release
 * reaches into it, shifted onto the scoped clock, so a scoped export ducks exactly where the
 * whole production does.
 */

const AT = "2026-09-02T10:00:00Z";
const BELLS = "ar_01J8G0000000000000000000A3";
const artifacts: RenderArtifact[] = [{ id: BELLS, file: "bells.wav", kind: "audio", mediaInfo: { hasAudio: true, durationSec: 20 } }];

function scene(id: string, order: number, shots: Array<{ id: string; durationSec: number }>): Scene {
  return {
    id,
    number: order,
    order,
    slug: id.replace(/^sc_/, ""),
    title: id,
    status: "accepted",
    version: 1,
    shots: shots.map((shot, index) => ({ id: shot.id, number: index + 1, title: shot.id, description: `Story beat ${shot.id}`, durationSec: shot.durationSec })),
  };
}

const production: ProductionBundle = {
  rehearsals: [], performances: [], performanceReview: { reviews: [], selections: {}, reviewHash: null, selectionHash: null },
  meta: { id: "bell-watch", format: "video", medium: "video", kind: "microdrama", title: "Bell Watch", status: "in-progress", frameRate: 25, failureModes: [], created: AT, updated: AT },
  story: null,
  season: null,
  routing: null,
  treatment: null,
  chapters: [],
  scenes: [scene("sc_a", 1, [{ id: "sh_1", durationSec: 8 }, { id: "sh_2", durationSec: 8 }])],
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
};

describe("codex round five", () => {
  it("keeps a speech region whose envelope reaches into the window, on the scoped clock", () => {
    // 16s of picture at 25 fps; one spoken line at 10s–12.48s over a bed the whole way.
    const timeline = applyTimelineCommands(seedStoryPictureTimeline(production), [
      { kind: "add-track", trackId: "tr_dialogue", trackKind: "dialogue", name: "Dialogue" },
      { kind: "place", trackId: "tr_dialogue", clip: { id: "cl_line", role: "dialogue", startFrame: 250, durationFrames: 62, sourceInFrames: 0, source: { kind: "artifact", artifactId: BELLS, label: "the line" } } },
      { kind: "add-track", trackId: "tr_music", trackKind: "music", name: "Music" },
      { kind: "place", trackId: "tr_music", clip: { id: "cl_bed", role: "music", startFrame: 0, durationFrames: 400, sourceInFrames: 0, source: { kind: "artifact", artifactId: BELLS, label: "the bed" } } },
    ]);
    const whole = buildRenderPlan({ production, artifacts, timeline: { status: "ready", timeline }, scope: { kind: "production" }, preset: "review-cut" });
    assert.equal(whole.ok, true);
    if (!whole.ok) return;
    assert.deepEqual(whole.plan.speech, [{ startSec: 10, endSec: 12.48 }]);
    const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

    // Ends before the look-ahead (80ms) of the line: nothing to duck, nothing carried.
    assert.deepEqual(windowPlan(whole.plan, 0, 9.5, { kind: "production" }).speech, []);
    // Ends inside the look-ahead: the region travels whole, past the window's end, on its clock.
    const before = windowPlan(whole.plan, 0, 9.95, { kind: "production" }).speech;
    assert.equal(before.length, 1);
    assert.ok(near(before[0]!.startSec, 10) && near(before[0]!.endSec, 12.48));
    // Starts inside the release (400ms) after the line: the region lands before zero, still ducking.
    const after = windowPlan(whole.plan, 12.6, 16, { kind: "production" }).speech;
    assert.equal(after.length, 1);
    assert.ok(near(after[0]!.startSec, -2.6) && near(after[0]!.endSec, -0.12), JSON.stringify(after));
    // Starts after the release has finished: gone.
    assert.deepEqual(windowPlan(whole.plan, 13, 16, { kind: "production" }).speech, []);
  });
});
