import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ProductionTimelineSchema,
  orderedTrackClips,
  seedSpinePictureTimeline,
  spineTimelineFingerprint,
  type ProductionSpine,
} from "@arke-studio/contracts";
import { applyTimelineCommand, TimelineCommandRefused } from "../../src/productions/timeline.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

/**
 * The first music-timed assembly (SPEC-037 R-13, R-32; issue 682): the spine's anchors as they
 * stand, against the master as measured, opened on the timeline by an empty batch and edited
 * from there like any other production. An unmeasured master has no first assembly.
 */

const CLOCK = () => "2026-09-01T12:00:00.000Z";
const PRODUCTION = "saltlight";
const TRACK = "ar_01J8G0000000000000000000R1";
const SPINE: ProductionSpine = {
  schemaVersion: 1,
  revision: 1,
  trackArtifactId: TRACK,
  markers: [],
  anchors: {
    sh_20: { startSec: 0, endSec: 8, clipAudio: { mode: "mute" } },
    sh_12: { startSec: 10, endSec: 18, clipAudio: { mode: "keep-diegetic", gainDb: -6 } },
  },
  updatedAt: "2026-08-19T12:00:00.000Z",
};

async function openWithSpine(measured: boolean): Promise<WorldStore> {
  const dir = await makeTempWorld();
  await writeFile(join(dir, "productions", PRODUCTION, "spine.json"), JSON.stringify(SPINE, null, 2) + "\n", "utf8");
  if (measured) {
    const sidecarPath = join(dir, "artifacts", "harbour-bells.wav.json");
    const sidecar = JSON.parse(await readFile(sidecarPath, "utf8")) as Record<string, unknown>;
    sidecar["mediaInfo"] = { durationSec: 30, hasAudio: true };
    await writeFile(sidecarPath, JSON.stringify(sidecar, null, 2) + "\n", "utf8");
  }
  const store = await WorldStore.open(dir, { clock: CLOCK });
  closeOnCleanup(() => store.close());
  return store;
}

const timelinePath = (store: WorldStore): string => join(store.dir, "productions", PRODUCTION, "timeline.json");

describe("the song clock on the timeline (issue 682)", () => {
  it("refuses a first assembly against an unmeasured master, by name", async () => {
    const store = await openWithSpine(false);
    const production = store.getBundle().productions.find((candidate) => candidate.meta.id === PRODUCTION)!;
    assert.ok(production.spine, "the fixture production carries the spine");
    await assert.rejects(
      applyTimelineCommand(store, PRODUCTION, {
        kind: "commands",
        commands: [],
        baseRevision: null,
        sourceFingerprint: spineTimelineFingerprint(production, production.spine!, 30),
      }),
      (error: unknown) => error instanceof TimelineCommandRefused && /measure the master track/.test(error.reason),
    );
    await assert.rejects(readFile(timelinePath(store), "utf8"), { code: "ENOENT" });
  });

  it("opens the anchors on the timeline with an empty batch, then edits against the saved record", async () => {
    const store = await openWithSpine(true);
    const production = store.getBundle().productions.find((candidate) => candidate.meta.id === PRODUCTION)!;
    const spine = production.spine!;
    const expected = seedSpinePictureTimeline(production, spine, 30);

    // The fence is the spine as measured: another length is another song.
    await assert.rejects(
      applyTimelineCommand(store, PRODUCTION, {
        kind: "commands",
        commands: [],
        baseRevision: null,
        sourceFingerprint: spineTimelineFingerprint(production, spine, 31),
      }),
      (error: unknown) => error instanceof TimelineCommandRefused && /spine changed/.test(error.reason),
    );

    await applyTimelineCommand(store, PRODUCTION, {
      kind: "commands",
      commands: [],
      baseRevision: null,
      sourceFingerprint: spineTimelineFingerprint(production, spine, 30),
    });
    const saved = ProductionTimelineSchema.parse(JSON.parse(await readFile(timelinePath(store), "utf8")));
    assert.equal(saved.revision, 0, "opening is not an edit");
    assert.deepEqual(saved.history, { undo: [], redo: [] });
    assert.equal(saved.migratedCut, true, "the legacy lanes folded in with the first write");
    const picture = saved.tracks.find((track) => track.id === "tr_picture")!;
    assert.deepEqual(
      orderedTrackClips(picture).map((clip) => [clip.id, clip.startFrame, clip.durationFrames, clip.audio]),
      orderedTrackClips(expected.tracks.find((track) => track.id === "tr_picture")!).map((clip) => [clip.id, clip.startFrame, clip.durationFrames, clip.audio]),
      "the anchors as they stand, in frames",
    );
    const master = saved.tracks.find((track) => track.id === "tr_master")!;
    assert.equal(master.kind, "music");
    assert.deepEqual(
      master.clips.map((clip) => clip.source),
      [{ kind: "artifact", artifactId: TRACK, label: "Master track" }],
      "the master is a Music clip, not a replacement for the picture",
    );
    assert.equal(store.getBundle().productions.find((candidate) => candidate.meta.id === PRODUCTION)?.timeline?.status, "ready");

    // From here the record is the authority: an empty batch changes nothing, a real one lands.
    await assert.rejects(
      applyTimelineCommand(store, PRODUCTION, {
        kind: "commands",
        commands: [],
        baseRevision: 0,
        sourceFingerprint: spineTimelineFingerprint(production, spine, 30),
      }),
      (error: unknown) => error instanceof TimelineCommandRefused && /changes nothing/.test(error.reason),
    );
    const moving = orderedTrackClips(picture)[1]!;
    await applyTimelineCommand(store, PRODUCTION, {
      kind: "commands",
      commands: [{ kind: "move-adjacent", clipId: moving.id, direction: "earlier" }],
      baseRevision: 0,
      sourceFingerprint: spineTimelineFingerprint(production, spine, 30),
    });
    const edited = ProductionTimelineSchema.parse(JSON.parse(await readFile(timelinePath(store), "utf8")));
    assert.equal(edited.revision, 1);
    assert.equal(edited.history.undo.length, 1);
    assert.equal(orderedTrackClips(edited.tracks.find((track) => track.id === "tr_picture")!)[0]!.id, moving.id);
  });
});
