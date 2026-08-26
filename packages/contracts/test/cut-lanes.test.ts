import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CutOverlaySchema,
  buildExportPlan,
  buildFfmpegArgs,
  exportAudioClips,
  exportOverlays,
} from "../src/cut.js";
import type { CutOverlay, DerivedCut } from "../src/cut.js";

/**
 * Lanes, and the sound a placed clip carries.
 *
 * The rule the whole feature rests on: a lane has no type. What a clip does is read from the
 * artifact it cites, so one lane can hold a picture and the next the sound split out of that
 * same file — and the exporter is the only place that has to know the difference.
 */

const cut = {
  entries: [{ durationSec: 6, label: "SHOT 1", media: { path: "p/a.mp4" } }],
  totalSec: 6,
} as unknown as DerivedCut;

const PLATE = "ar_01J8G0000000000000000000A1";
const INSERT = "ar_01J8G0000000000000000000A2";
const BELLS = "ar_01J8G0000000000000000000A3";
const SILENT = "ar_01J8G0000000000000000000A4";
const UNPROBED = "ar_01J8G0000000000000000000A5";

/**
 * `file` is a bare filename, because that is what a sidecar on disk actually holds — it is the
 * name *within* `artifacts/`, and the scanner files it verbatim. Writing the directory in here
 * is what let the exporter ship a path one level too high for a year: the fixture supplied the
 * prefix the resolver forgot, so every assertion below agreed with a graph ffmpeg could not open.
 */
const artifacts = [
  { id: PLATE, file: "plate.png", kind: "image" },
  { id: INSERT, file: "insert.mp4", kind: "video", mediaInfo: { hasAudio: true } },
  { id: BELLS, file: "bells.wav", kind: "audio" },
  { id: SILENT, file: "silent.mp4", kind: "video", mediaInfo: { hasAudio: false } },
  { id: UNPROBED, file: "unknown.mp4", kind: "video" },
];

const clip = (
  artifactId: string,
  startSec: number,
  endSec: number,
  extra: Partial<CutOverlay> = {},
): CutOverlay =>
  ({
    id: "ov_01J8G0000000000000000000B1",
    artifactId,
    startSec,
    endSec,
    lane: 0,
    audio: "keep",
    ...extra,
  }) as CutOverlay;

describe("a lane is a stacking order, not a type", () => {
  it("composites the higher lane last, whatever the clocks say", () => {
    const resolved = exportOverlays(
      [clip(INSERT, 0, 5, { lane: 0 }), clip(PLATE, 4, 5, { lane: 3 })],
      artifacts,
    );
    assert.deepEqual(
      resolved.map((o) => o.path),
      ["artifacts/insert.mp4", "artifacts/plate.png"],
      "lane 3 is nearer the viewer than lane 0, so it is laid after it",
    );
  });

  it("falls back to when, for two clips sharing one lane", () => {
    const resolved = exportOverlays(
      [clip(PLATE, 9, 10, { lane: 2 }), clip(INSERT, 1, 2, { lane: 2 })],
      artifacts,
    );
    assert.deepEqual(
      resolved.map((o) => o.startSec),
      [1, 9],
    );
  });

  it("reads a clip filed before lanes existed as lane 0, sound kept", () => {
    const parsed = CutOverlaySchema.parse({
      id: "ov_01J8G0000000000000000000B1",
      artifactId: PLATE,
      startSec: 1,
      endSec: 2,
    });
    assert.equal(parsed.lane, 0);
    assert.equal(parsed.audio, "keep");
  });

  it("refuses a lane past the last one rather than drawing off the end", () => {
    const beyond = {
      id: "ov_01J8G0000000000000000000B1",
      artifactId: PLATE,
      startSec: 1,
      endSec: 2,
      lane: 99,
    };
    assert.equal(CutOverlaySchema.safeParse(beyond).success, false);
  });
});

describe("the two halves a split leaves behind", () => {
  it("keeps the picture and drops the sound on the muted half", () => {
    const half = [clip(INSERT, 2, 4, { lane: 1, audio: "mute" })];
    assert.deepEqual(
      exportOverlays(half, artifacts).map((o) => o.path),
      ["artifacts/insert.mp4"],
    );
    assert.deepEqual(exportAudioClips(half, artifacts), []);
  });

  it("keeps the sound and lays no picture on the audio-only half", () => {
    const half = [clip(INSERT, 2, 4, { lane: 0, audio: "only" })];
    assert.deepEqual(exportOverlays(half, artifacts), []);
    assert.deepEqual(
      exportAudioClips(half, artifacts).map((c) => c.path),
      ["artifacts/insert.mp4"],
    );
  });

  it("renders both halves of one split file exactly once each", () => {
    const split = [
      clip(INSERT, 2, 4, { lane: 1, audio: "mute" }),
      clip(INSERT, 2, 4, { lane: 0, audio: "only" }),
    ];
    assert.equal(exportOverlays(split, artifacts).length, 1);
    assert.equal(exportAudioClips(split, artifacts).length, 1);
  });
});

describe("which clips are known to carry sound", () => {
  it("takes a dropped video's own sound by default — a person chose this file", () => {
    assert.deepEqual(
      exportAudioClips([clip(INSERT, 0, 3)], artifacts).map((c) => c.path),
      ["artifacts/insert.mp4"],
    );
  });

  it("takes an audio artifact with no probe, because its kind is the evidence", () => {
    assert.deepEqual(
      exportAudioClips([clip(BELLS, 0, 3)], artifacts).map((c) => c.path),
      ["artifacts/bells.wav"],
    );
  });

  it("takes nothing from an unprobed video: unknown is not evidence of a stream", () => {
    // Naming an audio input that is not there fails the whole encode, not the one clip.
    assert.deepEqual(exportAudioClips([clip(UNPROBED, 0, 3)], artifacts), []);
  });

  it("takes nothing from a video measured as silent", () => {
    assert.deepEqual(exportAudioClips([clip(SILENT, 0, 3)], artifacts), []);
  });

  it("takes nothing from a still, whatever its clip says about sound", () => {
    assert.deepEqual(exportAudioClips([clip(PLATE, 0, 3, { audio: "only" })], artifacts), []);
  });

  it("drops a clip citing an artifact the world no longer has", () => {
    assert.deepEqual(exportAudioClips([clip("ar_01J8G0000000000000000000ZZ", 0, 3)], artifacts), []);
  });

  /*
   * The bug the whole feature died on, and the reason nothing it emitted had ever encoded: both
   * resolvers handed back the sidecar's `file` untouched, so ffmpeg was asked for
   * `<world>/bells.wav` when the bytes are at `<world>/artifacts/bells.wav`, and the export
   * failed on an input that was plainly there. Pinned against the resolvers rather than the
   * graph, because the graph was never wrong.
   */
  it("names the artifacts directory, since a sidecar's file is only the name within it", () => {
    const picture = exportOverlays([clip(PLATE, 1, 2)], artifacts);
    const sound = exportAudioClips([clip(BELLS, 1, 2)], artifacts);
    assert.equal(picture[0]?.path, "artifacts/plate.png");
    assert.equal(sound[0]?.path, "artifacts/bells.wav");
    for (const p of [picture[0]?.path, sound[0]?.path]) {
      assert.ok(p?.startsWith("artifacts/"), `${p} is missing the artifacts/ directory`);
    }
  });
});

describe("the arguments sound produces", () => {
  const font = "C:\\Users\\D'Angelo\\Arke Studio, Inc; Stable [x64]\\Geist-Regular.ttf";
  const argsFor = (
    overlays: Parameters<typeof buildExportPlan>[2],
    audio: Parameters<typeof buildExportPlan>[3],
  ) => buildFfmpegArgs(buildExportPlan(cut, "review-cut", overlays, audio), "/w", "/out.mp4", font);
  const graphOf = (a: string[]) => a[a.indexOf("-filter_complex") + 1] ?? "";

  it("pins every slate to the redistributed font with Windows filter escaping", () => {
    const slateCut = { entries: [{ durationSec: 6, label: "SHOT 1", media: null }], totalSec: 6 } as unknown as DerivedCut;
    const graph = graphOf(buildFfmpegArgs(buildExportPlan(slateCut, "review-cut"), "/w", "/out.mp4", font));
    const escaped = String.raw`C\\:/Users/D\\\'Angelo/Arke Studio\, Inc\; Stable \[x64\]/Geist-Regular.ttf`;
    assert.ok(
      graph.includes(`drawtext=fontfile=${escaped}:text=`),
      `expected escaped font path in ${graph}`,
    );
    assert.doesNotMatch(graph, /drawtext=text=/, "host font discovery is never the fallback");
  });

  it("refuses a slate label the redistributed face would render as missing-glyph boxes", () => {
    const slateCut = { entries: [{ durationSec: 6, label: "SHOT 1 · 海", media: null }], totalSec: 6 } as unknown as DerivedCut;
    assert.throws(
      () => buildFfmpegArgs(buildExportPlan(slateCut, "review-cut"), "/w", "/out.mp4", font),
      /cannot render "海" \(U\+6D77\).*SHOT 1/,
    );
  });

  it("emits no audio map at all when nothing placed carries sound", () => {
    const plain = argsFor([], []);
    assert.equal(plain.includes("[aout]"), false);
    assert.equal(plain.includes("-c:a"), false);
    assert.deepEqual(plain, buildFfmpegArgs(buildExportPlan(cut, "review-cut"), "/w", "/out.mp4", font));
  });

  it("delays one sound to where it was placed and conforms it to the film", () => {
    const graph = graphOf(argsFor([], [{ path: "artifacts/bells.wav", startSec: 2, endSec: 4, gainDb: 0 }]));
    assert.match(graph, /adelay=2000:all=1/, "placed at 2s means delayed by 2000ms");
    assert.match(
      graph,
      /apad=whole_dur=2,atrim=duration=2/,
      "the window is two seconds, so the clip is two seconds",
    );
    assert.match(graph, /apad=whole_dur=6,atrim=duration=6.*\[aout\]/, "and the mix is the film's six");
    assert.equal(/amix/.test(graph), false, "one sound needs no mixer");
  });

  it("mixes two sounds without ducking either", () => {
    const graph = graphOf(
      argsFor(
        [],
        [
          { path: "artifacts/bells.wav", startSec: 0, endSec: 3, gainDb: 0 },
          { path: "artifacts/insert.mp4", startSec: 3, endSec: 6, gainDb: 0 },
        ],
      ),
    );
    assert.match(
      graph,
      /amix=inputs=2:normalize=0/,
      "normalize=0, or laying a second sound halves the first",
    );
  });

  it("numbers audio inputs after the picture, so the graph indexes what it means to", () => {
    const args = argsFor(
      [{ path: "artifacts/plate.png", startSec: 1, endSec: 2, still: true }],
      [{ path: "artifacts/bells.wav", startSec: 0, endSec: 3, gainDb: 0 }],
    );
    // One base item, then one overlay, so the sound is input 2.
    assert.match(graphOf(args), /\[2:a\]/);
    assert.equal(args[args.lastIndexOf("-i") + 1], "/w/artifacts/bells.wav");
  });

  it("maps picture and sound, and asks for a codec the container accepts", () => {
    const args = argsFor([], [{ path: "artifacts/bells.wav", startSec: 0, endSec: 3, gainDb: 0 }]);
    assert.equal(args[args.indexOf("[aout]") - 1], "-map");
    assert.equal(args[args.indexOf("-c:a") + 1], "aac");
  });
});
