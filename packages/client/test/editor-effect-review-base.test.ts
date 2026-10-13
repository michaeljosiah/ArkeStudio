import assert from "node:assert/strict";
import { test } from "node:test";
import { migrateLegacyCut, orderedShots, seedFirstPictureTimeline, seedSpinePictureTimeline, type ProductionBundle } from "@arke-studio/contracts";
import { effectReviewBase } from "../src/lib/editor-effect-review-base.js";
import { editorTimeline } from "../src/lib/editor-timeline.js";
import { effectArrangementFixture } from "./effect-arrangement-fixture.js";

function fixture(spine = false) {
  const { context } = effectArrangementFixture(), { production, artifacts } = context;
  production.timeline = { status: "absent" };
  production.cut.overlays = [{ id: "ov_01J8G000000000000000000001", artifactId: "ar_still", startSec: 1.5, endSec: 4, lane: 1, audio: "keep" }];
  if (spine) production.spine = { schemaVersion: 1, revision: 1, trackArtifactId: "ar_audio", markers: [],
    anchors: { [orderedShots(production.scenes[0]!)[0]!.id]: { startSec: 2, endSec: 5, clipAudio: { mode: "mute" } } }, updatedAt: "2026-10-11T00:00:00.000Z" };
  return { production, artifacts };
}

test("absent story review uses the canonical first seed plus legacy migration without opening or writing Current", () => {
  const { production, artifacts } = fixture(), before = structuredClone({ production, artifacts });
  const result = effectReviewBase(production, artifacts), expected = migrateLegacyCut(seedFirstPictureTimeline(production), production, artifacts).timeline;
  assert.deepEqual(result.timeline, expected); assert.equal(result.reason, undefined);
  assert.ok(result.timeline!.tracks.some(track => track.id === "tr_lane-1" && track.clips[0]?.startFrame === 36));
  assert.equal(result.timeline!.migratedCut, true); assert.equal(result.timeline!.revision, 0);
  assert.deepEqual({ production, artifacts }, before);
});

test("unopened measured spine review exactly uses the coordinator's song clock, anchors and migrated placements", () => {
  const { production, artifacts } = fixture(true), before = structuredClone({ production, artifacts });
  assert.equal(editorTimeline(production, { status: "absent" }, artifacts).timeline, null, "ordinary authoring still requires explicit opening");
  const result = effectReviewBase(production, artifacts);
  const expected = migrateLegacyCut(seedSpinePictureTimeline(production, production.spine!, 12), production, artifacts).timeline;
  assert.deepEqual(result.timeline, expected); assert.equal(result.reason, undefined);
  const master = result.timeline!.tracks.find(track => track.id === "tr_master")!.clips[0]!;
  assert.equal(master.durationFrames, 288); assert.deepEqual(master.source, { kind: "artifact", artifactId: "ar_audio", label: "Master track" });
  assert.equal(result.timeline!.tracks[0]!.clips[0]!.startFrame, 48);
  assert.ok(result.timeline!.tracks.some(track => track.id === "tr_lane-1"));
  assert.deepEqual({ production, artifacts }, before, "review cannot materialise timeline.json or mutate the read model");
});

test("saved timelines use their canonical migration and retain the original revision and history", () => {
  const { production, artifacts } = fixture(true);
  const saved = seedFirstPictureTimeline({ ...production, spine: null }); saved.revision = 7;
  production.timeline = { status: "ready", timeline: saved };
  const result = effectReviewBase(production, artifacts);
  assert.deepEqual(result.timeline, migrateLegacyCut(saved, production, artifacts).timeline);
  assert.equal(result.timeline!.revision, 7); assert.deepEqual(result.timeline!.history, saved.history);
  production.timeline = { status: "ready", timeline: result.timeline! };
  assert.equal(effectReviewBase(production, []).timeline, result.timeline, "an already migrated saved state does not need the original master to be re-seeded");
});

test("invalid, missing, foreign and unmeasured bases return a named failure, while world-shared measured audio is eligible", () => {
  const { production, artifacts } = fixture(true);
  production.timeline = { status: "invalid", message: "Malformed effect record" };
  assert.match(effectReviewBase(production, artifacts).reason!, /invalid.*Malformed effect record/);
  production.timeline = { status: "absent" };
  assert.match(effectReviewBase(production, []).reason!, /this world does not have/);
  const master = artifacts.find(artifact => artifact.id === "ar_audio")!;
  master.production = "another-production";
  assert.match(effectReviewBase(production, artifacts).reason!, /another production/);
  master.production = production.meta.id;
  const unmeasured = artifacts.map(artifact => artifact.id === master.id ? { ...artifact, mediaInfo: undefined } : artifact);
  assert.match(effectReviewBase(production, unmeasured).reason!, /Measure the master/);
  const shared = artifacts.map(artifact => artifact.id === master.id ? { ...artifact, production: undefined } : artifact);
  assert.ok(effectReviewBase(production, shared).timeline);
  const noState: ProductionBundle = { ...production }; delete noState.timeline;
  assert.deepEqual(effectReviewBase(noState, shared), effectReviewBase(production, shared));
});
