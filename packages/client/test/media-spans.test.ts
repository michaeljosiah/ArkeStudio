import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mediaSpans, spanAt } from "../src/lib/cut-playback.js";
import { runtimeSeconds } from "../src/lib/format.js";

/**
 * What plays, and how long it says it runs, for a production with no story (issue 453).
 *
 * The preview reads spans; a media-only cut has no shots to build them from, so before this the
 * transport advanced over a film the preview reported as empty. These are built from the RESOLVED
 * overlays — what `exportOverlays` returns — so the preview and the encode cannot disagree about
 * what is on screen at a given second.
 */

const clip = (path: string, startSec: number, endSec: number, still = false) => ({ path, startSec, endSec, still });

describe("what plays when there is no story", () => {
  it("has nothing to play when nothing is placed", () => {
    assert.deepEqual(mediaSpans([]), []);
  });

  it("starts the film at zero even when the first clip does not", () => {
    // Leading emptiness is part of the film: a clip dropped at 3s means three seconds of black,
    // not a film that begins late.
    const spans = mediaSpans([clip("artifacts/a.mp4", 3, 7)]);
    assert.equal(spans[0]!.startSec, 0);
    assert.equal(spans[0]!.path, null, "and there is nothing to show across it");
    assert.equal(spanAt(spans, 1)!.path, null);
    assert.equal(spanAt(spans, 4)!.path, "artifacts/a.mp4");
  });

  it("shows the topmost clip where two overlap, matching what the encode composites", () => {
    // `exportOverlays` returns lane-then-start order and the exporter chains them in it, so the
    // LAST one covering a moment is the one on top. Reading the first would show the picture
    // underneath and disagree with the file.
    const spans = mediaSpans([clip("artifacts/under.mp4", 0, 10), clip("artifacts/over.mp4", 4, 6)]);
    assert.equal(spanAt(spans, 2)!.path, "artifacts/under.mp4");
    assert.equal(spanAt(spans, 5)!.path, "artifacts/over.mp4", "the higher lane wins where they overlap");
    assert.equal(spanAt(spans, 8)!.path, "artifacts/under.mp4", "and the one beneath returns after it");
  });

  it("enters a clip late at the right point in the file, and a still at its only frame", () => {
    const overlapped = mediaSpans([clip("artifacts/under.mp4", 0, 10), clip("artifacts/over.mp4", 4, 6)]);
    // Resuming `under` at 6s is six seconds into that file, not the start of it.
    assert.equal(spanAt(overlapped, 7)!.mediaInSec, 6);
    const still = mediaSpans([clip("artifacts/plate.png", 2, 8, true)]);
    assert.equal(spanAt(still, 5)!.mediaInSec, 0, "a still has one frame and no timeline to be inside");
  });

  it("says which spans are stills, because a browser will not decode one as video", () => {
    // The preview has only ever had to play footage: a shot's take and a spine segment are always
    // video. A placed clip can be a plate, and handing that to the <video> shows nothing at all
    // while the export holds the frame for its whole placement.
    const spans = mediaSpans([clip("artifacts/plate.png", 0, 4, true), clip("artifacts/b.mp4", 6, 8)]);
    assert.equal(spanAt(spans, 2)!.still, true);
    assert.equal(spanAt(spans, 7)!.still, false, "and footage is not marked as one");
  });

  it("leaves no hole between spans, so the transport is never between two of them", () => {
    const spans = mediaSpans([clip("artifacts/a.mp4", 2, 4), clip("artifacts/b.mp4", 7, 9)]);
    for (let i = 0; i < spans.length - 1; i += 1) {
      assert.equal(spans[i]!.endSec, spans[i + 1]!.startSec, "spans are contiguous");
    }
    assert.equal(spans[0]!.startSec, 0);
    assert.equal(spanAt(spans, 5)!.path, null, "the gap between two clips is empty, not missing");
  });
});

describe("a runtime measured off the timeline", () => {
  it("reads whole seconds, because a placed length is not an authored one", () => {
    assert.equal(runtimeSeconds(15), "15s");
    assert.equal(runtimeSeconds(14.776), "15s", "not a measurement in a header");
  });

  it("never calls a real film zero", () => {
    // A clip can be MIN_CLIP_SEC long. Rounding that to "0s" would make something exportable look
    // exactly like the empty production the export refuses.
    assert.equal(runtimeSeconds(0), "0s");
    assert.equal(runtimeSeconds(0.1), "0.1s");
    assert.notEqual(runtimeSeconds(0.4), "0s");
    assert.notEqual(runtimeSeconds(0.04), "0s", "even below the smallest clip it stays non-zero");
  });
});
