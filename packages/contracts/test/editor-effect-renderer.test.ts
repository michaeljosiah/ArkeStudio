import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { defaultEffectClip, type EffectClip } from "../src/editor-effects.js";
import { moveEffect, trimEffect } from "../src/editor-effect-commands.js";
import { EFFECT_PRESET_CATALOGUE, EFFECT_RENDER_PROFILE, effectRenderCapabilityProblem, effectTimelineCapabilityProblem } from "../src/editor-effect-catalogue.js";
import { evaluateEffectFrame, type EffectFrame } from "../src/editor-effect-evaluator.js";
import { compositeRgba, rasterizeEffectFrame, renderEffectLayersRgba } from "../src/editor-effect-raster.js";
import type { EffectRenderProjection } from "../src/editor-effect-render-plan.js";
import { DEFAULT_MIX, type ProductionTimeline } from "../src/timeline.js";

function effect(preset: EffectClip["preset"]["id"] = "dust"): EffectClip {
  const value = defaultEffectClip({ id: "cl_fixture", lineageId: "ef_fixture", seed: 3735928559, startFrame: 0, durationFrames: 10000, preset });
  value.appearance = { ...value.appearance, amount: 1, size: 0.8, opacity: 0.9 };
  return value;
}
const evaluate = (value: EffectClip, absoluteFrame: number, frameRate = 25, targetAspectRatio = 16 / 9) => evaluateEffectFrame({ effect: value, absoluteFrame, frameRate, targetAspectRatio });
const hash = (rgba: Uint8ClampedArray) => createHash("sha256").update(rgba).digest("hex");
const nonzero = (rgba: Uint8ClampedArray) => rgba.some((value, index) => index % 4 === 3 && value > 0);

test("all six software presets have pinned, distinct visible RGBA fixtures", () => {
  const hashes: Record<string, string> = {
    dust: "0170b5880bd6332406a5151164185d814333634e188272ddd92325a4ff68176b",
    embers: "23e51579d01ccf608e948bb269efafc54237a61664cdfa4585f88f2d70e990d0",
    snow: "0427962c850ecfd0bb680791464b767f51d457179dc0b3e8db1621022894c150",
    lights: "3ebc47505d2ad4983fe4d5bb2163d959a261b4897d9c95f2b5dcb32f56cd5438",
    rain: "cbf6cbac1f0b70cd5808e90cced00f6198a6e4e7c2321f0044c4a202b67b8a4a",
    smoke: "fc81b85709781d771fc1be9aabccca73b9c491e22333a6e418f6da475971b4d1",
  };
  assert.equal(EFFECT_PRESET_CATALOGUE.length, 7);
  for (const preset of EFFECT_PRESET_CATALOGUE.filter(value => value.id !== "air-particles")) {
    const frame = evaluate(effect(preset.id), 73);
    assert.ok(frame.particles.length > 0 && frame.particles.length <= EFFECT_RENDER_PROFILE.maxParticlesPerEffect);
    const rgba = rasterizeEffectFrame(frame, 160, 90);
    assert.equal(nonzero(rgba), true, `${preset.id} must visibly draw`);
    assert.equal(hash(rgba), hashes[preset.id]);
  }
});

test("random access, looping and serialization equal sequential samples at every supported clock and aspect", () => {
  for (const preset of EFFECT_PRESET_CATALOGUE) for (const fps of [24, 25, 30]) for (const [width, height] of [[160, 90], [90, 160]] as const) {
    const value = effect(preset.id), aspect = width / height;
    const frames = new Map<number, string>();
    for (const at of [0, 1, 25, 73, 240, 9000]) frames.set(at, hash(rasterizeEffectFrame(evaluate(value, at, fps, aspect), width, height)));
    for (const at of [9000, 25, 0, 240, 73, 1, 73]) {
      const reloaded = JSON.parse(JSON.stringify(value)) as EffectClip;
      assert.equal(hash(rasterizeEffectFrame(evaluate(reloaded, at, fps, aspect), width, height)), frames.get(at));
    }
  }
});

test("split and trim retain identical particles and pixels, including fades and signed moved origins", () => {
  const original = effect("smoke");
  original.durationFrames = 300;
  original.fades = { startFrame: 0, endFrame: 300, inFrames: 70, outFrames: 130 };
  original.intensityCurve = { points: [{ id: "ep_i0", offsetFrames: 0, value: 0.2, interpolation: "smooth" }, { id: "ep_i1", offsetFrames: 250, value: 0.9, interpolation: "hold" }] };
  const right = { ...original, id: "cl_right", startFrame: 100, durationFrames: 200 };
  const cropped = trimEffect(right, "head", 30);
  for (const at of [130, 170, 260, 299]) {
    assert.deepEqual(evaluate(cropped, at).particles, evaluate(original, at).particles);
    assert.deepEqual(rasterizeEffectFrame(evaluate(cropped, at), 160, 90), rasterizeEffectFrame(evaluate(original, at), 160, 90));
  }
  const moved = moveEffect(cropped, 30);
  assert.equal(moved.simulationOriginFrame, -100);
  assert.deepEqual(evaluate(moved, 60).particles, evaluate(original, 160).particles);
});

test("births obey typed emitting area and zero speed leaves their positions stationary", () => {
  const value = effect();
  value.motion = { ...value.motion, speed: 0, area: { x: 0.2, y: 0.3, width: 0.1, height: 0.2 } };
  const first = evaluate(value, 100), later = evaluate(value, 101);
  for (const particle of first.particles) {
    assert.ok(particle.x >= 0.2 && particle.x <= 0.3);
    assert.ok(particle.y >= 0.3 && particle.y <= 0.5);
    const same = later.particles.find(candidate => candidate.id === particle.id);
    if (same) assert.deepEqual([same.x, same.y], [particle.x, particle.y]);
  }
});

test("missing audio is marked base-only and preserves base atmosphere", () => {
  const value = effect("embers");
  const base = evaluate(value, 50);
  value.audioInput = { kind: "composition-mix" };
  value.reaction.enabled = true;
  const missing = evaluate(value, 50);
  assert.equal(missing.reactionReady, false);
  assert.deepEqual(missing.particles, base.particles);
});

test("source-atop preserves translucent and transparent picture alpha exactly", () => {
  const picture = new Uint8ClampedArray([100, 50, 0, 128, 200, 100, 20, 0, 0, 0, 255, 255]);
  const fx = new Uint8ClampedArray([200, 100, 50, 128, 255, 255, 255, 255, 255, 0, 0, 255]);
  assert.deepEqual([...compositeRgba(picture, fx, "atop")], [150, 75, 25, 128, 0, 0, 0, 0, 255, 0, 0, 255]);
  assert.deepEqual([...compositeRgba(new Uint8ClampedArray([0, 0, 255, 255]), new Uint8ClampedArray([255, 0, 0, 128]))], [128, 0, 127, 255]);
  assert.deepEqual([...compositeRgba(new Uint8ClampedArray(4), new Uint8ClampedArray([7, 8, 9, 0]))], [0, 0, 0, 0]);
});

function projection(effects: EffectClip[] = []): EffectRenderProjection {
  return { rendererVersion: "software-rgba-v2", width: 1920, height: 1080, frameRate: 25, startFrame: 0, endFrame: 5500, pictureLayers: [],
    effectLayers: effects.map((value, index) => ({ effect: value, trackId: `tr_${index}`, trackOrder: index })), issues: [] };
}

test("limits count simultaneous visible target windows, not total clips or gaps", () => {
  const sequential = Array.from({ length: 20 }, (_, index) => ({ ...effect(), id: `cl_${index}`, startFrame: index * 100, durationFrames: 100 }));
  assert.equal(effectRenderCapabilityProblem(projection(sequential)), null);
  assert.deepEqual(renderEffectLayersRgba(sequential, 150, 25, 160, 90), renderEffectLayersRgba([sequential[1]!], 150, 25, 160, 90));
  const overlap = Array.from({ length: 9 }, (_, index) => ({ ...effect(), id: `cl_${index}` }));
  assert.match(effectRenderCapabilityProblem(projection(overlap))!, /8 effects/);
  const scoped = projection(overlap.map(value => ({ ...value, target: { kind: "picture-track" as const, trackId: "tr_video" } })));
  assert.equal(effectRenderCapabilityProblem(scoped), null, "a target gap has no active scoped effects");
  assert.equal(effectRenderCapabilityProblem({ ...scoped, endFrame: 0 }), null, "effects never invent delivery");
  assert.equal(effectRenderCapabilityProblem({ ...projection([effect()]), startFrame: 1_000_000, endFrame: 1_005_500 }), null, "a late production origin is not the delivery duration");
  assert.match(effectRenderCapabilityProblem({ ...projection([effect()]), endFrame: 25 * 1801 })!, /30 minutes/);
});

test("oversized raster/profile work is refused rather than silently reducing population", () => {
  assert.throws(() => renderEffectLayersRgba([effect()], 25, 25, 3840, 2160), /pixels/);
  assert.throws(() => renderEffectLayersRgba(Array.from({ length: 9 }, () => effect()), 25, 25, 160, 90), /8/);
  const frame = evaluate(effect(), 25);
  assert.throws(() => rasterizeEffectFrame({ ...frame, particles: Array(EFFECT_RENDER_PROFILE.maxParticlesPerEffect + 1).fill(frame.particles[0]) } as EffectFrame, 160, 90), /population/);
  const timeline: ProductionTimeline = { schemaVersion: 1, revision: 0, frameRate: 25, tracks: [], history: { undo: [], redo: [] }, mix: DEFAULT_MIX, library: [],
    effectProtection: [{ id: "pr_large", lineageId: "ef_fixture", kind: "boundary", boundary: "end", baselineRevision: 0, baselineFingerprint: "x".repeat(4 * 1024 * 1024) }] };
  assert.match(effectTimelineCapabilityProblem(timeline)!, /4 MiB/);
});

test("picture surface and scoped export group counts have finite shared limits", () => {
  const scoped = effect();
  scoped.target = { kind: "picture-track", trackId: "tr_video" };
  const plan = projection([scoped]);
  plan.pictureLayers = Array.from({ length: 129 }, (_, index) => ({ clipId: `cl_picture${index}`, trackId: "tr_video", order: index,
    kind: "media", label: "Picture", path: "fixture.png", still: true, startFrame: index * 25, endFrame: (index + 1) * 25,
    sourceInSec: 0, fit: "contain", matte: "source-alpha" }));
  assert.match(effectRenderCapabilityProblem(plan)!, /128.*groups/);
  assert.equal(effectRenderCapabilityProblem({ ...plan, pictureLayers: plan.pictureLayers.slice(0, 128) }), null);
  const overlapping = plan.pictureLayers.slice(0, 9).map(picture => ({ ...picture, startFrame: 0, endFrame: 100 }));
  assert.match(effectRenderCapabilityProblem({ ...plan, pictureLayers: overlapping })!, /8 picture layers/);
  assert.equal(effectRenderCapabilityProblem({ ...plan, pictureLayers: overlapping.slice(0, 8) }), null);
});
