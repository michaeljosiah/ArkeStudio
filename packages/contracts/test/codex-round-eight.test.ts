import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  TimelineOperationRefused,
  applyTimelineCommands,
  buildRenderPlan,
  pictureAtSec,
  seedSpinePictureTimeline,
  seedStoryPictureTimeline,
  type ProductionBundle,
  type ProductionSpine,
  type RenderArtifact,
  type Scene,
} from "../src/index.js";

/**
 * Round eight of PR 696: kept diegetic sound survives a pass-segment take on the song timeline,
 * a still overlay reports the base clip under it, and a cue id cannot cross tracks in one batch.
 */

const AT = "2026-09-02T10:00:00Z";
const SONG = "ar_01J8G0000000000000000000A6";
const PLATE = "ar_01J8G0000000000000000000A1";
const PASS = "tk_01J8E0000000000000000000P1";
const SEGMENT = "tk_01J8E0000000000000000000S1";
const artifacts: RenderArtifact[] = [
  { id: SONG, file: "song.mp3", kind: "audio", mediaInfo: { hasAudio: true, durationSec: 12 } },
  { id: PLATE, file: "plate.png", kind: "image" },
];

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
    scenes: [scene("sc_a", 1, [{ id: "sh_1", durationSec: 3 }, { id: "sh_2", durationSec: 3 }])],
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

describe("codex round eight", () => {
  it("keeps a shot's diegetic sound when its accepted take is a pass segment", () => {
    const spine: ProductionSpine = {
      schemaVersion: 1,
      revision: 1,
      trackArtifactId: SONG,
      markers: [],
      anchors: { sh_1: { startSec: 0, endSec: 3, clipAudio: { mode: "keep-diegetic", gainDb: -6 } } },
      updatedAt: AT,
    };
    const value = production({
      spine,
      takes: [take(PASS, ["sh_1", "sh_2"], { media: "pass.mp4" }), take(SEGMENT, ["sh_1"], { segment: { passTakeId: PASS, inSec: 2, outSec: 5 } })],
      selections: { sh_1: { acceptedTakeId: SEGMENT, trimInSec: 0 } },
      takeMediaInfo: { [PASS]: { sourceHash: `sha256:${"a".repeat(64)}`, mediaInfo: { durationSec: 9, hasAudio: true }, probedAt: AT } },
    });
    const timeline = seedSpinePictureTimeline(value, spine, 12);
    const plan = buildRenderPlan({ production: value, artifacts, timeline: { status: "ready", timeline }, scope: { kind: "production" }, preset: "review-cut" });
    assert.equal(plan.ok, true, plan.ok ? "" : plan.reason);
    if (!plan.ok) return;
    const kept = plan.plan.audio.find((item) => item.role === "picture");
    assert.ok(kept, "the segment's sound rides under the song");
    assert.equal(kept.path, `productions/bell-watch/takes/${PASS}/pass.mp4`);
    assert.equal(kept.gainDb, -6);
  });

  it("reports the base clip under a still overlay so the preview composites rather than replaces", () => {
    const value = production({
      takes: [take(PASS, ["sh_1"], { media: "pass.mp4" })],
      selections: { sh_1: { acceptedTakeId: PASS, trimInSec: 0 } },
      takeMediaInfo: { [PASS]: { sourceHash: `sha256:${"a".repeat(64)}`, mediaInfo: { durationSec: 9, hasAudio: false }, probedAt: AT } },
    });
    const timeline = applyTimelineCommands(seedStoryPictureTimeline(value), [
      { kind: "add-track", trackId: "tr_inserts", trackKind: "picture", name: "Inserts" },
      { kind: "place", trackId: "tr_inserts", clip: { id: "cl_logo", startFrame: 25, durationFrames: 25, sourceInFrames: 0, source: { kind: "artifact", artifactId: PLATE, label: "logo" } } },
    ]);
    const plan = buildRenderPlan({ production: value, artifacts, timeline: { status: "ready", timeline }, scope: { kind: "production" }, preset: "review-cut" });
    assert.equal(plan.ok, true, plan.ok ? "" : plan.reason);
    if (!plan.ok) return;
    const visible = pictureAtSec(plan.plan, 1.5);
    assert.ok(visible && visible.still, "the logo is on top");
    assert.deepEqual(visible.under, { path: `productions/bell-watch/takes/${PASS}/pass.mp4`, sourceSec: 1.5, label: visible.under?.label ?? "" });
    assert.equal(pictureAtSec(plan.plan, 0.5)?.under, undefined, "no overlay, no under");
  });

  it("refuses a subtitle id that leaves one track and reappears on another inside one batch", () => {
    const base = applyTimelineCommands(seedStoryPictureTimeline(production()), [
      { kind: "add-subtitle-track", trackId: "tr_subs-en", name: "English", language: "en" },
      { kind: "add-subtitle-track", trackId: "tr_subs-fr", name: "French", language: "fr" },
      { kind: "add-cue", trackId: "tr_subs-en", cue: { id: "cu_1", text: "Hello.", startFrame: 0, endFrame: 25 } },
    ]);
    assert.throws(
      () =>
        applyTimelineCommands(base, [
          { kind: "delete-cue", cueId: "cu_1" },
          { kind: "add-cue", trackId: "tr_subs-fr", cue: { id: "cu_1", text: "Bonjour.", startFrame: 0, endFrame: 25 } },
        ]),
      (error: unknown) => error instanceof TimelineOperationRefused && /earlier in this batch/.test(error.reason),
    );
  });
});
