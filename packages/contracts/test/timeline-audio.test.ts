import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_MIX,
  EffectAudioContributionSchema,
  ModelEditorRequestSchema,
  ProductionTimelineSchema,
  TIMELINE_EDITOR_COMMAND_GUIDE,
  TimelineOperationRefused,
  applyTimelineCommands,
  audibleTracks,
  audioAtSec,
  audioGainDbAt,
  audioLevelAt,
  buildExportPlan,
  buildFfmpegArgs,
  buildRenderPlan,
  describeTimelineCommand,
  duckingEnvelope,
  detachAudioCommands,
  effectiveAudioRole,
  migrateLegacyCut,
  playsWholeAudioSource,
  redoTimelineHistory,
  resolvePictureTimeline,
  seedStoryPictureTimeline,
  soundFadeAt,
  soundFadeWindows,
  sourceLengthFramesFor,
  SOUND_GATE,
  SoundGateSchema,
  soundGateAt,
  soundGateFromLevels,
  trackEndFrame,
  trackedGainDb,
  undoTimelineHistory,
  windowPlan,
  type ProductionBundle,
  type ProductionTimeline,
  type RenderArtifact,
  type RenderPlan,
  type Scene,
  type TimelineClip,
  type TimelineClipCommand,
} from "../src/index.js";

/**
 * Dialogue, Ambience and Music with speech-first mixing (SPEC-038 R-12..R-20, SPEC-037 R-30,
 * R-31; issue #681), plus the round-one review fixes on the Picture algebra: a deleted last
 * clip leaves its hole, a tail trim stops where the source does, and a hole is black through
 * the legacy builder as well.
 */

const AT = "2026-09-01T12:00:00Z";
const TAKE = "tk_01J8E0000000000000000000T1";
const VOICE = "tk_01J8E0000000000000000000V1";
const BELLS = "ar_01J8G0000000000000000000A3";
const SONG = "ar_01J8G0000000000000000000A6";
const INSERT = "ar_01J8G0000000000000000000A2";
const PLATE = "ar_01J8G0000000000000000000A1";

const artifacts: RenderArtifact[] = [
  { id: PLATE, file: "plate.png", kind: "image" },
  { id: INSERT, file: "insert.mp4", kind: "video", mediaInfo: { hasAudio: true, durationSec: 9 } },
  { id: BELLS, file: "bells.wav", kind: "audio", mediaInfo: { hasAudio: true, durationSec: 20 } },
  { id: SONG, file: "song.mp3", kind: "audio", mediaInfo: { hasAudio: true, durationSec: 180 } },
];

function scene(id: string, order: number, shots: Array<{ id: string; durationSec?: number }>): Scene {
  return {
    id,
    number: order,
    order,
    slug: id.replace(/^sc_/, ""),
    title: id,
    status: "accepted",
    version: 1,
    shots: shots.map((shot, index) => ({
      id: shot.id,
      number: index + 1,
      title: shot.id,
      description: `Story beat ${shot.id}`,
      ...(shot.durationSec === undefined ? {} : { durationSec: shot.durationSec }),
    })),
  };
}

function production(over: Partial<ProductionBundle> = {}): ProductionBundle {
  return {
    rehearsals: [], performances: [], performanceReview: { reviews: [], selections: {}, reviewHash: null, selectionHash: null },
    meta: {
      id: "bell-watch",
      format: "video",
      title: "Bell Watch",
      status: "in-progress",
      frameRate: 25,
      failureModes: [],
      created: AT,
      updated: AT,
    },
    story: null,
    season: null,
    routing: null,
    treatment: null,
    chapters: [],
    scenes: [
      scene("sc_one", 1, [
        { id: "sh_1", durationSec: 2 },
        { id: "sh_2", durationSec: 1.5 },
        { id: "sh_3" },
      ]),
    ],
    sceneFiles: {},
    episodes: [],
    episodeFiles: {},
    takes: [
      {
        id: TAKE,
        jobId: "jb_01J8E0000000000000000000J1",
        coversShots: ["sh_1"],
        kind: "clip",
        provider: "fal",
        model: "seedance-2.0",
        provenance: { canonRevision: 1, sheets: {} },
        prompt: "a shot",
        references: [],
        params: {},
        cost: { estimatedMicroUsd: 1000, actualMicroUsd: null },
        dispatchedAt: AT,
        media: "clip.mp4",
      },
      {
        id: VOICE,
        jobId: "jb_01J8E0000000000000000000J2",
        coversShots: ["sh_2"],
        kind: "voice",
        provider: "elevenlabs",
        model: "eleven_v3",
        provenance: { canonRevision: 1, sheets: { "maren-kest": 4 } },
        references: [],
        params: {},
        cost: { estimatedMicroUsd: 1000, actualMicroUsd: null },
        dispatchedAt: AT,
        media: "line.mp3",
      },
    ],
    reviews: [],
    selections: { sh_1: { acceptedTakeId: TAKE, trimInSec: 0 } },
    spine: null,
    cut: { audio: [], overlays: [] },
    editorRequests: [],
    takeMediaInfo: {
      [TAKE]: { sourceHash: `sha256:${"a".repeat(64)}`, mediaInfo: { durationSec: 3, hasAudio: true }, probedAt: AT },
      [VOICE]: { sourceHash: `sha256:${"b".repeat(64)}`, mediaInfo: { durationSec: 2, hasAudio: true }, probedAt: AT },
    },
    ...over,
  };
}

function valid(timeline: ProductionTimeline): ProductionTimeline {
  const parsed = ProductionTimelineSchema.safeParse(timeline);
  assert.equal(parsed.success, true, parsed.success ? "" : JSON.stringify(parsed.error.issues));
  return timeline;
}

describe("independent sound and roles (SPEC-043)", () => {
  it("records neutral roles on new legacy-lane placements while preserving pre-existing roles", () => {
    for (const kind of ["dialogue", "music", "ambience"] as const) {
      const timeline = applyTimelineCommands(seedStoryPictureTimeline(production()), [{ kind: "add-track", trackId: "tr_old", trackKind: kind, name: "Old" }]);
      timeline.tracks[1]!.clips = [audioClip("cl_old", SONG, "old.mp3", 0, 25)];
      timeline.history = { undo: [], redo: [] }; // A pre-existing saved mix, before command history.
      let next = applyTimelineCommands(timeline, [{ kind: "place", trackId: "tr_old", clip: audioClip("cl_new", SONG, "new.mp3", 25, 25) }]);
      next = ProductionTimelineSchema.parse(JSON.parse(JSON.stringify(next)));
      assert.equal(next.tracks[1]!.clips[0]!.role, undefined);
      assert.deepEqual(next.tracks[1]!.clips.map(clip => effectiveAudioRole(next.tracks[1]!, clip)), [kind, "unspecified"]);
      assert.deepEqual(undoTimelineHistory(next).tracks, timeline.tracks);
    }
  });

  it("recognises whole audio rounded onto the frame clock but refuses trimmed and unknown sources", () => {
    const heard = { sourceInSec: 0, startSec: 5, endSec: 5 + 25 / 24 };
    assert.equal(playsWholeAudioSource(heard, 1.03, 24), true, "rounding up still covers all source audio");
    assert.equal(playsWholeAudioSource(heard, 1.05, 24), true, "rounding down to the nearest frame is also a full placement");
    assert.equal(playsWholeAudioSource({ ...heard, endSec: 6 }, 1.03, 24), false, "one frame trimmed off the tail requires a window");
    assert.equal(playsWholeAudioSource({ ...heard, sourceInSec: 1 / 24 }, 1.03, 24), false);
    assert.equal(playsWholeAudioSource(heard, null, 24), false);
    assert.equal(playsWholeAudioSource({ ...heard, endSec: 8 }, 1.03, 24), true, "a padded clip contains the whole source");
  });

  it("detaches into free legacy tracks using only their explicit future default", () => {
    for (const kind of ["dialogue", "ambience", "music"] as const) {
      for (const defaultRole of [undefined, "music"] as const) {
        const p = production();
        const timeline = applyTimelineCommands(seedStoryPictureTimeline(p), [{ kind: "add-track", trackId: "tr_legacy", trackKind: kind, name: "Existing", defaultRole }]);
        const command = { kind: "detach-audio", clipId: timeline.tracks[0]!.clips[0]!.id, newClipId: "cl_detached" } as const;
        assert.throws(() => applyTimelineCommands(timeline, [command]), /current production sources/);
        const detached = valid(applyTimelineCommands(timeline, [command], { sources: { production: p, artifacts: [] } }));
        assert.equal(detached.tracks.length, 2, "reuse the available lane");
        assert.equal(detached.tracks[1]!.clips[0]!.role, defaultRole ?? "unspecified");
        assert.equal(detached.history.undo.length, timeline.history.undo.length + 1);
        assert.deepEqual(undoTimelineHistory(detached).tracks, timeline.tracks);
      }
    }
  });
  it("freezes the heard pass segment and selection trim when detaching a generated shot", () => {
    const p = production();
    const pass = p.takes[0]!;
    p.takes.push({ ...pass, id: "tk_01J8E0000000000000000000S1", media: undefined, segment: { passTakeId: pass.id, inSec: 1, outSec: 3 } });
    p.selections.sh_1 = { acceptedTakeId: "tk_01J8E0000000000000000000S1", trimInSec: .213 };
    let timeline = seedStoryPictureTimeline(p);
    const id = timeline.tracks[0]!.clips[0]!.id;
    timeline = applyTimelineCommands(timeline, [{ kind: "trim", clipId: id, edge: "end", deltaFrames: -10 }, { kind: "trim", clipId: id, edge: "start", deltaFrames: 5 }]);
    const commands = detachAudioCommands(p, timeline, [], id, "cl_detached");
    timeline = valid(applyTimelineCommands(timeline, commands));
    const sound = timeline.tracks.find(track => track.kind === "audio")!.clips[0]!;
    assert.deepEqual(sound.source, { kind: "take", takeId: "tk_01J8E0000000000000000000S1", label: timeline.tracks[0]!.clips[0]!.source.label, offsetSec: .213 });
    assert.equal(sound.sourceInFrames, 5, "frame edits remain separate from the exact selection trim");
    assert.throws(() => applyTimelineCommands(timeline, [{ kind: "trim", clipId: sound.id, edge: "end", deltaFrames: 100 }],
      { sourceLength: sourceLengthFramesFor(p, []) }), /source/);
    const render = () => buildRenderPlan({ production: p, artifacts, timeline: { status: "ready", timeline }, scope: { kind: "production" }, preset: "review-cut" });
    let plan = render(); assert.ok(plan.ok);
    assert.equal(plan.plan.audio.find(item => item.clipId === "cl_detached")!.sourceInSec, 1.413);
    p.selections.sh_1 = { acceptedTakeId: TAKE, trimInSec: 0 };
    plan = render(); assert.ok(plan.ok);
    assert.equal(plan.plan.audio.find(item => item.clipId === "cl_detached")!.sourceInSec, 1.413, "later selection changes do not replace detached sound");
    assert.throws(() => detachAudioCommands(p, timeline, [], id, "cl_twice"), /already muted/);
    const before = undoTimelineHistory(timeline);
    p.takeMediaInfo[TAKE]!.mediaInfo.hasAudio = false;
    assert.throws(() => detachAudioCommands(p, before, [], id, "cl_silent"), /no audio stream/);
    delete p.takeMediaInfo[TAKE];
    assert.throws(() => detachAudioCommands(p, before, [], id, "cl_unknown"), /Measure/);
  });

  it("extracts to a new neutral track atomically even when a free track exists (#908)", () => {
    const p = production();
    const timeline = applyTimelineCommands(seedStoryPictureTimeline(p), [
      { kind: "add-track", trackId: "tr_existing", trackKind: "audio", name: "Music", defaultRole: "music" },
    ]);
    const extracted = valid(applyTimelineCommands(timeline, [
      { kind: "detach-audio", clipId: "cl_sh-1", newClipId: "cl_extracted", newTrack: true },
    ], { sources: { production: p, artifacts: [] } }));
    assert.deepEqual(extracted.tracks[1], timeline.tracks[1], "the existing free track is untouched");
    assert.equal(extracted.tracks[0]!.clips[0]!.audio, "mute");
    assert.equal(extracted.tracks[2]!.kind, "audio");
    assert.equal(extracted.tracks[2]!.clips[0]!.role, "unspecified");
    assert.equal(extracted.history.undo.length, timeline.history.undo.length + 1);
    const undone = undoTimelineHistory(extracted);
    assert.deepEqual(undone.tracks, timeline.tracks);
    assert.deepEqual(redoTimelineHistory(undone).tracks, extracted.tracks);
  });

  it("keeps detached sound out of muted or soloed destination tracks", () => {
    const p = production();
    for (const state of [{ muted: true }, { solo: true }]) {
      const timeline = applyTimelineCommands(seedStoryPictureTimeline(p), [
        { kind: "add-track", trackId: "tr_reserved", trackKind: "audio", name: "Reserved" },
        { kind: "set-track", trackId: "tr_reserved", ...state },
      ]);
      const detached = applyTimelineCommands(timeline, [{ kind: "detach-audio", clipId: timeline.tracks[0]!.clips[0]!.id, newClipId: "cl_detached" }],
        { sources: { production: p, artifacts: [] } });
      assert.equal(detached.tracks.find(track => track.id === "tr_reserved")!.clips.length, 0);
      const result = buildRenderPlan({ production: p, timeline: { status: "ready", timeline: detached }, artifacts, scope: { kind: "production" }, preset: "review-cut" });
      assert.ok(result.ok);
      assert.equal(result.plan.audio.some(item => item.clipId === "cl_detached"), !state.solo, "detachment retains the existing audible set");
    }
  });

  it("persists future-only defaults and clip overrides through history and reload", () => {
    let timeline = applyTimelineCommands(seedStoryPictureTimeline(production()), [
      { kind: "add-track", trackId: "tr_new", trackKind: "audio", name: "Audio 1" },
      { kind: "place", trackId: "tr_new", clip: audioClip("cl_first", SONG, "song.mp3", 0, 25) },
    ]);
    timeline = applyTimelineCommands(timeline, [{ kind: "set-track", trackId: "tr_new", defaultRole: "music", name: "Soundtrack" }]);
    timeline = applyTimelineCommands(timeline, [{ kind: "place", trackId: "tr_new", clip: audioClip("cl_next", SONG, "song.mp3", 25, 25) }]);
    timeline = applyTimelineCommands(timeline, [{ kind: "set-clip-role", clipId: "cl_next", role: "dialogue" }]);
    timeline = ProductionTimelineSchema.parse(JSON.parse(JSON.stringify(timeline)));
    const roles = (value: ProductionTimeline) => { const track = value.tracks.find(track => track.id === "tr_new")!; return track.clips.map(clip => effectiveAudioRole(track, clip)); };
    assert.deepEqual(roles(timeline), ["unspecified", "dialogue"]);
    const reverted = undoTimelineHistory(timeline);
    assert.deepEqual(roles(reverted), ["unspecified", "music"]);
    assert.deepEqual(roles(redoTimelineHistory(reverted)), roles(timeline));
    const original = undoTimelineHistory(undoTimelineHistory(reverted));
    assert.equal(original.tracks.find(track => track.id === "tr_new")!.defaultRole, undefined);
    assert.deepEqual(roles(original), ["unspecified"]);
  });
});

function apply(timeline: ProductionTimeline, ...commands: TimelineClipCommand[]): ProductionTimeline {
  return applyTimelineCommands(timeline, commands);
}

function audioClip(id: `cl_${string}`, artifactId: string, label: string, startFrame: number, durationFrames: number, gainDb = 0): TimelineClip {
  return { id, startFrame, durationFrames, sourceInFrames: 0, source: { kind: "artifact", artifactId, label }, gainDb };
}

/** Picture 0–188 at 25 fps, a Dialogue line at 50–100, a Music bed under everything. */
function mixed(): ProductionTimeline {
  return valid(
    apply(
      seedStoryPictureTimeline(production()),
      // This authored mix deliberately replaces the video's own sound.
      { kind: "set-clip-audio", clipId: "cl_sh-1", audio: "mute" },
      { kind: "add-track", trackId: "tr_dialogue", trackKind: "dialogue", name: "Dialogue" },
      { kind: "add-track", trackId: "tr_music", trackKind: "music", name: "Music" },
      {
        kind: "place",
        trackId: "tr_dialogue",
        clip: { id: "cl_line", startFrame: 50, durationFrames: 50, sourceInFrames: 0, source: { kind: "take", takeId: VOICE, label: "line", sheetId: "maren-kest", voiceAssignedAtVersion: 4 }, gainDb: 0, role: "dialogue" },
      },
      { kind: "place", trackId: "tr_music", clip: { ...audioClip("cl_song", SONG, "song.mp3", 0, 188, -6), role: "music" } },
    ),
  );
}

function graphOf(args: string[]): string {
  return args[args.indexOf("-filter_complex") + 1] ?? "";
}

describe("the round-one Picture fixes", () => {
  it("keeps the hole a deleted last clip leaves, and Undo forgets it again", () => {
    const seeded = seedStoryPictureTimeline(production());
    const deleted = valid(apply(seeded, { kind: "delete", clipId: "cl_sh-3" }));
    assert.equal(trackEndFrame(deleted.tracks[0]!), 188, "the track still reaches where it did");
    assert.equal(deleted.tracks[0]!.endFrame, 188);
    const resolved = resolvePictureTimeline(production(), { status: "ready", timeline: deleted });
    assert.deepEqual(resolved.entries.map((entry) => [entry.hole ?? false, entry.durationSec]), [
      [false, 2],
      [false, 1.52],
      [true, 4],
    ]);
    assert.equal(resolved.totalSec, 7.52);
    const undone = valid(undoTimelineHistory(deleted));
    assert.equal(undone.tracks[0]!.endFrame, undefined);
    assert.deepEqual(undone.tracks[0]!.clips.map((clip) => clip.id), seeded.tracks[0]!.clips.map((clip) => clip.id));

    // Deleting the only clip leaves a film of its length, not a media-only production.
    const only = apply(seeded, { kind: "ripple-delete", clipId: "cl_sh-2" }, { kind: "ripple-delete", clipId: "cl_sh-3" });
    const emptied = valid(apply(only, { kind: "delete", clipId: "cl_sh-1" }));
    const emptyCut = resolvePictureTimeline(production(), { status: "ready", timeline: emptied });
    assert.deepEqual(emptyCut.entries.map((entry) => [entry.hole ?? false, entry.durationSec]), [[true, 2]]);
    // Ripple delete closes the range, and shifts a remembered end with it.
    const rippled = valid(apply(deleted, { kind: "ripple-delete", clipId: "cl_sh-2" }));
    assert.equal(trackEndFrame(rippled.tracks[0]!), 150);
    assert.equal(rippled.tracks[0]!.endFrame, 150);
  });

  it("bounds a tail trim by the measured source and refuses past it", () => {
    const seeded = seedStoryPictureTimeline(production());
    // sh_1 holds a 3s take at 25 fps: 75 frames from its first frame, 50 of them on the timeline.
    const opened = apply(seeded, { kind: "ripple-delete", clipId: "cl_sh-2" }, { kind: "ripple-delete", clipId: "cl_sh-3" });
    const length = (clip: TimelineClip): number | undefined => (clip.id === "cl_sh-1" ? 75 : undefined);
    const grown = valid(applyTimelineCommands(opened, [{ kind: "trim", clipId: "cl_sh-1", edge: "end", deltaFrames: 25 }], { sourceLength: length }));
    assert.equal(grown.tracks[0]!.clips[0]!.durationFrames, 75);
    assert.throws(
      () => applyTimelineCommands(opened, [{ kind: "trim", clipId: "cl_sh-1", edge: "end", deltaFrames: 26 }], { sourceLength: length }),
      /only 75 source frames/,
    );
    // Unmeasured is not measured zero: with no length known, nothing bounds the tail (R-5a).
    assert.doesNotThrow(() => apply(opened, { kind: "trim", clipId: "cl_sh-1", edge: "end", deltaFrames: 500 }));
  });

  it("renders a hole as black through the legacy plan builder too", () => {
    const seeded = seedStoryPictureTimeline(production());
    const holed = apply(seeded, { kind: "delete", clipId: "cl_sh-2" });
    const plan = buildExportPlan(resolvePictureTimeline(production(), { status: "ready", timeline: holed }), "review-cut", [], [], 25);
    assert.deepEqual(plan.items.map((item) => item.type), ["clip", "black", "slate"]);
    assert.ok(!graphOf(buildFfmpegArgs(plan, "/w", "/out.mp4", "/f.ttf")).includes("EMPTY"), "no title card names an empty second");
  });
});

describe("typed audio tracks and the speech-first mix (#681)", () => {
  it("places, gains, mutes, solos and mixes as durable commands with exact inverses", () => {
    const timeline = mixed();
    assert.equal(timeline.revision, 1, "the commands in one batch are one revision");
    const entry = timeline.history.undo[0]!;
    assert.equal(entry.kind === "change" ? entry.tracks.length : -1, 2, "two tracks were added");
    assert.equal(entry.kind === "change" ? entry.clips.length : -1, 3, "two clips were placed and picture sound muted");

    const gained = valid(apply(timeline, { kind: "set-clip-gain", clipId: "cl_song", gainDb: -12 }));
    assert.equal(gained.tracks.find((track) => track.id === "tr_music")!.clips[0]!.gainDb, -12);
    assert.throws(() => apply(timeline, { kind: "set-clip-gain", clipId: "cl_sh-1", gainDb: -3 }), /has no gain/);

    const soloed = valid(apply(gained, { kind: "set-track", trackId: "tr_dialogue", solo: true }));
    assert.deepEqual(audibleTracks(soloed).map((track) => track.id), ["tr_dialogue"], "solo leaves only the solo audio track");
    assert.equal(soloed.tracks.find((track) => track.id === "tr_music")!.muted, false, "solo changes no saved Mute value");
    assert.throws(() => apply(timeline, { kind: "set-track", trackId: "tr_picture", solo: true }), /cannot solo/);

    const quieter = valid(apply(soloed, { kind: "set-mix", mix: { duckingDb: -12, speechFirst: false } }));
    assert.deepEqual(quieter.mix, { ...DEFAULT_MIX, duckingDb: -12, speechFirst: false });
    const mixEntry = quieter.history.undo.at(-1)!;
    assert.equal(mixEntry.kind === "change" ? mixEntry.mix?.before.duckingDb : 0, -9);

    let back = quieter;
    for (let step = 0; step < 4; step += 1) back = valid(undoTimelineHistory(back));
    assert.deepEqual(back.tracks.map((track) => track.id), ["tr_picture"], "every added track is gone again");
    assert.deepEqual(back.mix, DEFAULT_MIX);
    let forward = back;
    for (let step = 0; step < 4; step += 1) forward = valid(redoTimelineHistory(forward));
    assert.deepEqual(forward.tracks.map((track) => track.id), quieter.tracks.map((track) => track.id));
    assert.deepEqual(forward.mix, quieter.mix);

    assert.throws(() => apply(timeline, { kind: "remove-track", trackId: "tr_music" }), /still holds 1 clip/);
    assert.throws(() => apply(timeline, { kind: "place", trackId: "tr_music", clip: { ...timeline.tracks[0]!.clips[0]!, id: "cl_x" } }), /belongs on a Picture track/);
  });

  it("lowers Music and Ambience under Dialogue by the mix's figure, along its envelope", () => {
    const result = buildRenderPlan({ production: production(), artifacts, timeline: { status: "ready", timeline: mixed() }, scope: { kind: "production" }, preset: "review-cut" });
    assert.equal(result.ok, true, result.ok ? "" : result.reason);
    if (!result.ok) return;
    const plan = result.plan;
    assert.deepEqual(plan.speech, [{ startSec: 2, endSec: 4 }]);
    const song = plan.audio.find((clip) => clip.clipId === "cl_song")!;
    assert.equal(song.role, "music");
    const line = plan.audio.find((clip) => clip.clipId === "cl_line")!;
    assert.equal(line.role, "dialogue");
    assert.equal(audioGainDbAt(plan, song, 1), -6, "the bed plays at its own gain before speech");
    assert.equal(audioGainDbAt(plan, song, 1.95), -15, "and drops 80 ms ahead of it");
    assert.equal(audioGainDbAt(plan, song, 3), -15);
    assert.equal(Math.round(audioGainDbAt(plan, song, 4.2) * 100) / 100, -10.5, "halfway through a 400 ms release");
    assert.equal(audioGainDbAt(plan, song, 4.4), -6);
    assert.equal(audioGainDbAt(plan, line, 3), 0, "speech itself is never lowered");
    assert.equal(Math.round(duckingEnvelope(plan.speech, plan.mix, 4.1) * 1000) / 1000, 0.75);
    assert.deepEqual(audioAtSec(plan, 3).map((clip) => [clip.clipId, clip.effectiveGainDb]), [["cl_line", 0], ["cl_song", -15]]);

    // The FFmpeg graph spells the same envelope: the same figures, in film seconds, after adelay.
    const graph = graphOf(buildFfmpegArgs(plan, "/w", "/out.mp4", "/f.ttf"));
    assert.match(graph, /adelay=0:all=1,asetpts=N\/SR\/TB,volume=eval=frame:volume='pow\(10,\(-6\+\(-9\)\*\(if\(between\(t,1\.92,4\),1,if\(between\(t,4,4\.4\),1-\(t-4\)\/0\.4,0\)\)\)\)\/20\)'\[ac1\]/);
    assert.match(graph, /adelay=2000:all=1,asetpts=N\/SR\/TB,volume=0dB\[ac0\]/, "dialogue keeps a plain gain");
    assert.match(graph, /alimiter=limit=0\.891251:level=false\[aout\]/, "peak protection at -1 dBFS closes the mix");
  });

  it("turning speech-first off removes the ducking and nothing else", () => {
    const off = valid(apply(mixed(), { kind: "set-mix", mix: { speechFirst: false } }));
    const result = buildRenderPlan({ production: production(), artifacts, timeline: { status: "ready", timeline: off }, scope: { kind: "production" }, preset: "review-cut" });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const plan = result.plan;
    assert.deepEqual(plan.speech, []);
    const song = plan.audio.find((clip) => clip.clipId === "cl_song")!;
    assert.equal(audioGainDbAt(plan, song, 3), -6, "the clip's own gain still applies");
    assert.match(graphOf(buildFfmpegArgs(plan, "/w", "/out.mp4", "/f.ttf")), /volume=-6dB\[ac1\]/);
  });

  it("mixes without normalisation, mutes and solos deterministically, and never extends the film", () => {
    const withBells = valid(
      apply(
        mixed(),
        { kind: "add-track", trackId: "tr_ambience", trackKind: "ambience", name: "Ambience" },
        { kind: "place", trackId: "tr_ambience", clip: { ...audioClip("cl_bells", BELLS, "bells.wav", 150, 100), role: "ambience" } },
      ),
    );
    const result = buildRenderPlan({ production: production(), artifacts, timeline: { status: "ready", timeline: withBells }, scope: { kind: "production" }, preset: "review-cut" });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const plan = result.plan;
    const song = plan.audio.find((clip) => clip.clipId === "cl_song")!;
    assert.equal(audioGainDbAt(plan, song, 1), -6, "a non-overlapping clip changes nothing about an existing one");
    assert.match(graphOf(buildFfmpegArgs(plan, "/w", "/out.mp4", "/f.ttf")), /amix=inputs=3:normalize=0/);
    assert.equal(plan.totalSec, 7.52, "sound reaching past the picture cannot lengthen the film (R-19)");
    const bells = plan.audio.find((clip) => clip.clipId === "cl_bells")!;
    assert.equal(bells.endSec, 7.52, "it is conformed to the picture's end instead");
    assert.notEqual(plan.items.at(-1)!.type, "black", "and no black tail is invented for it");

    const muted = valid(apply(withBells, { kind: "set-track", trackId: "tr_music", muted: true }));
    const mutedPlan = buildRenderPlan({ production: production(), artifacts, timeline: { status: "ready", timeline: muted }, scope: { kind: "production" }, preset: "review-cut" });
    assert.equal(mutedPlan.ok && mutedPlan.plan.audio.some((clip) => clip.clipId === "cl_song"), false, "a muted track contributes nothing");

    const soloed = valid(apply(withBells, { kind: "set-track", trackId: "tr_ambience", solo: true }));
    const soloPlan = buildRenderPlan({ production: production(), artifacts, timeline: { status: "ready", timeline: soloed }, scope: { kind: "production" }, preset: "review-cut" });
    assert.deepEqual(soloPlan.ok ? soloPlan.plan.audio.map((clip) => clip.clipId) : [], ["cl_bells"], "solo excludes every other audio track");
    assert.deepEqual(soloPlan.ok ? soloPlan.plan.speech : null, [], "and the excluded dialogue no longer ducks anything");
  });

  it("migrates lanes and named audio tracks into typed tracks without loss", () => {
    const value = production({
      cut: {
        audio: [
          { kind: "score", label: "Score", entries: [{ artifactId: SONG, offsetSec: 0.5 }] },
          { kind: "dialogue", label: "Dialogue", entries: [{ shotId: "sh_2", takeId: VOICE, sheetId: "maren-kest", voiceAssignedAtVersion: 4, offsetSec: 0.2 }] },
        ],
        overlays: [
          { id: "ov_01J8G0000000000000000000B1", artifactId: PLATE, startSec: 1, endSec: 3, lane: 1, audio: "keep" },
          { id: "ov_01J8G0000000000000000000B2", artifactId: INSERT, startSec: 2.5, endSec: 4.02, lane: 0, audio: "mute" },
          { id: "ov_01J8G0000000000000000000B3", artifactId: INSERT, startSec: 2.5, endSec: 4.02, lane: 0, audio: "only" },
          { id: "ov_01J8G0000000000000000000B4", artifactId: BELLS, startSec: 5, endSec: 6, lane: 0, audio: "keep" },
          { id: "ov_01J8G0000000000000000000B5", artifactId: "ar_01J8G0000000000000000000ZZ", startSec: 0, endSec: 1, lane: 2, audio: "keep" },
        ],
      },
    });
    const { timeline, dropped } = migrateLegacyCut(seedStoryPictureTimeline(value), value, artifacts);
    valid(timeline);
    assert.equal(timeline.migratedCut, true);
    assert.deepEqual(dropped, ["ov_01J8G0000000000000000000B5 cites a file which this world does not have"]);
    const byId = new Map(timeline.tracks.map((track) => [track.id, track] as const));
    assert.deepEqual(
      [...byId.values()].map((track) => [track.id, track.kind, track.name]),
      [
        ["tr_picture", "picture", "Picture"],
        ["tr_lane-0", "picture", "Overlay L0"],
        ["tr_lane-0-sound", "ambience", "Overlay L0 sound"],
        ["tr_lane-1", "picture", "Overlay L1"],
        ["tr_audio-0", "music", "Score"],
        ["tr_audio-1", "dialogue", "Dialogue"],
      ],
    );
    const insert = byId.get("tr_lane-0")!.clips[0]!;
    // Nearest frame, one-frame minimum: 2.5s is frame 63 (62.5 rounds up), 4.02s is frame 101.
    assert.deepEqual([insert.startFrame, insert.durationFrames, insert.audio, insert.linkedClipId], [63, 38, "mute", "cl_ov-01J8G0000000000000000000B3"]);
    const half = byId.get("tr_lane-0-sound")!.clips.find((clip) => clip.id === "cl_ov-01J8G0000000000000000000B3")!;
    assert.deepEqual([half.startFrame, half.durationFrames, half.gainDb, half.linkedClipId], [63, 38, 0, insert.id]);
    assert.equal(byId.get("tr_lane-0-sound")!.clips.length, 2, "the bells placed on the same lane are sound too");
    assert.equal(byId.get("tr_lane-1")!.clips[0]!.audio, undefined, "a still has no sound to keep or mute");
    assert.equal(byId.get("tr_audio-0")!.kind, "music", "score is spelled Music");
    const line = byId.get("tr_audio-1")!.clips[0]!;
    assert.equal(line.startFrame, 55, "placed against its shot's clip plus its offset");
    assert.equal(line.durationFrames, 50, "as long as the measured line");
    assert.deepEqual(line.source, { kind: "take", takeId: VOICE, label: "Dialogue line", sheetId: "maren-kest", voiceAssignedAtVersion: 4 });
    // Migrating again changes nothing.
    assert.deepEqual(migrateLegacyCut(timeline, value, artifacts).timeline, timeline);

    // The plan reads the typed tracks and no longer the file they came from.
    const result = buildRenderPlan({ production: value, artifacts, timeline: { status: "ready", timeline }, scope: { kind: "production" }, preset: "review-cut" });
    assert.equal(result.ok, true, result.ok ? "" : result.reason);
    if (!result.ok) return;
    const plan = result.plan;
    assert.deepEqual(
      plan.overlays.map((overlay) => [overlay.path, overlay.startSec, overlay.endSec]),
      [
        ["artifacts/insert.mp4", 2.52, 4.04],
        ["artifacts/plate.png", 1, 3],
      ],
    );
    assert.deepEqual(plan.audio.map((clip) => [clip.clipId, clip.role]).sort(), [
      ["cl_audio-0-0", "music"],
      ["cl_audio-1-0", "dialogue"],
      ["cl_ov-01J8G0000000000000000000B3", "ambience"],
      ["cl_ov-01J8G0000000000000000000B4", "ambience"],
      ["cl_sh-1", "picture"],
    ]);
    assert.deepEqual(plan.speech, [{ startSec: 2.2, endSec: 4.2 }]);
  });

  it("refuses a mixed-up clip and a soloed non-audio track at the schema", () => {
    const timeline = mixed();
    const wrong = { ...timeline, tracks: timeline.tracks.map((track) => (track.id === "tr_picture" ? { ...track, solo: true } : track)) };
    assert.equal(ProductionTimelineSchema.safeParse(wrong).success, false);
    const shotOnMusic = {
      ...timeline,
      tracks: timeline.tracks.map((track) => (track.id === "tr_music" ? { ...track, clips: [{ ...timeline.tracks[0]!.clips[0]!, id: "cl_wrong" as const }] } : track)),
    };
    assert.equal(ProductionTimelineSchema.safeParse(shotOnMusic).success, false);
    assert.throws(() => apply(timeline, { kind: "add-track", trackId: "tr_music", trackKind: "music", name: "Again" }), TimelineOperationRefused);
  });
});

/**
 * A sound clip fades in and out at its own edges (SPEC-038 R-37..R-44). The bed in `mixed()` runs
 * the whole film, 0 to 188 frames at 25 fps, at -6 dB under a line spoken from 2s to 4s; the fades
 * here are 50 frames in (2s) and 75 out (3s), so the fade in ends as the duck's look-ahead begins.
 */
describe("sound fades at a clip's edges (SPEC-038 R-37..R-44)", () => {
  const clipOf = (timeline: ProductionTimeline, id: string): TimelineClip => timeline.tracks.flatMap((track) => track.clips).find((clip) => clip.id === id)!;
  const faded = (): ProductionTimeline => valid(apply(mixed(), { kind: "sound-fade", clipId: "cl_song", inFrames: 50, outFrames: 75 }));
  const planOf = (timeline: ProductionTimeline): RenderPlan => {
    const result = buildRenderPlan({ production: production(), artifacts, timeline: { status: "ready", timeline }, scope: { kind: "production" }, preset: "review-cut" });
    if (!result.ok) assert.fail(result.reason);
    return result.plan;
  };
  const itemOf = (plan: RenderPlan, id: string) => plan.audio.find((clip) => clip.clipId === id)!;
  const near = (actual: number, expected: number, message?: string) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message ?? "level"}: ${actual} is not ${expected}`);

  it("is a patch: an edge left out keeps its fade, zero removes one, and a value already held is no edit", () => {
    let current = valid(apply(mixed(), { kind: "sound-fade", clipId: "cl_song", inFrames: 50 }));
    assert.deepEqual(clipOf(current, "cl_song").soundFade, { inFrames: 50 });
    current = valid(apply(current, { kind: "sound-fade", clipId: "cl_song", outFrames: 75 }));
    assert.deepEqual(clipOf(current, "cl_song").soundFade, { inFrames: 50, outFrames: 75 });
    assert.equal(clipOf(current, "cl_song").gainDb, -6, "the gain is its own setting");
    assert.throws(() => apply(current, { kind: "sound-fade", clipId: "cl_song", outFrames: 75 }), /changes nothing/);

    // It survives the file, and each command is one Undo.
    const saved = ProductionTimelineSchema.parse(JSON.parse(JSON.stringify(current)));
    assert.deepEqual(clipOf(undoTimelineHistory(saved), "cl_song").soundFade, { inFrames: 50 });
    assert.deepEqual(clipOf(redoTimelineHistory(undoTimelineHistory(saved)), "cl_song").soundFade, { inFrames: 50, outFrames: 75 });

    current = valid(apply(current, { kind: "sound-fade", clipId: "cl_song", inFrames: 0 }));
    assert.deepEqual(clipOf(current, "cl_song").soundFade, { outFrames: 75 });
    current = valid(apply(current, { kind: "sound-fade", clipId: "cl_song", outFrames: 0 }));
    assert.equal("soundFade" in clipOf(current, "cl_song"), false, "no empty fade is left on the clip");
    assert.equal(describeTimelineCommand({ kind: "sound-fade", clipId: "cl_song", inFrames: 50 }), "Set sound fade");
  });

  it("belongs to a clip on an audio track: a picture's own sound, a missing clip and a record that says otherwise are refused", () => {
    const timeline = mixed();
    assert.throws(() => apply(timeline, { kind: "sound-fade", clipId: "cl_sh-1", inFrames: 12 }), /clip on an audio track/);
    assert.throws(() => apply(timeline, { kind: "sound-fade", clipId: "cl_gone", inFrames: 12 }), /clip on an audio track/);
    // A record as a hand edit would leave it: no history, so the only thing wrong with it is the fade.
    const record = { ...timeline, history: { undo: [], redo: [] } };
    const onPicture = { ...record, tracks: record.tracks.map((track) => (track.id === "tr_picture" ? { ...track, clips: track.clips.map((clip, index) => (index === 0 ? { ...clip, soundFade: { inFrames: 12 } } : clip)) } : track)) };
    assert.deepEqual(ProductionTimelineSchema.safeParse(onPicture).error!.issues.map((issue) => issue.message), ["A sound fade belongs only to a clip on an audio track"]);
    assert.throws(() => apply(timeline, { kind: "place", trackId: "tr_picture", clip: { id: "cl_plate", startFrame: 300, durationFrames: 25, sourceInFrames: 0, source: { kind: "artifact", artifactId: PLATE, label: "plate" }, soundFade: { inFrames: 5 } } }),
      /sound fade belongs only to a clip on an audio track/);

    // A fade names an edge, in whole frames, 1 to 108,000.
    const parses = (soundFade: unknown): boolean => ProductionTimelineSchema.safeParse({ ...record, tracks: record.tracks.map((track) => (track.id === "tr_music" ? { ...track, clips: [{ ...track.clips[0]!, soundFade }] } : track)) }).success;
    for (const wrong of [{}, { inFrames: 0 }, { inFrames: 1.5 }, { outFrames: 108001 }, { inFrames: 12, curve: "ease" }]) assert.equal(parses(wrong), false, JSON.stringify(wrong));
    assert.equal(parses({ inFrames: 1, outFrames: 108000 }), true);
  });

  it("a split leaves each fade at its outer edge; a trim, a move and a duplicate keep both; Undo restores them", () => {
    const base = faded();
    const cut = valid(apply(base, { kind: "split", clipId: "cl_song", atFrame: 100, newClipId: "cl_song2" }));
    assert.deepEqual(clipOf(cut, "cl_song").soundFade, { inFrames: 50 });
    assert.deepEqual(clipOf(cut, "cl_song2").soundFade, { outFrames: 75 }, "the cut between the halves is hard");
    assert.deepEqual(clipOf(undoTimelineHistory(cut), "cl_song").soundFade, { inFrames: 50, outFrames: 75 });
    const unfaded = valid(apply(mixed(), { kind: "split", clipId: "cl_song", atFrame: 100, newClipId: "cl_song2" }));
    assert.equal("soundFade" in clipOf(unfaded, "cl_song") || "soundFade" in clipOf(unfaded, "cl_song2"), false, "a split invents no fade");

    // Trimmed to 38 frames, shorter than either fade: the record keeps what was set, and the read limits it.
    const trimmed = valid(apply(base, { kind: "trim", clipId: "cl_song", edge: "start", deltaFrames: 150 }));
    assert.deepEqual(clipOf(trimmed, "cl_song").soundFade, { inFrames: 50, outFrames: 75 });
    assert.deepEqual(soundFadeWindows(clipOf(trimmed, "cl_song"), 25), { fadeIn: { startSec: 6, durationSec: 1.52 }, fadeOut: { startSec: 6, durationSec: 1.52 } });
    const regrown = valid(apply(trimmed, { kind: "trim", clipId: "cl_song", edge: "start", deltaFrames: -150 }));
    assert.deepEqual(soundFadeWindows(clipOf(regrown, "cl_song"), 25), soundFadeWindows(clipOf(base, "cl_song"), 25), "lengthened again, it plays whole");

    // The fades are measured from the clip's edges, so they go where the clip goes.
    const moved = valid(apply(base, { kind: "move-to-frame", clipId: "cl_song", startFrame: 25 }));
    assert.deepEqual(soundFadeWindows(clipOf(moved, "cl_song"), 25), { fadeIn: { startSec: 1, durationSec: 2 }, fadeOut: { startSec: 5.52, durationSec: 3 } });
    const copied = valid(apply(base, { kind: "duplicate", clipId: "cl_song", newClipId: "cl_copy" }));
    assert.deepEqual(clipOf(copied, "cl_copy").soundFade, { inFrames: 50, outFrames: 75 });
    assert.deepEqual(soundFadeWindows(clipOf(mixed(), "cl_song"), 25), {}, "a clip with no fade has no window");
  });

  it("plays one level in the plan's function and the export's graph, with gain and ducking on top", () => {
    const plan = planOf(faded()), song = itemOf(plan, "cl_song"), line = itemOf(plan, "cl_line");
    assert.deepEqual([song.fadeIn, song.fadeOut], [{ startSec: 0, durationSec: 2 }, { startSec: 4.52, durationSec: 3 }]);
    assert.equal(line.fadeIn ?? line.fadeOut, undefined, "a clip with no fade carries none");

    // A straight line of amplitude at each edge, and full level between them.
    for (const [sec, share] of [[0, 0], [0.5, 0.25], [1, 0.5], [2, 1], [3, 1], [4.52, 1], [6.02, 0.5], [7.52, 0]] as const) near(soundFadeAt(song, sec), share, `fade at ${sec}s`);
    // Gain, then the duck, then the fade (R-38): -6 dB alone, -15 dB under speech and its look-ahead.
    near(audioLevelAt(plan, song, 1), Math.pow(10, -6 / 20) * 0.5);
    near(audioLevelAt(plan, song, 1.95), Math.pow(10, -15 / 20) * 0.975, "inside the look-ahead and the fade at once");
    near(audioLevelAt(plan, song, 3), Math.pow(10, -15 / 20));
    near(audioLevelAt(plan, song, 6.02), Math.pow(10, -6 / 20) * 0.5);
    near(audioLevelAt(plan, line, 3), 1, "speech has no fade and is never lowered");
    assert.equal(audioGainDbAt(plan, song, 1), -6, "the figure in dB is the gain and the duck alone");
    assert.deepEqual(audioAtSec(plan, 1).map((clip) => [clip.clipId, clip.effectiveGainDb, clip.fade]), [["cl_song", -6, 0.5]]);

    // The export spells the same two lines in film seconds, in a stage of its own that closes the
    // clip's chain, and leaves the gain-and-duck expression before it exactly as it was.
    const graph = graphOf(buildFfmpegArgs(plan, "/w", "/out.mp4", "/f.ttf"));
    assert.match(graph, /adelay=0:all=1,asetpts=N\/SR\/TB,volume=eval=frame:volume='pow\(10,\(-6\+\(-9\)\*\(if\(between\(t,1\.92,4\),1,if\(between\(t,4,4\.4\),1-\(t-4\)\/0\.4,0\)\)\)\)\/20\)',asetnsamples=n=64:p=0,volume=eval=frame:volume='clip\(\(t-\(0\)\)\/2,0,1\)\*clip\(\(\(7\.52\)-t\)\/3,0,1\)'\[ac1\]/);
    assert.match(graph, /asetpts=PTS-STARTPTS,adelay=2000:all=1,asetpts=N\/SR\/TB,volume=0dB\[ac0\]/, "an unfaded clip's chain is the one it always was");
    // One regroup in a chain and never a second: two made FFmpeg end the film's last padding early.
    assert.equal((graph.match(/asetnsamples/g) ?? []).length, 1);
    assert.equal(graphOf(buildFfmpegArgs(planOf(mixed()), "/w", "/out.mp4", "/f.ttf")).includes("asetnsamples"), false, "a film with no fade builds the graph it always did");
  });

  it("a fading Dialogue clip is still where speech is expected", () => {
    const spoken = planOf(valid(apply(faded(), { kind: "sound-fade", clipId: "cl_line", inFrames: 10, outFrames: 10 })));
    assert.deepEqual(spoken.speech, [{ startSec: 2, endSec: 4 }]);
    assert.equal(audioGainDbAt(spoken, itemOf(spoken, "cl_song"), 2.1), -15, "the bed is down for the whole line, however quietly it starts");
    near(audioLevelAt(spoken, itemOf(spoken, "cl_line"), 2.2), 0.5);
  });

  it("a delivery window that opens inside a fade plays the slope the whole film plays", () => {
    const whole = planOf(faded()), song = itemOf(whole, "cl_song");
    const part = windowPlan(whole, 1, 6.02, { kind: "production" }), cut = itemOf(part, "cl_song");
    assert.deepEqual([cut.startSec, cut.sourceInSec], [0, 1]);
    assert.equal(cut.fadeIn!.startSec, -1, "the fade keeps its own beginning, before the window");
    for (const offset of [0, 0.5, 0.99, 2, 4, 4.5, 5]) near(audioLevelAt(part, cut, offset), audioLevelAt(whole, song, 1 + offset), `level ${offset}s into the part`);
    assert.ok(graphOf(buildFfmpegArgs(part, "/w", "/out.mp4", "/f.ttf")).includes("volume='clip((t-(-1))/2,0,1)*clip((("), "the export starts halfway up the line");
    assert.equal(EffectAudioContributionSchema.safeParse(cut).success, true, "an analysed contribution may carry a fade that began before its window");

    // Between the fades the stage is not built at all: a fade that is over costs nothing.
    const middle = windowPlan(whole, 2.5, 4, { kind: "production" });
    assert.equal(graphOf(buildFfmpegArgs(middle, "/w", "/out.mp4", "/f.ttf")).includes("asetnsamples"), false);
    near(audioLevelAt(middle, itemOf(middle, "cl_song"), 1), Math.pow(10, -15 / 20));
    // A full-range window is the plan it came from.
    assert.deepEqual(windowPlan(whole, 0, whole.totalSec, { kind: "production" }).audio, whole.audio);
  });

  it("Arke's request may carry it, and the guide says what it does", () => {
    assert.equal(ModelEditorRequestSchema.safeParse({ summary: "Fade the music in", commands: [{ kind: "sound-fade", clipId: "cl_song", inFrames: 50 }] }).success, true);
    assert.equal(ModelEditorRequestSchema.safeParse({ summary: "Fade the music in", commands: [{ kind: "sound-fade", clipId: "cl_song", inFrames: -1 }] }).success, false);
    assert.match(TIMELINE_EDITOR_COMMAND_GUIDE, /sound-fade \(clipId, inFrames, outFrames, power\)/);
    assert.match(TIMELINE_EDITOR_COMMAND_GUIDE, /sound-fade's inFrames and outFrames fade a clip on an audio track up from silence/);
  });
});

/*
 * What the film's own assembler did and the Cut could not (2026-11-26). The scene's room was laid
 * from pieces that crossed every few seconds, its club music held one level under the talk while
 * nothing else in the scene did, and the whole bed came down with one number. In the Cut a
 * crossing dipped, ducking was one switch for the whole film, and a level was each clip's own.
 */
describe("a track's level, a track that holds under speech, and even-power fades (SPEC-038 R-52..R-56)", () => {
  const clipOf = (timeline: ProductionTimeline, id: string): TimelineClip => timeline.tracks.flatMap((track) => track.clips).find((clip) => clip.id === id)!;
  const trackOf = (timeline: ProductionTimeline, id: string) => timeline.tracks.find((track) => track.id === id)!;
  const planOf = (timeline: ProductionTimeline): RenderPlan => {
    const result = buildRenderPlan({ production: production(), artifacts, timeline: { status: "ready", timeline }, scope: { kind: "production" }, preset: "review-cut" });
    if (!result.ok) assert.fail(result.reason);
    return result.plan;
  };
  const itemOf = (plan: RenderPlan, id: string) => plan.audio.find((clip) => clip.clipId === id)!;
  const near = (actual: number, expected: number, message?: string) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message ?? "level"}: ${actual} is not ${expected}`);

  it("a track's level is added to each of its clips' gain, held to what a gain may be, and 0 dB is no field", () => {
    let current = valid(apply(mixed(), { kind: "set-track", trackId: "tr_music", levelDb: -6 }));
    assert.equal(trackOf(current, "tr_music").levelDb, -6);
    assert.equal(clipOf(current, "cl_song").gainDb, -6, "the clip keeps its own gain");
    const plan = planOf(current);
    assert.equal(itemOf(plan, "cl_song").gainDb, -12, "the clip's -6 and the track's -6");
    assert.equal(itemOf(plan, "cl_line").gainDb, 0, "another track's clips are as they were");
    assert.equal(audioGainDbAt(plan, itemOf(plan, "cl_song"), 3), -21, "and speech lowers it from there");
    assert.match(graphOf(buildFfmpegArgs(plan, "/w", "/out.mp4", "/f.ttf")), /volume='pow\(10,\(-12\+\(-9\)\*/);
    assert.deepEqual([trackedGainDb({ gainDb: -50 }, { levelDb: -30 }), trackedGainDb({ gainDb: 10 }, { levelDb: 9 }), trackedGainDb({}, {})], [-60, 12, 0]);

    // It survives the file, and it is one Undo.
    const saved = ProductionTimelineSchema.parse(JSON.parse(JSON.stringify(current)));
    assert.equal("levelDb" in trackOf(undoTimelineHistory(saved), "tr_music"), false);
    assert.equal(trackOf(redoTimelineHistory(undoTimelineHistory(saved)), "tr_music").levelDb, -6);
    current = valid(apply(current, { kind: "set-track", trackId: "tr_music", levelDb: 0 }));
    assert.equal("levelDb" in trackOf(current, "tr_music"), false, "0 dB is the track as it was made");
    assert.deepEqual(planOf(current).audio, planOf(mixed()).audio, "and its plan is the plan it was");

    assert.throws(() => apply(mixed(), { kind: "set-track", trackId: "tr_picture", levelDb: -3 }), /not an audio track and has no level/);
    assert.throws(() => apply(mixed(), { kind: "set-track", trackId: "tr_music", levelDb: 0 }), /changes nothing/);
    const record = { ...mixed(), history: { undo: [], redo: [] } };
    const levelled = (levelDb: unknown): boolean => ProductionTimelineSchema.safeParse({ ...record, tracks: record.tracks.map((track) => (track.id === "tr_music" ? { ...track, levelDb } : track)) }).success;
    assert.deepEqual([levelled(-60), levelled(12), levelled(13), levelled(-61), levelled("loud")], [true, true, false, false, false]);
  });

  it("a track that holds under speech is not lowered, and its clips are still what their roles say", () => {
    const held = valid(apply(mixed(), { kind: "set-track", trackId: "tr_music", ducks: false }));
    assert.equal(trackOf(held, "tr_music").ducks, false);
    const plan = planOf(held), song = itemOf(plan, "cl_song"), before = planOf(mixed());
    assert.deepEqual([song.ducks, song.role], [false, "music"]);
    assert.equal(audioGainDbAt(plan, song, 3), -6, "under the line, at its own gain");
    assert.equal(audioGainDbAt(before, itemOf(before, "cl_song"), 3), -15, "a track as it was made is lowered as it always was");
    assert.equal("ducks" in itemOf(before, "cl_song"), false, "a plan from a cut with no such track is the plan it was");
    near(audioLevelAt(plan, song, 3), Math.pow(10, -6 / 20));
    // The export gives it the plain gain it gives a sound nothing lowers, and no envelope.
    assert.match(graphOf(buildFfmpegArgs(plan, "/w", "/out.mp4", "/f.ttf")), /adelay=0:all=1,asetpts=N\/SR\/TB,volume=-6dB\[ac1\]/);
    assert.equal(EffectAudioContributionSchema.safeParse(song).success, true, "an analysed contribution says whether speech lowered it");

    const again = valid(apply(held, { kind: "set-track", trackId: "tr_music", ducks: true }));
    assert.equal("ducks" in trackOf(again, "tr_music"), false, "lowered again is the track as it was made");
    assert.throws(() => apply(mixed(), { kind: "set-track", trackId: "tr_music", ducks: true }), /changes nothing/);
    assert.throws(() => apply(mixed(), { kind: "set-track", trackId: "tr_picture", ducks: false }), /not an audio track and has no level/);
    const record = { ...mixed(), history: { undo: [], redo: [] } };
    assert.equal(ProductionTimelineSchema.safeParse({ ...record, tracks: record.tracks.map((track) => (track.id === "tr_music" ? { ...track, ducks: true } : track)) }).success, false, "only a hold is ever written");
  });

  it("an even-power fade is a quarter of a sine at each edge: a patch like the fades it shapes, kept by a split, gone with the last fade", () => {
    let current = valid(apply(mixed(), { kind: "sound-fade", clipId: "cl_song", inFrames: 50, outFrames: 75, power: true }));
    assert.deepEqual(clipOf(current, "cl_song").soundFade, { inFrames: 50, outFrames: 75, power: true });
    current = valid(apply(current, { kind: "sound-fade", clipId: "cl_song", inFrames: 25 }));
    assert.deepEqual(clipOf(current, "cl_song").soundFade, { inFrames: 25, outFrames: 75, power: true }, "an edge set alone keeps the shape");
    const cut = valid(apply(current, { kind: "split", clipId: "cl_song", atFrame: 100, newClipId: "cl_song2" }));
    assert.deepEqual([clipOf(cut, "cl_song").soundFade, clipOf(cut, "cl_song2").soundFade], [{ inFrames: 25, power: true }, { outFrames: 75, power: true }]);
    assert.deepEqual(clipOf(valid(apply(current, { kind: "sound-fade", clipId: "cl_song", power: false })), "cl_song").soundFade, { inFrames: 25, outFrames: 75 }, "false draws them straight again");
    assert.equal("soundFade" in clipOf(valid(apply(current, { kind: "sound-fade", clipId: "cl_song", inFrames: 0, outFrames: 0 })), "cl_song"), false, "with no fade left there is no shape");
    assert.throws(() => apply(mixed(), { kind: "sound-fade", clipId: "cl_song", power: true }), /changes nothing/, "a shape with no fade to draw is no edit");
    assert.throws(() => apply(current, { kind: "sound-fade", clipId: "cl_song", power: true }), /changes nothing/);

    const plan = planOf(valid(apply(mixed(), { kind: "sound-fade", clipId: "cl_song", inFrames: 50, outFrames: 75, power: true }))), song = itemOf(plan, "cl_song");
    assert.deepEqual([song.fadeIn, song.fadeOut], [{ startSec: 0, durationSec: 2, power: true }, { startSec: 4.52, durationSec: 3, power: true }]);
    for (const [sec, share] of [[0, 0], [0.5, Math.sin(Math.PI / 8)], [1, Math.SQRT1_2], [2, 1], [3, 1], [6.02, Math.SQRT1_2], [7.52, 0]] as const) near(soundFadeAt(song, sec), share, `fade at ${sec}s`);
    // Two sounds crossing under one another keep one loudness between them, where two straight lines fall to half the power at the middle.
    const out = { fadeOut: { startSec: 10, durationSec: 1.2, power: true as const } }, into = { fadeIn: { startSec: 10, durationSec: 1.2, power: true as const } };
    for (const sec of [10.1, 10.3, 10.6, 11, 11.15]) near(soundFadeAt(out, sec) ** 2 + soundFadeAt(into, sec) ** 2, 1, `power at ${sec}s`);
    near(soundFadeAt({ fadeOut: { startSec: 10, durationSec: 1.2 } }, 10.6) ** 2 + soundFadeAt({ fadeIn: { startSec: 10, durationSec: 1.2 } }, 10.6) ** 2, 0.5);

    // The export spells the same curve over the same line, in the same last stage of the clip's chain.
    assert.match(graphOf(buildFfmpegArgs(plan, "/w", "/out.mp4", "/f.ttf")), /asetnsamples=n=64:p=0,volume=eval=frame:volume='sin\(clip\(\(t-\(0\)\)\/2,0,1\)\*PI\/2\)\*sin\(clip\(\(\(7\.52\)-t\)\/3,0,1\)\*PI\/2\)'\[ac1\]/);
    assert.equal(EffectAudioContributionSchema.safeParse(song).success, true, "an analysed contribution carries its fade's shape");
    // A part of the film draws the curve the whole draws.
    const part = windowPlan(plan, 1, 6.02, { kind: "production" });
    for (const offset of [0, 0.5, 0.99, 4, 4.5, 5]) near(audioLevelAt(part, itemOf(part, "cl_song"), offset), audioLevelAt(plan, song, 1 + offset), `level ${offset}s into the part`);
  });

  it("Arke's request may carry them, and the guide says what each is for", () => {
    const asked = (command: unknown) => ModelEditorRequestSchema.safeParse({ summary: "Bring the room down", commands: [command] }).success;
    assert.match(TIMELINE_EDITOR_COMMAND_GUIDE, /sound-gate \(clipId, on, gate\)/);
    assert.match(TIMELINE_EDITOR_COMMAND_GUIDE, /match-loudness \(clipId, lufs\)/);
    assert.match(TIMELINE_EDITOR_COMMAND_GUIDE, /sound-gate's on true keeps a take's or a file's sound where it stands over its own floor/);
    assert.match(TIMELINE_EDITOR_COMMAND_GUIDE, /leave gate out, it is measured from the clip's sound when the request is made/);
    assert.match(TIMELINE_EDITOR_COMMAND_GUIDE, /match-loudness's lufs, -50 to -5, sets a clip's gain so the stretch it plays measures that loudness in the film's mix, its track's level counted/);
    assert.deepEqual([asked({ kind: "sound-gate", clipId: "cl_song", on: true }), asked({ kind: "match-loudness", clipId: "cl_song", lufs: -20 }),
      asked({ kind: "match-loudness", clipId: "cl_song", lufs: -4 }), asked({ kind: "sound-gate", clipId: "cl_song" })], [true, true, false, false]);
    assert.deepEqual([asked({ kind: "set-track", trackId: "tr_music", levelDb: -6, ducks: false }), asked({ kind: "sound-fade", clipId: "cl_song", inFrames: 30, power: true }),
      asked({ kind: "set-track", trackId: "tr_music", levelDb: 13 }), asked({ kind: "sound-fade", clipId: "cl_song", power: "even" })], [true, true, false, false]);
    assert.match(TIMELINE_EDITOR_COMMAND_GUIDE, /set-track \(trackId, name, defaultRole, muted, solo, order, levelDb, ducks, language\)/);
    assert.match(TIMELINE_EDITOR_COMMAND_GUIDE, /set-track's levelDb is added to the gain of every clip on an audio track/);
    assert.match(TIMELINE_EDITOR_COMMAND_GUIDE, /ducks false holds that track's level under speech/);
    assert.match(TIMELINE_EDITOR_COMMAND_GUIDE, /power true draws both fades as even-power curves/);
  });
});

/*
 * A gate on a take's own sound, and a clip set to a loudness (2026-11-26). Each generated take
 * makes a room of its own, and the room jumps at every cut. The film's assembler kept each take's
 * voice and cut its room, and matched every line to one loudness; the Cut had neither.
 */
describe("a gate on a sound clip, and a clip set to a loudness (SPEC-038 R-57..R-60)", () => {
  const clipOf = (timeline: ProductionTimeline, id: string): TimelineClip => timeline.tracks.flatMap((track) => track.clips).find((clip) => clip.id === id)!;
  const planOf = (timeline: ProductionTimeline): RenderPlan => {
    const result = buildRenderPlan({ production: production(), artifacts, timeline: { status: "ready", timeline }, scope: { kind: "production" }, preset: "review-cut" });
    if (!result.ok) assert.fail(result.reason);
    return result.plan;
  };
  const itemOf = (plan: RenderPlan, id: string) => plan.audio.find((clip) => clip.clipId === id)!;
  const near = (actual: number, expected: number, message?: string) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message ?? "level"}: ${actual} is not ${expected}`);
  const FLOOR = Math.pow(10, -15 / 20);
  // Kept from 1 s to 2.5 s and from 4 s to 6 s of the song's own file.
  const GATE = { thresholdDb: -42, open: [[1, 2.5], [4, 6]] as Array<[number, number]> };
  const gated = (): ProductionTimeline => valid(apply(mixed(), { kind: "sound-gate", clipId: "cl_song", on: true, gate: GATE }));
  /** A sound's level a hundredth of a second at a time: a room, with voice over it where the spans say. */
  const levels = (seconds: number, room: number, voice: number, spans: Array<[number, number]>) =>
    Array.from({ length: Math.round(seconds * 100) }, (_, step) => (spans.some(([from, to]) => step >= Math.round(from * 100) && step < Math.round(to * 100)) ? voice : room));

  it("is measured from the sound's own floor: kept where it stands 8 dB over the level a fifth of it sits under", () => {
    // Two lines over a room at -50 dBFS, with a tenth of a second between two words of the first.
    const take = soundGateFromLevels(levels(6, -50, -20, [[1, 1.8], [1.9, 2.6], [4, 5]]));
    assert.deepEqual(take, { thresholdDb: -42, open: [[1, 2.6], [4, 5]] }, "a quiet shorter than the hold stays open");
    assert.equal(SoundGateSchema.safeParse(take).success, true);
    // A click alone is not kept; nor is anything in a sound with nothing over its floor.
    assert.deepEqual(soundGateFromLevels(levels(4, -50, -20, [[1, 1.02], [2, 3]])).open, [[2, 3]]);
    assert.deepEqual(soundGateFromLevels(levels(4, -50, -50, [])).open, []);
    // A take that is voice for most of its length keeps its words. Measured from its middle step,
    // as the assembler did, its floor is the voice itself and every word is cut.
    const dense = soundGateFromLevels(levels(5, -50, -20, [[0, 3.8]]));
    assert.deepEqual(dense, { thresholdDb: -42, open: [[0, 3.8]] });
    // The limit, said rather than hidden: with under a fifth of it room, the level a fifth sits under is the voice.
    assert.deepEqual(soundGateFromLevels(levels(5, -50, -20, [[0, 4.2]])), { thresholdDb: -12, open: [] });
    // Held to what a level can be: digital silence under a voice, and a room as loud as the voice.
    assert.equal(soundGateFromLevels(levels(4, -120, -20, [[1, 2]])).thresholdDb, SOUND_GATE.minThresholdDb);
    assert.equal(soundGateFromLevels(levels(4, -10, -3, [[1, 2]])).thresholdDb, SOUND_GATE.maxThresholdDb);
    assert.deepEqual(soundGateFromLevels([]), { thresholdDb: -6, open: [] });
    // More stretches than a clip holds are joined across their shortest quiets, never dropped.
    const busy = soundGateFromLevels(levels(250, -50, -20, Array.from({ length: 500 }, (_, i): [number, number] => [i * .5, i * .5 + .2])));
    assert.equal(busy.open.length, SOUND_GATE.maxRegions); assert.equal(busy.open.at(-1)![1], 249.7);
    assert.equal(SoundGateSchema.safeParse(busy).success, true);
  });

  it("is set with its measurement, removed without one, and never set unmeasured", () => {
    let current = gated();
    assert.deepEqual(clipOf(current, "cl_song").soundGate, GATE);
    assert.deepEqual([clipOf(current, "cl_song").gainDb, clipOf(current, "cl_song").role], [-6, "music"], "the gain and the role are their own settings");
    assert.throws(() => apply(current, { kind: "sound-gate", clipId: "cl_song", on: true, gate: GATE }), /changes nothing/, "measured again from the same sound, it is the gate it was");
    assert.throws(() => apply(mixed(), { kind: "sound-gate", clipId: "cl_song", on: true }), /A gate is measured from the clip's sound before it is set/);
    assert.throws(() => apply(mixed(), { kind: "match-loudness", clipId: "cl_song", lufs: -20 }), /set to a loudness by measuring it first/);
    assert.throws(() => apply(mixed(), { kind: "sound-gate", clipId: "cl_sh-1", on: true, gate: GATE }), /clip on an audio track/, "a video's own sound has none until it is detached");
    assert.throws(() => apply(mixed(), { kind: "sound-gate", clipId: "cl_gone", on: false }), /clip on an audio track/);
    assert.throws(() => apply(mixed(), { kind: "sound-gate", clipId: "cl_song", on: false }), /changes nothing/);

    // It survives the file, and it is one Undo.
    const saved = ProductionTimelineSchema.parse(JSON.parse(JSON.stringify(current)));
    assert.equal("soundGate" in clipOf(undoTimelineHistory(saved), "cl_song"), false);
    assert.deepEqual(clipOf(redoTimelineHistory(undoTimelineHistory(saved)), "cl_song").soundGate, GATE);
    // A split keeps it on both halves and a duplicate copies it: the stretches are the source's, not the clip's.
    const cut = valid(apply(current, { kind: "split", clipId: "cl_song", atFrame: 100, newClipId: "cl_song2" }));
    assert.deepEqual([clipOf(cut, "cl_song").soundGate, clipOf(cut, "cl_song2").soundGate], [GATE, GATE]);
    assert.deepEqual(clipOf(valid(apply(current, { kind: "duplicate", clipId: "cl_song", newClipId: "cl_copy" })), "cl_copy").soundGate, GATE);
    current = valid(apply(current, { kind: "sound-gate", clipId: "cl_song", on: false }));
    assert.equal("soundGate" in clipOf(current, "cl_song"), false);
    assert.deepEqual([describeTimelineCommand({ kind: "sound-gate", clipId: "cl_song", on: true }), describeTimelineCommand({ kind: "sound-gate", clipId: "cl_song", on: false }),
      describeTimelineCommand({ kind: "match-loudness", clipId: "cl_song", lufs: -20 })], ["Gate sound", "Remove gate", "Set cl_song to -20 LUFS"]);

    // A record that says otherwise is refused: a gate on a picture clip, and stretches out of order or touching nothing.
    const record = { ...mixed(), history: { undo: [], redo: [] } };
    const onPicture = { ...record, tracks: record.tracks.map((track) => (track.id === "tr_picture" ? { ...track, clips: track.clips.map((clip, index) => (index === 0 ? { ...clip, soundGate: GATE } : clip)) } : track)) };
    assert.deepEqual(ProductionTimelineSchema.safeParse(onPicture).error!.issues.map((issue) => issue.message), ["A gate belongs only to a take's or a file's sound on an audio track"]);
    for (const wrong of [{ thresholdDb: -42, open: [[2, 1]] }, { thresholdDb: -42, open: [[1, 3], [2, 4]] }, { thresholdDb: -42, open: [[1, 1]] }, { thresholdDb: 3, open: [] }, { open: [[1, 2]] }]) {
      assert.equal(SoundGateSchema.safeParse(wrong).success, false, JSON.stringify(wrong));
    }
  });

  it("plays one level in the plan's function and the export's graph: whole where the sound is kept, 15 dB down where it is not", () => {
    // The song moved to start two seconds in: its file's 1 s is the film's 3 s.
    const plan = planOf(valid(apply(gated(), { kind: "move-to-frame", clipId: "cl_song", startFrame: 50 }, { kind: "set-track", trackId: "tr_music", ducks: false }))), song = itemOf(plan, "cl_song");
    assert.deepEqual(song.gate, [{ startSec: 3, endSec: 4.5 }, { startSec: 6, endSec: 8 }]);
    assert.equal(itemOf(plan, "cl_line").gate, undefined, "a clip with no gate carries none");
    for (const [sec, share] of [[3.5, 1], [2.5, FLOOR], [2.995, FLOOR + (1 - FLOOR) * .5], [3, 1], [4.5, 1], [4.575, FLOOR + (1 - FLOOR) * .5], [4.65, FLOOR], [5, FLOOR], [7.9, 1], [9, FLOOR]] as const) {
      near(soundGateAt(song, sec), share, `gate at ${sec}s`);
    }
    near(soundGateAt({}, 3), 1, "no gate is no change");
    near(soundGateAt({ gate: [] }, 3), FLOOR, "a gate that kept nothing is down throughout");
    // Gain, then the gate (R-57): -6 dB where the sound is kept, 15 dB under that where it is not.
    near(audioLevelAt(plan, song, 3.5), Math.pow(10, -6 / 20));
    near(audioLevelAt(plan, song, 5), Math.pow(10, -21 / 20));
    assert.equal(audioGainDbAt(plan, song, 5), -6, "the figure in dB is the gain alone");

    // The export spells the same lines in film seconds, in the fade's stage, the last of the clip's chain.
    const graph = graphOf(buildFfmpegArgs(plan, "/w", "/out.mp4", "/f.ttf"));
    assert.ok(graph.includes(`volume=-6dB,asetnsamples=n=64:p=0,volume=eval=frame:volume='(${FLOOR}+${1 - FLOOR}*(max(if(between(t,3,4.5),1,if(between(t,2.99,3),1-((3)-t)/0.01,if(between(t,4.5,4.65),1-(t-(4.5))/0.15,0))),if(between(t,6,8),1,`), graph);
    assert.equal((graph.match(/asetnsamples/g) ?? []).length, 1, "one regroup in a chain");
    // With a fade as well, the two share the stage.
    const both = graphOf(buildFfmpegArgs(planOf(valid(apply(gated(), { kind: "sound-fade", clipId: "cl_song", inFrames: 50 }))), "/w", "/out.mp4", "/f.ttf"));
    assert.ok(both.includes(`volume='clip((t-(0))/2,0,1)*(${FLOOR}+`), both);
    assert.equal((both.match(/asetnsamples/g) ?? []).length, 1);
    assert.equal(EffectAudioContributionSchema.safeParse(song).success, true, "an analysed contribution carries its gate");

    // Only the stretches an item can hear are in its plan, and a part of the film plays what the whole plays.
    const tail = planOf(valid(apply(gated(), { kind: "trim", clipId: "cl_song", edge: "start", deltaFrames: 75 })));
    assert.deepEqual(itemOf(tail, "cl_song").gate, [{ startSec: 4, endSec: 6 }], "trimmed past the first stretch, it is gone from the plan and still on the clip");
    const part = windowPlan(plan, 3.2, 7, { kind: "production" }), cut = itemOf(part, "cl_song");
    // Moved by the part's own start and not rounded again, so a slope falls where the whole film's does.
    assert.equal(cut.gate!.length, 2);
    for (const [index, [from, to]] of ([[-0.2, 1.3], [2.8, 4.8]] as const).entries()) { near(cut.gate![index]!.startSec, from, "a kept stretch's start"); near(cut.gate![index]!.endSec, to, "a kept stretch's end"); }
    for (const offset of [0, 0.5, 1.3, 1.36, 2, 2.795, 3.5]) near(audioLevelAt(part, cut, offset), audioLevelAt(plan, song, 3.2 + offset), `level ${offset}s into the part`);
  });
});
