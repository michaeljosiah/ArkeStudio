import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  TimelineOperationRefused,
  applyTimelineCommands,
  buildRenderPlan,
  episodeTimelineRange,
  parseSubtitles,
  seedStoryPictureTimeline,
  type Episode,
  type ProductionBundle,
  type RenderArtifact,
  type Scene,
} from "../src/index.js";

/**
 * Round seven of PR 696: a scene in two episodes refuses both, a take on the base Picture track
 * renders as a clip, the base track cannot be ordered above an overlay, and a subtitle stamp
 * with 99 seconds is a problem rather than a time.
 */

const AT = "2026-09-02T10:00:00Z";
const TAKE = "tk_01J8E0000000000000000000T1";
const artifacts: RenderArtifact[] = [];

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

function production(over: Partial<ProductionBundle> = {}): ProductionBundle {
  return {
    performances: [],
    meta: { id: "bell-watch", format: "video", medium: "video", kind: "microdrama", title: "Bell Watch", status: "in-progress", frameRate: 25, failureModes: [], created: AT, updated: AT },
    story: null,
    season: null,
    routing: null,
    treatment: null,
    chapters: [],
    scenes: [scene("sc_a", 1, [{ id: "sh_1", durationSec: 2 }, { id: "sh_2", durationSec: 2 }]), scene("sc_b", 2, [{ id: "sh_3", durationSec: 2 }])],
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

describe("codex round seven", () => {
  it("refuses an episode range when a scene belongs to two episodes", () => {
    const value = production({ episodes: [episode("ep_one", 1, ["sc_a"]), episode("ep_two", 2, ["sc_a", "sc_b"])] });
    const seeded = seedStoryPictureTimeline(value);
    for (const id of ["ep_one", "ep_two"]) {
      const range = episodeTimelineRange(value, seeded, id);
      assert.equal(range.ok, false, id);
      if (!range.ok) assert.match(range.reason, /shares sc_a/);
    }
  });

  it("renders a take placed on the base Picture track as a clip", () => {
    const value = production({
      takes: [
        {
          id: TAKE,
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
      takeMediaInfo: { [TAKE]: { sourceHash: `sha256:${"a".repeat(64)}`, mediaInfo: { durationSec: 6, hasAudio: true }, probedAt: AT } },
    });
    const timeline = applyTimelineCommands(seedStoryPictureTimeline(value), [
      { kind: "place", trackId: "tr_picture", clip: { id: "cl_insert", startFrame: 150, durationFrames: 50, sourceInFrames: 25, source: { kind: "take", takeId: TAKE, label: "the take" } } },
    ]);
    const plan = buildRenderPlan({ production: value, artifacts, timeline: { status: "ready", timeline }, scope: { kind: "production" }, preset: "review-cut" });
    assert.equal(plan.ok, true, plan.ok ? "" : plan.reason);
    if (!plan.ok) return;
    const clip = plan.plan.items.find((item) => item.type === "clip");
    assert.ok(clip && clip.type === "clip", "the take is a clip, not a slate");
    assert.equal(clip.path, `productions/bell-watch/takes/${TAKE}/clip.mp4`);
    assert.equal(clip.inSec, 1, "a second into the take");
    assert.ok(plan.plan.audio.some((item) => item.clipId === "cl_insert" && item.role === "picture"), "its own sound plays");
  });

  it("keeps the base Picture track below every other Picture track", () => {
    const seeded = seedStoryPictureTimeline(production());
    const withInserts = applyTimelineCommands(seeded, [{ kind: "add-track", trackId: "tr_inserts", trackKind: "picture", name: "Inserts" }]);
    assert.throws(
      () => applyTimelineCommands(withInserts, [{ kind: "set-track", trackId: "tr_picture", order: 9 }]),
      (error: unknown) => error instanceof TimelineOperationRefused && /stays below/.test(error.reason),
    );
    assert.throws(
      () => applyTimelineCommands(seeded, [{ kind: "add-track", trackId: "tr_under", trackKind: "picture", name: "Under", order: 0 }]),
      TimelineOperationRefused,
    );
    // Audio tracks may sit anywhere in the order; only Picture stacking is composition.
    applyTimelineCommands(withInserts, [{ kind: "add-track", trackId: "tr_bed", trackKind: "music", name: "Bed", order: 7 }]);
  });

  it("reports a subtitle stamp whose seconds or minutes run past 59", () => {
    const srt = ["1", "00:00:99,000 --> 00:01:00,000", "Late.", "", "2", "00:00:01,000 --> 00:00:02,000", "Fine.", ""].join("\n");
    const parsed = parseSubtitles(srt, "srt", 25);
    assert.equal(parsed.cues.length, 1);
    assert.equal(parsed.problems.length, 1);
    const vtt = ["WEBVTT", "", "00:75.000 --> 01:00.000", "Late.", ""].join("\n");
    const short = parseSubtitles(vtt, "vtt", 25);
    assert.equal(short.cues.length, 0);
    assert.equal(short.problems.length, 1);
  });
});
