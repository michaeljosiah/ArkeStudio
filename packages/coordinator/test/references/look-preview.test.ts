import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ManifestModel } from "@arke-studio/contracts";
import { lookPreviewRequest } from "../../src/references/master-look.js";

const MODEL: ManifestModel = {
  id: "test-image",
  provider: "fal",
  capability: "image",
  displayName: "Test Image",
  accepts: { referenceImages: 3, startFrame: false, endFrame: false },
  limits: { maxReferenceAudioSec: 60 },
  pricing: { kind: "perImage", microUsdPerImage: 40000 },
};

describe("the look preview request (SPEC-031 R-50..R-53)", () => {
  it("carries the look's own words unrewritten, with the subject-exclusion clause (R-52, row 27)", () => {
    const look = "salt-bleached watercolour where Maren Kest walks the tideline";
    const request = lookPreviewRequest("gen-abc", look, MODEL);
    const prompt = String(request.params["prompt"]);
    assert.ok(prompt.startsWith(look), "the words go in as written — a rewrite is a different look");
    // R-54 promotes this image to the master look, and SPEC-017 R-9 forbids a master look
    // from introducing its subject: a face here would arrive in every character the build makes.
    assert.match(prompt, /No people, no faces/);
  });

  it("is scoped to the conversation and lands in its sandbox (R-53, R-55)", () => {
    const request = lookPreviewRequest("gen-abc", "salt watercolour", MODEL);
    assert.equal(request.worldId, "gen-abc", "no placeholder world is ever invented");
    assert.deepEqual(request.target, { kind: "look-preview", id: "gen-abc" });
    assert.deepEqual(request.landing, { dir: "previews", name: "look-preview.png" });
    assert.equal(request.params["lookText"], "salt watercolour", "the carry test's evidence rides the job too");
    assert.ok(request.estimatedMicroUsd > 0, "the estimate the control states");
  });
});
