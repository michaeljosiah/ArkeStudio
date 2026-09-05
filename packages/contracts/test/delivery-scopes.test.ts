import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyTimelineCommands,
  audioAtSec,
  buildFfmpegArgs,
  buildRenderPlan,
  cueAtSec,
  episodeTimelineRange,
  pictureAtSec,
  seedSpinePictureTimeline,
  seedStoryPictureTimeline,
  spineTimelineFingerprint,
  timelineSourceFingerprint,
  windowPlan,
  type Episode,
  type ProductionBundle,
  type ProductionSpine,
  type RenderArtifact,
  type Scene,
} from "../src/index.js";

/**
 * Every visible track in production, episode and music-timed delivery (SPEC-037 R-32..R-34,
 * SPEC-038 R-3, R-30..R-36; issue #682): one timeline fixture reaches all three scopes through
 * one plan, an episode is that plan windowed to a validated contiguous range, and a music-timed
 * production's first assembly is its anchors plus the master as a Music clip.
 */

const AT = "2026-09-02T10:00:00Z";
const TAKE_A = "tk_01J8E0000000000000000000T1";
const TAKE_C = "tk_01J8E0000000000000000000T3";
const SONG = "ar_01J8G0000000000000000000A6";
const BELLS = "ar_01J8G0000000000000000000A3";
const PLATE = "ar_01J8G0000000000000000000A1";

const artifacts: RenderArtifact[] = [
  { id: PLATE, file: "plate.png", kind: "image" },
  { id: BELLS, file: "bells.wav", kind: "audio", mediaInfo: { hasAudio: true, durationSec: 20 } },
  { id: SONG, file: "song.mp3", kind: "audio", mediaInfo: { hasAudio: true, durationSec: 12 } },
];

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

function take(id: string, shotId: string) {
  return {
    id,
    jobId: "jb_01J8E0000000000000000000J1",
    coversShots: [shotId],
    kind: "clip" as const,
    provider: "fal",
    model: "seedance-2.0",
    provenance: { canonRevision: 1, sheets: {} },
    prompt: "a shot",
    references: [],
    params: {},
    cost: { estimatedMicroUsd: 1000, actualMicroUsd: null },
    dispatchedAt: AT,
    media: "clip.mp4",
  };
}

/** Two scenes in two episodes: sc_a (sh_1 2s, sh_2 1.5s) and sc_b (sh_3 4s, sh_4 2s) at 25 fps. */
function production(over: Partial<ProductionBundle> = {}): ProductionBundle {
  return {
    rehearsals: [], performances: [], performanceReview: { reviews: [], selections: {}, reviewHash: null, selectionHash: null },
    meta: { id: "bell-watch", format: "video", medium: "video", kind: "microdrama", title: "Bell Watch", status: "in-progress", frameRate: 25, failureModes: [], created: AT, updated: AT },
    story: null,
    season: null,
    routing: null,
    treatment: null,
    chapters: [],
    scenes: [
      scene("sc_a", 1, [{ id: "sh_1", durationSec: 2 }, { id: "sh_2", durationSec: 1.5 }]),
      scene("sc_b", 2, [{ id: "sh_3" }, { id: "sh_4", durationSec: 2 }]),
    ],
    sceneFiles: {},
    episodes: [episode("ep_one", 1, ["sc_a"]), episode("ep_two", 2, ["sc_b"])],
    episodeFiles: {},
    takes: [take(TAKE_A, "sh_1"), take(TAKE_C, "sh_3")],
    reviews: [],
    selections: { sh_1: { acceptedTakeId: TAKE_A, trimInSec: 0 }, sh_3: { acceptedTakeId: TAKE_C, trimInSec: 0 } },
    spine: null,
    cut: { audio: [], overlays: [] },
    editorRequests: [],
    takeMediaInfo: {
      [TAKE_A]: { sourceHash: `sha256:${"a".repeat(64)}`, mediaInfo: { durationSec: 3, hasAudio: true }, probedAt: AT },
      [TAKE_C]: { sourceHash: `sha256:${"c".repeat(64)}`, mediaInfo: { durationSec: 6, hasAudio: true }, probedAt: AT },
    },
    ...over,
  };
}

function ok<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  assert.equal(result.ok, true, "reason" in result ? String((result as { reason?: string }).reason) : "");
  return result as Extract<T, { ok: true }>;
}

describe("one timeline, three delivery scopes (#682)", () => {
  it("derives a contiguous episode range and refuses an interleaved one by name", () => {
    const value = production();
    const seeded = seedStoryPictureTimeline(value);
    assert.deepEqual(episodeTimelineRange(value, seeded, "ep_one"), { ok: true, startFrame: 0, endFrame: 88 });
    assert.deepEqual(episodeTimelineRange(value, seeded, "ep_two"), { ok: true, startFrame: 88, endFrame: 238 });
    // sh_3 (episode two) moves between sh_1 and sh_2: episode one is no longer one range.
    const interleaved = applyTimelineCommands(seeded, [{ kind: "move-to-order", clipId: "cl_sh-3", index: 1 }]);
    const refused = episodeTimelineRange(value, interleaved, "ep_one");
    assert.deepEqual(refused, { ok: false, reason: "one is interleaved with sh_3 (two); an episode delivers one contiguous range" });
    // Episode two is interleaved from its side as well: sh_2 now sits between sh_3 and sh_4.
    assert.deepEqual(episodeTimelineRange(value, interleaved, "ep_two"), { ok: false, reason: "two is interleaved with sh_2 (one); an episode delivers one contiguous range" });
    // Moving the whole of episode two ahead of episode one keeps both contiguous.
    const swapped = applyTimelineCommands(seeded, [
      { kind: "move-to-order", clipId: "cl_sh-3", index: 0 },
      { kind: "move-to-order", clipId: "cl_sh-4", index: 1 },
    ]);
    assert.deepEqual(episodeTimelineRange(value, swapped, "ep_two"), { ok: true, startFrame: 0, endFrame: 150 });
    assert.deepEqual(episodeTimelineRange(value, swapped, "ep_one"), { ok: true, startFrame: 150, endFrame: 238 });
    const emptied = applyTimelineCommands(seeded, [{ kind: "delete", clipId: "cl_sh-1" }, { kind: "delete", clipId: "cl_sh-2" }]);
    assert.deepEqual(episodeTimelineRange(value, emptied, "ep_one"), { ok: false, reason: "one has no Picture clips on the timeline" });
    assert.equal(episodeTimelineRange(value, seeded, "ep_nine").ok, false);
  });

  it("windows the production plan to an episode so every scope agrees at named frames", () => {
    const value = production({
      cut: {
        audio: [],
        overlays: [{ id: "ov_01J8G0000000000000000000B1", artifactId: PLATE, startSec: 3, endSec: 5, lane: 0, audio: "keep" }],
      },
    });
    const seeded = seedStoryPictureTimeline(value);
    const timeline = applyTimelineCommands(seeded, [
      { kind: "add-track", trackId: "tr_music", trackKind: "music", name: "Music" },
      { kind: "place", trackId: "tr_music", clip: { id: "cl_bed", startFrame: 50, durationFrames: 150, sourceInFrames: 0, source: { kind: "artifact", artifactId: BELLS, label: "bells" }, gainDb: -3 } },
      { kind: "add-subtitle-track", trackId: "tr_subs-en", name: "English", language: "en" },
      { kind: "add-cue", trackId: "tr_subs-en", cue: { id: "cu_1", text: "Across the cut", startFrame: 75, endFrame: 125 } },
    ]);
    const state = { status: "ready" as const, timeline };
    const whole = ok(buildRenderPlan({ production: value, artifacts, timeline: state, scope: { kind: "production" }, preset: "review-cut", subtitles: { trackId: "tr_subs-en", mode: "burn-in" } })).plan;
    const two = ok(buildRenderPlan({ production: value, artifacts, timeline: state, scope: { kind: "episode", episodeId: "ep_two" }, preset: "review-cut", subtitles: { trackId: "tr_subs-en", mode: "burn-in" } })).plan;
    assert.deepEqual(two.range, { startSec: 3.52, endSec: 9.52 });
    assert.equal(two.totalSec, 6);
    assert.equal(two.scope.kind, "episode");
    for (const offset of [0, 0.2, 1, 1.4, 2, 3.9, 5.9]) {
      const inWhole = pictureAtSec(whole, 3.52 + offset);
      const inTwo = pictureAtSec(two, offset);
      assert.deepEqual(inTwo && { path: inTwo.path, sourceSec: Math.round(inTwo.sourceSec * 1000), layer: inTwo.layer }, inWhole && { path: inWhole.path, sourceSec: Math.round(inWhole.sourceSec * 1000), layer: inWhole.layer }, `picture at +${offset}s`);
      assert.deepEqual(
        audioAtSec(two, offset).map((clip) => [clip.path, Math.round(clip.effectiveGainDb * 100), Math.round((clip.sourceInSec + (offset - clip.startSec)) * 1000)]),
        audioAtSec(whole, 3.52 + offset).map((clip) => [clip.path, Math.round(clip.effectiveGainDb * 100), Math.round((clip.sourceInSec + (3.52 + offset - clip.startSec)) * 1000)]),
        `sound at +${offset}s`,
      );
      assert.equal(cueAtSec(two, offset)?.text ?? null, cueAtSec(whole, 3.52 + offset)?.text ?? null, `cue at +${offset}s`);
    }
    // The plate straddles the cut: its head is gone, the rest is there, held as a still.
    assert.deepEqual(two.overlays, [{ path: "artifacts/plate.png", startSec: 0, endSec: 1.48, still: true }]);
    // The bed started 1.52s before the episode: it enters 1.52s into its source.
    assert.deepEqual(two.audio.map((clip) => [clip.startSec, clip.endSec, Math.round(clip.sourceInSec * 100) / 100]), [[0, 4.48, 1.52]]);
    assert.deepEqual(two.burnIn?.cues.map((cue) => [Math.round(cue.startSec * 100) / 100, Math.round(cue.endSec * 100) / 100]), [[0, 1.48]]);
    const graph = buildFfmpegArgs(two, "/w", "/out.mp4", "/f.ttf");
    assert.match(graph[graph.indexOf("-filter_complex") + 1]!, /concat=n=2:v=1:a=0/, "the two episode-two shots and nothing of episode one");
    const refused = buildRenderPlan({ production: value, artifacts, timeline: { status: "ready", timeline: applyTimelineCommands(timeline, [{ kind: "move-to-order", clipId: "cl_sh-3", index: 1 }]) }, scope: { kind: "episode", episodeId: "ep_one" }, preset: "master" });
    assert.deepEqual(refused, { ok: false, reason: "episode export refused: one is interleaved with sh_3 (two); an episode delivers one contiguous range" });
  });

  it("seeds a music-timed assembly from the anchors and mixes the master with the edited picture", () => {
    const spine: ProductionSpine = {
      schemaVersion: 1,
      revision: 3,
      trackArtifactId: SONG,
      markers: [],
      anchors: {
        sh_3: { startSec: 4, endSec: 9, clipAudio: { mode: "keep-diegetic", gainDb: -12 } },
        sh_1: { startSec: 1, endSec: 5, clipAudio: { mode: "mute" } },
        sh_9: { startSec: 10, endSec: 11, clipAudio: { mode: "mute" } },
      },
      updatedAt: AT,
    };
    const value = production({ spine, episodes: [] });
    const seeded = seedSpinePictureTimeline(value, spine, 12);
    assert.deepEqual(
      seeded.tracks[0]!.clips.map((clip) => [clip.id, clip.startFrame, clip.durationFrames, clip.audio, clip.gainDb]),
      [
        ["cl_sh-1", 25, 100, "mute", undefined],
        ["cl_sh-3", 125, 100, "keep", -12],
      ],
      "anchors in play order, the later one starting where the earlier ends; a deleted shot is no clip",
    );
    assert.equal(seeded.tracks[0]!.endFrame, 300, "the picture track remembers the song's end");
    assert.deepEqual(seeded.tracks[1]!.clips.map((clip) => [clip.id, clip.startFrame, clip.durationFrames]), [["cl_master", 0, 300]]);
    assert.equal(seeded.tracks[1]!.kind, "music");

    const print = spineTimelineFingerprint(value, spine, 12);
    assert.match(print, /^spine-picture-v1:[0-9a-f]{16}$/);
    assert.notEqual(print, spineTimelineFingerprint(value, spine, 13), "the measured length is part of the source");
    assert.notEqual(print, spineTimelineFingerprint(value, { ...spine, anchors: { ...spine.anchors, sh_1: { startSec: 2, endSec: 5, clipAudio: { mode: "mute" } } } }, 12));
    assert.equal(timelineSourceFingerprint(value, null), null, "an unmeasured master has no first assembly");
    assert.equal(timelineSourceFingerprint(value, 12), print);
    assert.match(timelineSourceFingerprint(production(), null) ?? "", /^story-picture-v1:/);

    assert.equal(buildRenderPlan({ production: value, artifacts, timeline: { status: "absent" }, scope: { kind: "production" }, preset: "master" }).ok, false, "absent still means the spine plan");
    const plan = ok(buildRenderPlan({ production: value, artifacts, timeline: { status: "ready", timeline: seeded }, scope: { kind: "production" }, preset: "master" })).plan;
    assert.equal(plan.totalSec, 12, "the song is the film's length");
    assert.deepEqual(plan.items.map((item) => [item.type, Math.round(item.durationSec * 100) / 100]), [["black", 1], ["clip", 4], ["clip", 4], ["black", 3]]);
    assert.deepEqual(
      plan.audio.map((clip) => [clip.clipId, clip.role, clip.gainDb, clip.startSec, clip.endSec]),
      [
        ["cl_sh-3", "picture", -12, 5, 9],
        ["cl_master", "music", 0, 0, 12],
      ],
      "the kept diegetic sound rides under the master at its stated gain; the muted shot is silent",
    );
    // Edited picture order is what the music-timed delivery mixes the master with (R-32).
    const edited = applyTimelineCommands(seeded, [{ kind: "move-adjacent", clipId: "cl_sh-3", direction: "earlier" }]);
    const editedPlan = ok(buildRenderPlan({ production: value, artifacts, timeline: { status: "ready", timeline: edited }, scope: { kind: "production" }, preset: "master" })).plan;
    assert.equal(pictureAtSec(editedPlan, 2)?.path, `productions/bell-watch/takes/${TAKE_C}/clip.mp4`);
    assert.equal(editedPlan.audio.find((clip) => clip.clipId === "cl_master")?.endSec, 12);
  });

  it("windows nothing when the range is empty and keeps a full-range window identical", () => {
    const value = production();
    const plan = ok(buildRenderPlan({ production: value, artifacts, timeline: { status: "ready", timeline: seedStoryPictureTimeline(value) }, scope: { kind: "production" }, preset: "review-cut" })).plan;
    const same = windowPlan(plan, 0, plan.totalSec, { kind: "production" });
    assert.deepEqual(same.items, plan.items);
    assert.equal(same.totalSec, plan.totalSec);
    const none = windowPlan(plan, 2, 2, { kind: "production" });
    assert.deepEqual(none.items, []);
    assert.equal(none.totalSec, 0);
  });
});
