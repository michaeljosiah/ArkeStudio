import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CUT_POINT_TOLERANCE_SEC,
  SNAP_THRESHOLD_SEC,
  TIMECODE_FPS,
  formatTimecode,
  parseTimecode,
  snapToPoints,
} from "../src/lib/timeline-drag.js";

/**
 * The parts of `timeline-drag.ts` ported from LTX-Desktop (Apache-2.0 — see the file header and
 * THIRD-PARTY-NOTICES.md). Upstream ships no tests for these, so the behaviour we now depend on
 * is pinned here rather than assumed, including the two places the port deliberately differs.
 */

describe("timecode, ported", () => {
  it("is HH:MM:SS:FF at the frame rate the export presets use", () => {
    assert.equal(TIMECODE_FPS, 24);
    assert.equal(formatTimecode(0), "00:00:00:00");
    assert.equal(formatTimecode(1.5), "00:00:01:12");
    assert.equal(formatTimecode(3661.25), "01:01:01:06");
  });

  it("clamps what upstream would have rendered as nonsense", () => {
    // Upstream returned "00:00:-1:-24" for a negative and "NaN:NaN:NaN:NaN" for a non-finite;
    // a cut can ask for either while a duration is still unmeasured.
    assert.equal(formatTimecode(-5), "00:00:00:00");
    assert.equal(formatTimecode(Number.NaN), "00:00:00:00");
    assert.equal(formatTimecode(Number.POSITIVE_INFINITY), "00:00:00:00");
  });

  it("round-trips through the parser at frame precision", () => {
    for (const sec of [0, 1.5, 61.25, 3661.5]) {
      assert.equal(parseTimecode(formatTimecode(sec)), Math.floor(sec * TIMECODE_FPS) / TIMECODE_FPS);
    }
  });

  it("accepts the shorter forms, and refuses what is not a timecode", () => {
    assert.equal(parseTimecode("01:30"), 90);
    assert.equal(parseTimecode("00:01:30:12"), 90.5);
    assert.equal(parseTimecode("90"), 90);
    assert.equal(parseTimecode("abc"), null);
    assert.equal(parseTimecode(""), null);
  });
});

describe("snapping, generalised from the trim path", () => {
  it("pulls to the nearest candidate inside the threshold", () => {
    assert.equal(SNAP_THRESHOLD_SEC, 0.2);
    assert.equal(snapToPoints(10.1, [10, 12]), 10);
    assert.equal(snapToPoints(11.95, [10, 12]), 12);
  });

  it("leaves a value alone when nothing is close enough", () => {
    assert.equal(snapToPoints(11, [10, 12]), 11);
    assert.equal(snapToPoints(10.1, []), 10.1);
  });

  it("takes the nearest, not the first, when two candidates are both in range", () => {
    // Upstream applied each candidate in turn, so the last one inside the threshold won rather
    // than the closest — visible wherever two boundaries sit within 0.2s of each other.
    assert.equal(snapToPoints(10.09, [10.3, 10.1, 10.0]), 10.1);
  });

  it("keeps the cut-point tolerance upstream tuned", () => {
    assert.equal(CUT_POINT_TOLERANCE_SEC, 0.05);
  });
});
