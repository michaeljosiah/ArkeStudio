import assert from "node:assert/strict";
import { test } from "node:test";
import { CrossfadeSchema, applyTimelineCommands, compileTrustedTimelineSteps, finishTrustedTimelineSteps, ProductionTimelineSchema,
  undoTimelineHistory, redoTimelineHistory, maxCrossfadeFrames, crossfadeWindow, planCrossfadeBatch, transitionInactiveReason,
  transitionProtectionProblem, addWeightedPicture, compositeWeightedTrack, projectPictureTransitions, pictureStackAtFrame,
  pictureTransitionWeight, type ArtifactSidecar, type ProductionBundle, type ProductionTimeline, type TransitionCommand, type EffectRenderProjection } from "../src/index.js";

const pair = { trackId: "tr_picture", leftClipId: "cl_a", rightClipId: "cl_b" };
const artifact = (id: string) => ({ id, kind: "image" } as ArtifactSidecar);
const sources = { production: {} as ProductionBundle, artifacts: [artifact("ar_01J8E0000000000000000000A1"), artifact("ar_01J8E0000000000000000000A2"), artifact("ar_01J8E0000000000000000000A3")] };
const timeline = (middle = 72): ProductionTimeline => ProductionTimelineSchema.parse({ schemaVersion: 1, revision: 0, frameRate: 24,
  tracks: [{ id: "tr_picture", kind: "picture", name: "Picture", order: 0, muted: false, clips: [
    { id: "cl_a", startFrame: 0, durationFrames: 72, source: { kind: "artifact", artifactId: "ar_01J8E0000000000000000000A1", label: "A" } },
    { id: "cl_b", startFrame: 72, durationFrames: middle, source: { kind: "artifact", artifactId: "ar_01J8E0000000000000000000A2", label: "B" } },
    { id: "cl_c", startFrame: 72 + middle, durationFrames: 72, source: { kind: "artifact", artifactId: "ar_01J8E0000000000000000000A3", label: "C" } },
  ] }], history: { undo: [], redo: [] } });
const command = (durationFrames = 24): TransitionCommand => ({ kind: "transition-set", ...pair, durationFrames });
const apply = (base: ProductionTimeline, commands: TransitionCommand[], effectAuthority: "human" | "suggestion" = "human") => applyTimelineCommands(base, commands, { sources, effectAuthority });

test("crossfade add, protect, direct edit, release and remove preserve cuts and round-trip durable history", () => {
  const original = timeline();
  let current = apply(original, [command()]);
  current = apply(current, [{ kind: "transition-protect", ...pair, setting: "join" }, { kind: "transition-protect", ...pair, setting: "duration" }]);
  current = apply(current, [command(36)]);
  assert.deepEqual(current.tracks, original.tracks);
  assert.equal(current.transitions![0]!.protectDuration, true);
  assert.equal(current.transitions![0]!.durationFrames, 36);
  const restored = ProductionTimelineSchema.parse(JSON.parse(JSON.stringify(current)));
  assert.equal(undoTimelineHistory(restored).transitions![0]!.durationFrames, 24);
  assert.deepEqual(redoTimelineHistory(undoTimelineHistory(restored)).transitions, current.transitions);
  current = apply(current, [{ kind: "transition-release", ...pair, setting: "duration" }]);
  assert.equal(current.transitions![0]!.protectJoin, true);
  assert.equal(current.transitions![0]!.protectDuration, false);
  assert.equal(apply(current, [command(30)], "suggestion").transitions![0]!.durationFrames, 30);
  assert.throws(() => apply(current, [{ kind: "transition-remove", ...pair }], "suggestion"), /protected/);
  assert.equal(apply(current, [{ kind: "transition-remove", ...pair }]).transitions!.length, 0);
});

test("suggestions cannot release or overwrite duration; identical replacement has no history entry", () => {
  const base = apply(timeline(), [command(), { kind: "transition-protect", ...pair, setting: "duration" }]);
  assert.throws(() => apply(base, [command(36)], "suggestion"), /protected/);
  assert.throws(() => apply(base, [{ kind: "transition-release", ...pair, setting: "duration" }], "suggestion"), /human/);
  const reduced = compileTrustedTimelineSteps(base, [{ id: "same", authority: "human", commands: [command()] }], { sources });
  const result = finishTrustedTimelineSteps(base, reduced);
  assert.equal(result.kind, "unchanged"); assert.equal(result.timeline, base);
  const unprotected = apply(timeline(), [command()]);
  const rows = planCrossfadeBatch(unprotected, { durationFrames: 24, scope: "range", from: 72, to: 73, replace: true, short: "review", isStill: () => true });
  assert.equal(rows[0]!.reason, "Already this duration"); assert.equal(rows[0]!.command, undefined);
});

test("odd durations, exact local bounds and both short neighbors are explicit", () => {
  assert.deepEqual(crossfadeWindow(100, 25), { startFrame: 88, endFrame: 113 });
  const base = timeline(15);
  const rows = planCrossfadeBatch(base, { durationFrames: 24, scope: "all", replace: false, short: "review", isStill: () => true });
  assert.deepEqual(rows.map(row => [row.status, row.durationFrames, row.command]), [["shorten", 12, undefined], ["shorten", 12, undefined]]);
  const accepted = planCrossfadeBatch(base, { durationFrames: 24, scope: "all", replace: false, short: "accept", isStill: () => true });
  const next = apply(base, accepted.map(row => row.command!));
  assert.equal(next.history.undo.length, 1); assert.deepEqual(next.tracks, base.tracks);
  assert.equal(maxCrossfadeFrames(next.tracks, next.transitions!, pair), 18);
  assert.throws(() => apply(next, [command(20)]), /space/);
});

test("selection needs both clips; cut range is half-open; videos and gaps are skipped", () => {
  const base = timeline();
  const input = { durationFrames: 24, replace: false, short: "review" as const, isStill: () => true };
  assert.equal(planCrossfadeBatch(base, { ...input, scope: "selected", selectedClipIds: ["cl_b"] }).length, 0);
  assert.equal(planCrossfadeBatch(base, { ...input, scope: "selected", selectedClipIds: ["cl_a", "cl_b"] }).length, 1);
  assert.deepEqual(planCrossfadeBatch(base, { ...input, scope: "range", from: 72, to: 144 }).map(row => row.join.cutFrame), [72]);
  assert.ok(planCrossfadeBatch(base, { ...input, scope: "all", isStill: clip => clip.id !== "cl_b" }).every(row => row.status === "skip"));
  base.tracks[0]!.clips[1]!.startFrame++;
  assert.equal(planCrossfadeBatch(base, { ...input, scope: "all" })[0]!.reason, "Gap between images");
});

test("a broken pair stays named and inactive; protection cannot be bypassed by a model move", () => {
  const base = apply(timeline(), [command(), { kind: "transition-protect", ...pair, setting: "join" }]);
  const changed = structuredClone(base); changed.tracks[0]!.clips[0]!.durationFrames--;
  assert.equal(transitionInactiveReason(changed.tracks, changed.transitions!, changed.transitions![0]!), "Original images no longer touch");
  assert.match(transitionProtectionProblem(base, changed)!, /adjacent/);
  assert.deepEqual(changed.transitions, base.transitions);
  const replaced = structuredClone(base); replaced.tracks[0]!.clips[0]!.source = { ...replaced.tracks[0]!.clips[1]!.source };
  assert.equal(transitionInactiveReason(replaced.tracks, replaced.transitions!, replaced.transitions![0]!), "An original image source changed");
  assert.match(transitionProtectionProblem(base, replaced)!, /original images/);
  const batch = planCrossfadeBatch(replaced, { durationFrames: 36, scope: "all", replace: true, short: "accept", isStill: () => true });
  assert.equal(batch[0]!.status, "skip"); assert.match(batch[0]!.reason, /source changed/); assert.equal(batch[0]!.command, undefined);
});

test("crossfade projection extends only the still coverage and midpoint has no dark dip", () => {
  const base = apply(timeline(), [command()]);
  const pictures = base.tracks[0]!.clips.map((clip, order) => ({ clipId: clip.id, trackId: "tr_picture", order, kind: "media" as const, label: clip.source.label,
    path: `${clip.id}.png`, still: true, startFrame: clip.startFrame, endFrame: clip.startFrame + clip.durationFrames, sourceInSec: 0, fit: "contain" as const, matte: "source-alpha" as const }));
  const layers = projectPictureTransitions(base, pictures);
  assert.equal(layers[0]!.endFrame, 84); assert.equal(layers[1]!.startFrame, 60);
  const plan: EffectRenderProjection = { rendererVersion: "software-rgba-v1", width: 1, height: 1, frameRate: 24, startFrame: 0, endFrame: 216, pictureLayers: layers, effectLayers: [], issues: [] };
  assert.equal(pictureStackAtFrame(plan, 72).length, 2);
  const track = new Float32Array(4), output = new Uint8ClampedArray([0, 0, 0, 255]);
  addWeightedPicture(track, new Uint8ClampedArray([255, 0, 0, 255]), pictureTransitionWeight(layers[0]!, 72), { x: 0, y: 0, width: 1, height: 1 }, 1);
  addWeightedPicture(track, new Uint8ClampedArray([0, 0, 255, 255]), pictureTransitionWeight(layers[1]!, 72), { x: 0, y: 0, width: 1, height: 1 }, 1);
  compositeWeightedTrack(output, track); assert.deepEqual([...output], [128, 0, 128, 255]);
  assert.equal(CrossfadeSchema.safeParse({ ...base.transitions![0], durationFrames: 1 }).success, false);
});
