import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ProductionTimelineSchema,
  applyTimelineCommands,
  assembleSceneCommands,
  orderedTrackClips,
  redoTimelineHistory,
  seedEmptyPictureTimeline,
  undoTimelineHistory,
  type ProductionBundle,
  type Scene,
} from "../src/index.js";

/**
 * The Library set and Arke's scene assembly (SPEC-039, decided 2026-09-02): the editor opens
 * empty; a scene reaches the timeline as one revision built from pure commands, with the
 * notes that explain it on the entry; the Library is a curated set that undo restores.
 */

const AT = "2026-09-01T12:00:00Z";
const TAKE = "tk_01J8E0000000000000000000T1";
const BELLS = "ar_01J8G0000000000000000000R1";

function scene(id: string, order: number, shots: Array<{ id: string; durationSec?: number; line?: string }>): Scene {
  return {
    id,
    number: order,
    order,
    slug: id.replace(/^sc_/, ""),
    title: `Scene ${order}`,
    status: "accepted",
    version: 1,
    shots: shots.map((shot, index) => ({
      id: shot.id,
      number: index + 1,
      title: shot.id,
      description: `Story beat ${shot.id}`,
      ...(shot.durationSec === undefined ? {} : { durationSec: shot.durationSec }),
      ...(shot.line === undefined ? {} : { audio: { kind: "dialogue", line: shot.line } }),
    })),
  };
}

function production(): ProductionBundle {
  return {
    meta: { id: "bell-watch", format: "video", title: "Bell Watch", status: "in-progress", frameRate: 25, failureModes: [], created: AT, updated: AT },
    story: null,
    season: null,
    routing: null,
    treatment: null,
    chapters: [],
    scenes: [
      scene("sc_one", 1, [{ id: "sh_1", durationSec: 2, line: "Hold the line." }, { id: "sh_2", durationSec: 1.5 }]),
      scene("sc_two", 2, [{ id: "sh_3" }]),
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
  };
}

const bells = { id: BELLS, kind: "audio", file: "harbour-bells.wav", links: ["sc_one"], mediaInfo: { hasAudio: true, durationSec: 30 } };

describe("the empty first state and the Library", () => {
  it("seeds an empty Picture track, nothing in the Library, and a record the schema accepts", () => {
    const timeline = ProductionTimelineSchema.parse(seedEmptyPictureTimeline(production()));
    assert.equal(timeline.tracks.length, 1);
    assert.equal(timeline.tracks[0]!.clips.length, 0);
    assert.deepEqual(timeline.library, []);
    assert.equal(timeline.revision, 0);
  });

  it("a record from before the Library existed opens with an empty one", () => {
    const { library: _library, ...older } = seedEmptyPictureTimeline(production());
    assert.deepEqual(ProductionTimelineSchema.parse(older).library, []);
  });

  it("adds without duplicates, refuses a no-op, and undo and redo carry the set", () => {
    const empty = seedEmptyPictureTimeline(production());
    const added = applyTimelineCommands(empty, [
      { kind: "add-to-library", items: [{ kind: "shot", shotId: "sh_1" }, { kind: "artifact", artifactId: BELLS }] },
    ]);
    assert.equal(added.library.length, 2);
    assert.equal(added.history.undo.at(-1)!.kind, "change");
    assert.throws(() => applyTimelineCommands(added, [{ kind: "add-to-library", items: [{ kind: "shot", shotId: "sh_1" }] }]), /changes nothing/);
    const removed = applyTimelineCommands(added, [{ kind: "remove-from-library", items: [{ kind: "shot", shotId: "sh_1" }] }]);
    assert.deepEqual(removed.library, [{ kind: "artifact", artifactId: BELLS }]);
    const undone = undoTimelineHistory(removed);
    assert.equal(undone.library.length, 2, "undo puts the item back");
    assert.equal(redoTimelineHistory(undone).library.length, 1, "redo takes it away again");
    assert.doesNotThrow(() => ProductionTimelineSchema.parse(undone));
  });
});

describe("Arke assembles a scene", () => {
  it("places the scene's shots in script order after what is there, conforms its lines, lays its bed, and says so", () => {
    const bundle = production();
    const empty = seedEmptyPictureTimeline(bundle);
    const first = assembleSceneCommands({ production: bundle, timeline: empty, sceneId: "sc_one", artifacts: [bells] });
    assert.ok(!("refused" in first), "scene one assembles");
    const applied = applyTimelineCommands(empty, first.commands, { label: "Arke assembled Scene 1", notes: first.notes });
    const picture = orderedTrackClips(applied.tracks.find((track) => track.id === "tr_picture")!);
    assert.deepEqual(
      picture.map((clip) => [clip.id, clip.startFrame, clip.durationFrames]),
      [["cl_sh-1", 0, 50], ["cl_sh-2", 50, 38]],
    );
    assert.deepEqual(first.placed, ["sh_1"]);
    assert.deepEqual(first.gaps, ["sh_2"], "a shot without an accepted take is placed as a gap");
    const subtitles = applied.tracks.find((track) => track.kind === "subtitle");
    assert.ok(subtitles, "a subtitle track is conformed from the shot lines");
    assert.deepEqual(subtitles.cues!.map((cue) => [cue.text, cue.startFrame, cue.endFrame]), [["Hold the line.", 0, 50]]);
    const ambience = applied.tracks.find((track) => track.kind === "ambience");
    assert.ok(ambience, "the linked bed lands on Ambience");
    assert.deepEqual(ambience.clips.map((clip) => [clip.startFrame, clip.durationFrames, clip.gainDb]), [[0, 88, -12]]);
    assert.deepEqual(applied.library, [
      { kind: "shot", shotId: "sh_1" },
      { kind: "shot", shotId: "sh_2" },
      { kind: "artifact", artifactId: BELLS },
    ]);
    const entry = applied.history.undo.at(-1)!;
    assert.ok(entry.kind === "change", "the assembly is one change entry");
    const notes = entry.notes ?? [];
    assert.ok(notes.some((note) => /Placed 2 shots from Scene 1/.test(note)), notes.join(" | "));
    assert.ok(notes.some((note) => /Left a gap/.test(note)), notes.join(" | "));
    assert.equal(applied.revision, 1, "one revision for the whole assembly");

    const second = assembleSceneCommands({ production: bundle, timeline: applied, sceneId: "sc_two", artifacts: [] });
    assert.ok(!("refused" in second));
    const both = applyTimelineCommands(applied, second.commands);
    const after = orderedTrackClips(both.tracks.find((track) => track.id === "tr_picture")!);
    assert.equal(after.at(-1)!.startFrame, 88, "the next scene follows the last clip");
    assert.equal(undoTimelineHistory(both).tracks.find((track) => track.id === "tr_picture")!.clips.length, 2, "one undo removes the whole scene");
  });

  it("refuses a scene already on the timeline, an unknown scene, and a scene with no shots", () => {
    const bundle = production();
    const empty = seedEmptyPictureTimeline(bundle);
    const first = assembleSceneCommands({ production: bundle, timeline: empty, sceneId: "sc_one", artifacts: [] });
    assert.ok(!("refused" in first));
    const applied = applyTimelineCommands(empty, first.commands);
    const again = assembleSceneCommands({ production: bundle, timeline: applied, sceneId: "sc_one", artifacts: [] });
    assert.ok("refused" in again && /already on the timeline/.test(again.refused));
    const unknown = assembleSceneCommands({ production: bundle, timeline: applied, sceneId: "sc_nine", artifacts: [] });
    assert.ok("refused" in unknown);
    bundle.scenes.push(scene("sc_bare", 3, []));
    const bare = assembleSceneCommands({ production: bundle, timeline: applied, sceneId: "sc_bare", artifacts: [] });
    assert.ok("refused" in bare && /no shots/.test(bare.refused));
  });
});
