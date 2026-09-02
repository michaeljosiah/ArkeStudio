import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FrameRateSchema,
  ClientMessageSchema,
  ProductionSchema,
  ProductionTimelineSchema,
  TimelineOperationRefused,
  TimelineStateSchema,
  deriveCut,
  framesToSeconds,
  movePictureClip,
  productionFrameRate,
  redoPictureMove,
  resolvePictureTimeline,
  secondsToFrames,
  seedStoryPictureTimeline,
  storyTimelineFingerprint,
  undoPictureMove,
  type ProductionBundle,
  type Scene,
} from "../src/index.js";

const AT = "2026-09-01T12:00:00Z";
const TAKE = "tk_01J8E0000000000000000000T1";

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

function production(over: Partial<ProductionBundle> = {}): ProductionBundle {
  return {
    meta: {
      id: "bell-watch",
      format: "video",
      title: "Bell Watch",
      status: "in-progress",
      frameRate: 25,
      failureModes: [],
      created: AT,
      updated: AT,
    },
    story: null,
    season: null,
    routing: null,
    treatment: null,
    chapters: [],
    scenes: [
      scene("sc_one", 1, [
        { id: "sh_1", durationSec: 2 },
        { id: "sh_2", durationSec: 1.5 },
        { id: "sh_3" },
      ]),
    ],
    sceneFiles: {},
    episodes: [],
    episodeFiles: {},
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
    reviews: [],
    selections: { sh_1: { acceptedTakeId: TAKE, trimInSec: 0 } },
    spine: null,
    cut: { audio: [], overlays: [] },
    editorRequests: [],
    takeMediaInfo: {},
    ...over,
  };
}

function clipIds(timeline: ReturnType<typeof seedStoryPictureTimeline>): string[] {
  return timeline.tracks[0]!.clips.map((clip) => clip.id);
}

describe("production frame clock", () => {
  it("keeps frameRate optional on disk and resolves legacy productions to 24", () => {
    const legacy = { ...production().meta };
    delete legacy.frameRate;
    const parsed = ProductionSchema.parse(legacy);
    assert.equal(Object.hasOwn(parsed, "frameRate"), false, "reading must not invent a field that could be written back");
    assert.equal(productionFrameRate(parsed), 24);
    assert.equal(productionFrameRate({ frameRate: 25 }), 25);
    assert.equal(FrameRateSchema.safeParse(23).success, false);
  });

  it("rounds seconds to the nearest whole production frame", () => {
    assert.equal(secondsToFrames(1.5, 25), 38);
    assert.equal(framesToSeconds(38, 25), 1.52);
    assert.equal(secondsToFrames(0.01, 24), 0);
    assert.throws(() => secondsToFrames(-1, 24), RangeError);
    assert.throws(() => secondsToFrames(Number.MAX_VALUE, 24), RangeError);
    assert.throws(() => framesToSeconds(1.5, 24), RangeError);
  });
});

describe("timeline command frames", () => {
  it("requires the first-assembly fence and strict history revision", () => {
    assert.equal(
      ClientMessageSchema.safeParse({
        kind: "timeline-move-picture",
        worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC",
        productionId: "bell-watch",
        clipId: "cl_sh-1",
        direction: "later",
        baseRevision: null,
        sourceFingerprint: storyTimelineFingerprint(production()),
      }).success,
      true,
    );
    assert.equal(
      ClientMessageSchema.safeParse({
        kind: "create-production",
        worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC",
        title: "Bell Watch",
        medium: "video",
        frameRate: 25,
      }).success,
      true,
    );
    assert.equal(
      ClientMessageSchema.safeParse({
        kind: "create-production",
        worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC",
        title: "Bell Watch",
        medium: "video",
        frameRate: 23,
      }).success,
      false,
    );
    assert.equal(
      ClientMessageSchema.safeParse({
        kind: "timeline-history",
        worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC",
        productionId: "bell-watch",
        action: "undo",
      }).success,
      false,
    );
    assert.equal(
      ClientMessageSchema.safeParse({
        kind: "export-cut",
        worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC",
        productionId: "bell-watch",
        preset: "review-cut",
        timelineRevision: 4,
      }).success,
      true,
    );
    assert.equal(
      ClientMessageSchema.safeParse({
        kind: "export-cut",
        worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC",
        productionId: "bell-watch",
        preset: "review-cut",
      }).success,
      false,
      "an export must name the timeline revision it previewed, including null for legacy derivation",
    );
  });
});

describe("timeline contracts and first assembly", () => {
  it("seeds every story shot, including unresolved gaps, with stable frame positions", () => {
    const timeline = seedStoryPictureTimeline(production());
    assert.deepEqual(clipIds(timeline), ["cl_sh-1", "cl_sh-2", "cl_sh-3"]);
    assert.deepEqual(
      timeline.tracks[0]!.clips.map((clip) => [clip.startFrame, clip.durationFrames, clip.source.kind === "shot" ? clip.source.shotId : null]),
      [
        [0, 50, "sh_1"],
        [50, 38, "sh_2"],
        [88, 100, "sh_3"],
      ],
    );
    assert.deepEqual(timeline.history, { undo: [], redo: [] });
    assert.equal(timeline.revision, 0);
    assert.equal(timeline.frameRate, 25);

    const resolved = resolvePictureTimeline(production(), { status: "ready", timeline });
    assert.equal(resolved.entries.length, 3, "the two shots without accepted media remain timed entries");
    assert.equal(resolved.gaps, 2);
  });

  it("uses an exact deterministic fingerprint of effective source order and duration", () => {
    const base = production();
    assert.equal(storyTimelineFingerprint(base), storyTimelineFingerprint(production()));
    assert.equal(
      storyTimelineFingerprint(base),
      storyTimelineFingerprint(production({ selections: {} })),
      "take selection does not change the shot-sourced first assembly",
    );
    const reversed = production({
      scenes: [scene("sc_one", 1, [{ id: "sh_3" }, { id: "sh_2", durationSec: 1.5 }, { id: "sh_1", durationSec: 2 }])],
    });
    assert.notEqual(storyTimelineFingerprint(base), storyTimelineFingerprint(reversed));
    assert.notEqual(
      storyTimelineFingerprint(base),
      storyTimelineFingerprint(production({ meta: { ...base.meta, frameRate: 30 } })),
    );
  });

  it("is strict, bounded, and keeps absence outside the saved-document schema", () => {
    const timeline = seedStoryPictureTimeline(production());
    assert.equal(ProductionTimelineSchema.safeParse(timeline).success, true);
    assert.equal(ProductionTimelineSchema.safeParse({ status: "absent" }).success, false);
    assert.deepEqual(TimelineStateSchema.parse({ status: "absent" }), { status: "absent" });
    assert.deepEqual(TimelineStateSchema.parse({ status: "invalid", message: "bad JSON" }), {
      status: "invalid",
      message: "bad JSON",
    });
    assert.equal(
      ProductionTimelineSchema.safeParse({ ...timeline, extra: true }).success,
      false,
      "unknown saved fields are refused",
    );
    assert.equal(
      ProductionTimelineSchema.safeParse({
        ...timeline,
        tracks: [{ ...timeline.tracks[0]!, clips: [{ ...timeline.tracks[0]!.clips[0]!, startFrame: 0.5 }] }],
      }).success,
      false,
    );
    assert.equal(
      ProductionTimelineSchema.safeParse({
        ...timeline,
        tracks: [
          {
            ...timeline.tracks[0]!,
            clips: [{ ...timeline.tracks[0]!.clips[0]!, startFrame: Number.MAX_SAFE_INTEGER }],
          },
        ],
      }).success,
      false,
      "a clip end may not overflow the safe frame clock",
    );

    const entry = {
      kind: "move" as const,
      trackId: timeline.tracks[0]!.id,
      clipId: timeline.tracks[0]!.clips[0]!.id,
      swappedWithClipId: timeline.tracks[0]!.clips[1]!.id,
      direction: "later" as const,
    };
    assert.equal(
      ProductionTimelineSchema.safeParse({
        ...timeline,
        history: { undo: Array.from({ length: 101 }, () => entry), redo: [] },
      }).success,
      false,
    );

    const moved = movePictureClip(timeline, "cl_sh-3", "earlier");
    assert.equal(
      ProductionTimelineSchema.safeParse({
        ...moved,
        history: {
          undo: [
            {
              kind: "move",
              trackId: timeline.tracks[0]!.id,
              clipId: "cl_sh-1",
              swappedWithClipId: "cl_sh-2",
              direction: "later",
            },
          ],
          redo: [],
        },
      }).success,
      false,
      "history that cannot replay from the saved order is invalid",
    );
  });
});

describe("durable Picture move history", () => {
  it("moves one position and round-trips stable identity through undo and redo", () => {
    const seeded = seedStoryPictureTimeline(production());
    const moved = movePictureClip(seeded, "cl_sh-3", "earlier");
    assert.deepEqual(clipIds(moved), ["cl_sh-1", "cl_sh-3", "cl_sh-2"]);
    assert.deepEqual(
      moved.tracks[0]!.clips.map((clip) => [clip.id, clip.startFrame, clip.durationFrames]),
      [
        ["cl_sh-1", 0, 50],
        ["cl_sh-3", 50, 100],
        ["cl_sh-2", 150, 38],
      ],
      "the swapped clips keep their durations and combined frame range",
    );
    assert.equal(moved.revision, 1);
    assert.equal(moved.history.undo.length, 1);
    assert.deepEqual(seeded.history, { undo: [], redo: [] }, "the input record was not mutated");

    const undone = undoPictureMove(moved);
    assert.deepEqual(clipIds(undone), clipIds(seeded));
    assert.deepEqual(undone.tracks[0]!.clips, seeded.tracks[0]!.clips);
    assert.equal(undone.revision, 2);
    assert.equal(undone.history.redo.length, 1);

    const redone = redoPictureMove(undone);
    assert.deepEqual(redone.tracks[0]!.clips, moved.tracks[0]!.clips);
    assert.equal(redone.revision, 3);

    const movedAfterUndo = movePictureClip(undoPictureMove(redone), "cl_sh-1", "later");
    assert.deepEqual(clipIds(movedAfterUndo), ["cl_sh-2", "cl_sh-1", "cl_sh-3"]);
    assert.deepEqual(movedAfterUndo.history.redo, [], "a new move after Undo clears Redo");
    assert.equal(ProductionTimelineSchema.safeParse(movedAfterUndo).success, true);
  });

  it("keeps only the latest 100 durable moves", () => {
    let timeline = seedStoryPictureTimeline(production());
    for (let index = 0; index < 101; index++) {
      timeline = movePictureClip(timeline, "cl_sh-2", index % 2 === 0 ? "earlier" : "later");
    }
    assert.equal(timeline.revision, 101);
    assert.equal(timeline.history.undo.length, 100);
    assert.equal(ProductionTimelineSchema.safeParse(timeline).success, true);
  });

  it("refuses a boundary or empty-history operation without changing the record", () => {
    const seeded = seedStoryPictureTimeline(production());
    assert.throws(() => movePictureClip(seeded, "cl_sh-1", "earlier"), TimelineOperationRefused);
    assert.throws(() => undoPictureMove(seeded), TimelineOperationRefused);
    assert.deepEqual(clipIds(seeded), ["cl_sh-1", "cl_sh-2", "cl_sh-3"]);
    assert.equal(seeded.revision, 0);
  });
});

describe("Picture timeline resolution", () => {
  it("delegates absence exactly to the existing derivation", () => {
    const value = production();
    assert.deepEqual(resolvePictureTimeline(value, { status: "absent" }), deriveCut(value));
  });

  it("uses saved order and frame duration while preserving take and media validity", () => {
    const value = production();
    const derived = deriveCut(value);
    const timeline = movePictureClip(seedStoryPictureTimeline(value), "cl_sh-3", "earlier");
    const resolved = resolvePictureTimeline(value, { status: "ready", timeline });
    assert.deepEqual(
      resolved.entries.map((entry) => [entry.shot.id, entry.clipId]),
      [
        ["sh_1", "cl_sh-1"],
        ["sh_3", "cl_sh-3"],
        ["sh_2", "cl_sh-2"],
      ],
    );
    assert.deepEqual(
      resolved.entries.map((entry) => entry.durationSec),
      [2, 4, 1.52],
    );
    for (const entry of resolved.entries) {
      const before = derived.entries.find((candidate) => candidate.shot.id === entry.shot.id)!;
      assert.equal(entry.takeId, before.takeId);
      assert.equal(entry.take, before.take);
      assert.deepEqual(entry.media, before.media);
    }
    assert.equal(resolved.entries[0]!.media?.path, `productions/bell-watch/takes/${TAKE}/clip.mp4`);
    assert.equal(resolved.gaps, 2);
  });

  it("resolves a cited shot through duplicate story ids and turns a genuine ambiguity into a gap (#718)", () => {
    const value = production();
    const timeline = seedStoryPictureTimeline(value);
    value.scenes.push(scene("sc_two", 2, [{ id: "sh_1" }]));

    const resolved = resolvePictureTimeline(value, { status: "ready", timeline });
    assert.equal(resolved.entries[0]!.sceneNumber, 1, "the clip's scene and shot citation chooses its source");
    assert.equal(resolved.entries[0]!.takeId, TAKE);

    const ambiguous = structuredClone(timeline);
    const source = ambiguous.tracks[0]!.clips[0]!.source;
    assert.equal(source.kind, "shot");
    if (source.kind === "shot") {
      source.sceneNumber = 9;
      source.shotNumber = 9;
    }
    const withGap = resolvePictureTimeline(value, { status: "ready", timeline: ambiguous });
    assert.equal(withGap.entries[0]!.takeId, null);
    assert.equal(withGap.entries[0]!.label, "AMBIGUOUS SHOT 9 · sh_1");
  });

  it("blocks malformed state, freezes the clock, and preserves a deleted source as a gap", () => {
    const value = production();
    assert.throws(
      () => resolvePictureTimeline(value, { status: "invalid", message: "timeline.json is malformed" }),
      /timeline.json is malformed/,
    );
    const timeline = seedStoryPictureTimeline(value);
    assert.throws(
      () =>
        resolvePictureTimeline(
          production({ meta: { ...value.meta, frameRate: 30 } }),
          { status: "ready", timeline },
        ),
      /fixed at 25 fps/,
    );

    const afterDeletion = production({
      scenes: [scene("sc_one", 1, [{ id: "sh_2", durationSec: 1.5 }, { id: "sh_3" }])],
      selections: {},
    });
    const resolved = resolvePictureTimeline(afterDeletion, { status: "ready", timeline });
    assert.deepEqual(resolved.entries.map((entry) => entry.shot.id), ["sh_1", "sh_2", "sh_3"]);
    assert.equal(resolved.entries[0]!.takeId, null);
    assert.equal(resolved.entries[0]!.label, "MISSING SHOT 1 · sh_1");
  });
});
