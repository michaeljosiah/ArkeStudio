import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyTimelineCommands,
  buildExportPlan,
  buildFfmpegArgs,
  buildRenderPlan,
  deriveCut,
  exportAudioClips,
  exportOverlays,
  pictureAtSec,
  pictureEdges,
  seedStoryPictureTimeline,
  type ExportPlan,
  type ProductionBundle,
  type RenderArtifact,
  type RenderPlan,
  type Scene,
} from "../src/index.js";

/**
 * One render plan, two executors (SPEC-038 R-1..R-11, issue #680; closes GitHub issue #486).
 *
 * The parity fixture asks the plan what is visible at named seconds and asks the FFmpeg graph
 * the same question by reading it back, so a disagreement between preview and export is found
 * here rather than by watching the file beside the screen.
 */

const AT = "2026-09-01T12:00:00Z";
const TAKE = "tk_01J8E0000000000000000000T1";
const PLATE = "ar_01J8G0000000000000000000A1";
const INSERT = "ar_01J8G0000000000000000000A2";
const BELLS = "ar_01J8G0000000000000000000A3";
const NOTES = "ar_01J8G0000000000000000000A4";

const artifacts: RenderArtifact[] = [
  { id: PLATE, file: "plate.png", kind: "image" },
  { id: INSERT, file: "insert.mp4", kind: "video", mediaInfo: { hasAudio: true, durationSec: 9 } },
  { id: BELLS, file: "bells.wav", kind: "audio" },
  { id: NOTES, file: "notes.md", kind: "document" },
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
    ],
    reviews: [],
    selections: { sh_1: { acceptedTakeId: TAKE, trimInSec: 0 } },
    spine: null,
    cut: {
      audio: [],
      overlays: [
        { id: "ov_01J8G0000000000000000000B1", artifactId: PLATE, startSec: 1, endSec: 3, lane: 1, audio: "keep" },
        { id: "ov_01J8G0000000000000000000B2", artifactId: INSERT, startSec: 2.5, endSec: 4, lane: 0, audio: "keep" },
        { id: "ov_01J8G0000000000000000000B3", artifactId: NOTES, startSec: 0, endSec: 9, lane: 2, audio: "keep" },
      ],
    },
    takeMediaInfo: {},
    ...over,
  };
}

interface GraphInput {
  path: string;
  still: boolean;
  inSec: number;
}

interface GraphPicture {
  path: string | null;
  layer: number;
  sourceSec: number;
}

/**
 * Read the picture back out of the arguments FFmpeg would be given.
 *
 * The concat lays inputs end to end at their conformed durations; each `overlay` in the chain
 * is confined to its `between(t,a,b)` window and lands over everything before it. The reading
 * is deliberately independent of how the plan was built: it parses the argv, nothing else.
 */
function ffmpegPictureAtSec(args: string[], sec: number): GraphPicture | null {
  const inputs: GraphInput[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "-i") continue;
    let still = false;
    let inSec = 0;
    for (let back = index - 1; back >= 0 && back > index - 8; back -= 1) {
      if (args[back] === "-loop") still = true;
      if (args[back] === "-ss") inSec = Number(args[back + 1]);
      if (args[back] === "-i") break;
    }
    inputs.push({ path: args[index + 1]!, still, inSec });
  }
  const graph = args[args.indexOf("-filter_complex") + 1] ?? "";
  const filters = graph.split(";");
  const concat = filters.find((filter) => filter.includes("concat=n="));
  assert.ok(concat, "one concat");
  const order = [...concat.matchAll(/\[v(\d+)\]/g)].map((match) => Number(match[1]));
  const durationOf = (input: number): number => {
    const filter = filters.find((candidate) => candidate.startsWith(`[${input}:v]`)) ?? "";
    const trimmed = /trim=duration=([0-9.]+)/.exec(filter);
    if (trimmed) return Number(trimmed[1]);
    // A generated source has no trim; its length is the `-t` before its `-i`.
    const at = args.findIndex((arg, position) => arg === "-i" && args.slice(0, position).filter((a) => a === "-i").length === input);
    return Number(args[at - 1]);
  };
  let picture: GraphPicture | null = null;
  let cursor = 0;
  for (const input of order) {
    const duration = durationOf(input);
    if (sec >= cursor && sec < cursor + duration) {
      const source = inputs[input]!;
      picture = source.path.includes("color=c=black")
        ? { path: null, layer: 0, sourceSec: 0 }
        : { path: source.path.replace(/^\/w\//, ""), layer: 0, sourceSec: source.inSec + (sec - cursor) };
      break;
    }
    cursor += duration;
  }
  const overlays = filters
    .map((filter) => /\[(\d+):v\]scale=[^;]*?(?:setpts=PTS-STARTPTS\+([0-9.]+)\/TB)?\[o(\d+)\]/.exec(filter))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ input: Number(match[1]), shift: match[2] === undefined ? null : Number(match[2]), layer: Number(match[3]) + 1 }));
  for (const overlay of overlays) {
    const window = new RegExp(`\\[o${overlay.layer - 1}\\]overlay=[^;]*between\\(t,([0-9.]+),([0-9.]+)\\)`).exec(graph);
    assert.ok(window, "every overlay is confined to a window");
    const start = Number(window[1]);
    const end = Number(window[2]);
    if (sec >= start && sec < end) {
      const source = inputs[overlay.input]!;
      picture = { path: source.path.replace(/^\/w\//, ""), layer: overlay.layer, sourceSec: source.still ? 0 : sec - start };
    }
  }
  return picture;
}

function planOf(result: ReturnType<typeof buildRenderPlan>) {
  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  return result.ok ? result.plan : (undefined as never);
}

/** The plan as the FFmpeg builder reads it: the render fields and the audio roles set aside. */
function stripRender(plan: RenderPlan): ExportPlan {
  const { preset, frameRate, items, overlays, audio, totalSec } = plan;
  return {
    preset,
    frameRate,
    items,
    overlays,
    audio: audio.map(({ path, startSec, endSec, gainDb }) => ({ path, startSec, endSec, gainDb })),
    totalSec,
  };
}

describe("one render plan for preview and export (#680)", () => {
  it("projects a legacy production to exactly the plan it always exported", () => {
    const value = production();
    const plan = planOf(buildRenderPlan({ production: value, artifacts, timeline: { status: "absent" }, scope: { kind: "production" }, preset: "review-cut" }));
    const legacy = buildExportPlan(deriveCut(value), "review-cut", exportOverlays(value.cut.overlays, artifacts), exportAudioClips(value.cut.overlays, artifacts), 25);
    assert.deepEqual(stripRender(plan), legacy);
    assert.deepEqual(
      buildFfmpegArgs(plan, "/w", "/out.mp4", "/fonts/Geist-Regular.ttf"),
      buildFfmpegArgs(legacy, "/w", "/out.mp4", "/fonts/Geist-Regular.ttf"),
      "the encode a legacy world gets is byte for byte the one it always got",
    );
    assert.deepEqual(plan.speech, []);
    assert.deepEqual(plan.audio.map((clip) => clip.role), ["picture"], "legacy placed sound has no role and is never lowered");
    assert.equal(plan.revision, null);
    assert.deepEqual(plan.range, { startSec: 0, endSec: 7.5 });
  });

  it("names invalid timeline state and never falls back to story order", () => {
    const result = buildRenderPlan({
      production: production(),
      artifacts,
      timeline: { status: "invalid", message: "history cannot be replayed" },
      scope: { kind: "production" },
      preset: "master",
    });
    assert.deepEqual(result, { ok: false, reason: "timeline is invalid: history cannot be replayed" });
  });

  it("agrees with the FFmpeg graph about source, stacking and gaps at named seconds", () => {
    const value = production();
    const seeded = seedStoryPictureTimeline(value);
    // sh_3 (a gap) moves first, sh_2 is deleted so frames 100–138 are a hole, sh_1 gets a head trim.
    const edited = applyTimelineCommands(seeded, [
      { kind: "move-adjacent", clipId: "cl_sh-3", direction: "earlier" },
      { kind: "move-adjacent", clipId: "cl_sh-3", direction: "earlier" },
      { kind: "delete", clipId: "cl_sh-2" },
      { kind: "trim", clipId: "cl_sh-1", edge: "start", deltaFrames: 5 },
    ]);
    const plan = planOf(buildRenderPlan({ production: value, artifacts, timeline: { status: "ready", timeline: edited }, scope: { kind: "production" }, preset: "review-cut" }));
    assert.equal(plan.revision, 1, "four commands in one batch are one revision");
    assert.deepEqual(
      plan.items.map((item) => [item.type, item.durationSec]),
      [
        ["slate", 4],
        ["black", 0.2],
        ["clip", 1.8],
        ["black", 1.52],
      ],
      "gap slate, the hole a head trim opened, the trimmed clip, then the hole the deleted last clip left",
    );
    assert.equal(plan.totalSec, 7.52, "Delete is not Ripple delete at the end of the track either");
    const args = buildFfmpegArgs(plan, "/w", "/out.mp4", "/fonts/Geist-Regular.ttf");
    const named = [0.5, 1.5, 2.9, 3.5, 4.1, 4.5, 5.9, 6.5, 7.4];
    for (const sec of named) {
      const expected = pictureAtSec(plan, sec);
      const graph = ffmpegPictureAtSec(args, sec);
      assert.ok(expected, `plan answers at ${sec}s`);
      assert.deepEqual(
        graph,
        { path: expected.path, layer: expected.layer, sourceSec: expected.sourceSec },
        `preview and FFmpeg agree at ${sec}s`,
      );
    }
    // The placed still shows where the export window says, above the base picture (issue 486).
    assert.equal(pictureAtSec(plan, 1.5)?.path, "artifacts/plate.png");
    assert.equal(pictureAtSec(plan, 1.5)?.layer, 2, "lane 1 composites after lane 0, so it is the second overlay");
    // The video insert composites over the still while both cover a moment: lane 0 is under
    // lane 1 in the legacy order, and the plan keeps that order.
    assert.equal(pictureAtSec(plan, 2.9)?.path, "artifacts/plate.png");
    assert.equal(pictureAtSec(plan, 3.5)?.path, "artifacts/insert.mp4");
    assert.equal(pictureAtSec(plan, 3.5)?.sourceSec, 1);
    // The trimmed clip plays from its source offset.
    const clipAt = pictureAtSec(plan, 4.5);
    assert.equal(clipAt?.path, `productions/bell-watch/takes/${TAKE}/clip.mp4`);
    assert.equal(clipAt?.sourceSec, 0.2 + (4.5 - 4.2));
    assert.equal(pictureAtSec(plan, 4.1)?.path, null, "the hole a trim opened is black, not a slate");
    assert.equal(pictureAtSec(plan, 6.5)?.path, null, "the deleted last clip's range is black, not a slate");
    assert.equal(pictureAtSec(plan, 7.6), null, "nothing plays past the film");
    assert.equal(pictureAtSec(plan, 0.5)?.label, "SHOT 3 · sh_3 · 4.0s", "an unresolved shot is a labelled slate");
    assert.deepEqual(pictureEdges(plan), [0, 1, 2.5, 3, 4, 4.2, 6, 7.52]);
  });

  it("refuses a placed clip whose artifact is missing or has no picture, by name", () => {
    const value = production();
    const seeded = seedStoryPictureTimeline(value);
    const withTrack = {
      ...seeded,
      tracks: [
        ...seeded.tracks,
        {
          id: "tr_inserts" as const,
          kind: "picture" as const,
          name: "Inserts",
          order: 1,
          muted: false,
          clips: [
            {
              id: "cl_ghost" as const,
              startFrame: 10,
              durationFrames: 20,
              sourceInFrames: 0,
              source: { kind: "artifact" as const, artifactId: "ar_01J8G0000000000000000000ZZ", label: "gone.mp4" },
            },
          ],
        },
      ],
    };
    const missing = buildRenderPlan({ production: value, artifacts, timeline: { status: "ready", timeline: withTrack }, scope: { kind: "production" }, preset: "review-cut" });
    assert.deepEqual(missing, { ok: false, reason: "cl_ghost cites artifact ar_01J8G0000000000000000000ZZ, which this world does not have" });

    const document = {
      ...withTrack,
      tracks: withTrack.tracks.map((track) =>
        track.id === "tr_inserts"
          ? { ...track, clips: [{ ...track.clips[0]!, source: { kind: "artifact" as const, artifactId: NOTES, label: "notes.md" } }] }
          : track,
      ),
    };
    const paper = buildRenderPlan({ production: value, artifacts, timeline: { status: "ready", timeline: document }, scope: { kind: "production" }, preset: "review-cut" });
    assert.deepEqual(paper, { ok: false, reason: "cl_ghost cites notes.md, which is document and has no picture" });

    const insert = {
      ...withTrack,
      tracks: withTrack.tracks.map((track) =>
        track.id === "tr_inserts"
          ? { ...track, clips: [{ ...track.clips[0]!, source: { kind: "artifact" as const, artifactId: INSERT, label: "insert.mp4" } }] }
          : track,
      ),
    };
    const plan = planOf(buildRenderPlan({ production: production({ cut: { audio: [], overlays: [] } }), artifacts, timeline: { status: "ready", timeline: insert }, scope: { kind: "production" }, preset: "review-cut" }));
    assert.deepEqual(plan.overlays, [{ path: "artifacts/insert.mp4", startSec: 0.4, endSec: 1.2, still: false }]);
    const args = buildFfmpegArgs(plan, "/w", "/out.mp4", "/fonts/Geist-Regular.ttf");
    assert.deepEqual(ffmpegPictureAtSec(args, 1), { path: "artifacts/insert.mp4", layer: 1, sourceSec: 0.6 });
    assert.deepEqual(ffmpegPictureAtSec(args, 1.3), { path: `productions/bell-watch/takes/${TAKE}/clip.mp4`, layer: 0, sourceSec: 1.3 });
  });

  it("keeps placed work that outlives the last Picture clip inside the film", () => {
    const value = production({
      cut: {
        audio: [],
        overlays: [{ id: "ov_01J8G0000000000000000000B9", artifactId: BELLS, startSec: 6, endSec: 12, lane: 0, audio: "keep" }],
      },
    });
    const plan = planOf(buildRenderPlan({ production: value, artifacts, timeline: { status: "ready", timeline: seedStoryPictureTimeline(value) }, scope: { kind: "production" }, preset: "master" }));
    assert.equal(plan.totalSec, 12);
    assert.deepEqual(plan.items.at(-1), { type: "black", durationSec: 4.48 }, "from the frame-quantised 7.52s end of the picture");
    assert.deepEqual(plan.range, { startSec: 0, endSec: 12 });
  });
});
