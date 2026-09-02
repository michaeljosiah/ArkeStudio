import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyTimelineCommands,
  buildRenderPlan,
  migrateLegacyCut,
  pictureAtSec,
  seedStoryPictureTimeline,
  sourceLengthFramesFor,
  type ProductionBundle,
  type RenderArtifact,
  type Scene,
} from "../src/index.js";

/**
 * Round nine of PR 696: takes resolve through their pass on typed audio and upper Picture
 * tracks, the base sits under a video overlay too, a soundless artifact on a legacy audio entry
 * is dropped by name, and a trimmed selection bounds the tail by what remains.
 */

const AT = "2026-09-02T10:00:00Z";
const PLATE = "ar_01J8G0000000000000000000A1";
const PASS = "tk_01J8E0000000000000000000P1";
const SEGMENT = "tk_01J8E0000000000000000000S1";
const TAKE2 = "tk_01J8E0000000000000000000T2";
const artifacts: RenderArtifact[] = [{ id: PLATE, file: "plate.png", kind: "image" }];

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
    takes: [take(PASS, ["sh_1", "sh_2"], { media: "pass.mp4" }), take(SEGMENT, ["sh_1"], { segment: { passTakeId: PASS, inSec: 2, outSec: 5 } }), take(TAKE2, ["sh_2"], { media: "two.mp4" })],
    reviews: [],
    selections: { sh_1: { acceptedTakeId: PASS, trimInSec: 0 }, sh_2: { acceptedTakeId: TAKE2, trimInSec: 0 } },
    spine: null,
    cut: { audio: [], overlays: [] },
    editorRequests: [],
    takeMediaInfo: {
      [PASS]: { sourceHash: `sha256:${"a".repeat(64)}`, mediaInfo: { durationSec: 10, hasAudio: true }, probedAt: AT },
      [TAKE2]: { sourceHash: `sha256:${"b".repeat(64)}`, mediaInfo: { durationSec: 6, hasAudio: false }, probedAt: AT },
    },
    ...over,
  };
}

describe("codex round nine", () => {
  it("plays a pass segment on a typed audio track and an upper Picture track through its pass", () => {
    const value = production();
    const timeline = applyTimelineCommands(seedStoryPictureTimeline(value), [
      { kind: "add-track", trackId: "tr_dialogue", trackKind: "dialogue", name: "Dialogue" },
      { kind: "place", trackId: "tr_dialogue", clip: { id: "cl_line", startFrame: 0, durationFrames: 50, sourceInFrames: 25, source: { kind: "take", takeId: SEGMENT, label: "the line" } } },
      { kind: "add-track", trackId: "tr_inserts", trackKind: "picture", name: "Inserts" },
      { kind: "place", trackId: "tr_inserts", clip: { id: "cl_insert", startFrame: 100, durationFrames: 50, sourceInFrames: 0, source: { kind: "take", takeId: SEGMENT, label: "the insert" } } },
    ]);
    const plan = buildRenderPlan({ production: value, artifacts, timeline: { status: "ready", timeline }, scope: { kind: "production" }, preset: "review-cut" });
    assert.equal(plan.ok, true, plan.ok ? "" : plan.reason);
    if (!plan.ok) return;
    const line = plan.plan.audio.find((item) => item.clipId === "cl_line");
    assert.ok(line, "the line plays");
    assert.equal(line.path, `productions/bell-watch/takes/${PASS}/pass.mp4`);
    assert.equal(line.sourceInSec, 3, "the segment's 2s plus the clip's own second");
    const insert = plan.plan.overlays.find((overlay) => !overlay.still);
    assert.ok(insert, "the insert is a video overlay");
    assert.equal(insert.path, `productions/bell-watch/takes/${PASS}/pass.mp4`);
    assert.equal(insert.sourceInSec, 2);
    // The base keeps playing under the video insert in preview, as it does in the export.
    const visible = pictureAtSec(plan.plan, 4.5);
    assert.ok(visible && !visible.still && visible.under !== undefined, JSON.stringify(visible));
    assert.equal(visible.under.path, `productions/bell-watch/takes/${TAKE2}/two.mp4`, "the base shot under the insert");
  });

  it("drops a legacy audio entry whose artifact carries no sound, by name", () => {
    const value = production({
      cut: { audio: [{ kind: "score", label: "Score", entries: [{ artifactId: PLATE, offsetSec: 0 }] }], overlays: [] },
    });
    const { timeline, dropped } = migrateLegacyCut(seedStoryPictureTimeline(value), value, artifacts);
    assert.equal(dropped.length, 1);
    assert.match(dropped[0]!, /plate\.png.*not known to carry sound/);
    assert.ok(!timeline.tracks.some((track) => track.kind === "music" && track.clips.length > 0), "no silent Music clip was saved");
    const plan = buildRenderPlan({ production: value, artifacts, timeline: { status: "ready", timeline }, scope: { kind: "production" }, preset: "review-cut" });
    assert.equal(plan.ok, true, plan.ok ? "" : plan.reason);
  });

  it("bounds a shot's tail by what remains after the selection's own trim", () => {
    const value = production({ selections: { sh_1: { acceptedTakeId: PASS, trimInSec: 6 } } });
    const seeded = seedStoryPictureTimeline(value);
    const clip = seeded.tracks[0]!.clips.find((candidate) => candidate.source.kind === "shot" && candidate.source.shotId === "sh_1")!;
    const length = sourceLengthFramesFor(value, [])(clip);
    assert.equal(length, 100, "10s measured, 6s already trimmed in, 4s remain at 25 fps");
    const untrimmed = sourceLengthFramesFor(production(), [])(clip);
    assert.equal(untrimmed, 250);
  });
});
