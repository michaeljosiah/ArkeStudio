import assert from "node:assert/strict";
import { test } from "node:test";
import { applyTimelineCommands, buildFfmpegArgs, compileTrustedTimelineSteps, describeTimelineCommand, finishTrustedTimelineSteps, pictureMotionAt, pictureMotionProgress, pictureMotionWindow,
  pictureTransitionWeight, ProductionTimelineSchema, projectPictureTransitions, redoTimelineHistory, undoTimelineHistory,
  type ArtifactSidecar, type ExportPlan, type ProductionBundle, type ProductionTimeline, type RenderPictureLayer, type TimelineClipCommand, type TimelineCommand } from "../src/index.js";

const STILL_A = "ar_01J8E0000000000000000000A1", STILL_B = "ar_01J8E0000000000000000000A2", FILM = "ar_01J8E0000000000000000000A3";
const sources = { production: {} as ProductionBundle, artifacts: [{ id: STILL_A, kind: "image" }, { id: STILL_B, kind: "image" }, { id: FILM, kind: "video" }] as ArtifactSidecar[] };
const timeline = (): ProductionTimeline => ProductionTimelineSchema.parse({ schemaVersion: 1, revision: 0, frameRate: 24, tracks: [
  { id: "tr_picture", kind: "picture", name: "Picture", order: 0, muted: false, clips: [
    { id: "cl_a", startFrame: 0, durationFrames: 72, source: { kind: "artifact", artifactId: STILL_A, label: "A" } },
    { id: "cl_b", startFrame: 72, durationFrames: 72, source: { kind: "artifact", artifactId: STILL_B, label: "B" } },
    { id: "cl_film", startFrame: 168, durationFrames: 48, source: { kind: "artifact", artifactId: FILM, label: "Film" } },
  ] },
  { id: "tr_music", kind: "audio", name: "Music", order: 1, muted: false, clips: [{ id: "cl_song", startFrame: 0, durationFrames: 216, source: { kind: "artifact", artifactId: "ar_01J8E0000000000000000000A4", label: "Song" } }] },
], history: { undo: [], redo: [] } });
const apply = (base: ProductionTimeline, commands: TimelineClipCommand[]) => applyTimelineCommands(base, commands, { sources, effectAuthority: "human" });
const clip = (value: ProductionTimeline, id: string) => value.tracks.flatMap(track => track.clips).find(row => row.id === id)!;
const push = { kind: "push-in", amount: .08 } as const;

test("a still takes a move and gives it up; a film, a sound and a missing clip are refused", () => {
  const moved = apply(timeline(), [{ kind: "picture-motion", clipId: "cl_a", motion: push }]);
  assert.deepEqual(clip(moved, "cl_a").motion, push);
  assert.equal(clip(moved, "cl_b").motion, undefined);
  const saved = ProductionTimelineSchema.parse(JSON.parse(JSON.stringify(moved)));
  assert.equal(clip(undoTimelineHistory(saved), "cl_a").motion, undefined);
  assert.deepEqual(clip(redoTimelineHistory(undoTimelineHistory(saved)), "cl_a").motion, push);
  const still = apply(moved, [{ kind: "picture-motion", clipId: "cl_a", motion: null }]);
  assert.equal("motion" in clip(still, "cl_a"), false);
  assert.throws(() => apply(timeline(), [{ kind: "picture-motion", clipId: "cl_film", motion: push }]), /still image/);
  assert.throws(() => apply(timeline(), [{ kind: "picture-motion", clipId: "cl_song", motion: push }]), /picture clip/);
  assert.throws(() => apply(timeline(), [{ kind: "picture-fade", clipId: "cl_gone", inFrames: 12 }]), /picture clip/);
  assert.deepEqual([{ kind: "picture-motion", clipId: "cl_a", motion: push }, { kind: "picture-motion", clipId: "cl_a", motion: null }, { kind: "picture-fade", clipId: "cl_a", inFrames: 12 }]
    .map(command => describeTimelineCommand(command as TimelineCommand)), ["Set picture motion", "Remove picture motion", "Set picture fade"]);
});

test("a fade is patched one edge at a time, zero removes an edge, and the same value again is no edit", () => {
  let current = apply(timeline(), [{ kind: "picture-fade", clipId: "cl_film", inFrames: 12 }]);
  assert.deepEqual(clip(current, "cl_film").fade, { inFrames: 12 });
  current = apply(current, [{ kind: "picture-fade", clipId: "cl_film", outFrames: 24 }]);
  assert.deepEqual(clip(current, "cl_film").fade, { inFrames: 12, outFrames: 24 });
  current = apply(current, [{ kind: "picture-fade", clipId: "cl_film", inFrames: 0 }]);
  assert.deepEqual(clip(current, "cl_film").fade, { outFrames: 24 });
  const same = compileTrustedTimelineSteps(current, [{ id: "same", authority: "human", commands: [{ kind: "picture-fade", clipId: "cl_film", outFrames: 24 }] }], { sources });
  assert.equal(finishTrustedTimelineSteps(current, same).kind, "unchanged");
  current = apply(current, [{ kind: "picture-fade", clipId: "cl_film", outFrames: 0 }]);
  assert.equal("fade" in clip(current, "cl_film"), false);
});

test("a record with a move or a fade off the picture tracks is refused", () => {
  const raw = JSON.parse(JSON.stringify(timeline()));
  raw.tracks[1].clips[0].fade = { inFrames: 12 };
  assert.match(ProductionTimelineSchema.safeParse(raw).error!.issues.map(issue => issue.message).join(" "), /belong only to picture clips/);
  raw.tracks[1].clips[0] = { ...raw.tracks[1].clips[0], fade: undefined, motion: push };
  assert.equal(ProductionTimelineSchema.safeParse(raw).success, false);
  assert.equal(ProductionTimelineSchema.safeParse({ ...timeline(), tracks: [{ ...timeline().tracks[0]!, clips: [{ ...clip(timeline(), "cl_a"), fade: {} }] }] }).success, false, "a fade names an edge");
  assert.equal(ProductionTimelineSchema.safeParse({ ...timeline(), tracks: [{ ...timeline().tracks[0]!, clips: [{ ...clip(timeline(), "cl_a"), motion: { kind: "push-in", amount: .8 } }] }] }).success, false);
});

test("a split keeps the move on both halves and each fade at the edge it was made for", () => {
  const base = apply(timeline(), [{ kind: "picture-motion", clipId: "cl_a", motion: push }, { kind: "picture-fade", clipId: "cl_a", inFrames: 12, outFrames: 18 }]);
  const cut = apply(base, [{ kind: "split", clipId: "cl_a", atFrame: 30, newClipId: "cl_a2" }]);
  assert.deepEqual(clip(cut, "cl_a").fade, { inFrames: 12 }); assert.deepEqual(clip(cut, "cl_a2").fade, { outFrames: 18 });
  assert.deepEqual(clip(cut, "cl_a").motion, push); assert.deepEqual(clip(cut, "cl_a2").motion, push);
  assert.deepEqual(clip(undoTimelineHistory(cut), "cl_a").fade, { inFrames: 12, outFrames: 18 });
});

test("a push ends closer and stays centred; a drift holds its distance and crosses the picture the way it is named", () => {
  assert.deepEqual(pictureMotionAt(push, 0), { zoom: 1, x: .5, y: .5 });
  assert.deepEqual(pictureMotionAt(push, 1), { zoom: 1.08, x: .5, y: .5 });
  assert.deepEqual(pictureMotionAt({ kind: "pull-out", amount: .2 }, 0), { zoom: 1.2, x: .5, y: .5 });
  assert.equal(pictureMotionAt({ kind: "pull-out", amount: .2 }, 1).zoom, 1);
  // The picture moves left, so the window starts at its left edge and ends at its right.
  assert.deepEqual(pictureMotionWindow(pictureMotionAt({ kind: "drift-left", amount: .25 }, 0), 1000, 500), { x: 0, y: 50, width: 800, height: 400 });
  assert.deepEqual(pictureMotionWindow(pictureMotionAt({ kind: "drift-left", amount: .25 }, 1), 1000, 500), { x: 200, y: 50, width: 800, height: 400 });
  assert.equal(pictureMotionWindow(pictureMotionAt({ kind: "drift-right", amount: .25 }, 0), 1000, 500).x, 200);
  assert.equal(pictureMotionWindow(pictureMotionAt({ kind: "drift-up", amount: .25 }, 1), 1000, 500).y, 100);
  assert.equal(pictureMotionWindow(pictureMotionAt({ kind: "drift-down", amount: .25 }, 1), 1000, 500).y, 0);
  assert.equal(pictureMotionProgress({ startFrame: 48, endFrame: 96 }, 72), .5);
});

const layers = (value: ProductionTimeline): RenderPictureLayer[] => value.tracks[0]!.clips.map((row, order) => ({ clipId: row.id, trackId: "tr_picture", order, kind: "media", label: row.source.label,
  path: `${row.id}.png`, still: row.id !== "cl_film", startFrame: row.startFrame, endFrame: row.startFrame + row.durationFrames, sourceInSec: 0, sourceSize: { width: 1080, height: 1920 }, fit: "contain", matte: "source-alpha",
  ...(row.motion ? { motion: row.motion } : {}) }));

test("an open edge fades from and to what lies beneath; a crossfade keeps the edge it holds; a long fade stops at the clip", () => {
  const base = apply(timeline(), [
    { kind: "picture-fade", clipId: "cl_a", inFrames: 24, outFrames: 24 }, { kind: "picture-fade", clipId: "cl_b", inFrames: 24, outFrames: 12 }, { kind: "picture-fade", clipId: "cl_film", inFrames: 500 },
    { kind: "transition-set", trackId: "tr_picture", leftClipId: "cl_a", rightClipId: "cl_b", durationFrames: 24 },
  ]);
  const [a, b, film] = projectPictureTransitions(base, layers(base));
  assert.deepEqual(a!.fadeIn, { startFrame: 0, durationFrames: 24 });
  assert.deepEqual(a!.fadeOut, { startFrame: 60, durationFrames: 24 }, "the crossfade, not the clip's own fade out");
  assert.deepEqual(b!.fadeIn, { startFrame: 60, durationFrames: 24 });
  assert.deepEqual(b!.fadeOut, { startFrame: 132, durationFrames: 12 });
  assert.deepEqual(film!.fadeIn, { startFrame: 168, durationFrames: 48 });
  assert.equal(pictureTransitionWeight(a!, 0), 0); assert.equal(pictureTransitionWeight(a!, 12), .5); assert.equal(pictureTransitionWeight(a!, 30), 1);
  assert.equal(pictureTransitionWeight(b!, 138), .5); assert.equal(pictureTransitionWeight(film!, 192), .5);
});

test("the export moves a still with one read of its file, and counts short fades natively", () => {
  const base = apply(timeline(), [{ kind: "picture-motion", clipId: "cl_a", motion: { kind: "drift-left", amount: .1 } }, { kind: "picture-fade", clipId: "cl_a", inFrames: 24 }, { kind: "picture-fade", clipId: "cl_b", outFrames: 400 }]);
  const pictures = projectPictureTransitions(base, layers(base)).filter(layer => layer.still);
  const plan: ExportPlan = { preset: "vertical-master", frameRate: 24, items: [], overlays: [], audio: [], totalSec: 6,
    effectRender: { rendererVersion: "software-rgba-v2", width: 1080, height: 1920, frameRate: 24, startFrame: 0, endFrame: 144, effectLayers: [], issues: [], pictureLayers: pictures } };
  const args = buildFfmpegArgs(plan, "/world", "/film.mp4", "/font.ttf", []), graph = args[args.indexOf("-filter_complex") + 1]!;
  assert.equal(args.includes("-loop"), false, "a looped still is decoded again for every frame");
  assert.ok(graph.includes("zoompan=z='(1.1)+(0)*(on+0)/72':x='(iw-iw/zoom)*((0)+(1)*(on+0)/72)':y='(ih-ih/zoom)*((0.5)+(0)*(on+0)/72)':d=72:s=1080x1920:fps=24"), graph);
  assert.equal((graph.match(/zoompan/g) ?? []).length, 1, "only the still that moves is resampled");
  assert.ok(graph.includes("fade=t=in:start_frame=0:nb_frames=24:alpha=1"));
  assert.ok(graph.includes("fade=t=out:start_frame=0:nb_frames=72:alpha=1"), "counted from the picture's own first frame");
  assert.equal(graph.includes("geq="), false, "no picture is weighed pixel by pixel");
  const from = (startFrame: number) => {
    const windowed = buildFfmpegArgs({ ...plan, totalSec: (60 - startFrame) / 24, effectRender: { ...plan.effectRender!, startFrame, endFrame: 60 } }, "/world", "/film.mp4", "/font.ttf", []);
    return windowed[windowed.indexOf("-filter_complex") + 1]!;
  };
  // An export that opens inside the move starts it where the film is; inside the fade, the weight is spelled out by the film's frame.
  assert.ok(from(12).includes("(on+12)/72")); assert.match(from(12), /geq=[^;]*alpha\(X,Y\)\*[^;]*\(N\+12-0\)\/24/);
  assert.equal(/geq=|fade=/.test(from(36)), false, "a fade that is over costs nothing");
});
