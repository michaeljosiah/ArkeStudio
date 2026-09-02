import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_MIX,
  ProductionTimelineSchema,
  TimelineOperationRefused,
  applyTimelineCommands,
  audibleTracks,
  audioAtSec,
  audioGainDbAt,
  buildExportPlan,
  buildFfmpegArgs,
  buildRenderPlan,
  duckingEnvelope,
  migrateLegacyCut,
  redoTimelineHistory,
  resolvePictureTimeline,
  seedStoryPictureTimeline,
  trackEndFrame,
  undoTimelineHistory,
  type ProductionBundle,
  type ProductionTimeline,
  type RenderArtifact,
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
      { kind: "add-track", trackId: "tr_dialogue", trackKind: "dialogue", name: "Dialogue" },
      { kind: "add-track", trackId: "tr_music", trackKind: "music", name: "Music" },
      {
        kind: "place",
        trackId: "tr_dialogue",
        clip: { id: "cl_line", startFrame: 50, durationFrames: 50, sourceInFrames: 0, source: { kind: "take", takeId: VOICE, label: "line", sheetId: "maren-kest", voiceAssignedAtVersion: 4 }, gainDb: 0 },
      },
      { kind: "place", trackId: "tr_music", clip: audioClip("cl_song", SONG, "song.mp3", 0, 188, -6) },
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
    assert.equal(timeline.revision, 1, "four commands in one batch are one revision");
    const entry = timeline.history.undo[0]!;
    assert.equal(entry.kind === "change" ? entry.tracks.length : -1, 2, "two tracks were added");
    assert.equal(entry.kind === "change" ? entry.clips.length : -1, 2, "two clips were placed");

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
    assert.match(graph, /adelay=0:all=1,volume=eval=frame:volume='pow\(10,\(-6\+\(-9\)\*\(if\(between\(t,1\.92,4\),1,if\(between\(t,4,4\.4\),1-\(t-4\)\/0\.4,0\)\)\)\)\/20\)'\[ac1\]/);
    assert.match(graph, /adelay=2000:all=1,volume=0dB\[ac0\]/, "dialogue keeps a plain gain");
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
        { kind: "place", trackId: "tr_ambience", clip: audioClip("cl_bells", BELLS, "bells.wav", 150, 100) },
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
    assert.deepEqual(dropped, ["ov_01J8G0000000000000000000B5 cites artifact ar_01J8G0000000000000000000ZZ, which this world does not have"]);
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
