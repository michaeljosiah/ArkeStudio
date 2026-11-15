import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AudioSpineCommandSchema,
  AudioSpineOperationRefused,
  ProductionSetupDraftSchema,
  ProductionSetupUpdateSchema,
  ProductionSpineSchema,
  SceneRecordSchema,
  SceneSchema,
  SongWindowSchema,
  applyAudioSpineCommand,
  applyProductionSetupUpdate,
  migrateLegacyScene,
  pinnedInWindowSec,
  projectSceneRecord,
  sceneSectionMarkers,
  sceneSections,
  songTime,
  type ProductionSetupDraft,
  type Scene,
  type SpineMarker,
} from "../src/index.js";

/**
 * A scene's place in the song (issues 3100, 3101; SPEC-012 R-VSETUP-19): an optional window on
 * the setup scene and on the scene record. Setup had nowhere to keep a music video's times, so
 * they went into titles as words; the scene's header and the song's sections now read the field.
 */

const scene = (over: Partial<Scene> = {}): Scene => ({
  id: "sc_verse-1", number: 1, slug: "verse-1", title: "Verse 1", status: "draft", version: 1, shots: [], ...over,
});

const draft = (): ProductionSetupDraft => ProductionSetupDraftSchema.parse({
  schemaVersion: 1, setupId: "cv_01J8F3K2QW9VZX4N7M0RTYB6HC", worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC", revision: 1,
  title: "Why you do me like that", kind: "music-video", aspect: "9:16", frameRate: 24,
  narrative: {}, arcs: [], references: [], openQuestions: [], episodes: [],
  scenes: [{ key: "intro", title: "Intro" }, { key: "verse-1", title: "Verse 1: the phone", synopsis: "She reads the message." }],
});

describe("the window itself", () => {
  it("is a start before an end, neither negative, and nothing else", () => {
    assert.deepEqual(SongWindowSchema.parse({ startSec: 0, endSec: 16 }), { startSec: 0, endSec: 16 });
    assert.deepEqual(SongWindowSchema.parse({ startSec: 16.5, endSec: 44.25 }), { startSec: 16.5, endSec: 44.25 });
    assert.throws(() => SongWindowSchema.parse({ startSec: 16, endSec: 16 }), /endSec/);
    assert.throws(() => SongWindowSchema.parse({ startSec: 44, endSec: 16 }), /endSec/);
    assert.throws(() => SongWindowSchema.parse({ startSec: -1, endSec: 16 }));
    assert.throws(() => SongWindowSchema.parse({ startSec: 0 }));
    assert.throws(() => SongWindowSchema.parse({ startSec: 0, endSec: 16, label: "Intro" }));
  });

  it("reads on the song's clock, exact to what was given", () => {
    assert.equal(songTime(0), "0:00");
    assert.equal(songTime(16), "0:16");
    assert.equal(songTime(16.5), "0:16.5");
    assert.equal(songTime(44.25), "0:44.25");
    assert.equal(songTime(227.6), "3:47.6");
  });

  it("is not held to any song's length", () => {
    // Setup has no song to measure against, and a shorter track chosen later must not unread a scene.
    assert.equal(SongWindowSchema.parse({ startSec: 7_000, endSec: 9_000 }).endSec, 9_000);
  });
});

describe("the scene record", () => {
  it("reads a scene written before the window existed, unchanged, in both shapes", () => {
    // This schema is a read path: a tightening here deletes scenes from worlds on disk.
    const legacy = SceneSchema.parse(scene());
    assert.equal(legacy.songWindow, undefined);
    assert.equal("songWindow" in legacy, false, "absent stays absent, never written as a default");
    const graph = SceneRecordSchema.parse(JSON.parse(JSON.stringify(migrateLegacyScene(legacy))));
    assert.equal(graph.songWindow, undefined);
  });

  it("keeps a window through the graph migration, a round trip and the legacy projection", () => {
    const graph = migrateLegacyScene(SceneSchema.parse(scene({ songWindow: { startSec: 16, endSec: 44 } })));
    const reparsed = SceneRecordSchema.parse(JSON.parse(JSON.stringify(graph)));
    assert.deepEqual(reparsed.songWindow, { startSec: 16, endSec: 44 });
    const projected = projectSceneRecord(reparsed);
    assert.ok(projected.kind === "scene");
    assert.deepEqual(projected.scene.songWindow, { startSec: 16, endSec: 44 });
  });

  it("refuses a window that could not be honoured", () => {
    assert.throws(() => SceneSchema.parse(scene({ songWindow: { startSec: 44, endSec: 16 } })));
    assert.throws(() => SceneSchema.parse(scene({ songWindow: { startSec: -2, endSec: 16 } })));
    assert.throws(() => SceneRecordSchema.parse({ ...migrateLegacyScene(scene()), songWindow: { startSec: 0, endSec: 0 } }));
  });
});

describe("the setup scene", () => {
  it("reads a draft written before the window existed, and an update that names none", () => {
    assert.equal(draft().scenes.every((item) => item.songWindow === undefined), true);
    const renamed = applyProductionSetupUpdate(draft(), { expectedRevision: 1, scenes: [{ key: "intro", title: "Cold open" }] });
    assert.equal("songWindow" in renamed.scenes[0]!, false);
  });

  it("keeps a window through unrelated turns, replaces it whole, and takes it away on null", () => {
    const placed = applyProductionSetupUpdate(draft(), { expectedRevision: 1, scenes: [
      { key: "intro", songWindow: { startSec: 0, endSec: 16 } },
      { key: "verse-1", title: "Verse 1: the phone", songWindow: { startSec: 16, endSec: 44 } },
    ] });
    assert.deepEqual(placed.scenes.map((item) => item.songWindow), [{ startSec: 0, endSec: 16 }, { startSec: 16, endSec: 44 }]);
    assert.equal(placed.scenes[1]!.synopsis, "She reads the message.", "the fields beside it are kept");

    const retitled = applyProductionSetupUpdate(placed, { expectedRevision: 2, scenes: [{ key: "verse-1", title: "Verse 1" }] });
    assert.deepEqual(retitled.scenes[1]!.songWindow, { startSec: 16, endSec: 44 }, "an update that omits it keeps it");

    const moved = applyProductionSetupUpdate(retitled, { expectedRevision: 3, scenes: [{ key: "verse-1", songWindow: { startSec: 18, endSec: 46 } }] });
    assert.deepEqual(moved.scenes[1]!.songWindow, { startSec: 18, endSec: 46 });

    const cleared = applyProductionSetupUpdate(moved, { expectedRevision: 4, scenes: [{ key: "verse-1", songWindow: null }] });
    assert.equal(cleared.scenes[1]!.songWindow, undefined);
    assert.equal(JSON.parse(JSON.stringify(cleared)).scenes[1].songWindow, undefined, "and nothing of it is written");
    assert.deepEqual(cleared.scenes[0]!.songWindow, { startSec: 0, endSec: 16 }, "the other scene keeps its own");
  });

  it("refuses a bad window in a draft and in an update, and a null in a draft", () => {
    const bad = { startSec: 44, endSec: 16 };
    assert.equal(ProductionSetupUpdateSchema.safeParse({ expectedRevision: 1, scenes: [{ key: "intro", songWindow: bad }] }).success, false);
    assert.throws(() => applyProductionSetupUpdate(draft(), { expectedRevision: 1, scenes: [{ key: "intro", songWindow: bad }] }));
    assert.equal(ProductionSetupDraftSchema.safeParse({ ...draft(), scenes: [{ key: "intro", title: "Intro", songWindow: bad }] }).success, false);
    assert.equal(ProductionSetupDraftSchema.safeParse({ ...draft(), scenes: [{ key: "intro", title: "Intro", songWindow: null }] }).success, false);
  });
});

describe("sections from the scenes", () => {
  const scenes = [
    { title: "Verse 1: the phone", number: 2, songWindow: { startSec: 16, endSec: 44 } },
    { title: "Bridge", number: 4 },
    { title: "Intro", number: 1, songWindow: { startSec: 0, endSec: 16 } },
    { title: "  ", number: 3, songWindow: { startSec: 44, endSec: 60 } },
  ];
  let minted = 0;
  const mintId = () => `mk_${String(++minted).padStart(26, "0")}`;
  const spine = (markers: SpineMarker[] = []) => ProductionSpineSchema.parse({
    schemaVersion: 1, revision: 3, trackArtifactId: "ar_01J8G0000000000000000000R1", markers, anchors: {}, updatedAt: "2026-11-15T09:00:00.000Z",
  });

  it("gives one section for each scene with a window, in song order, named as the scene", () => {
    assert.deepEqual(sceneSections(scenes), [
      { label: "Intro", atSec: 0 },
      { label: "Verse 1: the phone", atSec: 16 },
      { label: "Scene 3", atSec: 44 },
    ]);
    assert.deepEqual(sceneSections([{ title: "Bridge", number: 4 }]), []);
    const markers = sceneSectionMarkers(scenes, mintId);
    assert.equal(markers.length, 3);
    assert.equal(markers.every((marker) => marker.kind === "section" && marker.source === "manual"), true);
    assert.equal(new Set(markers.map((marker) => marker.id)).size, 3);
  });

  it("marks them on a song that has no sections, keeping its lyrics, in one revision", () => {
    const lyric: SpineMarker = { kind: "lyric", id: "mk_01J8G0000000000000000000Y1", text: "Why you do me", atSec: 20, source: "lrc" };
    const next = applyAudioSpineCommand(spine([lyric]), { kind: "mark-sections-from-scenes" }, "2026-11-15T09:01:00.000Z", sceneSectionMarkers(scenes, mintId))!;
    assert.equal(next.revision, 4);
    assert.deepEqual(next.markers.map((marker) => (marker.kind === "section" ? marker.label : marker.text)),
      ["Intro", "Verse 1: the phone", "Why you do me", "Scene 3"]);
    assert.deepEqual(next.anchors, {}, "shots stay where they are pinned");
  });

  it("is refused once the song has a section, with no scenes to read, and with no spine", () => {
    const section: SpineMarker = { kind: "section", id: "mk_01J8G0000000000000000000S1", label: "Verse 1", atSec: 16, source: "manual" };
    const sections = sceneSectionMarkers(scenes, mintId);
    assert.throws(() => applyAudioSpineCommand(spine([section]), { kind: "mark-sections-from-scenes" }, "2026-11-15T09:01:00.000Z", sections),
      (error) => error instanceof AudioSpineOperationRefused && /already has sections/.test(error.reason));
    assert.throws(() => applyAudioSpineCommand(spine(), { kind: "mark-sections-from-scenes" }, "2026-11-15T09:01:00.000Z"),
      (error) => error instanceof AudioSpineOperationRefused && /no scene has a place in the song/.test(error.reason));
    assert.throws(() => applyAudioSpineCommand(null, { kind: "mark-sections-from-scenes" }, "2026-11-15T09:01:00.000Z", sections),
      (error) => error instanceof AudioSpineOperationRefused && /no audio spine/.test(error.reason));
  });

  it("is a command that carries nothing of its own", () => {
    assert.equal(AudioSpineCommandSchema.safeParse({ kind: "mark-sections-from-scenes" }).success, true);
    assert.equal(AudioSpineCommandSchema.safeParse({ kind: "mark-sections-from-scenes", markers: [] }).success, false);
  });
});

describe("how much of a window is pinned", () => {
  const spine = ProductionSpineSchema.parse({
    schemaVersion: 1, revision: 2, trackArtifactId: "ar_01J8G0000000000000000000R1", markers: [], updatedAt: "2026-11-15T09:00:00.000Z",
    anchors: {
      sh_1: { startSec: 16, endSec: 22 },
      sh_2: { startSec: 22, endSec: 28 },
      // Starts inside the window and runs past it: only what falls inside counts.
      sh_3: { startSec: 40, endSec: 50 },
      // Another scene's shot, pinned inside this window.
      sh_9: { startSec: 30, endSec: 34 },
    },
  });
  const window = { startSec: 16, endSec: 44 };

  it("counts the part of each of the scene's anchors that falls inside it", () => {
    assert.equal(pinnedInWindowSec(window, spine, ["sh_1", "sh_2"]), 12);
    assert.equal(pinnedInWindowSec(window, spine, ["sh_1", "sh_2", "sh_3"]), 16);
    assert.equal(pinnedInWindowSec(window, spine, []), 0);
    assert.equal(pinnedInWindowSec(window, spine, ["sh_unpinned"]), 0);
    assert.equal(pinnedInWindowSec({ startSec: 60, endSec: 80 }, spine, ["sh_1", "sh_2", "sh_3"]), 0, "pinned elsewhere is not pinned here");
  });
});
