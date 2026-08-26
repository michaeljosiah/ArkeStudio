import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MEDIA_CANVAS_MIN_SEC,
  buildExportPlan,
  buildFfmpegArgs,
  exportOverlays,
  isMediaOnly,
  mediaCanvasSec,
  placedExtentSec,
} from "../src/cut.js";
import type { CutOverlay, DerivedCut } from "../src/cut.js";

/**
 * Compositing overlays into the export (82a binding 4: one that does not reach the export is
 * decoration). The filter graph was settled against ffmpeg 8.1 before it was written — a blue
 * film with a red plate placed 2s→4s reads blue, red, blue at 1s, 3s and 5s — and what is pinned
 * here is the arguments that produce it.
 */

const cut = { entries: [{ durationSec: 6, label: "SHOT 1", media: { path: "p/a.mp4" } }], totalSec: 6 } as unknown as DerivedCut;

/** Bare filenames, as a real sidecar holds them — the resolver is what names `artifacts/`. */
const artifacts = [
  { id: "ar_01J8G0000000000000000000A1", file: "plate.png", kind: "image" },
  { id: "ar_01J8G0000000000000000000A2", file: "insert.mp4", kind: "video" },
  { id: "ar_01J8G0000000000000000000A3", file: "bells.wav", kind: "audio" },
  { id: "ar_01J8G0000000000000000000A4", file: "notes.md", kind: "document" },
  { id: "ar_01J8G0000000000000000000A5", file: "board.png", kind: "board" },
];

const overlay = (artifactId: string, startSec: number, endSec: number): CutOverlay =>
  ({ id: "ov_01J8G0000000000000000000B1", artifactId, startSec, endSec }) as CutOverlay;

describe("resolving overlays for the exporter", () => {
  it("takes picture, and only picture", () => {
    const resolved = exportOverlays(
      [
        overlay("ar_01J8G0000000000000000000A1", 1, 2),
        overlay("ar_01J8G0000000000000000000A2", 2, 3),
        overlay("ar_01J8G0000000000000000000A5", 3, 4),
      ],
      artifacts,
    );
    assert.deepEqual(
      resolved.map((o) => [o.path, o.still]),
      [
        ["artifacts/plate.png", true],
        ["artifacts/insert.mp4", false],
        ["artifacts/board.png", true],
      ],
      "a compiled board is a picture too; a still holds, a clip does not",
    );
  });

  it("drops what is not a frame rather than rendering it as an absence", () => {
    // The OV lane accepts anything draggable; the exporter is where "over the picture" has to
    // mean something, so audio and documents are simply not laid over anything.
    const resolved = exportOverlays(
      [overlay("ar_01J8G0000000000000000000A3", 0, 5), overlay("ar_01J8G0000000000000000000A4", 0, 5)],
      artifacts,
    );
    assert.deepEqual(resolved, []);
  });

  it("drops one citing an artifact the world no longer has", () => {
    assert.deepEqual(exportOverlays([overlay("ar_01J8G0000000000000000000ZZ", 0, 5)], artifacts), []);
  });

  it("orders by when, so the later placement composites on top", () => {
    const resolved = exportOverlays(
      [overlay("ar_01J8G0000000000000000000A2", 9, 10), overlay("ar_01J8G0000000000000000000A1", 1, 2)],
      artifacts,
    );
    assert.deepEqual(
      resolved.map((o) => o.startSec),
      [1, 9],
    );
  });
});

describe("the arguments an overlay produces", () => {
  const args = (overlays: Parameters<typeof buildExportPlan>[2], of: DerivedCut = cut) =>
    buildFfmpegArgs(buildExportPlan(of, "review-cut", overlays), "/w", "/out.mp4", "/fonts/Geist-Regular.ttf");
  /** The filter graph is one argument; reading it is what most of these assert against. */
  const graphOf = (a: string[]) => a[a.indexOf("-filter_complex") + 1] ?? "";

  it("emits exactly what it always did when there are none", () => {
    const plain = args([]);
    assert.equal(plain[plain.indexOf("-map") + 1], "[out]", "the concat output is still the film");
    assert.ok(!plain.some((a) => a === "-loop"), "nothing is held");
    assert.ok(!plain.join(" ").includes("overlay="), "and nothing is laid over anything");
  });

  it("holds a still for the film's length, so its window has something to show", () => {
    const withStill = args([{ path: "artifacts/plate.png", startSec: 2, endSec: 4, still: true }]);
    const loop = withStill.indexOf("-loop");
    assert.notEqual(loop, -1);
    assert.deepEqual(withStill.slice(loop, loop + 4), ["-loop", "1", "-t", "6"], "held for the whole 6s film");
    assert.equal(withStill[loop + 5], "/w/artifacts/plate.png");
  });

  it("shifts a clip to where it was placed, and never holds it", () => {
    const withClip = args([{ path: "artifacts/insert.mp4", startSec: 2, endSec: 4, still: false }]);
    assert.ok(!withClip.includes("-loop"), "a clip has its own timeline; holding it would freeze a frame");
    const graph = graphOf(withClip);
    assert.match(graph, /setpts=PTS-STARTPTS\+2\/TB/, "moved to its start, or it plays from the top of the film");
  });

  it("confines each to its own window and lets the film outlive it", () => {
    const graph = graphOf(args([{ path: "artifacts/plate.png", startSec: 2, endSec: 4, still: true }]));
    assert.match(graph, /enable='between\(t,2,4\)'/, "outside its window the picture is unchanged");
    assert.match(graph, /eof_action=pass/, "a clip running out must not end the film");
  });

  it("chains several so the map is the last one, not the concat", () => {
    const many = args([
      { path: "artifacts/plate.png", startSec: 1, endSec: 2, still: true },
      { path: "artifacts/insert.mp4", startSec: 3, endSec: 4, still: false },
    ]);
    const graph = graphOf(many);
    assert.match(graph, /\[out\]\[o0\]overlay=.*\[ov0\]/, "the first lands on the assembled picture");
    assert.match(graph, /\[ov0\]\[o1\]overlay=.*\[ov1\]/, "and the second on the first");
    assert.equal(many[many.indexOf("-map") + 1], "[ov1]", "what is encoded is the last one");
  });

  it("numbers overlay inputs after every clip and slate", () => {
    const two = {
      entries: [
        { durationSec: 3, label: "SHOT 1", media: { path: "p/a.mp4" } },
        { durationSec: 3, label: "SHOT 2", media: null },
      ],
      totalSec: 6,
    } as unknown as DerivedCut;
    // Two items means inputs 0 and 1; the overlay is input 2, and reading it as 1 would lay the
    // slate over the film.
    const graph = graphOf(args([{ path: "artifacts/plate.png", startSec: 0, endSec: 1, still: true }], two));
    assert.match(graph, /\[2:v\]scale=/);
  });
});

/**
 * A shot's slot is binding (issue 450).
 *
 * `buildExportPlan` always knew each item's authored duration and the encoder used it for slates
 * alone, so an untrimmed take handed its whole source to the concat: a 4s shot holding an 8s take
 * exported eight seconds of picture against a cut that said four. What made it more than a wrong
 * number is that a placed clip is positioned in absolute output time — so every shot after an
 * overrun slid out from under whatever had been laid over it, while the sound, conformed to
 * `totalSec`, stopped early and left the overrun silent.
 *
 * Verified against ffmpeg 8.1.2 before being pinned here: three 4s slots fed 8s, 2s and 4s
 * sources encode to exactly 12.000s of video and 12.000s of audio, reading blue at 1s and 3.5s,
 * green at 4.5s and 7.5s, and red at 8.5s and 11.5s — the oversized one cut, the undersized one
 * clone-padded, and a sound placed 5s→7s landing inside the second shot rather than beside it.
 */
describe("a shot's slot is what a clip is conformed to", () => {
  const graphFor = (entries: { durationSec: number; media: { path: string } | null }[]) => {
    const of = { entries: entries.map((e, i) => ({ ...e, label: `SHOT ${i + 1}` })), totalSec: entries.reduce((a, e) => a + e.durationSec, 0) } as unknown as DerivedCut;
    const a = buildFfmpegArgs(buildExportPlan(of, "review-cut"), "/w", "/out.mp4", "/fonts/Geist-Regular.ttf");
    return a[a.indexOf("-filter_complex") + 1] ?? "";
  };

  it("cuts a clip to its shot's slot and pads a short one up to it", () => {
    const graph = graphFor([{ durationSec: 4, media: { path: "p/a.mp4" } }]);
    // Both halves, because either alone leaves one direction of the defect in place: `trim`
    // without `tpad` still lets a short take shorten the film.
    assert.match(graph, /tpad=stop_mode=clone:stop_duration=4/, "a short take is filled to the slot");
    assert.match(graph, /trim=duration=4/, "and a long one is cut to it");
    assert.match(graph, /trim=duration=4,setpts=PTS-STARTPTS/, "each segment restarts at zero for the concat");
  });

  it("conforms every clip to its own slot, not to one length for all of them", () => {
    // The bug this pins is a single shared duration: it passes a same-length cut and fails a real
    // one, which is exactly the shape a plausible refactor takes.
    const graph = graphFor([
      { durationSec: 4, media: { path: "p/a.mp4" } },
      { durationSec: 6.5, media: { path: "p/b.mp4" } },
    ]);
    assert.match(graph, /\[0:v\][^;]*trim=duration=4,/, "the first clip takes the first slot");
    assert.match(graph, /\[1:v\][^;]*trim=duration=6\.5,/, "and the second takes its own");
  });

  it("leaves slates alone, which were always exact", () => {
    const graph = graphFor([{ durationSec: 4, media: null }]);
    assert.ok(!graph.includes("tpad="), "a slate is generated at its length, never conformed to it");
    assert.match(graph, /drawtext=/);
  });
});

/**
 * A production that is only media (issue 453).
 *
 * The picture stays derived wherever a story exists — none of this touches that. What it covers
 * is the case derivation has nothing to work from, where the clips somebody placed ARE the film.
 *
 * Verified against ffmpeg 8.1.2 before being pinned: a story-less cut carrying a 4s picture at 0s
 * and a 4s sound at 2s encodes to exactly 6.000s — the furthest thing placed, not the longer
 * canvas the screen draws — reading the clip at 1s and 3.5s, bare black at 5s with YMAX 16 (a
 * slate measures 246+, because a slate has text on it), and −91dB before the sound against
 * −21.1dB across it.
 */
describe("a production with no story", () => {
  const empty = { entries: [], covered: 0, gaps: 0, totalSec: 0, uncoveredSec: 0 } as unknown as DerivedCut;
  const graphOf = (a: string[]) => a[a.indexOf("-filter_complex") + 1] ?? "";

  it("is recognised by having nothing derived, not by having no scenes", () => {
    assert.equal(isMediaOnly(empty), true);
    assert.equal(isMediaOnly(cut), false, "a cut with entries orders a picture and is not this");
  });

  it("measures the film by what reaches furthest, counting sound as well as picture", () => {
    // The sound outlasts the picture here. Taking the picture's extent would silently cut the
    // film short of something a person placed.
    assert.equal(placedExtentSec([{ endSec: 4 }, { endSec: 6 }]), 6);
    assert.equal(placedExtentSec([]), 0, "nothing placed is not a film of some default length");
  });

  it("draws a canvas longer than the film, so there is somewhere to drop the next clip", () => {
    // The empty state has to be droppable or it is a dead end: every gesture on the Cut refuses
    // at zero, so a canvas measured only by its contents could never accept the first clip.
    assert.equal(mediaCanvasSec([]), MEDIA_CANVAS_MIN_SEC);
    assert.ok(mediaCanvasSec([{ endSec: 300 }]) > 300, "and it grows past the last clip, never stops at it");
  });

  it("exports the placed work over bare ground, at the work's length and not the canvas's", () => {
    const plan = buildExportPlan(empty, "review-cut", [{ path: "artifacts/a.mp4", startSec: 0, endSec: 4, still: false }], [
      { path: "artifacts/b.wav", startSec: 2, endSec: 6, gainDb: 0 },
    ]);
    assert.deepEqual(plan.items, [{ type: "black", durationSec: 6 }], "one bed, as long as the furthest thing placed");
    assert.equal(plan.totalSec, 6);
    assert.ok(plan.totalSec < mediaCanvasSec([{ endSec: 6 }]), "the empty canvas past the work is not part of the film");
  });

  it("writes nothing on that ground, because there is no missing work to name", () => {
    const graph = graphOf(
      buildFfmpegArgs(
        buildExportPlan(empty, "review-cut", [{ path: "artifacts/a.mp4", startSec: 0, endSec: 4, still: false }], []),
        "/w",
        "/out.mp4",
        // A font is still handed over: the point is that nothing asks it to draw anything.
        "/fonts/Geist-Regular.ttf",
      ),
    );
    // The distinction this pins: a slate names work the story asked for and nobody delivered. A
    // production with no story asked for nothing, so a label here would be reporting a fiction.
    assert.ok(!graph.includes("drawtext"), "no slate label over a film nobody left a gap in");
    assert.match(graph, /concat=n=1/, "the bed is still concatenated, so the overlay chain has a film to lay on");
  });

  it("refuses to describe an empty one as a film", () => {
    const plan = buildExportPlan(empty, "review-cut", [], []);
    // Nothing placed and no story is not a zero-length film; it is nothing yet. The screen blocks
    // on this rather than handing ffmpeg `concat=n=0`, which is not a filter graph.
    assert.deepEqual(plan.items, []);
    assert.equal(plan.totalSec, 0);
  });
});
