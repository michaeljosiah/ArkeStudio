import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { helperEdits } from "@arke-studio/contracts";
import {
  anchorHolds,
  placeTray,
  SELECTION_HELPERS,
  TRAY_FLIP_MARGIN,
  TRAY_GAP,
  TRAY_HEIGHT,
} from "../src/components/editor/selection-actions.js";

describe("the helpers on a selection", () => {
  it("offers four, and only three of them edit", () => {
    assert.deepEqual(
      SELECTION_HELPERS.map((h) => h.kind),
      ["rewrite", "expand", "tighten", "ask"],
    );
    assert.deepEqual(
      SELECTION_HELPERS.filter((h) => h.edits).map((h) => h.kind),
      ["rewrite", "expand", "tighten"],
      "ask returns an answer, so it has nothing to press into the page",
    );
  });

  it("agrees with the contract about which one cannot be pressed", () => {
    // Two ends decide this — the client withholds Replace, the coordinator prompts differently —
    // so a helper whose two verdicts disagree is the bug this catches.
    for (const helper of SELECTION_HELPERS) {
      assert.equal(helper.edits, helperEdits(helper.kind), `${helper.kind} disagrees`);
    }
  });
});

describe("where the tray goes", () => {
  it("sits below the selection, which is the rule and not the exception", () => {
    const { top, above } = placeTray(100, 140, 540);
    assert.equal(above, false);
    assert.equal(top, 140 + TRAY_GAP, "six under the last line");
  });

  it("flips above only when there is no room under the selection", () => {
    const editor = 540;
    // Exactly enough room is still room: the threshold is derived from the tray, not guessed.
    const tight = placeTray(400, editor - TRAY_FLIP_MARGIN, editor);
    assert.equal(tight.above, false, "a tray that just fits below stays below");

    const past = placeTray(400, editor - TRAY_FLIP_MARGIN + 1, editor);
    assert.equal(past.above, true);
    assert.equal(past.top, 400 - TRAY_GAP - TRAY_HEIGHT, "and clears the selection's first line");
  });

  it("never places the tray off the top of the editor", () => {
    // A selection starting on the first line of a document short enough to leave no room below.
    const { top } = placeTray(2, 30, 34);
    assert.ok(top >= 0, `flipped to ${top}, which is outside the editor`);
  });

  it("derives the flip threshold rather than restating it", () => {
    assert.equal(TRAY_FLIP_MARGIN, TRAY_HEIGHT + TRAY_GAP);
  });
});

describe("whether a result may still be pressed", () => {
  const anchor = "They hear the harbour answer it.";

  it("holds while the passage is untouched", () => {
    assert.equal(anchorHolds(anchor, anchor), true);
  });

  it("goes stale when the passage itself changed", () => {
    assert.equal(anchorHolds("They hear the harbour answer back.", anchor), false);
  });

  it("goes stale when the passage was deleted out from under it", () => {
    // The mapping's own verdict, and the case position arithmetic cannot see: two mapped positions
    // collapse onto a perfectly valid point inside whatever replaced the range.
    assert.equal(anchorHolds(anchor, anchor, true), false, "deleted outranks a text match");
    assert.equal(anchorHolds(null, anchor), false, "and so does having no range left to read");
  });
});
