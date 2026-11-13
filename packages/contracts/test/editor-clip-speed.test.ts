import assert from "node:assert/strict";
import { test } from "node:test";
import { applyTimelineCommands, buildFfmpegArgs, clipSourceInSec, compileTrustedTimelineSteps, describeTimelineCommand, detachAudioCommands, finishTrustedTimelineSteps,
  ModelEditorRequestSchema, pictureSourceSec, ProductionTimelineSchema, redoTimelineHistory, retimedSourceFrames, textLookForNewClip, TIMELINE_EDITOR_COMMAND_GUIDE, timelineUsesCompositor, undoTimelineHistory,
  type ArtifactSidecar, type ExportPlan, type ProductionBundle, type ProductionTimeline, type RenderPictureLayer, type TimelineClip, type TimelineClipCommand, type TimelineCommand } from "../src/index.js";

const STILL = "ar_01J8E0000000000000000000A1", FILM = "ar_01J8E0000000000000000000A3", SONG = "ar_01J8E0000000000000000000A4";
const sources = { production: { meta: { id: "p" } } as ProductionBundle, artifacts: [{ id: STILL, kind: "image" }, { id: FILM, kind: "video", mediaInfo: { hasAudio: true, durationSec: 5 } }] as ArtifactSidecar[] };
// The film is 120 frames of source at 24 fps. `cl_film` plays frames 24 to 72 of it, with room after it; `cl_tight` has a neighbour 12 frames on.
const bare = (): ProductionTimeline => ProductionTimelineSchema.parse({ schemaVersion: 1, revision: 0, frameRate: 24, tracks: [
  { id: "tr_picture", kind: "picture", name: "Picture", order: 0, muted: false, clips: [
    { id: "cl_still", startFrame: 0, durationFrames: 48, source: { kind: "artifact", artifactId: STILL, label: "Still" } },
    { id: "cl_tight", startFrame: 48, durationFrames: 48, source: { kind: "artifact", artifactId: FILM, label: "Tight" } },
    { id: "cl_film", startFrame: 108, durationFrames: 48, sourceInFrames: 24, source: { kind: "artifact", artifactId: FILM, label: "Film" } },
  ] },
  { id: "tr_music", kind: "audio", name: "Music", order: 1, muted: false, clips: [{ id: "cl_song", startFrame: 0, durationFrames: 216, source: { kind: "artifact", artifactId: SONG, label: "Song" } }] },
], history: { undo: [], redo: [] } });
/** The same with a title after the film, placed as the Cut places one. */
const timeline = (): ProductionTimeline => applyTimelineCommands(bare(), [{ kind: "place", trackId: "tr_picture", clip: { id: "cl_title", startFrame: 400, durationFrames: 48, sourceInFrames: 0,
  source: { kind: "text", text: "Title", label: "Title", look: textLookForNewClip(bare()) } } }], { effectAuthority: "human" });
const sourceLength = (clip: TimelineClip) => clip.source.kind === "artifact" && clip.source.artifactId === FILM ? retimedSourceFrames(120, clip.speed ?? 1) : undefined;
const apply = (base: ProductionTimeline, commands: TimelineClipCommand[]) => applyTimelineCommands(base, commands, { sources, sourceLength, effectAuthority: "human" });
const clip = (value: ProductionTimeline, id: string) => value.tracks.flatMap(track => track.clips).find(row => row.id === id)!;
const window = (value: TimelineClip) => [value.startFrame, value.durationFrames, value.sourceInFrames, value.speed, value.reverse];
/** The source frame each timeline frame of a clip shows, as the Viewer and the export both read it. */
const shown = (value: TimelineClip) => Array.from({ length: value.durationFrames }, (_, index) => {
  const layer = { startFrame: value.startFrame, endFrame: value.startFrame + value.durationFrames, sourceInSec: clipSourceInSec(value, 24),
    ...(value.speed === undefined ? {} : { speed: value.speed }), ...(value.reverse ? { reverse: true as const } : {}) };
  return Math.floor(pictureSourceSec(layer, value.startFrame + index, 24) * 24 + 1e-6);
});

test("a film at another speed plays the same stretch of source in more or less time, and keeps its start", () => {
  const fast = apply(timeline(), [{ kind: "set-clip-speed", clipId: "cl_film", speed: 2 }]);
  // Source frames 24 to 72 are frames 12 to 36 of the film at twice its speed.
  assert.deepEqual(window(clip(fast, "cl_film")), [108, 24, 12, 2, undefined]);
  assert.deepEqual([shown(clip(fast, "cl_film"))[0], shown(clip(fast, "cl_film")).at(-1)], [24, 70]);
  const slow = apply(timeline(), [{ kind: "set-clip-speed", clipId: "cl_film", speed: .5 }]);
  assert.deepEqual(window(clip(slow, "cl_film")), [108, 96, 48, .5, undefined]);
  assert.deepEqual([shown(clip(slow, "cl_film"))[0], shown(clip(slow, "cl_film"))[1], shown(clip(slow, "cl_film")).at(-1)], [24, 24, 71], "each source frame is held for two");
  const back = apply(slow, [{ kind: "set-clip-speed", clipId: "cl_film", speed: 1 }]);
  assert.deepEqual(window(clip(back, "cl_film")), [108, 48, 24, undefined, undefined]);
  assert.equal("speed" in clip(back, "cl_film"), false, "its own speed is not written");
  const saved = ProductionTimelineSchema.parse(JSON.parse(JSON.stringify(fast)));
  assert.deepEqual(window(clip(undoTimelineHistory(saved), "cl_film")), [108, 48, 24, undefined, undefined]);
  assert.deepEqual(window(clip(redoTimelineHistory(undoTimelineHistory(saved)), "cl_film")), [108, 24, 12, 2, undefined]);
  assert.deepEqual([{ kind: "set-clip-speed", clipId: "cl_film", speed: 1.25 }, { kind: "set-clip-reverse", clipId: "cl_film", reverse: true }, { kind: "set-clip-reverse", clipId: "cl_film", reverse: false }]
    .map(command => describeTimelineCommand(command as TimelineCommand)), ["Set speed to 1.25x", "Play backwards", "Play forwards"]);
});

test("a slowed film grows no further than the next clip or its source, and never moves another clip", () => {
  const slow = apply(timeline(), [{ kind: "set-clip-speed", clipId: "cl_tight", speed: .5 }]);
  // It wants 96 frames and there are 60 before the film after it: it keeps what plays first.
  assert.deepEqual(window(clip(slow, "cl_tight")), [48, 60, 0, .5, undefined]);
  assert.deepEqual(window(clip(slow, "cl_film")), [108, 48, 24, undefined, undefined]);
  // Backwards, what plays first is the window's end, so the frames given up are at its start.
  const reversed = apply(timeline(), [{ kind: "set-clip-reverse", clipId: "cl_tight", reverse: true }, { kind: "set-clip-speed", clipId: "cl_tight", speed: .5 }]);
  assert.deepEqual(window(clip(reversed, "cl_tight")), [48, 60, 36, .5, true]);
  assert.equal(shown(clip(reversed, "cl_tight"))[0], 47, "it still opens on the frame it opened on");
  // The trim that brings the rest back stops where the source does: 120 frames are 240 at half speed.
  const moved = apply(slow, [{ kind: "move-to-frame", clipId: "cl_film", startFrame: 600 }]);
  assert.equal(clip(apply(moved, [{ kind: "trim", clipId: "cl_tight", edge: "end", deltaFrames: 180 }]), "cl_tight").durationFrames, 240);
  assert.throws(() => apply(moved, [{ kind: "trim", clipId: "cl_tight", edge: "end", deltaFrames: 181 }]), /has only 240 source frames/);
  // A third of a frame over the source's end is still a frame of it: 120 / 1.3 is 92.3, so 93.
  assert.equal(retimedSourceFrames(120, 1.3), 93); assert.equal(retimedSourceFrames(120, 2), 60); assert.equal(retimedSourceFrames(120, .25), 480);
});

test("a still, a title, a sound and a clip that is not there are refused; the same value again is no edit", () => {
  assert.throws(() => apply(timeline(), [{ kind: "set-clip-speed", clipId: "cl_still", speed: 2 }]), /need a video/);
  assert.throws(() => apply(timeline(), [{ kind: "set-clip-reverse", clipId: "cl_still", reverse: true }]), /need a video/);
  assert.throws(() => apply(timeline(), [{ kind: "set-clip-speed", clipId: "cl_title", speed: 2 }]), /Text has no speed/);
  assert.throws(() => apply(timeline(), [{ kind: "set-clip-reverse", clipId: "cl_song", reverse: true }]), /Picture track/);
  assert.throws(() => apply(timeline(), [{ kind: "set-clip-speed", clipId: "cl_gone", speed: 2 }]), /exactly one clip/);
  for (const command of [{ kind: "set-clip-speed", clipId: "cl_film", speed: 1 }, { kind: "set-clip-reverse", clipId: "cl_film", reverse: false }] as TimelineClipCommand[]) {
    const same = compileTrustedTimelineSteps(timeline(), [{ id: "same", authority: "human", commands: [command] }], { sources, sourceLength });
    assert.equal(finishTrustedTimelineSteps(timeline(), same).kind, "unchanged");
  }
});

test("a record holds a speed in hundredths within its range, on a video on a Picture track and nowhere else", () => {
  const withClip = (track: number, index: number, extra: object) => {
    const raw = JSON.parse(JSON.stringify(timeline()));
    raw.tracks[track].clips[index] = { ...raw.tracks[track].clips[index], ...extra };
    return ProductionTimelineSchema.safeParse(raw);
  };
  assert.equal(withClip(0, 2, { speed: 1.05, reverse: true }).success, true);
  assert.equal(withClip(0, 2, { speed: 1.055 }).success, false, "a speed is given in hundredths");
  assert.equal(withClip(0, 2, { speed: .2 }).success, false); assert.equal(withClip(0, 2, { speed: 4.01 }).success, false);
  assert.equal(withClip(0, 2, { reverse: false }).success, false, "forwards is not written");
  assert.match(withClip(1, 0, { speed: 2 }).error!.issues.map(issue => issue.message).join(" "), /Picture track/);
  assert.match(withClip(0, 3, { reverse: true }).error!.issues.map(issue => issue.message).join(" "), /Text has no speed/);
  // A clip placed with a speed lands as one, and is refused where a command would be.
  const placed = apply(timeline(), [{ kind: "place", trackId: "tr_picture", clip: { id: "cl_new", startFrame: 200, durationFrames: 30, sourceInFrames: 0, speed: 2, reverse: true, source: { kind: "artifact", artifactId: FILM, label: "New" } } }]);
  assert.deepEqual(window(clip(placed, "cl_new")), [200, 30, 0, 2, true]);
  assert.throws(() => apply(timeline(), [{ kind: "place", trackId: "tr_music", clip: { id: "cl_new", startFrame: 300, durationFrames: 30, sourceInFrames: 0, speed: 2, source: { kind: "artifact", artifactId: SONG, label: "New" } } }]), /Picture track/);
});

test("a reversed film shows the frames it showed forwards, last first, and Reverse again restores it", () => {
  const forwards = shown(clip(timeline(), "cl_film"));
  const reversed = apply(timeline(), [{ kind: "set-clip-reverse", clipId: "cl_film", reverse: true }]);
  assert.deepEqual(window(clip(reversed, "cl_film")), [108, 48, 24, undefined, true], "its window does not move");
  assert.deepEqual(shown(clip(reversed, "cl_film")), [...forwards].reverse());
  assert.equal(shown(clip(reversed, "cl_film")).at(-1), 24, "it ends on the frame it began on");
  const again = apply(reversed, [{ kind: "set-clip-reverse", clipId: "cl_film", reverse: false }]);
  assert.equal("reverse" in clip(again, "cl_film"), false);
  assert.deepEqual(shown(clip(again, "cl_film")), forwards);
  // At another speed too: the same samples, the other way.
  const both = apply(reversed, [{ kind: "set-clip-speed", clipId: "cl_film", speed: 1.25 }]);
  const one = apply(timeline(), [{ kind: "set-clip-speed", clipId: "cl_film", speed: 1.25 }]);
  assert.deepEqual(shown(clip(both, "cl_film")), [...shown(clip(one, "cl_film"))].reverse());
});

test("a split of a reversed or re-timed film changes no frame, and a duplicate carries both", () => {
  for (const setup of [[{ kind: "set-clip-reverse", clipId: "cl_film", reverse: true }], [{ kind: "set-clip-speed", clipId: "cl_film", speed: 1.3 }],
    [{ kind: "set-clip-reverse", clipId: "cl_film", reverse: true }, { kind: "set-clip-speed", clipId: "cl_film", speed: .75 }]] as TimelineClipCommand[][]) {
    const base = apply(timeline(), setup), whole = clip(base, "cl_film"), at = whole.startFrame + 17;
    const cut = apply(base, [{ kind: "split", clipId: "cl_film", atFrame: at, newClipId: "cl_film2" }]);
    assert.deepEqual([...shown(clip(cut, "cl_film")), ...shown(clip(cut, "cl_film2"))], shown(whole), JSON.stringify(setup));
    assert.deepEqual([clip(cut, "cl_film2").speed, clip(cut, "cl_film2").reverse], [whole.speed, whole.reverse]);
    assert.deepEqual(window(clip(undoTimelineHistory(cut), "cl_film")), window(whole));
    const copy = clip(apply(base, [{ kind: "duplicate", clipId: "cl_film", newClipId: "cl_copy" }]), "cl_copy");
    assert.deepEqual(shown(copy), shown(whole));
  }
});

test("a reversed film's head trims the end of its source and its tail the start", () => {
  const base = apply(timeline(), [{ kind: "set-clip-reverse", clipId: "cl_film", reverse: true }]), whole = shown(clip(base, "cl_film"));
  const head = clip(apply(base, [{ kind: "trim", clipId: "cl_film", edge: "start", deltaFrames: 10 }]), "cl_film");
  assert.deepEqual(window(head), [118, 38, 24, undefined, true]);
  assert.deepEqual(shown(head), whole.slice(10), "the frames left are the frames it showed there");
  const tail = clip(apply(base, [{ kind: "trim", clipId: "cl_film", edge: "end", deltaFrames: -10 }]), "cl_film");
  assert.deepEqual(window(tail), [108, 38, 34, undefined, true]);
  assert.deepEqual(shown(tail), whole.slice(0, 38));
  // Its tail grows back into the source before the window, and no further than the source's first frame.
  assert.equal(clip(apply(base, [{ kind: "trim", clipId: "cl_film", edge: "end", deltaFrames: 24 }]), "cl_film").sourceInFrames, 0);
  assert.throws(() => apply(base, [{ kind: "trim", clipId: "cl_film", edge: "end", deltaFrames: 25 }]), /no source before its first frame/);
  // Its head grows into the source after the window: 120 frames, of which the window ends at 72.
  const moved = apply(base, [{ kind: "move-to-frame", clipId: "cl_film", startFrame: 700 }]);
  assert.equal(clip(apply(moved, [{ kind: "trim", clipId: "cl_film", edge: "start", deltaFrames: -48 }]), "cl_film").durationFrames, 96);
  assert.throws(() => apply(moved, [{ kind: "trim", clipId: "cl_film", edge: "start", deltaFrames: -49 }]), /has only 96 source frames/);
});

test("a film at another speed or backwards is drawn by the compositor, and has no sound to detach", () => {
  assert.equal(timelineUsesCompositor(timeline()), true, "the title already asks for it");
  const plain = bare();
  assert.equal(timelineUsesCompositor(plain), false);
  assert.equal(timelineUsesCompositor(apply(plain, [{ kind: "set-clip-speed", clipId: "cl_film", speed: 1.05 }])), true);
  const reversed = apply(plain, [{ kind: "set-clip-reverse", clipId: "cl_film", reverse: true }]);
  assert.equal(timelineUsesCompositor(reversed), true);
  assert.throws(() => detachAudioCommands(sources.production, reversed, sources.artifacts, "cl_film", "cl_sound"), /plays no sound to detach/);
});

test("Arke may set a speed and a direction, and its guide says what each does", () => {
  assert.equal(ModelEditorRequestSchema.safeParse({ summary: "Slow the film", commands: [{ kind: "set-clip-speed", clipId: "cl_film", speed: .8 }, { kind: "set-clip-reverse", clipId: "cl_film", reverse: true }] }).success, true);
  assert.equal(ModelEditorRequestSchema.safeParse({ summary: "Too fast", commands: [{ kind: "set-clip-speed", clipId: "cl_film", speed: 8 }] }).success, false);
  assert.match(TIMELINE_EDITOR_COMMAND_GUIDE, /set-clip-speed \(clipId, speed\)/); assert.match(TIMELINE_EDITOR_COMMAND_GUIDE, /set-clip-reverse \(clipId, reverse\)/);
  assert.match(TIMELINE_EDITOR_COMMAND_GUIDE, /0\.25 to 4 in hundredths/); assert.match(TIMELINE_EDITOR_COMMAND_GUIDE, /plays no sound of its own/);
});

const layer = (over: Partial<RenderPictureLayer>): RenderPictureLayer => ({ clipId: "cl_film", trackId: "tr_picture", order: 0, kind: "media", label: "Film", path: "artifacts/film.mp4", still: false,
  startFrame: 24, endFrame: 72, sourceInSec: 1, sourceOutSec: 5, sourceSize: { width: 1080, height: 1920 }, fit: "contain", matte: "source-alpha", ...over });
const graphOf = (pictureLayers: RenderPictureLayer[], startFrame = 0, endFrame = 96) => {
  const plan: ExportPlan = { preset: "vertical-master", frameRate: 24, items: [], overlays: [], audio: [], totalSec: (endFrame - startFrame) / 24,
    effectRender: { rendererVersion: "software-rgba-v2", width: 1080, height: 1920, frameRate: 24, startFrame, endFrame, effectLayers: [], issues: [], pictureLayers } };
  const args = buildFfmpegArgs(plan, "/world", "/film.mp4", "/font.ttf", []);
  return args[args.indexOf("-filter_complex") + 1]!;
};

test("the export reads a film at its own speed exactly as it did, and re-times or turns round only the film that asks", () => {
  assert.ok(graphOf([layer({})]).includes("format=gbrap,scale=1080:1920:flags=bilinear,setsar=1,setpts=PTS-STARTPTS-1/TB,fps=fps=24:round=up:start_time=0,tpad=stop_mode=clone:stop_duration=2,trim=end_frame=48,settb=expr=1/24,setpts=N+24[ep0]"));
  // At 1.25x the stamps are divided in microseconds, with the Viewer's own tolerance for a frame that starts on the sample.
  const fast = graphOf([layer({ speed: 1.25 })]);
  assert.ok(fast.includes("format=gbrap,scale=1080:1920:flags=bilinear,setsar=1,settb=expr=1/1000000,setpts=(PTS-STARTPTS-1.0001/TB)/1.25,tpad=stop_mode=clone:stop_duration=3,fps=fps=24:round=up:start_time=0,tpad=stop_mode=clone:stop_duration=2,trim=end_frame=48,settb=expr=1/24,setpts=N+24[ep0]"), fast);
  assert.equal(fast.includes("reverse"), false);
  // Backwards: the same 48 frames read forwards from the window's start, then turned round before they are scaled.
  const back = graphOf([layer({ reverse: true })]);
  assert.ok(back.includes("[1:v]settb=expr=1/1000000,setpts=(PTS-STARTPTS-1.0001/TB)/1,tpad=stop_mode=clone:stop_duration=3,fps=fps=24:round=up:start_time=0,tpad=stop_mode=clone:stop_duration=2,trim=end_frame=48,reverse,format=gbrap,scale=1080:1920:flags=bilinear,setsar=1,settb=expr=1/24,setpts=N+24[ep0]"), back);
});

test("an export that opens or closes inside a reversed film reads the frames that part of it shows", () => {
  // The film's last 12 frames on screen are its first 12 of source: an export from frame 60 reads from the window's start.
  assert.ok(graphOf([layer({ reverse: true })], 60, 96).includes("setpts=(PTS-STARTPTS-1.0001/TB)/1,tpad=stop_mode=clone:stop_duration=1.5,fps=fps=24:round=up:start_time=0,tpad=stop_mode=clone:stop_duration=0.5,trim=end_frame=12,reverse,"));
  // Its first 12 on screen are its last 12 of source, which begin 36 frames into the window.
  assert.ok(graphOf([layer({ reverse: true })], 0, 36).includes("setpts=(PTS-STARTPTS-2.5001/TB)/1,tpad=stop_mode=clone:stop_duration=1.5,fps=fps=24:round=up:start_time=0,tpad=stop_mode=clone:stop_duration=0.5,trim=end_frame=12,reverse,"));
  // Forwards at half speed, opening 12 frames in: six frames of source on.
  assert.ok(graphOf([layer({ speed: .5 })], 36, 96).includes("setpts=(PTS-STARTPTS-1.2501/TB)/0.5,"));
  assert.equal(pictureSourceSec(layer({ speed: .5 }), 36, 24), 1.25);
  assert.equal(pictureSourceSec(layer({ reverse: true }), 24, 24), 1 + 47 / 24);
  assert.equal(pictureSourceSec(layer({ reverse: true, speed: 2 }), 71, 24), 1);
});
