import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  characterImageOutput,
  estimateCharacterImageMicroUsd,
  estimateMicroUsd,
  formatMicroUsd,
  gateLocalRuntimes,
  ModelManifestSchema,
  modelCapabilityCopy,
  modelForCapability,
  passesForDuration,
  reconcileStrategy,
  sumMicroUsd,
  type ClientDeclarations,
} from "@arke-studio/contracts";
import { requireModel, SHIPPED_MANIFEST } from "../src/manifest-data.js";
import { FAL_ENDPOINTS } from "../src/fal-catalogue.generated.js";

const model = (id: string) => {
  const hit = SHIPPED_MANIFEST.models.find((m) => m.id === id);
  assert.ok(hit, `${id} in shipped manifest`);
  return hit;
};

describe("the shipped manifest (R-9, §3.2)", () => {
  it("every model round-trips through the schema", () => {
    const reparsed = ModelManifestSchema.parse(JSON.parse(JSON.stringify(SHIPPED_MANIFEST)));
    assert.deepEqual(reparsed, SHIPPED_MANIFEST);
    assert.ok(SHIPPED_MANIFEST.models.length >= 10);
  });

  it("a dispatch to an absent model is refused with a reason (R-12, D4)", () => {
    const refused = requireModel(SHIPPED_MANIFEST, "sora-9000");
    assert.equal(refused.ok, false);
    assert.ok(!refused.ok && /not in the model manifest/.test(refused.reason));
    assert.ok(!refused.ok && refused.reason.includes("v9"));
    assert.equal(requireModel(SHIPPED_MANIFEST, "seedance-2.0").ok, true);
  });

  it("every FAL model the manifest offers has a route behind it", () => {
    // The failure this prevents: a model offered in the picker, estimated, accepted, and only
    // then refused at dispatch with "no endpoint mapping" — after the user had committed.
    const offered = SHIPPED_MANIFEST.models.filter((m) => m.provider === "fal");
    assert.ok(offered.length > 0);
    for (const m of offered) {
      assert.ok(FAL_ENDPOINTS[m.id], `${m.id} has a fal route`);
      assert.match(FAL_ENDPOINTS[m.id]!, /^[a-z0-9-]+\/[a-z0-9./-]+$/, `${m.id}'s route looks like a fal route`);
    }
    // And nothing routes anywhere the manifest does not offer, which would be a model the app
    // can submit but never estimate.
    for (const id of Object.keys(FAL_ENDPOINTS)) {
      assert.ok(offered.some((m) => m.id === id), `${id} is offered in the manifest`);
    }
  });

  it("capability copy matches the manifest for accepting and refusing models (R-10)", () => {
    assert.equal(modelCapabilityCopy(model("seedance-2.0")), "refs ×4 · frames · 15s");
    assert.equal(modelCapabilityCopy(model("halcyon-1.5")), "no refs · frames · 12s");
  });

  it("declares role support and does not advertise references OpenAI drops", () => {
    for (const imageModel of SHIPPED_MANIFEST.models.filter((candidate) => candidate.capability === "image")) {
      assert.equal(typeof imageModel.accepts.referenceRoles, "boolean", `${imageModel.id} declares role support`);
    }
    assert.equal(model("gpt-image-2").accepts.referenceImages, 0);
    assert.equal(model("gpt-image-2").accepts.referenceRoles, false);
  });

  it("pass packing computes from the duration cap (§2.5)", () => {
    assert.equal(passesForDuration(model("seedance-2.0"), 40), 3); // 15s cap
    assert.equal(passesForDuration(model("seedance-2.0"), 15), 1);
    assert.equal(passesForDuration(model("seedance-2.0"), 0), 0);
  });
});

describe("estimation per pricing shape (R-11, R-15, §3.2)", () => {
  // These check the arithmetic, so they read the rate out of the manifest rather than repeating
  // it. The old versions hard-coded figures from a hand-written price list, and every one of
  // them failed the day the prices came from fal instead of from memory — which told us nothing
  // about the estimator, only that a price had changed.
  it("per second, with the resolution override", () => {
    const seedance = model("seedance-2.0");
    assert.equal(seedance.pricing.kind, "perSecond");
    if (seedance.pricing.kind !== "perSecond") return;
    const base = seedance.pricing.microUsdPerSecond;
    const hd = seedance.pricing.byResolution?.["1080p"] ?? base;
    assert.equal(estimateMicroUsd(seedance, { durationSec: 6 }), base * 6);
    assert.equal(estimateMicroUsd(seedance, { durationSec: 6, resolution: "1080p" }), hd * 6);
    assert.equal(estimateMicroUsd(seedance, { durationSec: 6, resolution: "720p" }), base * 6);
  });

  it("per image, with count and resolution override", () => {
    const banana = model("nano-banana-2");
    assert.equal(banana.pricing.kind, "perImage");
    if (banana.pricing.kind !== "perImage") return;
    const each = banana.pricing.microUsdPerImage;
    assert.equal(estimateMicroUsd(banana, {}), each);
    assert.equal(estimateMicroUsd(banana, { images: 4 }), each * 4);
    assert.equal(estimateMicroUsd(model("soul-2.0"), { images: 2, resolution: "4k" }), 240000);
  });

  it("per megapixel rounds up, once", () => {
    const flux = model("flux-2-pro");
    assert.equal(flux.pricing.kind, "perMegapixel");
    if (flux.pricing.kind !== "perMegapixel") return;
    const perMp = flux.pricing.microUsdPerMegapixel;
    // Fractional megapixels are charged as such; it is the money that rounds up, not the area.
    // The expectation goes through milli-units like the estimator does — 8.3 * 30000 in plain
    // floating point is 249000.00000000003, and ceiling that overcharges by a micro-dollar.
    const expect = (mp: number) => Math.ceil((Math.round(mp * 1000) * perMp) / 1000);
    assert.equal(estimateMicroUsd(flux, { megapixels: 8.3 }), expect(8.3));
    assert.equal(estimateMicroUsd(flux, { megapixels: 0.001 }), expect(0.001), "never down to nothing");
    assert.equal(estimateMicroUsd(flux, { images: 4, megapixels: 1 }), perMp * 4);
  });

  it("prices explicit character outputs, including model resolution overrides", () => {
    const flux = model("flux-2-pro");
    assert.ok(estimateCharacterImageMicroUsd(flux, "main-photo") > 0);
    assert.equal(
      estimateCharacterImageMicroUsd(flux, "main-photo", 4),
      estimateCharacterImageMicroUsd(flux, "main-photo") * 4,
    );
    const fourKOnly = {
      ...model("soul-2.0"),
      limits: { ...model("soul-2.0").limits, resolutions: ["4k"] },
    };
    assert.equal(characterImageOutput(fourKOnly, "character-sheet").resolution, "4k");
    assert.equal(estimateCharacterImageMicroUsd(fourKOnly, "character-sheet"), 120000);
  });

  it("selects a capability-valid routed model with the same fallback everywhere", () => {
    const flux = model("flux-2-pro");
    const video = model("seedance-2.0");
    const manifest = { ...SHIPPED_MANIFEST, models: [video, flux] };
    assert.equal(modelForCapability(manifest, { image: flux.id }, "image")?.id, flux.id);
    assert.equal(modelForCapability(manifest, { image: video.id }, "image")?.id, flux.id);
    assert.equal(modelForCapability(manifest, { image: "missing" }, "image")?.id, flux.id);
  });

  it("per character", () => {
    assert.equal(estimateMicroUsd(model("eleven-v3"), { characters: 1000 }), 300000);
  });

  it("per token, both directions, ceiling at the millionth", () => {
    const sonnet = model("claude-sonnet-5");
    assert.equal(estimateMicroUsd(sonnet, { tokensIn: 10_000, tokensOut: 2_000 }), 30000 + 30000);
    assert.equal(estimateMicroUsd(sonnet, { tokensIn: 1 }), 3, "sub-token fractions round up, never to zero");
  });

  it("unmetered is exactly zero (R-18)", () => {
    assert.equal(estimateMicroUsd(model("llama3.1-8b"), { tokensIn: 1_000_000 }), 0);
  });
});

describe("money (R-14, D3, §3.2)", () => {
  it("a scene-sized estimate summing dozens of line items is exact", () => {
    // 60 line items priced like real fractions of a cent; float would already drift here.
    const items = Array.from({ length: 60 }, (_, i) => 21667 * (i % 7) + 433);
    const expected = items.reduce((a, b) => a + b, 0);
    assert.equal(sumMicroUsd(items), expected);
    assert.ok(Number.isInteger(sumMicroUsd(items)));
  });

  it("rejects non-integer amounts instead of accumulating them", () => {
    assert.throws(() => sumMicroUsd([1.5]), /non-integer/);
  });

  it("formats once at the edge (round half-up at the cent; sub-cent keeps figures)", () => {
    assert.equal(formatMicroUsd(0), "$0.00");
    assert.equal(formatMicroUsd(40000), "$0.04");
    assert.equal(formatMicroUsd(128400), "$0.13");
    assert.equal(formatMicroUsd(125000), "$0.13", "half a cent rounds up");
    assert.equal(formatMicroUsd(1_234_567_890), "$1,234.57");
    assert.equal(formatMicroUsd(300), "$0.0003");
    assert.equal(formatMicroUsd(-128400), "-$0.13");
  });
});

describe("the declarations → strategy mapping (R-23, D8, DoD)", () => {
  it("every combination of the four flags resolves without a per-provider branch", () => {
    const combos: Array<[boolean, boolean, boolean, string]> = [
      [true, true, false, "by-idempotency-key"],
      [true, true, true, "by-idempotency-key"],
      [true, false, true, "list-recent"], // key attached but not queryable → search recents
      [false, false, true, "list-recent"],
      [false, true, true, "list-recent"], // lookup without idempotency keys is unusable
      [true, false, false, "ask-user"],
      [false, true, false, "ask-user"],
      [false, false, false, "ask-user"], // the honest option, stating the duplicate risk
    ];
    for (const [supportsIdempotencyKey, supportsLookupByKey, supportsListRecent, expected] of combos) {
      for (const reportsCost of [true, false]) {
        const decl: ClientDeclarations = {
          supportsIdempotencyKey,
          supportsLookupByKey,
          supportsListRecent,
          reportsCost,
        };
        assert.equal(reconcileStrategy(decl), expected, JSON.stringify(decl));
      }
    }
  });
});

describe("local runtime gating (R-22, D11, D12)", () => {
  const detectedAt = "2026-08-01T12:00:00.000Z";

  it("disabled names both figures and the cloud alternative", () => {
    const status = gateLocalRuntimes(
      SHIPPED_MANIFEST,
      { vramMb: 12 * 1024, memMb: 32 * 1024, diskFreeMb: 500 * 1024 },
      detectedAt,
    );
    const llama70b = status.models.find((m) => m.modelId === "llama3.3-70b");
    assert.equal(llama70b?.state, "disabled");
    assert.match(llama70b!.reason!, /Needs 41 GB VRAM\. This machine has 12 GB\./);
    assert.match(llama70b!.reason!, /Cloud llm still works via OpenAI\./);
    const llama8b = status.models.find((m) => m.modelId === "llama3.1-8b");
    assert.equal(llama8b?.state, "ready");
  });

  it("a failed probe yields unknown, never disabled (D12)", () => {
    const status = gateLocalRuntimes(
      SHIPPED_MANIFEST,
      { vramMb: null, memMb: 32 * 1024, diskFreeMb: 500 * 1024 },
      detectedAt,
    );
    const llama70b = status.models.find((m) => m.modelId === "llama3.3-70b");
    assert.equal(llama70b?.state, "unknown");
    assert.match(llama70b!.reason!, /could not be measured/);
  });

  it("kokoro and whisper gate on memory and disk without any credential", () => {
    const status = gateLocalRuntimes(
      SHIPPED_MANIFEST,
      { vramMb: null, memMb: 2 * 1024, diskFreeMb: 500 * 1024 },
      detectedAt,
    );
    const kokoro = status.models.find((m) => m.modelId === "kokoro-82m");
    assert.equal(kokoro?.state, "disabled");
    assert.match(kokoro!.reason!, /Needs 4 GB memory\. This machine has 2 GB\./);
  });
});
