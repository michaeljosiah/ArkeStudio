import assert from "node:assert/strict";
import { test } from "node:test";
import { applyTimelineCommands, captureEffectProtectionRule, correctEffectLikelyBeat, DEFAULT_MIX, defaultEffectClip, effectResponsePresetConflicts,
  uncoveredEffectPassages, type EffectAudioInput, type ProductionTimeline } from "../src/index.js";

const effect = () => defaultEffectClip({ id: "cl_dust", lineageId: "ef_dust", seed: 7, startFrame: 10, durationFrames: 100 });
test("simple response replacement identifies each independently protected mapping without changing direct human authority", () => {
  const clip = effect();
  const rules = ["reaction.beat", "reaction.energy", "appearance.amount"] as const;
  const protectedRules = rules.map((property, index) => captureEffectProtectionRule({ id: `pr_${index}`, lineageId: clip.lineageId, kind: "property", property, scope: { kind: "whole" } }, [clip], 1));
  assert.deepEqual(effectResponsePresetConflicts(clip, protectedRules, "beat-pulse"), ["reaction.beat", "reaction.energy"]);
  assert.deepEqual(effectResponsePresetConflicts(clip, protectedRules, "gentle-shimmer"), []);
  assert.equal(clip.reaction.preset, "gentle-shimmer");
});
test("likely-beat corrections persist independent suppression and absolute-clock accents at every supported frame rate", () => {
  for (const fps of [24, 25, 30]) {
    let id = 0;
    const before = effect();
    const corrected = correctEffectLikelyBeat(before, { frame: 45, strength: .75 }, fps, 48, () => `ec_${++id}`);
    assert.deepEqual(corrected.map(cue => [cue.kind, cue.frame, cue.durationFrames]), [["suppress", 45, Math.ceil(fps * .12)], ["accent", 48, Math.ceil(fps * .12)]]);
    assert.equal(corrected[1]!.strength, .75);
    assert.equal(new Set(corrected.map(cue => cue.id)).size, 2);
    assert.deepEqual(before.cueOverrides, []);
    assert.equal(correctEffectLikelyBeat(before, { frame: 45, strength: 1 }, fps, null, () => "ec_removed").length, 1);
    assert.throws(() => correctEffectLikelyBeat(before, { frame: 45, strength: 1 }, fps, -1, () => `ec_${++id}`));
  }
});
test("fixed passage gaps survive split, moved segments and uncovered boundaries", () => {
  const clip = effect(), split = [{ ...clip, durationFrames: 30 }, { ...clip, id: "cl_right", startFrame: 60, durationFrames: 30 }];
  assert.deepEqual(uncoveredEffectPassages(split, clip.lineageId, 0, 120), [{ startFrame: 0, endFrame: 10 }, { startFrame: 40, endFrame: 60 }, { startFrame: 90, endFrame: 120 }]);
  assert.deepEqual(uncoveredEffectPassages([clip], clip.lineageId, 20, 100), []);
});
test("semantic commands distinguish an audio clip from picture video sound by owner track", () => {
  const clip = effect();
  const timeline: ProductionTimeline = { schemaVersion: 1, revision: 0, frameRate: 24, mix: DEFAULT_MIX, library: [], history: { undo: [], redo: [] }, tracks: [
    { id: "tr_picture", kind: "picture", name: "Picture", order: 0, muted: false, clips: [{ id: "cl_video", startFrame: 0, durationFrames: 240, sourceInFrames: 0, source: { kind: "artifact", artifactId: "ar_video", label: "Video" } }] },
    { id: "tr_sound", kind: "audio", name: "Sound", order: 1, muted: false, clips: [{ id: "cl_song", startFrame: 0, durationFrames: 240, sourceInFrames: 0, source: { kind: "artifact", artifactId: "ar_song", label: "Song" } }] },
    { id: "tr_fx", kind: "effect", name: "Effects", order: 2, muted: false, clips: [], effects: [clip] },
  ] };
  const bind = (audioInput: EffectAudioInput) => applyTimelineCommands(timeline, [{ kind: "effect-patch", clipId: clip.id, patch: { audioInput } }], { effectAuthority: "human" });
  assert.throws(() => bind({ kind: "audio-clip", clipId: "cl_video" }), /audio clip/);
  assert.throws(() => bind({ kind: "video-sound", clipId: "cl_song" }), /visual video/);
  assert.doesNotThrow(() => bind({ kind: "audio-clip", clipId: "cl_song" }));
  assert.doesNotThrow(() => bind({ kind: "video-sound", clipId: "cl_video" }));
});
