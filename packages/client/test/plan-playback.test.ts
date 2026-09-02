import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pictureAtSec, type ExportPlan } from "@arke-studio/contracts";
import { planSpans } from "../src/lib/plan-playback.js";
import { mediaSpans, spanAt, storySpans } from "../src/lib/cut-playback.js";
import type { DerivedCut } from "@arke-studio/contracts";

/**
 * The browser executor reads the plan, not the story (SPEC-038 R-1, R-8; issue #680). Every span
 * it plays answers the same question the plan answers, and the two legacy derivations it replaces
 * are reproduced exactly where they were right.
 */

const plan: ExportPlan = {
  preset: "review-cut",
  frameRate: 24,
  items: [
    { type: "clip", path: "p/a.mp4", durationSec: 4, label: "SHOT 1" },
    { type: "slate", label: "SHOT 2 · 2.0s", durationSec: 2 },
    { type: "black", durationSec: 1 },
    { type: "clip", path: "p/c.mp4", inSec: 3, durationSec: 3, label: "SHOT 3" },
  ],
  overlays: [
    { path: "artifacts/plate.png", startSec: 1, endSec: 2, still: true },
    { path: "artifacts/insert.mp4", startSec: 5, endSec: 8, still: false },
  ],
  audio: [],
  totalSec: 10,
};

describe("the preview reads the render plan (#680)", () => {
  it("plays what the plan says is visible between every edge", () => {
    const spans = planSpans(plan);
    assert.deepEqual(
      spans.map((span) => [span.startSec, span.endSec, span.path, span.mediaInSec, span.still ?? false]),
      [
        [0, 1, "p/a.mp4", 0, false],
        [1, 2, "artifacts/plate.png", 0, true],
        [2, 4, "p/a.mp4", 2, false],
        [4, 5, null, 0, false],
        // The insert keeps playing across 7s, but the base under it changes there, so the base
        // video the preview runs beneath it has to switch: two spans, one overlay (round nine).
        [5, 7, "artifacts/insert.mp4", 0, false],
        [7, 8, "artifacts/insert.mp4", 2, false],
        [8, 10, "p/c.mp4", 4, false],
      ],
    );
    for (const sec of [0.5, 1.5, 3, 4.5, 6.9, 8, 9.9]) {
      const span = spanAt(spans, sec);
      const visible = pictureAtSec(plan, sec);
      assert.ok(span && visible, `both answer at ${sec}s`);
      assert.equal(span.path, visible.path, `same source at ${sec}s`);
      // A still has one frame and a slate has none: only a clip's offset advances with the span.
      if (visible.path !== null && !visible.still) {
        assert.equal(span.mediaInSec + (sec - span.startSec), visible.sourceSec, `same source offset at ${sec}s`);
      }
    }
  });

  it("reproduces the story spans for a plan with no overlays", () => {
    const cut = {
      entries: [
        { durationSec: 4, label: "SHOT 1", media: { path: "p/a.mp4" } },
        { durationSec: 2, label: "SHOT 2 · gap", media: null },
        { durationSec: 3, label: "SHOT 3", media: { path: "p/c.mp4", inSec: 3 } },
      ],
      totalSec: 9,
    } as unknown as DerivedCut;
    const bare: ExportPlan = {
      ...plan,
      items: [
        { type: "clip", path: "p/a.mp4", durationSec: 4, label: "SHOT 1" },
        { type: "slate", label: "SHOT 2 · gap", durationSec: 2 },
        { type: "clip", path: "p/c.mp4", inSec: 3, durationSec: 3, label: "SHOT 3" },
      ],
      overlays: [],
      totalSec: 9,
    };
    assert.deepEqual(
      planSpans(bare).map((span) => [span.startSec, span.endSec, span.path, span.mediaInSec]),
      storySpans(cut).map((span) => [span.startSec, span.endSec, span.path, span.mediaInSec]),
    );
  });

  it("reproduces the media-only spans, top placement winning", () => {
    const placed = [
      { path: "artifacts/a.mp4", startSec: 1, endSec: 5, still: false },
      { path: "artifacts/b.png", startSec: 3, endSec: 4, still: true },
    ];
    const mediaOnly: ExportPlan = {
      ...plan,
      items: [{ type: "black", durationSec: 5 }],
      overlays: placed,
      totalSec: 5,
    };
    assert.deepEqual(
      planSpans(mediaOnly).map((span) => [span.startSec, span.endSec, span.path, span.mediaInSec, span.still ?? false]),
      mediaSpans(placed).map((span) => [span.startSec, span.endSec, span.path, span.mediaInSec, span.still ?? false]),
    );
  });
});
