import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_MIX, EffectClipSchema, EffectCurveSchema, ProductionTimelineSchema, TimelineCommandSchema,
  applyTimelineCommands, defaultEffectClip, effectCurveAt, effectVisibilityAt, redoTimelineHistory, timelineCarriesEffects, undoTimelineHistory,
  type ProductionTimeline, type TimelineClipCommand } from "../src/index.js";

const base = (): ProductionTimeline => ({ schemaVersion: 1, revision: 0, frameRate: 25, tracks: [
  { id: "tr_picture", kind: "picture", name: "Picture", order: 0, muted: false, clips: [] },
], history: { undo: [], redo: [] }, mix: DEFAULT_MIX, library: [] });
const dust = () => defaultEffectClip({ id: "cl_dust", lineageId: "ef_dust", startFrame: 0, durationFrames: 200, seed: 42 });
const human = (timeline: ProductionTimeline, commands: TimelineClipCommand[]) => ProductionTimelineSchema.parse(applyTimelineCommands(timeline, commands, { effectAuthority: "human" }));
const placed = () => human(base(), [{ kind: "add-track", trackId: "tr_fx", trackKind: "effect", name: "Atmosphere" }, { kind: "effect-create", trackId: "tr_fx", effect: dust() }]);
const effects = (timeline: ProductionTimeline) => timeline.tracks.flatMap(track => track.effects ?? []);

test("procedural schema refuses media payload, unsafe clocks and unknown presets", () => {
  assert.equal(EffectClipSchema.safeParse({ ...dust(), source: { kind: "artifact", artifactId: "ar_fake" } }).success, false);
  assert.equal(EffectClipSchema.safeParse({ ...dust(), preset: { id: "dust", version: 2 } }).success, false);
  assert.equal(EffectClipSchema.safeParse({ ...dust(), startFrame: Number.MAX_SAFE_INTEGER }).success, false);
  assert.equal(EffectClipSchema.safeParse({ ...dust(), appearance: { ...dust().appearance, amount: Infinity } }).success, false);
  assert.equal(EffectClipSchema.safeParse({ ...dust(), reaction: { ...dust().reaction, enabled: true } }).success, false);
  assert.equal(TimelineCommandSchema.safeParse({ kind: "effect-remove", clipId: "cl_dust", origin: "human" }).success, false);
});

test("effects and ordinary edits share one atomic history; retained effects fence old readers", () => {
  const timeline = placed();
  assert.equal(timeline.revision, 1);
  assert.equal(timeline.history.undo.length, 1);
  assert.equal(effects(timeline).length, 1);
  const undone = ProductionTimelineSchema.parse(undoTimelineHistory(timeline));
  assert.deepEqual(undone.tracks, base().tracks);
  assert.equal(timelineCarriesEffects(undone), true);
  assert.deepEqual(ProductionTimelineSchema.parse(redoTimelineHistory(undone)).tracks, timeline.tracks);
  assert.equal(timelineCarriesEffects(base()), false);
  assert.equal("effectProtection" in human(base(), [{ kind: "set-track", trackId: "tr_picture", name: "Video" }]), false);
});

test("independent target, interval and audio bindings remain independent", () => {
  let timeline = placed();
  timeline = human(timeline, [{ kind: "effect-patch", clipId: "cl_dust", patch: { audioInput: { kind: "composition-mix" }, reaction: { enabled: true } } }]);
  const original = effects(timeline)[0]!;
  timeline = human(timeline, [{ kind: "effect-patch", clipId: "cl_dust", patch: { target: { kind: "picture-track", trackId: "tr_picture" } } }]);
  assert.deepEqual(effects(timeline)[0]!.audioInput, original.audioInput);
  assert.equal(effects(timeline)[0]!.startFrame, original.startFrame);
  timeline = human(timeline, [{ kind: "effect-move", clipId: "cl_dust", startFrame: 50 }]);
  assert.deepEqual(effects(timeline)[0]!.target, { kind: "picture-track", trackId: "tr_picture" });
  assert.deepEqual(effects(timeline)[0]!.audioInput, original.audioInput);
});

test("split and crop retain fades, curves, origin and exact per-frame visibility", () => {
  let timeline = placed();
  timeline = human(timeline, [{ kind: "effect-patch", clipId: "cl_dust", patch: {
    fades: { startFrame: 0, endFrame: 200, inFrames: 80, outFrames: 80 },
    intensityCurve: { points: [{ id: "ep_a", offsetFrames: 0, value: 0, interpolation: "smooth" }, { id: "ep_b", offsetFrames: 200, value: 1, interpolation: "linear" }] },
  } }]);
  const original = effects(timeline)[0]!;
  const split = human(timeline, [{ kind: "effect-split", clipId: "cl_dust", atFrame: 100, newClipId: "cl_right" }]);
  for (let frame = 0; frame < 200; frame++) assert.equal(effects(split).reduce((sum, effect) => sum + effectVisibilityAt(effect, frame), 0), effectVisibilityAt(original, frame));
  const trimmed = human(split, [{ kind: "effect-trim", clipId: "cl_right", edge: "head", deltaFrames: 20 }]);
  for (let frame = 120; frame < 200; frame++) assert.equal(effectVisibilityAt(effects(trimmed).find(effect => effect.id === "cl_right")!, frame), effectVisibilityAt(original, frame));
  assert.deepEqual(undoTimelineHistory(trimmed).tracks, split.tracks);
});

test("move after a head crop preserves signed simulation phase and fixed audio cues", () => {
  let timeline = human(placed(), [{ kind: "effect-patch", clipId: "cl_dust", patch: { cueOverrides: [{ id: "ec_beat", frame: 10, durationFrames: 5, strength: 1, kind: "accent" }] } },
    { kind: "effect-trim", clipId: "cl_dust", edge: "head", deltaFrames: 100 }]);
  timeline = human(timeline, [{ kind: "effect-move", clipId: "cl_dust", startFrame: 50 }]);
  assert.equal(effects(timeline)[0]!.simulationOriginFrame, -50);
  assert.equal(effects(timeline)[0]!.fades.startFrame, -50);
  assert.equal(effects(timeline)[0]!.cueOverrides[0]!.frame, 10);
  const extended = human(timeline, [{ kind: "effect-trim", clipId: "cl_dust", edge: "head", deltaFrames: -20 }]);
  assert.equal(effects(extended)[0]!.simulationOriginFrame, -50);
});

test("points in an extended head use signed offsets and retain phase and passage protection on split", () => {
  let timeline = human(placed(), [{ kind: "effect-move", clipId: "cl_dust", startFrame: 50 },
    { kind: "effect-trim", clipId: "cl_dust", edge: "head", deltaFrames: -25 },
    { kind: "effect-patch", clipId: "cl_dust", patch: { intensityCurve: { points: [
      { id: "ep_head", offsetFrames: -25, value: 0.2, interpolation: "smooth" },
      { id: "ep_origin", offsetFrames: 0, value: 0.5, interpolation: "linear" },
      { id: "ep_tail", offsetFrames: 150, value: 1, interpolation: "hold" },
    ] } } }]);
  timeline = human(timeline, [{ kind: "effect-protect", rule: { id: "pr_curve", lineageId: "ef_dust", kind: "property", property: "intensityCurve", scope: { kind: "passage", startFrame: 25, endFrame: 100 } } }]);
  const original = effects(timeline)[0]!;
  assert.equal(original.simulationOriginFrame, 50);
  assert.equal(original.intensityCurve.points[0]!.offsetFrames, -25);
  const split = ProductionTimelineSchema.parse(applyTimelineCommands(timeline, [{ kind: "effect-split", clipId: "cl_dust", atFrame: 40, newClipId: "cl_head_right" }]));
  for (let frame = 25; frame < 250; frame++) assert.equal(effects(split).reduce((sum, effect) => sum + effectVisibilityAt(effect, frame), 0), effectVisibilityAt(original, frame));
  assert.deepEqual(split.effectProtection, timeline.effectProtection);
  const patch = { intensityCurve: { points: original.intensityCurve.points.map(point => point.id === "ep_head" ? { ...point, value: 0.9 } : point) } };
  assert.throws(() => applyTimelineCommands(timeline, [{ kind: "effect-patch", clipId: "cl_dust", patch }]), /protect/i);
  const changed = human(timeline, [{ kind: "effect-patch", clipId: "cl_dust", patch }]);
  assert.notEqual(changed.effectProtection![0]!.baselineFingerprint, timeline.effectProtection![0]!.baselineFingerprint);
  assert.deepEqual(undoTimelineHistory(changed).tracks, timeline.tracks);
  assert.deepEqual(undoTimelineHistory(changed).effectProtection, timeline.effectProtection);
});

test("overlapping independent effects work while split segments retain unique lineage coverage", () => {
  const timeline = human(placed(), [{ kind: "effect-create", trackId: "tr_fx", effect: defaultEffectClip({ id: "cl_rain", lineageId: "ef_rain", startFrame: 50, durationFrames: 200, seed: 9, preset: "rain" }) }]);
  assert.equal(effects(timeline).length, 2);
  assert.throws(() => human(timeline, [{ kind: "effect-create", trackId: "tr_fx", effect: { ...dust(), id: "cl_alias" } }]), /lineage/);
  const split = human(timeline, [{ kind: "effect-split", clipId: "cl_dust", atFrame: 100, newClipId: "cl_right" }]);
  assert.throws(() => human(split, [{ kind: "effect-move", clipId: "cl_right", startFrame: 50 }]), /overlapping/);
});

test("duplicate has independent lineage and seed, remapped protections and exact undo", () => {
  let timeline = human(placed(), [{ kind: "effect-protect", rule: { id: "pr_end", lineageId: "ef_dust", kind: "boundary", boundary: "end" } },
    { kind: "effect-protect", rule: { id: "pr_open", lineageId: "ef_dust", kind: "passage-coverage", startFrame: 0, endFrame: 24 } }]);
  const before = timeline;
  timeline = human(timeline, [{ kind: "effect-duplicate", clipId: "cl_dust", newClipId: "cl_copy", newLineageId: "ef_copy", startFrame: 300, seed: 43 }]);
  assert.equal(effects(timeline).find(effect => effect.id === "cl_copy")!.seed, 43);
  const coverage = timeline.effectProtection!.find(rule => rule.lineageId === "ef_copy" && rule.kind === "passage-coverage");
  assert.equal(coverage?.kind === "passage-coverage" && coverage.startFrame, 300);
  assert.deepEqual(undoTimelineHistory(timeline).tracks, before.tracks);
  assert.deepEqual(undoTimelineHistory(timeline).effectProtection, before.effectProtection);
  assert.throws(() => human(before, [{ kind: "effect-duplicate", clipId: "cl_dust", newClipId: "cl_copy", newLineageId: "ef_copy", startFrame: 300, seed: 42 }]), /seed/);
});

test("protection constrains suggestions, permits human edits and releases explicitly", () => {
  const timeline = human(placed(), [{ kind: "effect-protect", rule: { id: "pr_colour", lineageId: "ef_dust", kind: "property", property: "appearance.colour", scope: { kind: "whole" } } }]);
  assert.throws(() => applyTimelineCommands(timeline, [{ kind: "effect-patch", clipId: "cl_dust", patch: { appearance: { colour: "#000000" } } }]), /protect|colour/i);
  assert.throws(() => applyTimelineCommands(timeline, [{ kind: "effect-release", ruleId: "pr_colour" }, { kind: "effect-remove", clipId: "cl_dust" }]), /human/i);
  assert.throws(() => applyTimelineCommands(timeline, [{ kind: "set-track", trackId: "tr_fx", muted: true }]), /visibility|protect/i);
  const edited = human(timeline, [{ kind: "effect-patch", clipId: "cl_dust", patch: { appearance: { colour: "#000000" } } }]);
  assert.equal(edited.effectProtection!.length, 1);
  assert.notEqual(edited.effectProtection![0]!.baselineFingerprint, timeline.effectProtection![0]!.baselineFingerprint);
  const deleted = human(edited, [{ kind: "effect-remove", clipId: "cl_dust" }]);
  assert.deepEqual(deleted.effectProtection, []);
  assert.deepEqual(undoTimelineHistory(deleted).effectProtection, edited.effectProtection);
});

test("normalized curves are sorted, bounded and hold at endpoints", () => {
  const curve = EffectCurveSchema.parse({ points: [{ id: "ep_a", offsetFrames: 10, value: 0, interpolation: "smooth" }, { id: "ep_b", offsetFrames: 20, value: 1, interpolation: "hold" }] });
  assert.equal(effectCurveAt(curve, 15), 0.5);
  for (let frame = -10; frame <= 40; frame++) assert.ok(effectCurveAt(curve, frame) >= 0 && effectCurveAt(curve, frame) <= 1);
  assert.equal(EffectCurveSchema.safeParse({ points: [curve.points[0], { ...curve.points[1], offsetFrames: 10 }] }).success, false);
  assert.equal(effectCurveAt({ points: [] }, 0), 1);
});
