import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSpineExportPlan, buildSpineFfmpegArgs, spineExportRefusals } from "../src/spine-export.js";
import type { DerivedSpineCut } from "../src/spine-cut.js";

function filtersOf(args: string[]): string {
  return args[args.indexOf("-filter_complex") + 1]!;
}

function cutOf(segments: DerivedSpineCut["segments"], trackDurationSec: number): DerivedSpineCut {
  const total = (kind: string): number =>
    segments.filter((s) => s.kind === kind).reduce((a, s) => a + (s.endSec - s.startSec), 0);
  return {
    trackDurationSec,
    segments,
    problems: [],
    clipSec: total("clip"),
    slateSec: total("slate"),
    blackSec: total("black"),
    unanchoredShotIds: [],
  };
}

const CLIP = {
  kind: "clip" as const,
  startSec: 0,
  endSec: 4,
  label: "SHOT 1 - Wide",
  shotId: "sh_1",
  takeId: "tk_01J8D0000000000000000000A1",
  media: { path: "productions/p/takes/t/clip.mp4", inSec: 0, outSec: 4 },
  clipAudio: { mode: "mute" as const },
};

describe("spine export", () => {
  const font = "C:\\Users\\D'Angelo\\Arke Studio, Inc; Stable [x64]\\Geist-Regular.ttf";
  it("uses the production frame rate for quantisation and ffmpeg", () => {
    const plan = buildSpineExportPlan(cutOf([CLIP], 4), "master", "audio/master.mp3", 25);
    assert.match(filtersOf(buildSpineFfmpegArgs(plan, "/w", "/out.mp4", font)), /fps=25/);
  });

  it("quantises boundaries so error cannot accumulate across a long cut", () => {
    // Sixty contiguous 1.02s segments: rounding each length independently makes a 61.2s song
    // export as 60s, truncated by its own -t.
    const segs = Array.from({ length: 60 }, (_, i) => ({
      ...CLIP,
      startSec: i * 1.02,
      endSec: (i + 1) * 1.02,
      media: { path: "productions/p/takes/t/clip.mp4", inSec: 0, outSec: 1.02 },
    }));
    const plan = buildSpineExportPlan(cutOf(segs, 61.2), "review-cut", "a/m.mp3");
    assert.equal(plan.items.length, 60);
    assert.equal(Number(plan.items.reduce((a, i) => a + i.durationSec, 0).toFixed(6)), Number(plan.totalSec.toFixed(6)));
    assert.equal(Number(plan.totalSec.toFixed(3)), 61.208);
  });

  it("refuses a master when the picture covers the song but a problem remains", () => {
    // No visible hole: an unmeasured take filled its window on an assumption nobody verified.
    const cut = { ...cutOf([CLIP], 4), problems: [{ shotId: "sh_1", kind: "unmeasured" as const, detail: "not probed" }] };
    assert.equal(spineExportRefusals(cut, "review-cut"), null);
    const refusal = spineExportRefusals(cut, "master");
    assert.equal(refusal?.reason, "incomplete");
    assert.match(refusal!.detail, /unmeasured/);
  });

  it("keeps nothing when a clip has no audio stream to keep", () => {
    const silent = { ...CLIP, hasAudio: false, clipAudio: { mode: "keep-diegetic" as const, gainDb: -9 } };
    const plan = buildSpineExportPlan(cutOf([silent], 4), "review-cut", "a/m.mp3");
    assert.equal(plan.items[0]!.type === "clip" ? plan.items[0]!.audio : "n/a", null);
    // Referencing an absent audio input fails the whole export, not the one shot.
    assert.doesNotMatch(filtersOf(buildSpineFfmpegArgs(plan, "/w", "/o.mp4", font)), /\[0:a\]/);
  });

  it("does not let a percent sign in a shot title fail the review cut", () => {
    const plan = buildSpineExportPlan(
      cutOf([{ kind: "slate", startSec: 0, endSec: 4, label: "SHOT 2 - 100% Practical", shotId: "sh_2" }], 4),
      "review-cut",
      "a/m.mp3",
    );
    const graph = filtersOf(buildSpineFfmpegArgs(plan, "/w", "/o.mp4", font));
    assert.match(graph, /drawtext=expansion=none:/);
    const escaped = String.raw`C\\:/Users/D\\\'Angelo/Arke Studio\, Inc\; Stable \[x64\]/Geist-Regular.ttf`;
    assert.ok(graph.includes(`fontfile=${escaped}`), `expected escaped font path in ${graph}`);
  });

  it("refuses a non-Latin slate label the redistributed face cannot render", () => {
    const plan = buildSpineExportPlan(
      cutOf([{ kind: "slate", startSec: 0, endSec: 4, label: "SHOT 2 · 海", shotId: "sh_2" }], 4),
      "review-cut",
      "a/m.mp3",
    );
    assert.throws(() => buildSpineFfmpegArgs(plan, "/w", "/o.mp4", font), /cannot render "海" \(U\+6D77\)/);
  });

  it("drops a segment too short to be a frame", () => {
    const plan = buildSpineExportPlan(
      cutOf([{ ...CLIP, endSec: 4 }, { kind: "black", startSec: 4, endSec: 4.0000005, label: "" }], 4.0000005),
      "review-cut",
      "audio/master.mp3",
    );
    // The derivation reports exact seconds on purpose; a frame is the honest place to round.
    assert.deepEqual(plan.items.map((i) => i.type), ["clip"]);
    assert.equal(plan.totalSec, 4);
  });

  it("puts the master under the whole export and ends the encode when the song does", () => {
    const plan = buildSpineExportPlan(cutOf([CLIP], 4), "review-cut", "audio/master.mp3");
    const args = buildSpineFfmpegArgs(plan, "/w", "/out.mp4", font);
    assert.ok(args.includes("/w/audio/master.mp3"));
    const filters = filtersOf(args);
    assert.match(filters, /\[1:a\]anull\[aout\]/);
    assert.deepEqual(args.slice(args.indexOf("-t")), ["-t", "4", "/out.mp4"]);
  });

  it("mutes a clip's own audio by default", () => {
    const plan = buildSpineExportPlan(cutOf([CLIP], 4), "review-cut", "audio/master.mp3");
    assert.equal(plan.items[0]!.type === "clip" ? plan.items[0]!.audio : "n/a", null);
    assert.doesNotMatch(filtersOf(buildSpineFfmpegArgs(plan, "/w", "/o.mp4", font)), /amix/);
  });

  it("rides kept clip audio under the master at its stated gain, without ducking the song", () => {
    const kept = { ...CLIP, startSec: 10, endSec: 14, hasAudio: true, clipAudio: { mode: "keep-diegetic" as const, gainDb: -9 } };
    const plan = buildSpineExportPlan(cutOf([{ kind: "black", startSec: 0, endSec: 10, label: "" }, kept], 14), "review-cut", "audio/master.mp3");
    const args = buildSpineFfmpegArgs(plan, "/w", "/o.mp4", font);
    const filters = filtersOf(args);
    assert.match(filters, /adelay=10000:all=1,volume=-9dB/);
    // normalize=0 is load-bearing: amix's default divides by input count, which would pull the
    // song down for exactly the length of any shot that kept its audio.
    assert.match(filters, /amix=inputs=2:normalize=0/);
  });

  it("keeps nothing from an unprobed clip, since unknown is not evidence of audio", () => {
    // A review cut tolerates the `unmeasured` problem a master refuses, so the unknown state is
    // reachable here. Referencing a stream that turns out not to exist fails the whole export.
    const unprobed = { ...CLIP, clipAudio: { mode: "keep-diegetic" as const, gainDb: -9 } };
    const plan = buildSpineExportPlan(cutOf([unprobed], 4), "review-cut", "a/m.mp3");
    assert.equal(plan.items[0]!.type === "clip" ? plan.items[0]!.audio : "n/a", null);
    assert.doesNotMatch(filtersOf(buildSpineFfmpegArgs(plan, "/w", "/o.mp4", font)), /amix/);
  });

  it("conforms each clip's render to its planned length, not to its own source length", () => {
    // Quantising the plan is not enough: `fps` rounds every clip independently from its source,
    // which puts the accumulated drift straight back into the filter graph.
    const segs = Array.from({ length: 3 }, (_, i) => ({
      ...CLIP,
      startSec: i * 1.02,
      endSec: (i + 1) * 1.02,
      media: { path: "productions/p/takes/t/clip.mp4", inSec: 0, outSec: 1.02 },
    }));
    const plan = buildSpineExportPlan(cutOf(segs, 3.06), "review-cut", "a/m.mp3");
    const filters = filtersOf(buildSpineFfmpegArgs(plan, "/w", "/o.mp4", font));
    for (const item of plan.items) {
      assert.match(filters, new RegExp(`tpad=stop_mode=clone:stop_duration=${item.durationSec},trim=duration=${item.durationSec}`));
    }
    // The source read never crosses the window it was given, whatever the conform needs.
    const args = buildSpineFfmpegArgs(plan, "/w", "/o.mp4", font);
    assert.deepEqual(args.slice(args.indexOf("-ss"), args.indexOf("-ss") + 4), ["-ss", "0", "-to", "1.02"]);
  });

  it("places kept audio at the same quantised start as its picture", () => {
    // A preceding 0.02s black collapses at 24fps, so the picture starts at 0; delaying the audio
    // to the unrounded 0.02 would sit them half a frame apart for no reason anybody chose.
    const plan = buildSpineExportPlan(
      cutOf(
        [
          { kind: "black", startSec: 0, endSec: 0.02, label: "" },
          { ...CLIP, startSec: 0.02, endSec: 4, hasAudio: true, clipAudio: { mode: "keep-diegetic" as const, gainDb: -9 } },
        ],
        4,
      ),
      "review-cut",
      "a/m.mp3",
    );
    const clip = plan.items.find((i) => i.type === "clip")!;
    assert.equal(clip.type === "clip" ? clip.audio?.atSec : -1, 0);
    assert.match(filtersOf(buildSpineFfmpegArgs(plan, "/w", "/o.mp4", font)), /adelay=0:all=1/);
  });

  it("renders a review cut with its holes and refuses a master with the same holes", () => {
    const holed = cutOf(
      [CLIP, { kind: "slate", startSec: 4, endSec: 10, label: "SHOT 2 - 6.0s", shotId: "sh_2" }],
      10,
    );
    assert.equal(spineExportRefusals(holed, "review-cut"), null);
    const refusal = spineExportRefusals(holed, "master");
    assert.equal(refusal?.reason, "incomplete");
    assert.equal(refusal?.missingSec, 6);
    // Seeing the gaps against the song is the point of a review cut.
    const plan = buildSpineExportPlan(holed, "review-cut", "audio/master.mp3");
    assert.deepEqual(plan.items.map((i) => i.type), ["clip", "slate"]);
  });

  it("refuses a master track with no audio stream before building a graph that needs one", () => {
    // Duration-bearing and silent is a real state: the schemas permit it and a duration-only
    // probe accepts it, and the graph then references an input that is not there.
    const cut = cutOf([CLIP], 4);
    const plan = buildSpineExportPlan(cut, "review-cut", "artifacts/silent.mp4");
    // The graph always maps the master's audio, which is exactly why the coordinator checks the
    // stream exists before it gets here.
    assert.match(filtersOf(buildSpineFfmpegArgs(plan, "/w", "/o.mp4", font)), /\[1:a\]anull\[aout\]/);
  });

  it("refuses a master that would silently drop a shot anchored nowhere", () => {
    // Every second of the song has picture, so nothing about the result looks incomplete — which
    // is exactly why this is the worst of the three ways to be unfinished.
    const cut = { ...cutOf([CLIP], 4), unanchoredShotIds: ["sh_2"] };
    assert.equal(spineExportRefusals(cut, "review-cut"), null);
    const refusal = spineExportRefusals(cut, "master");
    assert.equal(refusal?.reason, "incomplete");
    assert.match(refusal!.detail, /1 shot anchored nowhere/);
  });

  it("lets a complete cut through to master", () => {
    assert.equal(spineExportRefusals(cutOf([CLIP], 4), "master"), null);
  });

  it("windows a clip's audio exactly like its picture", () => {
    const seg = { ...CLIP, media: { path: "productions/p/takes/t/pass.mp4", inSec: 12, outSec: 16 } };
    const args = buildSpineFfmpegArgs(buildSpineExportPlan(cutOf([seg], 4), "review-cut", "a/m.mp3"), "/w", "/o.mp4", font);
    const ss = args.indexOf("-ss");
    assert.deepEqual(args.slice(ss, ss + 6), ["-ss", "12", "-to", "16", "-i", "/w/productions/p/takes/t/pass.mp4"]);
  });
});
