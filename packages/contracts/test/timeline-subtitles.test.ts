import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_SUBTITLE_STYLE,
  ProductionTimelineSchema,
  TimelineOperationRefused,
  applyTimelineCommands,
  buildFfmpegArgs,
  buildRenderPlan,
  cueAtSec,
  parseSubtitles,
  redoTimelineHistory,
  seedStoryPictureTimeline,
  serializeSubtitles,
  undoTimelineHistory,
  type ProductionBundle,
  type ProductionTimeline,
  type Scene,
  type SubtitleCue,
  type TimelineClipCommand,
} from "../src/index.js";

/**
 * Subtitle tracks on the timeline (SPEC-038 R-21..R-29; issue #683): cues are authored timed
 * text on a language track, every edit is one fenced undo step, overlap on one track refuses by
 * name, and the same cues drive the preview, the burned pixels and the sidecar.
 */

const AT = "2026-09-02T09:00:00Z";
const TAKE = "tk_01J8E0000000000000000000T1";

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

function production(): ProductionBundle {
  return {
    rehearsals: [], performances: [], performanceReview: { reviews: [], selections: {}, reviewHash: null, selectionHash: null },
    meta: { id: "bell-watch", format: "video", title: "Bell Watch", status: "in-progress", frameRate: 25, failureModes: [], created: AT, updated: AT },
    story: null,
    season: null,
    routing: null,
    treatment: null,
    chapters: [],
    scenes: [scene("sc_one", 1, [{ id: "sh_1", durationSec: 2 }, { id: "sh_2", durationSec: 4 }])],
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
    cut: { audio: [], overlays: [] },
    editorRequests: [],
    takeMediaInfo: {},
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

const cue = (id: `cu_${string}`, text: string, startFrame: number, endFrame: number, speaker?: string): SubtitleCue => ({
  id,
  text,
  startFrame,
  endFrame,
  ...(speaker !== undefined ? { speaker } : {}),
});

function withSubtitles(): ProductionTimeline {
  return valid(
    apply(
      seedStoryPictureTimeline(production()),
      { kind: "add-subtitle-track", trackId: "tr_subs-en", name: "English", language: "en" },
      { kind: "add-cue", trackId: "tr_subs-en", cue: cue("cu_1", "Hello, harbour.", 10, 50, "maren-kest") },
      { kind: "add-cue", trackId: "tr_subs-en", cue: cue("cu_2", "The bells,\nfar under.", 60, 120) },
    ),
  );
}

describe("subtitle tracks and cues (#683)", () => {
  it("adds a language track and cues as one undo step, and edits with exact inverses", () => {
    const timeline = withSubtitles();
    assert.equal(timeline.revision, 1);
    const track = timeline.tracks.find((candidate) => candidate.id === "tr_subs-en")!;
    assert.equal(track.kind, "subtitle");
    assert.equal(track.language, "en");
    assert.deepEqual(track.style, DEFAULT_SUBTITLE_STYLE);
    assert.deepEqual(track.cues!.map((candidate) => candidate.id), ["cu_1", "cu_2"]);

    const edited = valid(apply(timeline, { kind: "edit-cue", cueId: "cu_1", text: "Hello, harbour!", endFrame: 55, speaker: null }));
    const changed = edited.tracks.find((candidate) => candidate.id === "tr_subs-en")!.cues![0]!;
    assert.deepEqual(changed, { id: "cu_1", text: "Hello, harbour!", startFrame: 10, endFrame: 55 });
    const undone = valid(undoTimelineHistory(edited));
    assert.deepEqual(undone.tracks.find((candidate) => candidate.id === "tr_subs-en")!.cues![0], cue("cu_1", "Hello, harbour.", 10, 50, "maren-kest"));
    assert.deepEqual(redoTimelineHistory(undone).tracks.find((candidate) => candidate.id === "tr_subs-en")!.cues![0], changed);

    const deleted = valid(apply(timeline, { kind: "delete-cue", cueId: "cu_2" }));
    assert.deepEqual(deleted.tracks.find((candidate) => candidate.id === "tr_subs-en")!.cues!.map((candidate) => candidate.id), ["cu_1"]);
    let back = deleted;
    for (let step = 0; step < 2; step += 1) back = valid(undoTimelineHistory(back));
    assert.deepEqual(back.tracks.map((candidate) => candidate.id), ["tr_picture"], "the track and its cues are gone again");

    const restyled = valid(apply(timeline, { kind: "set-subtitle-style", trackId: "tr_subs-en", style: { background: "box", relativeSize: 0.06 } }));
    assert.deepEqual(restyled.tracks.find((candidate) => candidate.id === "tr_subs-en")!.style, { ...DEFAULT_SUBTITLE_STYLE, background: "box", relativeSize: 0.06 });
    assert.deepEqual(undoTimelineHistory(restyled).tracks.find((candidate) => candidate.id === "tr_subs-en")!.style, DEFAULT_SUBTITLE_STYLE);
  });

  it("refuses overlap on one track by name, an inverted cue, and cues on other kinds", () => {
    const timeline = withSubtitles();
    assert.throws(() => apply(timeline, { kind: "add-cue", trackId: "tr_subs-en", cue: cue("cu_3", "over", 40, 70) }), /cues cu_1 and cu_3 overlap/);
    assert.throws(() => apply(timeline, { kind: "edit-cue", cueId: "cu_2", startFrame: 45 }), /cues cu_1 and cu_2 overlap/);
    assert.throws(() => apply(timeline, { kind: "edit-cue", cueId: "cu_2", endFrame: 60 }), /must end after it starts/);
    assert.throws(() => apply(timeline, { kind: "add-cue", trackId: "tr_picture", cue: cue("cu_3", "x", 0, 1) }), /not a Subtitle track/);
    assert.throws(() => apply(timeline, { kind: "add-track", trackId: "tr_subs-fr", trackKind: "subtitle", name: "French" }), /added with its language/);
    assert.throws(() => apply(timeline, { kind: "remove-track", trackId: "tr_subs-en" }), /still holds 2 subtitles/);
    // Two language tracks may overlap each other freely (R-26).
    const french = valid(
      apply(
        timeline,
        { kind: "add-subtitle-track", trackId: "tr_subs-fr", name: "Français", language: "fr" },
        { kind: "add-cue", trackId: "tr_subs-fr", cue: cue("cu_fr1", "Bonjour, le port.", 10, 50) },
      ),
    );
    assert.equal(french.tracks.filter((candidate) => candidate.kind === "subtitle").length, 2);
    const wrong = { ...timeline, tracks: timeline.tracks.map((candidate) => (candidate.id === "tr_picture" ? { ...candidate, language: "en" } : candidate)) };
    assert.equal(ProductionTimelineSchema.safeParse(wrong).success, false);
  });

  it("imports parsed rows with provenance, replacing or joining, and refuses a joined overlap whole", () => {
    const parsed = parseSubtitles("1\n00:00:00,400 --> 00:00:01,600\nOne.\n\n2\n00:00:05,000 --> 00:00:06,000\nTwo.\n", "srt", 25);
    assert.deepEqual(parsed.problems, []);
    const rows = parsed.cues.map((row, index) => ({ id: `cu_imp${index}` as const, ...row }));
    const timeline = withSubtitles();
    assert.throws(
      () => apply(timeline, { kind: "import-cues", trackId: "tr_subs-en", cues: rows, replace: false, provenance: { kind: "import", format: "srt", at: AT } }),
      TimelineOperationRefused,
      "One. overlaps cu_1, so nothing from the file lands",
    );
    const replaced = valid(apply(timeline, { kind: "import-cues", trackId: "tr_subs-en", cues: rows, replace: true, provenance: { kind: "import", format: "srt", at: AT } }));
    const cues = replaced.tracks.find((candidate) => candidate.id === "tr_subs-en")!.cues!;
    assert.deepEqual(cues.map((candidate) => [candidate.id, candidate.startFrame, candidate.endFrame, candidate.provenance?.kind]), [
      ["cu_imp0", 10, 40, "import"],
      ["cu_imp1", 125, 150, "import"],
    ]);
    const entry = replaced.history.undo.at(-1)!;
    assert.equal(entry.kind === "change" ? entry.cues.length : -1, 4, "two removed and two added, in one step");
    assert.deepEqual(undoTimelineHistory(replaced).tracks.find((candidate) => candidate.id === "tr_subs-en")!.cues!.map((candidate) => candidate.id), ["cu_1", "cu_2"]);
  });

  it("carries the chosen track into the plan, burns pixels only on request, and never touches the cues", () => {
    const timeline = withSubtitles();
    const before = JSON.stringify(timeline);
    const artifacts: never[] = [];
    const none = buildRenderPlan({ production: production(), artifacts, timeline: { status: "ready", timeline }, scope: { kind: "production" }, preset: "review-cut" });
    assert.equal(none.ok && none.plan.subtitles, null, "no track chosen, nothing viewed or delivered");

    const shown = buildRenderPlan({ production: production(), artifacts, timeline: { status: "ready", timeline }, scope: { kind: "production" }, preset: "review-cut", subtitles: { trackId: "tr_subs-en", mode: "none" } });
    assert.equal(shown.ok, true, shown.ok ? "" : shown.reason);
    if (!shown.ok) return;
    assert.deepEqual(shown.plan.subtitles?.cues.map((candidate) => [candidate.text, candidate.startSec, candidate.endSec]), [
      ["Hello, harbour.", 0.4, 2],
      ["The bells,\nfar under.", 2.4, 4.8],
    ]);
    assert.equal(cueAtSec(shown.plan, 1)?.text, "Hello, harbour.");
    assert.equal(cueAtSec(shown.plan, 2.2), null);
    assert.equal(shown.plan.burnIn, undefined, "mode none burns nothing");
    assert.ok(!buildFfmpegArgs(shown.plan, "/w", "/out.mp4", "/f.ttf").join(" ").includes("Hello"), "and the encode carries no subtitle text");

    const burned = buildRenderPlan({ production: production(), artifacts, timeline: { status: "ready", timeline }, scope: { kind: "production" }, preset: "master", subtitles: { trackId: "tr_subs-en", mode: "burn-in+sidecar", sidecar: "vtt" } });
    assert.equal(burned.ok, true);
    if (!burned.ok) return;
    const graph = buildFfmpegArgs(burned.plan, "/w", "/out.mp4", "/f.ttf");
    const filters = graph[graph.indexOf("-filter_complex") + 1]!;
    assert.match(filters, /\[out\]drawtext=expansion=none:fontfile=\/f\.ttf:text='Hello, harbour\.':fontcolor=0xffffff:fontsize=49:x=\(w-tw\)\/2:y=h-th-65:borderw=2:bordercolor=black:enable='between\(t,0\.4,2\)'\[st0\]/);
    assert.match(filters, /\[st0\]drawtext=[^;]*text='The bells,\nfar under\.'[^;]*enable='between\(t,2\.4,4\.8\)'\[st1\]/, "an authored line break reaches the pixels as a line break");
    assert.equal(graph[graph.indexOf("-map") + 1], "[st1]", "the burned picture is what is encoded");
    assert.equal(JSON.stringify(timeline), before, "burn-in changed no saved cue");

    // The sidecar is the same cues, at frame-derived timestamps.
    const sidecar = serializeSubtitles(
      timeline.tracks.find((candidate) => candidate.id === "tr_subs-en")!.cues!,
      burned.plan.subtitles!.sidecar,
      timeline.frameRate,
    );
    assert.equal(sidecar, "WEBVTT\n\n00:00:00.400 --> 00:00:02.000\nHello, harbour.\n\n00:00:02.400 --> 00:00:04.800\nThe bells,\nfar under.\n");

    const muted = apply(timeline, { kind: "set-track", trackId: "tr_subs-en", muted: true });
    const refused = buildRenderPlan({ production: production(), artifacts, timeline: { status: "ready", timeline: muted }, scope: { kind: "production" }, preset: "master", subtitles: { trackId: "tr_subs-en", mode: "sidecar" } });
    assert.deepEqual(refused, { ok: false, reason: "English is muted; unmute it or choose another subtitle track" });
    const missing = buildRenderPlan({ production: production(), artifacts, timeline: { status: "ready", timeline }, scope: { kind: "production" }, preset: "master", subtitles: { trackId: "tr_subs-de", mode: "sidecar" } });
    assert.deepEqual(missing, { ok: false, reason: "subtitle track tr_subs-de is not on the timeline" });
  });
});
