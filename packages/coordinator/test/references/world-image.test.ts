import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ManifestModel, WorldMeta } from "@arke-studio/contracts";
import {
  WORLD_IMAGE_CANDIDATE,
  WORLD_IMAGE_DIR,
  worldImagePrompt,
  worldImageRequest,
} from "../../src/references/world-image.js";

const meta = (over: Partial<WorldMeta> = {}): WorldMeta =>
  ({
    worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC",
    slug: "the-undersong",
    schemaVersion: 1,
    name: "The Undersong",
    logline: "A coastal city where a drowned god still sings, and some people can hear it.",
    tone: "quiet dread",
    genre: "folk horror",
    canonRevision: 3,
    nextCanonId: 9,
    created: "2026-08-01T12:00:00.000Z",
    updated: "2026-08-02T12:00:00.000Z",
    ...over,
  }) as WorldMeta;

const model: ManifestModel = {
  id: "flux-2-pro",
  provider: "fal",
  capability: "image",
  displayName: "Flux 2 Pro",
  accepts: { referenceImages: 4, startFrame: false, endFrame: false },
  limits: {},
  pricing: { kind: "perMegapixel", microUsdPerMegapixel: 30000 },
};

describe("the world's key image", () => {
  it("puts the author's own sentence in, as written", () => {
    const prompt = worldImagePrompt(meta());
    assert.ok(prompt.includes("A coastal city where a drowned god still sings"), "the logline is not paraphrased");
    assert.ok(prompt.includes("The Undersong"));
    assert.ok(prompt.includes("quiet dread") && prompt.includes("folk horror"));
  });

  it("asks for a place, not a face — character sheets are where a face is decided", () => {
    const prompt = worldImagePrompt(meta());
    assert.match(prompt, /no character portraits/i);
    assert.match(prompt, /no text, no logos/i);
  });

  it("says only what the world says: absent fields are left out, never invented", () => {
    const bare = worldImagePrompt(meta({ logline: undefined, tone: undefined, genre: undefined }));
    assert.ok(bare.includes("The Undersong"));
    assert.ok(!bare.includes("Tone:"), "no empty label with nothing after it");
    assert.ok(!bare.includes("Genre:"));
    assert.ok(!bare.includes("undefined"));
  });

  it("is an ordinary image job, so the queue can estimate, ledger and cancel it", () => {
    const request = worldImageRequest(meta(), model);
    assert.equal(request.capability, "image");
    assert.equal(request.provider, "fal");
    assert.equal(request.model, "flux-2-pro");
    assert.equal(request.target.kind, "world-image");
    assert.equal(request.target.id, meta().worldId);
    assert.ok(request.estimatedMicroUsd > 0, "estimated before it runs, like everything that spends");
  });

  it("lands where it can be looked at and said yes to, not straight over the world's image", () => {
    const request = worldImageRequest(meta(), model);
    assert.equal(request.landing.dir, WORLD_IMAGE_DIR);
    assert.equal(request.landing.name, WORLD_IMAGE_CANDIDATE);
    assert.ok(!request.landing.dir.includes("world-art"), "the world keeps the image it has until asked");
  });
});
