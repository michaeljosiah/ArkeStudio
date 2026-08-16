import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ManifestModel } from "@arke-studio/contracts";
import { setupForMode, type ModeSetup } from "../src/lib/composer-mode.js";

/**
 * Switching what the bench makes (found 2026-08-16 while driving the installed app).
 *
 * The mode buttons used to reset the model and every parameter to that mode's defaults, in both
 * directions. A video setup — the model, its length, whether it makes sound — was destroyed by
 * one press of *Image*, and pressing *Video* again did not bring it back. The round trip looked
 * free and was not.
 */

const VIDEO_A: ManifestModel = {
  id: "video-a",
  provider: "fal",
  capability: "video",
  displayName: "Video A",
  accepts: { referenceImages: 0, referenceRoles: false, startFrame: false, endFrame: false },
  limits: { maxDurationSec: 8 },
  pricing: { kind: "perSecond", microUsdPerSecond: 100000 },
};
const VIDEO_B: ManifestModel = { ...VIDEO_A, id: "video-b", displayName: "Video B" };
const IMAGE_A: ManifestModel = {
  id: "image-a",
  provider: "openai",
  capability: "image",
  displayName: "Image A",
  accepts: { referenceImages: 0, referenceRoles: false, startFrame: false, endFrame: false },
  limits: {},
  pricing: { kind: "perImage", microUsdPerImage: 60000 },
};

/** A deliberate video setup: not the first row, and not the default controls. */
const CHOSEN_VIDEO: ModeSetup = {
  provider: "fal",
  model: "video-b",
  params: { kind: "video", durationSec: 10, sound: false },
};

describe("switching what the bench makes", () => {
  it("gives a mode back exactly as it was left", () => {
    const back = setupForMode("video", CHOSEN_VIDEO, [VIDEO_A, VIDEO_B]);
    assert.deepEqual(back, CHOSEN_VIDEO);
    // Which is the whole point: the length and the sound choice survive the round trip.
    assert.equal(back.params.kind === "video" && back.params.durationSec, 10);
    assert.equal(back.params.kind === "video" && back.params.sound, false);
  });

  it("starts a mode nobody has used at its own defaults", () => {
    const fresh = setupForMode("video", undefined, [VIDEO_A, VIDEO_B]);
    assert.deepEqual(fresh, { provider: "fal", model: "video-a", params: { kind: "video" } });
    assert.deepEqual(setupForMode("image", undefined, [IMAGE_A]), {
      provider: "openai",
      model: "image-a",
      params: { kind: "image", count: 1 },
    });
  });

  it("drops a remembered model that is no longer usable, rather than restoring a refusal", () => {
    // A key withdrawn or a row disabled between one press and the next: restoring video-b would
    // put a selection in the composer that the dispatch is bound to refuse.
    const narrowed = setupForMode("video", CHOSEN_VIDEO, [VIDEO_A]);
    assert.equal(narrowed.model, "video-a");
    assert.deepEqual(narrowed.params, { kind: "video" }, "and its controls go with it");
  });

  it("says nothing rather than inventing a model when a mode has no usable rows", () => {
    const none = setupForMode("video", undefined, []);
    assert.deepEqual(none, { provider: "", model: "", params: { kind: "video" } });
  });
});
