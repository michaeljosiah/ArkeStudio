import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ProductionTimelineSchema,
  TimelineCommandSchema,
  TimelineOperationRefused,
  applyTimelineCommands,
  formatFrames,
  historySelectionChanges,
  movePictureClip,
  orderedTrackClips,
  redoTimelineHistory,
  resolvePictureTimeline,
  seedStoryPictureTimeline,
  storyOrderDrift,
  undoTimelineHistory,
  type ProductionBundle,
  type ProductionTimeline,
  type Scene,
  type TimelineClip,
  type TimelineClipCommand,
} from "../src/index.js";

/**
 * The command algebra (SPEC-037 R-19..R-27, issue #679): every command is pure, all-or-nothing,
 * and exactly one undo step, and its inverse restores the record byte for byte.
 */

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
    rehearsals: [], performances: [], performanceReview: { reviews: [], selections: {}, reviewHash: null, selectionHash: null },
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

/** Frames 0–50 sh_1, 50–88 sh_2, 88–188 sh_3 at 25 fps. */
function seeded(): ProductionTimeline {
  return seedStoryPictureTimeline(production());
}

function layout(timeline: ProductionTimeline): Array<[string, number, number, number]> {
  return orderedTrackClips(timeline.tracks[0]!).map((clip) => [clip.id, clip.startFrame, clip.durationFrames, clip.sourceInFrames]);
}

function apply(timeline: ProductionTimeline, ...commands: TimelineClipCommand[]): ProductionTimeline {
  return applyTimelineCommands(timeline, commands);
}

function valid(timeline: ProductionTimeline): ProductionTimeline {
  const parsed = ProductionTimelineSchema.safeParse(timeline);
  assert.equal(parsed.success, true, parsed.success ? "" : JSON.stringify(parsed.error.issues));
  return timeline;
}

describe("the Picture command algebra (#679)", () => {
  it("moves to an explicit order while every hole keeps its slot", () => {
    const withHole = apply(seeded(), { kind: "delete", clipId: "cl_sh-2" });
    assert.deepEqual(layout(withHole), [
      ["cl_sh-1", 0, 50, 0],
      ["cl_sh-3", 88, 100, 0],
    ]);
    const moved = valid(apply(withHole, { kind: "move-to-order", clipId: "cl_sh-3", index: 0 }));
    assert.deepEqual(layout(moved), [
      ["cl_sh-3", 0, 100, 0],
      ["cl_sh-1", 138, 50, 0],
    ]);
    assert.equal(moved.history.undo.length, 2);
    assert.deepEqual(layout(undoTimelineHistory(moved)), layout(withHole));
    assert.throws(() => apply(withHole, { kind: "move-to-order", clipId: "cl_sh-3", index: 2 }), TimelineOperationRefused);
    assert.throws(() => apply(withHole, { kind: "move-to-order", clipId: "cl_sh-3", index: 1 }), /changes nothing/);
  });

  it("moves to an explicit frame and refuses to land on another clip", () => {
    const opened = apply(seeded(), { kind: "delete", clipId: "cl_sh-2" });
    const moved = valid(apply(opened, { kind: "move-to-frame", clipId: "cl_sh-3", startFrame: 60 }));
    assert.deepEqual(layout(moved), [
      ["cl_sh-1", 0, 50, 0],
      ["cl_sh-3", 60, 100, 0],
    ]);
    assert.throws(() => apply(opened, { kind: "move-to-frame", clipId: "cl_sh-3", startFrame: 40 }), /overlap/);
    assert.deepEqual(layout(opened), [
      ["cl_sh-1", 0, 50, 0],
      ["cl_sh-3", 88, 100, 0],
    ]);
  });

  it("trims either edge, moving the source edge with the timeline edge", () => {
    const head = valid(apply(seeded(), { kind: "trim", clipId: "cl_sh-2", edge: "start", deltaFrames: 10 }));
    assert.deepEqual(layout(head)[1], ["cl_sh-2", 60, 28, 10]);
    const restored = valid(apply(head, { kind: "trim", clipId: "cl_sh-2", edge: "start", deltaFrames: -10 }));
    assert.deepEqual(layout(restored)[1], ["cl_sh-2", 50, 38, 0]);
    // Extending the head past the source's first frame or into the previous clip both refuse.
    assert.throws(() => apply(seeded(), { kind: "trim", clipId: "cl_sh-2", edge: "start", deltaFrames: -1 }), /no source before/);
    assert.throws(() => apply(head, { kind: "trim", clipId: "cl_sh-2", edge: "start", deltaFrames: -11 }), /no source before/);
    // sh_1 grows to frame 55 while sh_2 sits at 60 with ten frames of source behind it: pulling
    // sh_2's head back six frames has source to spare and still refuses, because of sh_1.
    const crowded = apply(head, { kind: "trim", clipId: "cl_sh-1", edge: "end", deltaFrames: 5 });
    assert.throws(() => apply(crowded, { kind: "trim", clipId: "cl_sh-2", edge: "start", deltaFrames: -6 }), /cannot extend into cl_sh-1/);

    const tail = valid(apply(seeded(), { kind: "trim", clipId: "cl_sh-2", edge: "end", deltaFrames: -8 }));
    assert.deepEqual(layout(tail)[1], ["cl_sh-2", 50, 30, 0]);
    assert.throws(() => apply(seeded(), { kind: "trim", clipId: "cl_sh-2", edge: "end", deltaFrames: 1 }), /cannot extend into cl_sh-3/);
    assert.throws(() => apply(seeded(), { kind: "trim", clipId: "cl_sh-2", edge: "end", deltaFrames: -38 }), /at least one frame/);
    assert.throws(() => apply(seeded(), { kind: "trim", clipId: "cl_sh-2", edge: "start", deltaFrames: 38 }), /at least one frame/);
  });

  it("splits into ranges that recombine exactly and mints one id per split", () => {
    const trimmed = apply(seeded(), { kind: "trim", clipId: "cl_sh-3", edge: "start", deltaFrames: 4 });
    const split = valid(apply(trimmed, { kind: "split", clipId: "cl_sh-3", atFrame: 122, newClipId: "cl_right" }));
    const [left, right] = layout(split).slice(2);
    assert.deepEqual(left, ["cl_sh-3", 92, 30, 4]);
    assert.deepEqual(right, ["cl_right", 122, 66, 34]);
    assert.equal(left![1] + left![2], right![1], "the timeline ranges are contiguous");
    assert.equal(left![3] + left![2], right![3], "the source ranges are contiguous");
    assert.equal(left![2] + right![2], 96, "the combined duration is unchanged");
    const splitEntry = split.history.undo.at(-1)!;
    assert.equal(splitEntry.kind === "change" ? splitEntry.clips.length : 0, 2);
    assert.throws(() => apply(trimmed, { kind: "split", clipId: "cl_sh-3", atFrame: 92, newClipId: "cl_right" }), /not inside/);
    assert.throws(() => apply(trimmed, { kind: "split", clipId: "cl_sh-3", atFrame: 188, newClipId: "cl_right" }), /not inside/);
    assert.throws(() => apply(trimmed, { kind: "split", clipId: "cl_sh-3", atFrame: 122, newClipId: "cl_sh-1" }), /already on the timeline/);
    assert.deepEqual(layout(undoTimelineHistory(split)), layout(trimmed));
  });

  it("duplicates beside the original when there is room, otherwise after everything", () => {
    const opened = apply(seeded(), { kind: "delete", clipId: "cl_sh-3" });
    const beside = valid(apply(opened, { kind: "duplicate", clipId: "cl_sh-2", newClipId: "cl_copy" }));
    assert.deepEqual(layout(beside), [
      ["cl_sh-1", 0, 50, 0],
      ["cl_sh-2", 50, 38, 0],
      ["cl_copy", 88, 38, 0],
    ]);
    // A 50-frame clip does not fit the 38-frame hole its neighbour left, so the copy lands after
    // everything rather than rippling anything to make room.
    const packed = valid(apply(apply(seeded(), { kind: "delete", clipId: "cl_sh-2" }), { kind: "duplicate", clipId: "cl_sh-1", newClipId: "cl_copy" }));
    assert.deepEqual(layout(packed).at(-1), ["cl_copy", 188, 50, 0]);
    const entry = packed.history.undo.at(-1)!;
    assert.equal(entry.kind, "change");
    assert.equal(entry.kind === "change" ? entry.clips.length : 0, 1, "exactly one new clip");
    assert.equal(entry.kind === "change" ? entry.clips[0]!.before : undefined, null);
    assert.equal(packed.tracks[0]!.clips.filter((clip) => clip.source.kind === "shot" && clip.source.shotId === "sh_1").length, 2);
  });

  it("deletes into a hole and ripples only the affected range on the affected track", () => {
    const deleted = valid(apply(seeded(), { kind: "delete", clipId: "cl_sh-2" }));
    assert.deepEqual(layout(deleted), [
      ["cl_sh-1", 0, 50, 0],
      ["cl_sh-3", 88, 100, 0],
    ]);
    const rippled = valid(apply(seeded(), { kind: "ripple-delete", clipId: "cl_sh-2" }));
    assert.deepEqual(layout(rippled), [
      ["cl_sh-1", 0, 50, 0],
      ["cl_sh-3", 50, 100, 0],
    ]);
    // Only the deleted clip's own range closes: a hole that already existed stays open.
    const holed = apply(seeded(), { kind: "move-to-frame", clipId: "cl_sh-3", startFrame: 100 });
    const rippledHole = valid(apply(holed, { kind: "ripple-delete", clipId: "cl_sh-2" }));
    assert.deepEqual(layout(rippledHole), [
      ["cl_sh-1", 0, 50, 0],
      ["cl_sh-3", 62, 100, 0],
    ]);
    assert.deepEqual(layout(undoTimelineHistory(rippledHole)), layout(holed));
  });

  it("applies a batch atomically: a refused command leaves no write and no history", () => {
    const base = seeded();
    assert.throws(
      () =>
        apply(
          base,
          { kind: "delete", clipId: "cl_sh-1" },
          { kind: "move-to-frame", clipId: "cl_sh-3", startFrame: 100 },
          { kind: "trim", clipId: "cl_sh-2", edge: "end", deltaFrames: 13 },
        ),
      /cannot extend into cl_sh-3/,
    );
    assert.equal(base.revision, 0);
    assert.deepEqual(base.history, { undo: [], redo: [] });
    assert.deepEqual(layout(base), layout(seeded()));

    const batch = valid(
      apply(
        base,
        { kind: "move-adjacent", clipId: "cl_sh-3", direction: "earlier" },
        { kind: "move-adjacent", clipId: "cl_sh-3", direction: "later" },
        { kind: "delete", clipId: "cl_sh-1" },
      ),
    );
    assert.equal(batch.revision, 1);
    assert.equal(batch.history.undo.length, 1, "a batch is one undo step");
    const entry = batch.history.undo[0]!;
    assert.equal(entry.kind === "change" ? entry.clips.length : -1, 1, "a clip moved and moved back is not a change");
    assert.deepEqual(layout(undoTimelineHistory(batch)), layout(base));
  });

  it("undoes and redoes through the exact inverse and clears Redo on a new edit", () => {
    let timeline = seeded();
    const steps: TimelineClipCommand[] = [
      { kind: "trim", clipId: "cl_sh-1", edge: "end", deltaFrames: -10 },
      { kind: "split", clipId: "cl_sh-3", atFrame: 100, newClipId: "cl_tail" },
      { kind: "ripple-delete", clipId: "cl_sh-2" },
      { kind: "duplicate", clipId: "cl_tail", newClipId: "cl_tail-2" },
    ];
    const snapshots = [layout(timeline)];
    for (const step of steps) {
      timeline = valid(apply(timeline, step));
      snapshots.push(layout(timeline));
    }
    assert.equal(timeline.revision, 4);
    for (let index = steps.length; index > 0; index -= 1) {
      timeline = valid(undoTimelineHistory(timeline));
      assert.deepEqual(layout(timeline), snapshots[index - 1]);
    }
    assert.throws(() => undoTimelineHistory(timeline), /nothing to undo/);
    for (let index = 1; index <= steps.length; index += 1) {
      timeline = valid(redoTimelineHistory(timeline));
      assert.deepEqual(layout(timeline), snapshots[index]);
    }
    assert.equal(timeline.revision, 12);
    timeline = undoTimelineHistory(undoTimelineHistory(timeline));
    assert.equal(timeline.history.redo.length, 2);
    timeline = valid(apply(timeline, { kind: "delete", clipId: "cl_sh-1" }));
    assert.deepEqual(timeline.history.redo, [], "a new edit after Undo clears Redo");
  });

  it("refuses history that no longer replays from the saved record", () => {
    const edited = apply(seeded(), { kind: "trim", clipId: "cl_sh-1", edge: "end", deltaFrames: -10 });
    const tampered: ProductionTimeline = {
      ...edited,
      tracks: edited.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip): TimelineClip => (clip.id === "cl_sh-1" ? { ...clip, durationFrames: 45 } : clip)),
      })),
    };
    const parsed = ProductionTimelineSchema.safeParse(tampered);
    assert.equal(parsed.success, false);
    assert.match(JSON.stringify(parsed.success ? [] : parsed.error.issues), /not replayable from its undo position/);
    assert.throws(() => undoTimelineHistory(tampered), /not in its undo position/);
  });

  it("still undoes the first slice's move entries", () => {
    const seededRecord = seeded();
    const legacy: ProductionTimeline = {
      ...seededRecord,
      revision: 1,
      tracks: seededRecord.tracks.map((track) => ({
        ...track,
        clips: [
          { ...track.clips[0]!, id: "cl_sh-2", startFrame: 0, durationFrames: 38, source: track.clips[1]!.source },
          { ...track.clips[1]!, id: "cl_sh-1", startFrame: 38, durationFrames: 50, source: track.clips[0]!.source },
          track.clips[2]!,
        ],
      })),
      history: {
        undo: [{ kind: "move", trackId: "tr_picture", clipId: "cl_sh-2", swappedWithClipId: "cl_sh-1", direction: "earlier" }],
        redo: [],
      },
    };
    valid(legacy);
    const undone = valid(undoTimelineHistory(legacy));
    assert.deepEqual(layout(undone), layout(seededRecord));
    assert.equal(undone.history.redo[0]?.kind, "move");
    assert.deepEqual(layout(redoTimelineHistory(undone)), layout(legacy));
    // New moves write change entries, on the same stack, beside the legacy one.
    const moved = valid(movePictureClip(legacy, "cl_sh-3", "earlier"));
    assert.equal(moved.history.undo.at(-1)?.kind, "change");
    assert.deepEqual(layout(undoTimelineHistory(undoTimelineHistory(moved))), layout(seededRecord));
  });

  it("records a take switch as a selection change that Undo reverses without touching reviews", () => {
    const before = { acceptedTakeId: null, trimInSec: 0 };
    const after = { acceptedTakeId: TAKE, trimInSec: 0 };
    const switched = valid(
      applyTimelineCommands(seeded(), [], {
        label: "Use a take for sh_2",
        selections: [{ shotId: "sh_2", before, after }],
      }),
    );
    assert.equal(switched.history.undo.length, 1);
    assert.deepEqual(layout(switched), layout(seeded()), "a take switch moves no clip");
    const entry = switched.history.undo[0]!;
    assert.deepEqual(historySelectionChanges(entry, "undo"), [{ shotId: "sh_2", before: after, after: before }]);
    assert.deepEqual(historySelectionChanges(entry, "redo"), [{ shotId: "sh_2", before, after }]);
    assert.throws(
      () => applyTimelineCommands(seeded(), [], { selections: [{ shotId: "sh_2", before: after, after }] }),
      /changes nothing/,
    );
  });

  it("names story drift without blocking it", () => {
    const value = production();
    assert.deepEqual(storyOrderDrift(value, seeded()), { reordered: false, missing: [], repeated: [] });
    const reordered = apply(seeded(), { kind: "move-adjacent", clipId: "cl_sh-3", direction: "earlier" });
    assert.equal(storyOrderDrift(value, reordered).reordered, true);
    const trimmed = apply(seeded(), { kind: "delete", clipId: "cl_sh-2" });
    assert.deepEqual(storyOrderDrift(value, trimmed), { reordered: false, missing: ["sh_2"], repeated: [] });
    const doubled = apply(seeded(), { kind: "duplicate", clipId: "cl_sh-1", newClipId: "cl_again" });
    assert.deepEqual(storyOrderDrift(value, doubled), { reordered: false, missing: [], repeated: ["sh_1"] });
  });

  it("resolves holes as black entries and applies the clip's source offset to its media", () => {
    const value = production();
    const edited = apply(
      seeded(),
      { kind: "delete", clipId: "cl_sh-2" },
      { kind: "trim", clipId: "cl_sh-1", edge: "start", deltaFrames: 5 },
    );
    const resolved = resolvePictureTimeline(value, { status: "ready", timeline: edited });
    assert.deepEqual(
      resolved.entries.map((entry) => [entry.clipId, entry.hole ?? false, entry.durationSec, entry.media?.inSec ?? null]),
      [
        // The head trim moved the timeline edge as well as the source edge, so the first five
        // frames are now empty timeline rather than picture.
        ["cl_sh-1", true, 0.2, null],
        ["cl_sh-1", false, 1.8, 0.2],
        ["cl_sh-3", true, 1.52, null],
        ["cl_sh-3", false, 4, null],
      ],
    );
    assert.equal(resolved.entries[2]!.label, "EMPTY · 00:00:01:13");
    assert.equal(resolved.covered, 1);
    assert.equal(resolved.gaps, 1, "a hole is not a gap: nothing asked for it");
    assert.equal(resolved.totalSec, 7.52);
  });

  it("formats whole frames as HH:MM:SS:FF at the production clock", () => {
    assert.equal(formatFrames(0, 24), "00:00:00:00");
    assert.equal(formatFrames(25 * 61 + 7, 25), "00:01:01:07");
    assert.equal(formatFrames(30 * 3600 + 29, 30), "01:00:00:29");
  });

  it("parses the command vocabulary strictly", () => {
    assert.equal(TimelineCommandSchema.safeParse({ kind: "trim", clipId: "cl_a", edge: "start", deltaFrames: 0 }).success, false);
    assert.equal(TimelineCommandSchema.safeParse({ kind: "split", clipId: "cl_a", atFrame: 3, newClipId: "ov_x" }).success, false);
    assert.equal(TimelineCommandSchema.safeParse({ kind: "switch-take", shotId: "sh_2", takeId: TAKE }).success, true);
    assert.equal(TimelineCommandSchema.safeParse({ kind: "delete", clipId: "cl_a", extra: 1 }).success, false);
  });
});
