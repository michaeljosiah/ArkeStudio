import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyTimelineCommands,
  buildRenderPlan,
  migrateLegacyCut,
  seedSpinePictureTimeline,
  seedStoryPictureTimeline,
  type Episode,
  type ProductionBundle,
  type ProductionSpine,
  type RenderArtifact,
  type Scene,
} from "../src/index.js";

/**
 * Round six of PR 696: a pass segment migrates through its pass with its window, an episode of
 * a music-timed production delivers once its timeline is saved, and a clip id cannot cross
 * tracks inside one batch.
 */

const AT = "2026-09-02T10:00:00Z";
const SONG = "ar_01J8G0000000000000000000A6";
const PASS = "tk_01J8E0000000000000000000P1";
const SEGMENT = "tk_01J8E0000000000000000000S1";
const artifacts: RenderArtifact[] = [{ id: SONG, file: "song.mp3", kind: "audio", mediaInfo: { hasAudio: true, durationSec: 12 } }];

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

function episode(id: string, order: number, scenes: string[]): Episode {
  return { id, version: 1, order, title: id.replace(/^ep_/, ""), scenes };
}

function take(id: string, coversShots: string[], extra: { media?: string; segment?: { passTakeId: string; inSec: number; outSec: number } }) {
  return {
    id,
    jobId: "jb_01J8E0000000000000000000J1",
    coversShots,
    kind: "clip" as const,
    provider: "fal",
    model: "seedance-2.0",
    provenance: { canonRevision: 1, sheets: {} },
    prompt: "a shot",
    references: [],
    params: {},
    cost: { estimatedMicroUsd: 1000, actualMicroUsd: null },
    dispatchedAt: AT,
    ...extra,
  };
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
    scenes: [scene("sc_a", 1, [{ id: "sh_1", durationSec: 4 }, { id: "sh_2", durationSec: 4 }])],
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

describe("codex round six", () => {
  it("migrates a pass-segment line through its pass, carrying the segment's window", () => {
    const value = production({
      takes: [take(PASS, ["sh_1", "sh_2"], { media: "pass.mp4" }), take(SEGMENT, ["sh_1"], { segment: { passTakeId: PASS, inSec: 2, outSec: 5 } })],
      cut: { audio: [{ kind: "dialogue", label: "Dialogue", entries: [{ takeId: SEGMENT, shotId: "sh_1", offsetSec: 0 }] }], overlays: [] },
    });
    const { timeline, dropped } = migrateLegacyCut(seedStoryPictureTimeline(value), value, artifacts);
    assert.deepEqual(dropped, [], "the line is carried, not dropped");
    const dialogue = timeline.tracks.find((track) => track.kind === "dialogue");
    assert.ok(dialogue, "a Dialogue track was made");
    const [clip] = dialogue.clips;
    assert.ok(clip);
    assert.deepEqual(clip.source.kind === "take" ? clip.source.takeId : null, PASS, "the clip cites the pass, which has the media");
    assert.equal(clip.sourceInFrames, 50, "2s into the pass at 25 fps");
    assert.equal(clip.durationFrames, 75, "the segment's 3s");
  });

  it("delivers an episode of a music-timed production once its timeline is saved", () => {
    const spine: ProductionSpine = {
      schemaVersion: 1,
      revision: 1,
      trackArtifactId: SONG,
      markers: [],
      anchors: { sh_1: { startSec: 0, endSec: 4, clipAudio: { mode: "mute" } }, sh_2: { startSec: 4, endSec: 8, clipAudio: { mode: "mute" } } },
      updatedAt: AT,
    };
    const value = production({ spine, episodes: [episode("ep_one", 1, ["sc_a"])] });
    const scope = { kind: "episode" as const, episodeId: "ep_one" };
    const before = buildRenderPlan({ production: value, artifacts, timeline: { status: "absent" }, scope, preset: "review-cut" });
    assert.equal(before.ok, false, "the legacy spine has no episode authority");
    const timeline = seedSpinePictureTimeline(value, spine, 12);
    const after = buildRenderPlan({ production: value, artifacts, timeline: { status: "ready", timeline }, scope, preset: "review-cut" });
    assert.equal(after.ok, true, after.ok ? "" : after.reason);
    if (after.ok) assert.equal(after.plan.totalSec, 8);
  });

  it("refuses a clip id that leaves one track and reappears on another inside one batch", () => {
    const seeded = seedStoryPictureTimeline(production());
    const withInserts = applyTimelineCommands(seeded, [{ kind: "add-track", trackId: "tr_inserts", trackKind: "picture", name: "Inserts" }]);
    assert.throws(
      () =>
        applyTimelineCommands(withInserts, [
          { kind: "delete", clipId: "cl_sh-2" },
          { kind: "place", trackId: "tr_inserts", clip: { id: "cl_sh-2", startFrame: 0, durationFrames: 10, sourceInFrames: 0, source: { kind: "artifact", artifactId: SONG, label: "again" } } },
        ]),
      /earlier in this batch/,
    );
  });
});
