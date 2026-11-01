import assert from "node:assert/strict";
import { it } from "node:test";
import { productionHasScore, ProductionTimelineSchema, ClientMessageSchema, derivedNegatives, NO_BACKGROUND_MUSIC, type ProductionBundle } from "../src/index.js";

const base = (): Pick<ProductionBundle, "spine" | "timeline" | "cut"> => ({ spine: null, cut: { audio: [], overlays: [] } });
const timeline = (role: "music" | "dialogue" = "music") => ProductionTimelineSchema.parse({ schemaVersion: 1, revision: 1, frameRate: 24,
  tracks: [{ id: "tr_audio", kind: "audio", name: "Sound", order: 0, muted: false, clips: [{ id: "cl_music", startFrame: 0, durationFrames: 240, sourceInFrames: 0,
    source: { kind: "artifact", artifactId: "ar_01J8G0000000000000000000R1", label: "Track" }, role }] }], library: [], history: { undo: [], redo: [] } });
it("honours current timeline Music roles and retires the legacy score fallback after materialisation", () => {
  const value = base(); assert.equal(productionHasScore(value), false);
  value.cut.audio = [{ kind: "score", label: "Old score", entries: [{ offsetSec: 0 }] }];
  assert.equal(productionHasScore(value), true);
  value.timeline = { status: "ready", timeline: timeline("dialogue") };
  assert.equal(productionHasScore(value), false, "a stale legacy score is no longer delivery intent");
  value.timeline = { status: "ready", timeline: timeline() };
  assert.equal(productionHasScore(value), true);
  assert.match(derivedNegatives({ capability: "video", audioDesign: { scoreTrack: productionHasScore(value) }, constraints: { music: "allow-model-score", subtitles: "never", failureModes: [] } })!, /No background music/);
  assert.equal(NO_BACKGROUND_MUSIC.includes("environmental and action sound"), true);
});
it("an assigned spine master establishes score intent before or after opening the timeline", () => {
  const value = base(); value.spine = { schemaVersion: 1, revision: 1, trackArtifactId: "ar_01J8G0000000000000000000R1", markers: [], anchors: {}, updatedAt: "2026-11-01T12:00:00Z" };
  assert.equal(productionHasScore(value), true);
  value.timeline = { status: "ready", timeline: timeline("dialogue") }; assert.equal(productionHasScore(value), true);
});
it("measurement requests accept opaque source IDs and reject arbitrary paths", () => {
  const request = { kind: "measure-production-media", worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC", productionId: "saltlight", requestId: "01J8F3K2QW9VZX4N7M0RTYB6HC",
    source: { kind: "take", takeId: "tk_01J8E0000000000000000000T1" } };
  assert.ok(ClientMessageSchema.safeParse(request).success);
  assert.equal(ClientMessageSchema.safeParse({ ...request, path: "../../private.mp4" }).success, false);
  assert.equal(ClientMessageSchema.safeParse({ ...request, source: { kind: "take", takeId: "../outside" } }).success, false);
});
