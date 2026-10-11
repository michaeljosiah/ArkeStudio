import assert from "node:assert/strict";
import { test } from "node:test";
import { ulid, type EffectArrangementScope, type EffectVersionRef } from "@arke-studio/contracts";
import { effectArrangementDeliveryRange, effectArrangementPlacedRange, effectArrangementRequest, effectArrangementFollowUp } from "../src/lib/editor-effect-arrangement.js";
import { effectArrangementFixture } from "./effect-arrangement-fixture.js";

const scope = (): EffectArrangementScope => ({ kind: "effects-only", target: { kind: "composition" }, range: { startFrame: 0, endFrame: 240 },
  audio: { kind: "off" }, direction: "Soft atmosphere", palette: [{ id: "dust", version: 1 }] });

test("arrangement range uses absolute delivery frames at 24/25/30 fps, never a longer editor canvas", () => {
  const { plan } = effectArrangementFixture();
  for (const fps of [24, 25, 30] as const) {
    assert.deepEqual(effectArrangementDeliveryRange({ ...plan, totalSec: 1000, range: { startSec: 2, endSec: 9 } }, fps), { startFrame: fps * 2, endFrame: fps * 9 });
  }
  assert.equal(effectArrangementDeliveryRange(null, 24), null);
  assert.equal(effectArrangementDeliveryRange({ ...plan, range: { startSec: 0, endSec: 0 } }, 24), null);
});

test("Whole song copies the explicit placement, clipped to delivery, without mutating any entity", () => {
  const { timeline } = effectArrangementFixture(), before = structuredClone(timeline), range = { startFrame: 72, endFrame: 240 };
  assert.deepEqual(effectArrangementPlacedRange(timeline, { kind: "audio-clip", clipId: "cl_audio" }, range), {
    ok: true, original: { startFrame: 48, endFrame: 312 }, range: { startFrame: 72, endFrame: 240 }, clipped: true, hasGaps: false,
  });
  assert.deepEqual(timeline, before);
  assert.equal(effectArrangementPlacedRange(timeline, { kind: "composition-mix" }, range).ok, false);
  assert.equal(effectArrangementPlacedRange(timeline, { kind: "audio-clip", clipId: "cl_video" }, range).ok, false);
  assert.equal(effectArrangementPlacedRange(timeline, { kind: "video-sound", clipId: "cl_audio" }, range).ok, false);
  assert.equal(effectArrangementPlacedRange(timeline, { kind: "audio-clip", clipId: "cl_missing" }, range).ok, false);
  assert.equal(effectArrangementPlacedRange(timeline, { kind: "audio-clip", clipId: "cl_audio" }, { startFrame: 0, endFrame: 24 }).ok, false);
});

test("whole-track interval labels gaps and refuses empty tracks instead of guessing a song", () => {
  const { timeline } = effectArrangementFixture(), track = timeline.tracks[1]!;
  track.clips[0]!.durationFrames = 24;
  track.clips.push({ ...structuredClone(track.clips[0]!), id: "cl_later", startFrame: 144 });
  const result = effectArrangementPlacedRange(timeline, { kind: "audio-track", trackId: track.id }, { startFrame: 0, endFrame: 240 });
  assert.deepEqual(result, { ok: true, original: { startFrame: 48, endFrame: 168 }, range: { startFrame: 48, endFrame: 168 }, clipped: false, hasGaps: true });
  track.clips = [];
  assert.equal(effectArrangementPlacedRange(timeline, { kind: "audio-track", trackId: track.id }, { startFrame: 0, endFrame: 240 }).ok, false);
});

test("the prepared request is strictly effects-only with an independent copied scope", () => {
  const chosen = scope(), request = effectArrangementRequest(chosen);
  chosen.range.endFrame = 48; chosen.palette[0]!.id = "rain";
  assert.equal(request.scope.range.endFrame, 240); assert.equal(request.scope.palette[0]!.id, "dust");
  assert.match(request.text, /effects-only.*Soft atmosphere/);
  assert.throws(() => effectArrangementRequest({ ...scope(), direction: " " }));
  assert.throws(() => effectArrangementRequest({ ...scope(), palette: [] }));
  assert.throws(() => effectArrangementRequest({ ...scope(), palette: [{ id: "dust", version: 1 }, { id: "dust", version: 1 }] }), /only once/);
});

test("follow-up captures exact reviewed version and selection without changing scope or granting authority", () => {
  const chosen = scope(), reviewed: EffectVersionRef = { familyId: `req_${ulid()}`, versionId: "v1", candidateHash: "a".repeat(64), decisionRevision: 3 };
  const request = effectArrangementFollowUp({ scope: chosen, reviewed, selectedEffectId: "cl_dust", text: " Make this less busy " });
  chosen.direction = "Changed later"; reviewed.decisionRevision = 4; reviewed.versionId = "v2";
  assert.equal(request.text, "Make this less busy");
  assert.equal(request.subject.scope.direction, "Soft atmosphere");
  assert.equal(request.subject.reviewed!.decisionRevision, 3); assert.equal(request.subject.reviewed!.versionId, "v1");
  assert.equal(request.subject.selectedEffectId, "cl_dust");
  assert.deepEqual(Object.keys(request.subject).sort(), ["kind", "reviewed", "scope", "selectedEffectId"]);
  assert.throws(() => effectArrangementFollowUp({ scope: scope(), reviewed, text: " " }), /Describe/);
});
