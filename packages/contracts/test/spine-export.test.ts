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
  it("quantises segment lengths to the preset frame grid and drops what cannot be a frame", () => {
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
    const args = buildSpineFfmpegArgs(plan, "/w", "/out.mp4");
    assert.ok(args.includes("/w/audio/master.mp3"));
    const filters = filtersOf(args);
    assert.match(filters, /\[1:a\]anull\[aout\]/);
    assert.deepEqual(args.slice(args.indexOf("-t")), ["-t", "4", "/out.mp4"]);
  });

  it("mutes a clip's own audio by default", () => {
    const plan = buildSpineExportPlan(cutOf([CLIP], 4), "review-cut", "audio/master.mp3");
    assert.equal(plan.items[0]!.type === "clip" ? plan.items[0]!.audio : "n/a", null);
    assert.doesNotMatch(filtersOf(buildSpineFfmpegArgs(plan, "/w", "/o.mp4")), /amix/);
  });

  it("rides kept clip audio under the master at its stated gain, without ducking the song", () => {
    const kept = { ...CLIP, startSec: 10, endSec: 14, clipAudio: { mode: "keep-diegetic" as const, gainDb: -9 } };
    const plan = buildSpineExportPlan(cutOf([{ kind: "black", startSec: 0, endSec: 10, label: "" }, kept], 14), "review-cut", "audio/master.mp3");
    const args = buildSpineFfmpegArgs(plan, "/w", "/o.mp4");
    const filters = filtersOf(args);
    assert.match(filters, /adelay=10000:all=1,volume=-9dB/);
    // normalize=0 is load-bearing: amix's default divides by input count, which would pull the
    // song down for exactly the length of any shot that kept its audio.
    assert.match(filters, /amix=inputs=2:normalize=0/);
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

  it("lets a complete cut through to master", () => {
    assert.equal(spineExportRefusals(cutOf([CLIP], 4), "master"), null);
  });

  it("windows a clip's audio exactly like its picture", () => {
    const seg = { ...CLIP, media: { path: "productions/p/takes/t/pass.mp4", inSec: 12, outSec: 16 } };
    const args = buildSpineFfmpegArgs(buildSpineExportPlan(cutOf([seg], 4), "review-cut", "a/m.mp3"), "/w", "/o.mp4");
    const ss = args.indexOf("-ss");
    assert.deepEqual(args.slice(ss, ss + 6), ["-ss", "12", "-to", "16", "-i", "/w/productions/p/takes/t/pass.mp4"]);
  });
});
