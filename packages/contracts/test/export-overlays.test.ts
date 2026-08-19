import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildExportPlan, buildFfmpegArgs, exportOverlays } from "../src/cut.js";
import type { CutOverlay, DerivedCut } from "../src/cut.js";

/**
 * Compositing overlays into the export (82a binding 4: one that does not reach the export is
 * decoration). The filter graph was settled against ffmpeg 8.1 before it was written — a blue
 * film with a red plate placed 2s→4s reads blue, red, blue at 1s, 3s and 5s — and what is pinned
 * here is the arguments that produce it.
 */

const cut = { entries: [{ durationSec: 6, label: "SHOT 1", media: { path: "p/a.mp4" } }], totalSec: 6 } as unknown as DerivedCut;

const artifacts = [
  { id: "ar_01J8G0000000000000000000A1", file: "artifacts/plate.png", kind: "image" },
  { id: "ar_01J8G0000000000000000000A2", file: "artifacts/insert.mp4", kind: "video" },
  { id: "ar_01J8G0000000000000000000A3", file: "artifacts/bells.wav", kind: "audio" },
  { id: "ar_01J8G0000000000000000000A4", file: "artifacts/notes.md", kind: "document" },
  { id: "ar_01J8G0000000000000000000A5", file: "artifacts/board.png", kind: "board" },
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
    buildFfmpegArgs(buildExportPlan(of, "review-cut", overlays), "/w", "/out.mp4");
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
