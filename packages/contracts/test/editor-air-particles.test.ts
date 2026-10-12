import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultEffectClip, evaluateEffectFrame, rasterizeEffectFrame, clearAirParticleCache, airParticleCacheBytes, AIR_PARTICLE_PROFILE,
  compositeRgba, addWeightedPicture, compositeWeightedTrack, moveEffect, trimEffect, restoreEffectCommands, applyTimelineCommands,
  ProductionTimelineSchema, undoTimelineHistory, redoTimelineHistory, compilePictureProposal, pictureStickyEdits, pictureAppearanceState, keepPictureAppearance,
  effectRenderCapabilityProblem, PictureProposalVersionSchema, pictureAppearanceDelta, withPictureAppearance, finishTrustedTimelineSteps, type ProductionTimeline, type TimelineClipCommand, type ModelPictureProposal } from "../src/index.js";
const air = () => defaultEffectClip({ id: "cl_air", lineageId: "ef_air", seed: 81273, startFrame: 0, durationFrames: 45000, preset: "air-particles" });
const frame = (effect = air(), absoluteFrame = 240) => evaluateEffectFrame({ effect, absoluteFrame, frameRate: 25, targetAspectRatio: 16 / 9 });
test("Air Particles cold and cached seeks, loops, moves and head trims preserve exact frames", () => {
  const value = air();
  const sample = frame(value, 43199); clearAirParticleCache();
  for (const at of [10, 149, 150, 151, 275, 43198]) frame(value, at);
  assert.deepEqual(frame(value, 43199), sample);
  assert.ok(airParticleCacheBytes() <= AIR_PARTICLE_PROFILE.maxCacheBytes);
  const cropped = trimEffect(value, "head", 300);
  assert.deepEqual(frame(cropped, 43199).particles, sample.particles);
  assert.deepEqual(frame(moveEffect(value, 100), 43299).particles, sample.particles);
  assert.equal(frame({ ...value, appearance: { ...value.appearance, amount: 0 } }).particles.length, 0);
  assert.ok(frame(value).particles.length >= 500);
});
test("physics, Pattern and texture controls change visible output without mutating the authored record", () => {
  const value = air(), before = structuredClone(value), pixels = rasterizeEffectFrame(frame(value), 320, 180);
  for (const patch of [{ seed: 11 }, { motion: { ...value.motion, airflow: 0 } }, { motion: { ...value.motion, particleDeflections: false } },
    { motion: { ...value.motion, boundary: "open-flow" as const } }, { appearance: { ...value.appearance, texture: 0, softness: 0 } }]) {
    assert.notDeepEqual(rasterizeEffectFrame(frame({ ...value, ...patch }), 320, 180), pixels);
  }
  assert.deepEqual(value, before);
  const restore = restoreEffectCommands({ ...value, seed: 4 }, value);
  assert.equal(restore.at(-1)!.kind, "effect-patch");
  assert.equal(restore.find(command => command.kind === "effect-patch")!.patch.seed, value.seed);
});
test("Screen and Add preserve transparent mattes and use each crossfade source against one backdrop", () => {
  const backdrop = new Uint8ClampedArray([80, 100, 140, 255]), source = new Uint8ClampedArray([120, 60, 10, 128]);
  assert.deepEqual([...compositeRgba(backdrop.slice(), new Uint8ClampedArray([0, 0, 0, 255]), "over", "screen")], [...backdrop]);
  assert.deepEqual([...compositeRgba(backdrop.slice(), new Uint8ClampedArray([255, 255, 255, 255]), "over", "add")], [255, 255, 255, 255]);
  assert.equal(compositeRgba(new Uint8ClampedArray([80, 100, 140, 32]), source, "atop", "screen")[3], 32);
  assert.deepEqual(compositeRgba(backdrop.slice(), source, "over", "add", 0), backdrop);
  const track = new Float32Array(4), rect = { x: 0, y: 0, width: 1, height: 1 };
  addWeightedPicture(track, source, .5, rect, 1, backdrop, "screen", .8);
  addWeightedPicture(track, source, .5, rect, 1, backdrop, "screen", .8);
  const weighted = backdrop.slice(); compositeWeightedTrack(weighted, track);
  assert.deepEqual(weighted, compositeRgba(backdrop.slice(), source, "over", "screen", .8));
});
const base = (): ProductionTimeline => ProductionTimelineSchema.parse({ schemaVersion: 1, revision: 0, frameRate: 25, tracks: [
  { id: "tr_picture", kind: "picture", name: "Picture", order: 0, muted: false, clips: [{ id: "cl_a", startFrame: 0, durationFrames: 100,
    source: { kind: "artifact", artifactId: "ar_01J8E0000000000000000000A1", label: "A" } }] },
], history: { undo: [], redo: [] } });
const human = (timeline: ProductionTimeline, commands: TimelineClipCommand[]) => applyTimelineCommands(timeline, commands, { effectAuthority: "human" });
const picture = (timeline: ProductionTimeline) => timeline.tracks[0]!.clips[0]!;

test("picture proposal snapshots cover multiple full tracks without a global 4000-clip ceiling", () => {
  const value = base(), template = picture(value);
  value.tracks = [0, 1].map(track => ({ ...value.tracks[0]!, id: `tr_picture${track}`, order: track,
    clips: Array.from({ length: 2100 }, (_, index) => ({ ...template, id: `cl_${track}_${index}`, startFrame: index * 100 })) }));
  const timeline = ProductionTimelineSchema.parse(value), before = pictureAppearanceState(timeline);
  const pictures = before.map((row, index) => index === 4199 ? { ...row, visual: { blendMode: "screen" as const, opacity: .5 } } : row);
  const snapshot = PictureProposalVersionSchema.pick({ before: true, pictures: true }).parse({ before, pictures });
  assert.equal(snapshot.before.length, 4200);
  assert.deepEqual(pictureAppearanceDelta(snapshot.before, snapshot.pictures).map(row => row.clipId), ["cl_1_2099"]);
  const applied = withPictureAppearance(timeline, snapshot.pictures);
  assert.deepEqual(applied.tracks[1]!.clips[2099]!.visual, { blendMode: "screen", opacity: .5 });
  assert.equal(JSON.stringify(applied.tracks[0]), JSON.stringify(timeline.tracks[0]));
});
test("picture rules survive splits and duplicates; human edits update the baseline and history restores it", () => {
  const original = base();
  const protectedBase = human(original, [{ kind: "picture-appearance", clipId: "cl_a", patch: { blendMode: "screen", opacity: .7 } },
    { kind: "picture-protect", clipId: "cl_a", rule: { id: "vp_blend", property: "blendMode", scope: { kind: "whole" } } }]);
  assert.throws(() => applyTimelineCommands(protectedBase, [{ kind: "picture-appearance", clipId: "cl_a", patch: { blendMode: "add" } }]), /protect/i);
  assert.throws(() => applyTimelineCommands(protectedBase, [{ kind: "picture-release", ruleId: "vp_blend" }]), /human/);
  assert.throws(() => applyTimelineCommands(protectedBase, [{ kind: "set-track", trackId: "tr_picture", muted: true }]), /protect/i);
  const edited = human(protectedBase, [{ kind: "picture-appearance", clipId: "cl_a", patch: { blendMode: "add" } }]);
  assert.equal(picture(edited).visual?.protection?.length, 1);
  assert.deepEqual(undoTimelineHistory(edited).tracks, protectedBase.tracks);
  assert.deepEqual(redoTimelineHistory(undoTimelineHistory(edited)).tracks, edited.tracks);
  const split = human(edited, [{ kind: "split", clipId: "cl_a", atFrame: 50, newClipId: "cl_b" }]);
  assert.equal(split.tracks[0]!.clips[1]!.visualOriginId, "cl_a");
  assert.throws(() => applyTimelineCommands(split, [{ kind: "picture-appearance", clipId: "cl_b", patch: { blendMode: "normal" } }]), /protect/i);
  const duplicate = human(split, [{ kind: "duplicate", clipId: "cl_b", newClipId: "cl_c" }]);
  assert.equal(duplicate.tracks[0]!.clips[2]!.visualOriginId, "cl_c");
  assert.notEqual(duplicate.tracks[0]!.clips[2]!.visual?.protection?.[0]?.id, "vp_blend");
});
test("fixed picture passage stays on production time; only the intersecting segment is constrained", () => {
  let value = human(base(), [{ kind: "picture-protect", clipId: "cl_a", rule: { id: "vp_opacity", property: "opacity", scope: { kind: "passage", startFrame: 10, endFrame: 40 } } }]);
  value = human(value, [{ kind: "split", clipId: "cl_a", atFrame: 50, newClipId: "cl_b" }]);
  assert.throws(() => applyTimelineCommands(value, [{ kind: "picture-appearance", clipId: "cl_a", patch: { opacity: .5 } }]), /protect/i);
  const outside = applyTimelineCommands(value, [{ kind: "picture-appearance", clipId: "cl_b", patch: { opacity: .5 } }]);
  assert.equal(outside.tracks[0]!.clips[1]!.visual?.opacity, .5);
  assert.throws(() => applyTimelineCommands(value, [{ kind: "delete", clipId: "cl_a" }]), /protect/i);
});
test("picture proposal retains each manual property and pending protection across broad revisions", () => {
  const original = base(), model: ModelPictureProposal = { summary: "Lighten", commands: [{ kind: "picture-appearance", clipId: "cl_a", patch: { blendMode: "screen", opacity: .8 } }] };
  const first = compilePictureProposal(original, model, [], {}); assert.deepEqual(first.conflicts, []);
  let sticky = pictureStickyEdits([{ kind: "picture-appearance", clipId: "cl_a", patch: { opacity: .6 } }, { kind: "picture-protect", clipId: "cl_a", rule: { id: "vp_screen", property: "blendMode", scope: { kind: "whole" } } }], [], pictureAppearanceState(first.candidate));
  const revised = { ...model, commands: [{ kind: "picture-appearance" as const, clipId: "cl_a", patch: { blendMode: "add" as const, opacity: 1 } }] };
  const next = compilePictureProposal(original, revised, sticky, {}); assert.deepEqual(next.conflicts, []);
  assert.equal(picture(next.candidate).visual?.blendMode, "screen"); assert.equal(picture(next.candidate).visual?.opacity, .6);
  sticky = pictureStickyEdits([{ kind: "picture-release", ruleId: "vp_screen" }], sticky, pictureAppearanceState(next.candidate));
  const released = compilePictureProposal(original, revised, sticky, {}); assert.equal(picture(released.candidate).visual?.blendMode, "add");
  const kept = compilePictureProposal(original, revised, keepPictureAppearance(original, "cl_a", sticky), {});
  assert.equal(picture(kept.candidate).visual, undefined);
  assert.deepEqual(pictureAppearanceDelta(pictureAppearanceState(original), pictureAppearanceState(kept.candidate)), []);
  assert.equal(finishTrustedTimelineSteps(original, kept.reduction!).kind, "unchanged");
  assert.equal(original.revision, 0); assert.equal(picture(original).visual, undefined);
  assert.throws(() => pictureStickyEdits([{ kind: "picture-release", ruleId: "vp_missing" }], [], pictureAppearanceState(original)), /no longer present/);
});

test("render readiness counts separate blended intermediates before export", () => {
  const effects = Array.from({ length: 129 }, (_, index) => ({ ...air(), id: `cl_${index}` as const, startFrame: index * 25, durationFrames: 25 }));
  const plan = { rendererVersion: "software-rgba-v2" as const, width: 320, height: 180, frameRate: 25, startFrame: 0, endFrame: 129 * 25,
    pictureLayers: [], effectLayers: effects.map(effect => ({ effect, trackId: "tr_fx", trackOrder: 0 })), issues: [] };
  assert.match(effectRenderCapabilityProblem(plan)!, /128.*groups/);
  for (const effect of effects) effect.appearance.blendMode = "normal";
  assert.equal(effectRenderCapabilityProblem(plan), null);
});

test("Pattern and physics protections survive human edits and block suggestion changes", () => {
  const value = base(); value.tracks.push({ id: "tr_fx", kind: "effect", name: "Effects", order: 1, muted: false, clips: [], effects: [air()] });
  const rules = ["seed", "motion.boundary", "motion.particleDeflections", "appearance.blendMode"] as const;
  const protectedValue = human(value, rules.map((property, index) => ({ kind: "effect-protect", rule: { kind: "property", id: `pr_${index}`, lineageId: "ef_air", property, scope: { kind: "whole" } } })));
  for (const patch of [{ seed: 123 }, { motion: { boundary: "open-flow" as const } }, { motion: { particleDeflections: false } }, { appearance: { blendMode: "add" as const } }]) {
    assert.throws(() => applyTimelineCommands(protectedValue, [{ kind: "effect-patch", clipId: "cl_air", patch }]), /protect/i);
  }
  const manual = human(protectedValue, [{ kind: "effect-patch", clipId: "cl_air", patch: { seed: 123 } }]);
  assert.equal(manual.effectProtection?.length, rules.length);
  assert.throws(() => applyTimelineCommands(manual, [{ kind: "effect-patch", clipId: "cl_air", patch: { seed: air().seed } }]), /protect/i);
  assert.equal(undoTimelineHistory(manual).tracks[1]!.effects![0]!.seed, air().seed);
});

test("Pattern edits update a split lineage in one undoable transaction and respect protected passages", () => {
  const value = base(); value.tracks.push({ id: "tr_fx", kind: "effect", name: "Effects", order: 1, muted: false, clips: [], effects: [air()] });
  const split = human(value, [{ kind: "effect-split", clipId: "cl_air", atFrame: 300, newClipId: "cl_tail" }]);
  const commands: TimelineClipCommand[] = [{ kind: "effect-patch", clipId: "cl_tail", patch: { seed: 123 } }];
  for (const changed of [human(split, commands), applyTimelineCommands(split, commands)]) {
    assert.deepEqual(changed.tracks[1]!.effects!.map(effect => effect.seed), [123, 123]);
    assert.equal(changed.revision, split.revision + 1);
    assert.deepEqual(undoTimelineHistory(changed).tracks, split.tracks);
  }
  const protectedValue = human(split, [{ kind: "effect-protect", rule: { id: "pr_pattern", kind: "property", lineageId: "ef_air", property: "seed",
    scope: { kind: "passage", startFrame: 0, endFrame: 100 } } }]);
  assert.throws(() => applyTimelineCommands(protectedValue, commands), /protect/i, "editing the tail cannot bypass the head's protected pattern");
  const manual = human(protectedValue, commands);
  assert.deepEqual(manual.tracks[1]!.effects!.map(effect => effect.seed), [123, 123]);
  assert.equal(manual.effectProtection?.length, 1);
  assert.deepEqual(undoTimelineHistory(manual).effectProtection, protectedValue.effectProtection);
});
