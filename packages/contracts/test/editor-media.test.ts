import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  TimelineOperationRefused,
  applyTimelineCommands,
  laneRefusal,
  mediaPlacementCommands,
  seedEmptyPictureTimeline,
  type ArtifactSidecar,
  type ProductionBundle,
} from "../src/index.js";

/**
 * Where an import lands (SPEC-043 R-1, R-3; issue 1035): a named lane takes the drop at its
 * frame and refuses the wrong kind by name; the new-lane strip makes one lane per kind for the
 * whole drop; the older forms are unchanged.
 */

const AT = "2026-09-01T12:00:00Z";

function production(): ProductionBundle {
  return {
    rehearsals: [], performances: [], performanceReview: { reviews: [], selections: {}, reviewHash: null, selectionHash: null },
    meta: { id: "footage", format: "video", title: "Footage", status: "in-progress", frameRate: 24, failureModes: [], created: AT, updated: AT },
    story: null, season: null, routing: null, treatment: null, chapters: [],
    scenes: [], sceneFiles: {}, episodes: [], episodeFiles: {},
    takes: [], reviews: [], selections: {}, spine: null, cut: { audio: [], overlays: [] }, editorRequests: [], takeMediaInfo: {},
  };
}

const artifact = (id: string, kind: ArtifactSidecar["kind"], file: string, mediaInfo?: ArtifactSidecar["mediaInfo"]): ArtifactSidecar =>
  ({ id, kind, file, hash: "sha256:0000000000000000", origin: { by: "user" }, links: [], created: AT, ...(mediaInfo ? { mediaInfo } : {}) }) as ArtifactSidecar;

const FILM = artifact("ar_01J8G0000000000000000000F1", "video", "film.mp4", { durationSec: 2, hasAudio: true });
const SILENT = artifact("ar_01J8G0000000000000000000F2", "video", "silent.mp4", { durationSec: 2, hasAudio: false });
const SONG = artifact("ar_01J8G0000000000000000000S1", "audio", "song.wav", { durationSec: 3, hasAudio: true });
const PLATE = artifact("ar_01J8G0000000000000000000P1", "image", "plate.png");

let minted = 0;
const mint = () => `cl_${String(++minted).padStart(4, "0")}` as `cl_${string}`;

describe("a drop on a lane the timeline has", () => {
  it("places at the dropped frame, chains the rest of the drop after it, and lists each in the Library", () => {
    const base = applyTimelineCommands(seedEmptyPictureTimeline(production()), [
      { kind: "add-track", trackId: "tr_overlay-1", trackKind: "picture", name: "Overlay 1" },
    ]);
    const commands = mediaPlacementCommands(base, [FILM, PLATE], { trackId: "tr_overlay-1", frame: 48 }, mint);
    const placed = commands.filter((command) => command.kind === "place");
    assert.deepEqual(placed.map((command) => command.kind === "place" && [command.trackId, command.clip.startFrame, command.clip.durationFrames]), [
      ["tr_overlay-1", 48, 48],
      ["tr_overlay-1", 96, 96],
    ]);
    assert.equal(commands.filter((command) => command.kind === "add-to-library").length, 2, "both files join the Library");
    const after = applyTimelineCommands(base, commands);
    assert.equal(after.tracks.find((track) => track.id === "tr_overlay-1")!.clips.length, 2);
  });

  it("takes a video's sound on a sound lane, and refuses a still there by name", () => {
    const base = applyTimelineCommands(seedEmptyPictureTimeline(production()), [
      { kind: "add-track", trackId: "tr_audio-1", trackKind: "audio", name: "Audio 1" },
    ]);
    const commands = mediaPlacementCommands(base, [FILM, SONG], { trackId: "tr_audio-1", frame: 0 }, mint);
    const placed = commands.filter((command) => command.kind === "place");
    assert.deepEqual(placed.map((command) => command.kind === "place" && [command.clip.startFrame, command.clip.gainDb, command.clip.audio]), [
      [0, 0, undefined],
      [48, 0, undefined],
    ]);
    assert.throws(
      () => mediaPlacementCommands(base, [PLATE], { trackId: "tr_audio-1", frame: 0 }, mint),
      (error: unknown) => error instanceof TimelineOperationRefused && /plate\.png has no sound; Audio 1 takes sound/.test(error.reason),
    );
    assert.throws(
      () => mediaPlacementCommands(base, [SILENT], { trackId: "tr_audio-1", frame: 0 }, mint),
      (error: unknown) => error instanceof TimelineOperationRefused && /has no measured sound/.test(error.reason),
    );
    assert.throws(
      () => mediaPlacementCommands(base, [SONG], { trackId: "tr_picture", frame: 0 }, mint),
      (error: unknown) => error instanceof TimelineOperationRefused && /song\.wav has no picture; Picture takes picture/.test(error.reason),
    );
  });

  it("refuses a drop that would overlap rather than sliding it, and a lane that has gone", () => {
    const base = applyTimelineCommands(seedEmptyPictureTimeline(production()), [
      { kind: "add-track", trackId: "tr_overlay-1", trackKind: "picture", name: "Overlay 1" },
      { kind: "place", trackId: "tr_overlay-1", clip: { id: "cl_first", startFrame: 24, durationFrames: 48, sourceInFrames: 0, source: { kind: "artifact", artifactId: FILM.id, label: "film.mp4" } } },
    ]);
    assert.throws(() => mediaPlacementCommands(base, [PLATE], { trackId: "tr_overlay-1", frame: 40 }, mint), TimelineOperationRefused);
    assert.throws(
      () => mediaPlacementCommands(base, [PLATE], { trackId: "tr_overlay-9", frame: 0 }, mint),
      (error: unknown) => error instanceof TimelineOperationRefused && /no longer on the timeline/.test(error.reason),
    );
  });
});

describe("a drop on the new-lane strip", () => {
  it("makes one lane per kind for the whole drop and chains each kind from the dropped frame", () => {
    const base = seedEmptyPictureTimeline(production());
    const commands = mediaPlacementCommands(base, [FILM, SONG, PLATE], { newTrack: true, frame: 12 }, mint);
    const added = commands.filter((command) => command.kind === "add-track");
    assert.deepEqual(added.map((command) => command.kind === "add-track" && [command.trackId, command.trackKind, command.name]), [
      ["tr_overlay-1", "picture", "Overlay 1"],
      ["tr_audio-1", "audio", "Audio 1"],
    ]);
    const placed = commands.filter((command) => command.kind === "place");
    assert.deepEqual(placed.map((command) => command.kind === "place" && [command.trackId, command.clip.startFrame]), [
      ["tr_overlay-1", 12],
      ["tr_audio-1", 60],
      ["tr_overlay-1", 132],
    ]);
    const after = applyTimelineCommands(base, commands);
    assert.equal(after.tracks.length, 3);
  });

  it("numbers the new overlay after the lanes already there", () => {
    const base = applyTimelineCommands(seedEmptyPictureTimeline(production()), [
      { kind: "add-track", trackId: "tr_overlay-1", trackKind: "picture", name: "Overlay 1" },
    ]);
    const commands = mediaPlacementCommands(base, [PLATE], { newTrack: true, frame: 0 }, mint);
    assert.ok(commands.some((command) => command.kind === "add-track" && command.trackId === "tr_overlay-2"));
  });
});

describe("the older forms are what they were", () => {
  it("appends picture after the last Picture clip and sound onto the first audio track", () => {
    const base = seedEmptyPictureTimeline(production());
    const commands = mediaPlacementCommands(base, [FILM, SONG], "append", mint);
    const placed = commands.filter((command) => command.kind === "place");
    assert.deepEqual(placed.map((command) => command.kind === "place" && [command.trackId, command.clip.startFrame]), [
      ["tr_picture", 0],
      ["tr_audio-1", 0],
    ]);
  });

  it("refuses sound dropped at a frame on the base Picture track", () => {
    assert.throws(() => mediaPlacementCommands(seedEmptyPictureTimeline(production()), [SONG], 12, mint), /has no picture/);
  });

  it("states the lane rule once, for the import to report file by file", () => {
    assert.equal(laneRefusal(FILM, true), null);
    assert.equal(laneRefusal(SILENT, true), "has no measured sound");
    assert.equal(laneRefusal(PLATE, true), "has no sound");
    assert.equal(laneRefusal(SONG, false), "has no picture");
    assert.equal(laneRefusal(PLATE, false), null);
  });
});
