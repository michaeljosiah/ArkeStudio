import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ArtifactSidecarSchema,
  frameDispatchFor,
  modelCapabilityCopy,
  ShotSelectionSchema,
  type ManifestModel,
} from "../src/index.js";

/**
 * Boundary frames (issue 154): the schemas that make a frame durable, and the one capability
 * query every consumer reads instead of the manifest's two vocabularies.
 */

const MODEL: ManifestModel = {
  id: "wan-like",
  provider: "fal",
  capability: "video",
  displayName: "Wan-like",
  accepts: { referenceImages: 4, startFrame: false, endFrame: false },
  limits: { maxDurationSec: 15 },
  pricing: { kind: "perSecond", microUsdPerSecond: 20000 },
  modes: {
    "first-frame": { route: "acme/wan-like/image-to-video", locked: ["aspect"] },
    "first-and-last-frame": { route: "acme/wan-like/image-to-video", locked: ["aspect"] },
  },
};

describe("boundary-frame contracts (issue 154)", () => {
  it("a selection may name a durable frame artifact, and every older selection still parses", () => {
    const modern = ShotSelectionSchema.parse({
      acceptedTakeId: "tk_01J8E0000000000000000000T1",
      startFrameTakeId: "tk_01J8E0000000000000000000T2",
      startFrameArtifactId: "ar_01J8E0000000000000000000A1",
    });
    assert.equal(modern.startFrameArtifactId, "ar_01J8E0000000000000000000A1");
    // The exact shape every selections.json written before issue 154 has.
    const legacy = ShotSelectionSchema.parse({ acceptedTakeId: "tk_01J8E0000000000000000000T1", trimInSec: 2 });
    assert.equal(legacy.startFrameArtifactId, undefined);
    // A take id where an artifact id belongs is a category error, refused at parse.
    assert.throws(() => ShotSelectionSchema.parse({ startFrameArtifactId: "tk_01J8E0000000000000000000T1" }));
  });

  it("a boundary frame is an image by definition — a clip with extraction provenance refuses", () => {
    const base = {
      id: "ar_01J8E0000000000000000000A2",
      file: "boundary-sh_2-x.png",
      hash: "sha256:0011223344556677",
      origin: { by: "system", producedBy: "boundary-frame:tk_01J8E0000000000000000000T1" },
      links: [],
      created: "2026-08-01T12:00:00.000Z",
      boundaryExtraction: {
        sourceTakeId: "tk_01J8E0000000000000000000T1",
        mediaTakeId: "tk_01J8E0000000000000000000T1",
        atSec: null,
        method: "ffmpeg-frame/1",
      },
    };
    const image = ArtifactSidecarSchema.parse({ ...base, kind: "image" });
    assert.equal(image.boundaryExtraction?.atSec, null);
    assert.throws(
      () => ArtifactSidecarSchema.parse({ ...base, kind: "video" }),
      /must be an image/,
      "a video take's media path can never pose as a frame",
    );
  });

  it("one query answers mode, route, fields and locks — or refuses (the pre-submit gate)", () => {
    const one = frameDispatchFor(MODEL, 1)!;
    assert.deepEqual(one, {
      mode: "first-frame",
      route: "acme/wan-like/image-to-video",
      fields: { start: "image_url", end: null },
      locked: ["aspect"],
    });
    const two = frameDispatchFor(MODEL, 2)!;
    assert.equal(two.mode, "first-and-last-frame");
    assert.equal(two.fields.end, "end_image_url");
    // No modes means no frame route at all — generate-only rows refuse both shapes.
    const textOnly: ManifestModel = { ...MODEL, modes: undefined };
    assert.equal(frameDispatchFor(textOnly, 1), null);
    assert.equal(frameDispatchFor(textOnly, 2), null);
  });

  it("the picker's copy reads the same authority, with the legacy flags honoured where they remain", () => {
    assert.equal(modelCapabilityCopy(MODEL), "refs ×4 · frames · 15s");
    const firstOnly: ManifestModel = {
      ...MODEL,
      modes: { "first-frame": { route: "acme/i2v", locked: [] } },
    };
    assert.equal(modelCapabilityCopy(firstOnly), "refs ×4 · start frame · 15s");
    // Halcyon-shaped: no modes, but the row itself still claims frames (issue 137) — the copy
    // keeps saying so until that row is corrected, because the copy reports the manifest.
    const legacyClaims: ManifestModel = {
      ...MODEL,
      modes: undefined,
      accepts: { referenceImages: 0, startFrame: true, endFrame: true },
    };
    assert.equal(modelCapabilityCopy(legacyClaims), "no refs · frames · 15s");
  });
});
