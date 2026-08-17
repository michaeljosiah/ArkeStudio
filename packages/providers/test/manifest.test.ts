import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FAL_MODELS } from "../src/fal-catalogue.generated.js";
import {
  characterImageEstimateIsUsable,
  characterImageOutput,
  dispatchDuration,
  durationOptions,
  pricedDuration,
  estimateCharacterImageMicroUsd,
  estimateMicroUsd,
  formatMicroUsd,
  aspectOffered,
  gateLocalRuntimes,
  imageOutputFor,
  ModelManifestSchema,
  modelCapabilityCopy,
  modelForCapability,
  modelPriceCopy,
  offeredAspects,
  parseAspect,
  passesForDuration,
  reconcileStrategy,
  sceneImageOutput,
  sumMicroUsd,
  tiersFor,
  type ClientDeclarations,
} from "@arke-studio/contracts";
import { requireModel, SHIPPED_MANIFEST } from "../src/manifest-data.js";
import { FAL_EDIT_ENDPOINTS, FAL_ENDPOINTS } from "../src/fal-catalogue.generated.js";

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
    assert.ok(!refused.ok && refused.reason.includes(`v${SHIPPED_MANIFEST.manifestVersion}`));
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
    // The refusing side. ltx ships a text route and nothing else, so its row takes no references
    // — and still names its length, because a video row's length is the other half of the copy.
    assert.equal(modelCapabilityCopy(model("ltx-2.5-pro")), "no refs · 10s");
    // The accepting side, on video. These rows read "no refs" for as long as the families were
    // curated as text-only (#154); the reference-to-video siblings were there the whole time,
    // and a row that hides a route it has is the same lie as one that claims a route it lacks.
    assert.equal(modelCapabilityCopy(model("seedance-2.0")), "refs ×9 · 15s");
    // And on image. This used to be Higgsfield's "halcyon-1.5", whose row claimed both frames —
    // for a model that turned out not to exist in the catalogue under any name (#137). Soul is
    // the real row, and it takes exactly one reference.
    assert.equal(modelCapabilityCopy(model("text2image_soul_v2")), "refs ×1");
  });

  it("no fal video row claims a frame its route cannot take", () => {
    // The failure this prevents: the picker printing "frames" beside a model, and the dispatch
    // dialog warning about shots without one, for a route that has no image input at all.
    for (const video of SHIPPED_MANIFEST.models.filter((m) => m.capability === "video" && m.provider === "fal")) {
      assert.equal(video.accepts.startFrame, false, `${video.id} claims no start frame`);
      assert.equal(video.accepts.endFrame, false, `${video.id} claims no end frame`);
    }
  });

  it("prices every model in the unit it is billed in, never a bare figure", () => {
    // The unit is the point: $0.30 beside a video model and $0.30 beside an image model look
    // like the same money, and one of them is per second of footage.
    assert.match(modelPriceCopy(model("seedance-2.0")), /\/ second$/);
    assert.equal(modelPriceCopy(model("gpt-image-2")).includes("/"), false, "per image is a flat figure");
    assert.match(modelPriceCopy(model("flux-2-pro")), /\/ megapixel$/);
    for (const local of SHIPPED_MANIFEST.models.filter((m) => m.pricing.kind === "unmetered")) {
      assert.match(modelPriceCopy(local), /unmetered/);
    }
  });

  it("declares implemented GPT Image 2 reference support without invented role slots", () => {
    for (const imageModel of SHIPPED_MANIFEST.models.filter((candidate) => candidate.capability === "image")) {
      assert.equal(typeof imageModel.accepts.referenceRoles, "boolean", `${imageModel.id} declares role support`);
    }
    assert.equal(model("gpt-image-2").accepts.referenceImages, 16);
    assert.equal(model("gpt-image-2").accepts.referenceRoles, false);
    assert.equal(modelCapabilityCopy(model("gpt-image-2")), "refs ×16");
  });

  it("every video model declares the lengths it can be asked for", () => {
    // The same shape as the route check above: a model offered with no declared length is one
    // whose dispatch silently runs at the provider's default while the estimate says otherwise.
    for (const video of SHIPPED_MANIFEST.models.filter((m) => m.capability === "video" && m.provider === "fal")) {
      const options = durationOptions(video);
      assert.ok(options.length > 0, `${video.id} declares its lengths`);
      // Equal, not merely within: the cap packs whole-scene passes and the options are what the
      // route can be asked for, so a cap above the longest option lets a pass be built that
      // dispatch then refuses — with nothing warned beforehand, because the dialog's warning
      // inspects shots. The generator derives one from the other; this is the guard on that.
      assert.equal(
        video.limits.maxDurationSec,
        options[options.length - 1],
        `${video.id}'s cap is its longest declared length`,
      );
    }
  });

  it("snaps a planned length up to one the route accepts, never down", () => {
    const veo = model("veo-3.1");
    // Veo takes 4s, 6s or 8s and nothing between: a 5s shot becomes a 6s dispatch, because
    // rounding down would bill for footage that ends before the shot does.
    assert.deepEqual(dispatchDuration(veo, 5), { kind: "asked", seconds: 6, wire: "6s" });
    assert.deepEqual(dispatchDuration(veo, 4), { kind: "asked", seconds: 4, wire: "4s" });
    // Longer than anything the route offers is refused, not clamped: a 22s shot dispatched as
    // a 15s clip is paid-for footage that cannot cover the shot.
    assert.deepEqual(dispatchDuration(veo, 99), { kind: "over-cap", longest: 8, becauseReferences: false });
    assert.equal(pricedDuration(veo, 99), 99, "and it is not priced as if it had been shortened");
    // And the estimate follows the snap rather than the request.
    assert.equal(
      estimateMicroUsd(veo, { durationSec: 6 }) > estimateMicroUsd(veo, { durationSec: 5 }),
      true,
      "a 5s shot priced as 5s would understate the 6s that runs",
    );
    // A model with no declared lengths says so, rather than inventing one.
    const bare = { ...veo, limits: { ...veo.limits, durations: undefined } };
    assert.deepEqual(dispatchDuration(bare, 5), { kind: "provider-default" });
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
    assert.equal(estimateMicroUsd(model("text2image_soul_v2"), { images: 2 }), 120000);
    // The per-image resolution override is a pricing *shape*, not a property of any shipped
    // row — it used to be exercised through a Higgsfield row that priced a 4k tier the model
    // could not reach. Build it here instead, so the arithmetic is tested without a row having
    // to be wrong to test it.
    const tiered = {
      ...model("text2image_soul_v2"),
      pricing: { kind: "perImage" as const, microUsdPerImage: 60000, byResolution: { "2k": 120000 } },
    };
    assert.equal(estimateMicroUsd(tiered, { images: 2, resolution: "2k" }), 240000);
  });

  it("prices GPT Image 2 reference input conservatively", () => {
    const image = model("gpt-image-2");
    assert.equal(image.pricing.kind, "perImage");
    if (image.pricing.kind !== "perImage") return;
    assert.equal(estimateMicroUsd(image, { images: 1 }), 53000);
    assert.equal(estimateMicroUsd(image, { images: 1, referenceImages: 1 }), 153000);
    assert.equal(estimateMicroUsd(image, { images: 4, referenceImages: 4 }), 612000);
  });

  it("prices a token-billed image as a ceiling, and says so", () => {
    const gpt = model("gpt-image-2-fal");
    assert.equal(gpt.pricing.kind, "perImageToken");
    if (gpt.pricing.kind !== "perImageToken") return;
    const p = gpt.pricing;
    const one =
      (p.assumedImageOutputTokensPerImage * p.microUsdPerMillionImageOutput +
        p.assumedTextInputTokens * p.microUsdPerMillionTextInput) /
      1_000_000;
    assert.equal(estimateMicroUsd(gpt, { images: 1 }), one);
    assert.equal(estimateMicroUsd(gpt, { images: 3 }), one * 3);
    // A reference costs image-input tokens, so it is added, not free.
    assert.ok(
      estimateMicroUsd(gpt, { images: 1, referenceImages: 2 }) > estimateMicroUsd(gpt, { images: 1 }),
    );
    // fal rounds a total up to the closest hundredth of a cent; the estimate rounds the same way,
    // so it can never sit a fraction under what will be charged.
    assert.equal(p.roundUpToMicroUsd, 100);
    assert.equal(estimateMicroUsd(gpt, { images: 1 }) % 100, 0);
    assert.match(modelPriceCopy(gpt), /at most$/);
  });

  it("refuses a token-billed row that does not state what the estimate assumes", () => {
    // The sync script drops a price it cannot read. A token table with no assumption is exactly
    // that: rates without a way to turn them into a figure before spending.
    const bare = {
      kind: "perImageToken" as const,
      microUsdPerMillionTextInput: 5_000_000,
      microUsdPerMillionImageInput: 8_000_000,
      microUsdPerMillionImageOutput: 30_000_000,
      assumedTextInputTokens: 0,
      assumedImageInputTokensPerReference: 0,
      assumedImageOutputTokensPerImage: 0,
    };
    const zeroed = { ...model("gpt-image-2-fal"), pricing: bare };
    assert.equal(estimateMicroUsd(zeroed, { images: 1 }), 0);
    assert.equal(characterImageEstimateIsUsable(zeroed, 0), false, "a free image is not believable here");
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

  it("a tier changes the dimensions, not only the label", () => {
    // Several clients submit width/height and ignore `resolution` — OpenAI, and every fal route
    // that is not a nano-banana. A tier that moved only the label left those requests at 1K
    // while the picker said 4K, and per-megapixel estimates read the same stale dimensions.
    const flux = model("flux-2-pro");
    const oneK = characterImageOutput(flux, "main-photo", "1K");
    const fourK = characterImageOutput(flux, "main-photo", "4K");
    assert.ok(Math.max(fourK.width, fourK.height) > Math.max(oneK.width, oneK.height), "4K is bigger");
    assert.equal(fourK.aspect, oneK.aspect, "the aspect is what the workflow chose, not the tier");
    assert.equal(fourK.width % 2, 0);
    assert.equal(fourK.height % 2, 0);
    // And the money follows the pixels for a per-megapixel model.
    assert.ok(
      estimateCharacterImageMicroUsd(flux, "main-photo", 1, 0, "4K") >
        estimateCharacterImageMicroUsd(flux, "main-photo", 1, 0, "1K"),
    );
  });

  it("hits the megapixel a model's tier actually names, not a long edge", () => {
    // Flux calls 4K "4MP". A 4096px long edge at 3:2 is about 13MP — three times what was asked
    // for, on a model billed by the megapixel, and the request carries only the dimensions.
    const flux = model("flux-2-pro");
    for (const [tier, expected] of [
      ["1K", 1],
      ["2K", 2],
      ["4K", 4],
    ] as const) {
      const out = characterImageOutput(flux, "main-photo", tier);
      const mp = (out.width * out.height) / 1_000_000;
      assert.ok(Math.abs(mp - expected) < 0.05, `${tier} lands on ${expected}MP, got ${mp.toFixed(2)}`);
    }
    // A model whose tiers are plain size words keeps the long-edge scale.
    const banana = model("nano-banana-2");
    const fourK = characterImageOutput(banana, "main-photo", "4K");
    assert.equal(Math.max(fourK.width, fourK.height), 4096);
  });

  /*
   * The shape, once it is the author's to choose.
   *
   * Aspect used to be decided entirely by provider and orientation, so a 16:9 plate was
   * unreachable from any screen. These hold the two rules that make offering it safe: the picker
   * offers only what the row declares, and a ratio the row never declared is ignored rather than
   * sent and refused.
   */
  /*
   * Three properties held over every shipped row at once, so no future row can reintroduce any
   * of them by being added.
   *
   * The middle one is the reason the other two exist. `limits.aspects` is a *curated offer list*
   * — the fal catalogue's own header says what a model accepts is curated because the API does
   * not say, and nano-banana's entry deliberately omits ratios its route does have — so a shape
   * outside that list is not an invalid request. What is invalid is having two different defaults
   * for one model: the picker took the curated list's first entry, which made nano-banana default
   * to a 21:9 crop on a screen with a shape control and 16:9 on every screen without one.
   */
  it("never derives a shape it would not also offer", () => {
    for (const m of SHIPPED_MANIFEST.models.filter((x) => x.capability === "image")) {
      for (const landscape of [true, false]) {
        const offered = offeredAspects(m, { landscape });
        if (offered.length === 0) continue;
        const derived = imageOutputFor(m, { landscape }).aspect;
        assert.ok(
          offered.includes(derived),
          `${m.id} ${landscape ? "landscape" : "portrait"} derives ${derived}, offers ${offered.join(",")}`,
        );
        assert.ok(aspectOffered(m, derived), `${m.id} would reject its own default`);
      }
    }
  });

  it("defaults a picker to the shape that surface already produced", () => {
    // Opening a dialog and changing nothing must generate what pressing Generate generated before
    // the dialog had controls. The default is therefore first in the offered list, not whichever
    // preset the catalogue happened to list first.
    for (const m of SHIPPED_MANIFEST.models.filter((x) => x.capability === "image")) {
      for (const landscape of [true, false]) {
        const offered = offeredAspects(m, { landscape });
        if (offered.length === 0) continue;
        assert.equal(
          offered[0],
          imageOutputFor(m, { landscape }).aspect,
          `${m.id} ${landscape ? "landscape" : "portrait"} would open on a different shape`,
        );
      }
    }
  });

  it("always reports an aspect that describes the pixels it is sending", () => {
    // The string is user-visible and recorded in job params, and a client that submits
    // `aspect_ratio` instead of width and height would send this one. It has to be the truth
    // about the dimensions beside it, on every path — derived or chosen, at every tier.
    for (const m of SHIPPED_MANIFEST.models.filter((x) => x.capability === "image")) {
      for (const landscape of [true, false]) {
        for (const aspect of [undefined, ...offeredAspects(m, { landscape })]) {
          for (const tier of [undefined, "1K", "2K", "4K"] as const) {
            const out = imageOutputFor(m, {
              landscape,
              ...(tier !== undefined ? { tier } : {}),
              ...(aspect !== undefined ? { aspect } : {}),
            });
            const stated = parseAspect(out.aspect);
            assert.ok(stated !== null, `${m.id} reported an unparseable aspect ${out.aspect}`);
            const actual = out.width / out.height;
            assert.ok(
              Math.abs(actual - stated) / stated < 0.02,
              `${m.id} says ${out.aspect} but sends ${out.width}x${out.height}`,
            );
          }
        }
      }
    }
  });

  it("offers each row exactly the shapes it declares", () => {
    // Enumerated rows pass through verbatim, including ones outside the standard set.
    assert.deepEqual(offeredAspects(model("gpt-image-2")), ["1:1", "3:2", "2:3"]);
    assert.ok(offeredAspects(model("nano-banana-2")).includes("21:9"), "its own list, not ours");
    // And a row that declares nothing offers nothing, so no control is drawn over a guess.
    const mute = { ...model("flux-2-pro"), limits: { ...model("flux-2-pro").limits, aspects: undefined } };
    assert.deepEqual(offeredAspects(mute), []);
    assert.deepEqual(offeredAspects({ ...model("flux-2-pro"), unverified: true }), [], "unverified claims nothing");
  });

  it("narrows the standard set to a continuous range, where that is how the row speaks", () => {
    const ranged = { ...model("flux-2-pro"), limits: { ...model("flux-2-pro").limits, aspects: undefined }, aspectRange: { min: 0.9, max: 1.4 } };
    const offered = offeredAspects(ranged);
    assert.ok(offered.includes("1:1"), "1.0 is inside [0.9, 1.4]");
    assert.ok(offered.includes("4:3"), "1.33 is inside");
    assert.ok(!offered.includes("16:9"), "1.78 is not");
    assert.ok(!offered.includes("9:16"), "nor is 0.56");
  });

  it("reshapes around the long edge, so a shape change is not also a size change", () => {
    const flux = model("flux-2-pro");
    for (const aspect of offeredAspects(flux)) {
      const out = imageOutputFor(flux, { landscape: true, tier: "2K", aspect });
      assert.equal(out.aspect, aspect, `${aspect} is what comes back`);
      const [w, h] = [out.width, out.height];
      const ratio = w / h;
      const wanted = parseAspect(aspect)!;
      assert.ok(Math.abs(ratio - wanted) / wanted < 0.02, `${aspect} arrives as ${w}x${h}`);
      assert.equal(w % 2, 0, "even, because several providers reject odd dimensions");
      assert.equal(h % 2, 0);
      // Still the tier that was asked for: flux calls 2K "2MP", and the area is the target.
      const mp = (w * h) / 1_000_000;
      assert.ok(Math.abs(mp - 2) < 0.05, `${aspect} stays at the 2K tier, got ${mp.toFixed(2)}MP`);
    }
  });

  it("ignores a shape the model never offered, rather than sending it", () => {
    // The manifest is the first line of defence and the picker never offers this. This is the
    // backstop: obeying it would put a request on the wire the route refuses after the estimate
    // was accepted.
    const openai = model("gpt-image-2");
    assert.ok(!offeredAspects(openai).includes("16:9"));
    const out = imageOutputFor(openai, { landscape: true, aspect: "16:9" });
    assert.equal(out.aspect, "3:2", "its own landscape shape, not the one asked for");
    assert.ok(["1024x1024", "1536x1024", "1024x1536"].includes(`${out.width}x${out.height}`));
  });

  it("prices the shape, not only the size, on a row billed by area", () => {
    const flux = model("flux-2-pro");
    const square = estimateCharacterImageMicroUsd(flux, "main-photo", 1, 0, "2K", "1:1");
    const wide = estimateCharacterImageMicroUsd(flux, "main-photo", 1, 0, "2K", "16:9");
    // Equal here rather than different, and that is the point: flux's tiers are megapixel
    // targets, so every shape at 2K is 2MP and costs the same. The figure has to come from the
    // dimensions the request will carry either way — a flat assumed 1MP was wrong for all of them.
    assert.equal(square, wide, "same area, same money");
    assert.ok(square > 0);
    const longEdgeRow = model("nano-banana-2");
    assert.ok(estimateCharacterImageMicroUsd(longEdgeRow, "main-photo", 1, 0, "2K", "16:9") > 0);
  });

  it("every size an OpenAI request can carry is one the route accepts (#223)", () => {
    // OpenAI's `size` is an enum, not a width and a height. Long-edge scaling turned the 2K tier
    // into 1366x2048, which the route rejected at validation in 1.3s — a guaranteed failure
    // offered in the picker as an ordinary choice, priced the same as the 1K that works.
    const accepted = new Set(["1024x1024", "1536x1024", "1024x1536"]);
    const images = SHIPPED_MANIFEST.models.filter((m) => m.provider === "openai" && m.capability === "image");
    assert.ok(images.length > 0);
    for (const image of images) {
      // Every tier, not only the reachable ones: a stale saved choice or a later manifest row
      // must not be able to put a size on the wire the route has never heard of.
      for (const tier of [undefined, "1K", "2K", "4K"] as const) {
        for (const out of [
          characterImageOutput(image, "main-photo", tier),
          characterImageOutput(image, "character-sheet", tier),
          sceneImageOutput(image, tier),
        ]) {
          const size = `${out.width}x${out.height}`;
          assert.ok(accepted.has(size), `${image.id} at ${tier ?? "no tier"} would send ${size}`);
        }
      }
    }
  });

  it("GPT Image 2 offers only the tier its route reaches", () => {
    const image = model("gpt-image-2");
    assert.deepEqual(tiersFor(image), ["1K"], "2K is disabled in the picker, not silently sent and refused");
    // And a request that asks for one anyway comes back portrait: the reference workflows are
    // portrait, and squaring them to the nearest size would crop the subject out of its frame.
    const portrait = characterImageOutput(image, "main-photo", "2K");
    assert.ok(portrait.height > portrait.width, `main-photo stays portrait, got ${portrait.width}x${portrait.height}`);
    assert.equal(portrait.aspect, "2:3");
    const landscape = sceneImageOutput(image, "4K");
    assert.ok(landscape.width > landscape.height, `a scene still stays landscape, got ${landscape.width}x${landscape.height}`);
  });

  it("prices explicit character outputs, including model resolution overrides", () => {
    const flux = model("flux-2-pro");
    assert.ok(estimateCharacterImageMicroUsd(flux, "main-photo") > 0);
    assert.equal(
      estimateCharacterImageMicroUsd(flux, "main-photo", 4),
      estimateCharacterImageMicroUsd(flux, "main-photo") * 4,
    );
    const fourKOnly = {
      ...model("text2image_soul_v2"),
      limits: { ...model("text2image_soul_v2").limits, resolutions: ["4k"] },
      pricing: { kind: "perImage" as const, microUsdPerImage: 60000, byResolution: { "4k": 120000 } },
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
    assert.equal(estimateMicroUsd(model("eleven_multilingual_v2"), { characters: 1000 }), 300000);
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

/**
 * Prompt caps (design 68). Every number here is transcribed from the provider's own route
 * schema, so the test's job is to catch a regeneration or a hand-edit that quietly changes one —
 * and, just as much, to keep the ABSENCES deliberate. A row with no cap makes the composer show
 * no counter; if somebody later fills one in from a blog post or a guess, this fails and asks
 * them to cite it instead.
 */
describe("how long a prompt each model takes", () => {
  const PUBLISHED: Record<string, number> = {
    "nano-banana-2": 50000,
    "nano-banana-pro": 50000,
    "gpt-image-2-fal": 32000,
    "gpt-image-2": 32000,
    "veo-3.1": 20000,
    "veo-3.1-fast": 20000,
    "kling-3-pro": 2500,
    "kling-3-standard": 2500,
  };

  for (const [id, chars] of Object.entries(PUBLISHED)) {
    it(`${id} states ${chars} characters, as its provider publishes`, () => {
      assert.equal(model(id).limits.maxPromptChars, chars);
    });
  }

  // fal's schema for these declares no maxLength. "The provider does not say" is not "unlimited",
  // and it is not an invitation to pick a number: the counter simply does not appear.
  for (const id of ["flux-2-pro", "seedance-2.0", "seedance-2.0-fast", "text2image_soul_v2"]) {
    it(`${id} states no cap, because none is published`, () => {
      assert.equal(model(id).limits.maxPromptChars, undefined);
    });
  }

  it("no row invents one: every cap present is a positive integer", () => {
    for (const m of SHIPPED_MANIFEST.models) {
      const cap = m.limits.maxPromptChars;
      if (cap === undefined) continue;
      assert.ok(Number.isInteger(cap) && cap > 0, `${m.id} cap is a positive integer`);
    }
  });
});

describe("the new video families carry the routes' own numbers (fal catalogue sync)", () => {
  const byId = (id: string) => {
    const model = FAL_MODELS.find((m) => m.id === id);
    assert.ok(model, `${id} is in the shipped catalogue`);
    return model!;
  };

  /**
   * Every figure below is the route's published one. They are asserted rather than trusted
   * because the sync script reads them out of prose, and prose that reads correctly forwards
   * can also read one-off backwards: an earlier pass paired every minimax resolution with the
   * NEXT price and priced 480P at 768P's rate.
   */
  it("prices each resolution at its own published rate", () => {
    const h3 = byId("minimax-h3");
    assert.equal(h3.pricing.kind, "perSecond");
    if (h3.pricing.kind === "perSecond") {
      // 768P was $0.08 when this row was first synced and is $0.06 as of 2026-08-17 — a real cut
      // by fal, re-read from the route's prose, not a re-pairing by the parser. The guard above
      // still holds precisely because 480P did NOT move with it: a shifted read would have
      // carried every tier along, and each of these is its own published number.
      assert.deepEqual(h3.pricing.byResolution, {
        "480P": 50000,
        "768P": 60000,
        "2K": 130000,
        "4K": 160000,
      });
      // The base is the route's OWN default (2K), not the cheapest tier: a job that picks no
      // resolution is charged at the default, and basing it on 480P understates it 2.6x.
      assert.equal(h3.pricing.microUsdPerSecond, 130000);
    }
    const wan = byId("wan-2.7");
    if (wan.pricing.kind === "perSecond") {
      assert.equal(wan.pricing.byResolution?.["720p"], 100000);
      assert.equal(wan.pricing.byResolution?.["1080p"], 150000);
      assert.equal(wan.pricing.microUsdPerSecond, 150000);
    }
  });

  it("keys every rate to the word the picker sends, across the price list's own spellings", () => {
    // The ltx fast route is billed for "4K" and dispatched with "2160p". A rate keyed on the
    // prose word is a lookup that misses in silence, falling back to the base rate.
    const fast = byId("ltx-2.5-fast");
    if (fast.pricing.kind === "perSecond") {
      assert.equal(fast.pricing.byResolution?.["2160p"], 300000);
      assert.equal(fast.pricing.byResolution?.["4k"], undefined);
    }
    for (const id of ["minimax-h3", "ltx-2.5-pro", "ltx-2.5-fast", "wan-2.7"]) {
      const model = byId(id);
      if (model.pricing.kind !== "perSecond") continue;
      for (const key of Object.keys(model.pricing.byResolution ?? {})) {
        assert.ok(
          (model.limits.resolutions ?? []).includes(key),
          `${id}: the rate for "${key}" names a resolution the row offers`,
        );
      }
    }
  });

  it("declares the wire type of a length, because these routes count in numbers", () => {
    // seedance and kling take duration as a string out of a list; minimax, ltx and wan declare
    // an integer or a number enum, and "6" is not a member of [6, 8, 10].
    for (const id of ["minimax-h3", "ltx-2.5-pro", "ltx-2.5-fast", "wan-2.7"]) {
      assert.equal(byId(id).limits.durationWire, "number", `${id} sends a numeric duration`);
    }
    assert.equal(byId("seedance-2.0").limits.durationWire, undefined, "seedance keeps its strings");
  });

  it("names the references field where the family disagrees with seedance", () => {
    // minimax and wan call the array `reference_image_urls`; seedance calls it `image_urls`.
    assert.equal(byId("minimax-h3").limits.referencesField, "reference_image_urls");
    assert.equal(byId("wan-2.7").limits.referencesField, "reference_image_urls");
    assert.equal(byId("seedance-2.0").limits.referencesField, "image_urls");
    // ltx ships no reference route at all, so it has no array to mis-name.
    assert.equal(byId("ltx-2.5-pro").limits.referencesField, undefined);
  });

  it("carries references as references, not as a sequence of keyframes", () => {
    // These routes were first curated as `keyframe-sequence`, which is what an array of images
    // beside a video model looks like from the outside. Their own schemas say otherwise:
    // seedance's reads "refer to them in the prompt as @Image1, @Image2", minimax's "referenced
    // in the prompt as Image 1, Image 2". That is this studio's reference vocabulary — images
    // the shot may cite — not frames the shot passes through, and a sequence mode would have
    // promised an ordering the route never honors.
    for (const id of ["minimax-h3", "wan-2.7", "seedance-2.0", "seedance-2.0-fast"]) {
      assert.equal(byId(id).modes?.["keyframe-sequence"], undefined, `${id} claims no sequence`);
    }
  });

  it("only claims a reference ceiling the route published", () => {
    // minimax's and seedance's reference routes declare maxItems 9. wan's declares none, so 4
    // is a deliberate under-promise rather than a guess at a ceiling: a dropped reference costs
    // less than a dispatch that dies after the estimate was accepted. Raise it from a live call.
    assert.equal(byId("minimax-h3").accepts.referenceImages, 9);
    assert.equal(byId("seedance-2.0").accepts.referenceImages, 9);
    assert.equal(byId("wan-2.7").accepts.referenceImages, 4);
  });

  it("routes every row that accepts references somewhere that takes them", () => {
    // The failure this prevents is the expensive one: a row advertising "refs ×9" whose only
    // endpoint is text-to-video, so the picker offers references, the estimate prices them, and
    // the submitted job either drops them silently or dies after the user has committed. The
    // reference route and the field it names are two halves of one claim — neither alone works.
    for (const m of SHIPPED_MANIFEST.models.filter((c) => c.provider === "fal" && c.accepts.referenceImages > 0)) {
      assert.ok(FAL_EDIT_ENDPOINTS[m.id], `${m.id} accepts references and has a route that takes them`);
    }
    // ...and nothing routes references for a row that says it takes none, which would be a
    // capability the app can reach but never offers.
    for (const id of Object.keys(FAL_EDIT_ENDPOINTS)) {
      assert.ok(model(id).accepts.referenceImages > 0, `${id} offers the references its route takes`);
    }
  });

  it("offers a prompt counter only where the route publishes a cap", () => {
    assert.equal(byId("minimax-h3").limits.maxPromptChars, 50000);
    assert.equal(byId("ltx-2.5-pro").limits.maxPromptChars, 5000);
    // wan 2.7 declares no maxLength: "the provider does not say" is not "unlimited".
    assert.equal(byId("wan-2.7").limits.maxPromptChars, undefined);
  });
});

describe("a length goes in the route's own type (fal 422, 2026-08-16)", () => {
  /**
   * Wan accepted the submission, queued the job, and answered its result with
   * `Input should be 2, 3, ... 15` for an input of "2". The lengths are stored as strings
   * because they are record keys; the wire value must be the route's declared type, and it is
   * converted here — at the one place every surface asks for a length — rather than at each
   * caller, which is how the bench came to send a quoted number while the client sent a bare one.
   */
  it("sends a number where the route declares one, a string where it declares that", () => {
    const wan = FAL_MODELS.find((m) => m.id === "wan-2.7")!;
    const asked = dispatchDuration(wan, 2);
    assert.equal(asked.kind, "asked");
    if (asked.kind === "asked") {
      assert.equal(asked.wire, 2);
      assert.equal(typeof asked.wire, "number");
    }
    const seedance = FAL_MODELS.find((m) => m.id === "seedance-2.0")!;
    const legacy = dispatchDuration(seedance, 5);
    if (legacy.kind === "asked") {
      assert.equal(legacy.wire, "5");
      assert.equal(typeof legacy.wire, "string");
    }
  });

  it("covers every video row the catalogue ships, so a new family cannot reintroduce it", () => {
    for (const model of FAL_MODELS.filter((m) => m.capability === "video")) {
      const options = Object.keys(model.limits.durations ?? {}).map(Number);
      if (options.length === 0) continue;
      const choice = dispatchDuration(model, options[0]!);
      if (choice.kind !== "asked") continue;
      const expected = model.limits.durationWire === "number" ? "number" : "string";
      assert.equal(typeof choice.wire, expected, `${model.id} sends a ${expected} duration`);
    }
  });
});

describe("the reference route's own ceiling (probed 2026-08-16)", () => {
  const wan = () => FAL_MODELS.find((m) => m.id === "wan-2.7")!;

  /**
   * A row's lengths are transcribed from the route it dispatches to by default, but a job
   * carrying references goes to a different endpoint — and wan's two disagree: text-to-video
   * declares 2–15, reference-to-video 2–10. Read from the wrong one, the composer offers 12s,
   * the estimate prices 12s, the user accepts, and the route rejects a length it never offered.
   */
  it("shortens the offered lengths for a job that carries references", () => {
    assert.equal(durationOptions(wan()).at(-1), 15);
    assert.equal(durationOptions(wan(), { withReferences: true }).at(-1), 10);
    // Only the tail goes: every length both routes make is still on offer.
    assert.deepEqual(durationOptions(wan(), { withReferences: true }), [2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("refuses a length the reference route will not make, and says the references did it", () => {
    const plain = dispatchDuration(wan(), 12);
    assert.equal(plain.kind, "asked", "12s is fine without references");
    const withRefs = dispatchDuration(wan(), 12, { withReferences: true });
    assert.equal(withRefs.kind, "over-cap");
    if (withRefs.kind === "over-cap") {
      assert.equal(withRefs.longest, 10);
      // The distinction the refusal is built on: there is a shot to be had by removing one.
      assert.equal(withRefs.becauseReferences, true);
    }
    const genuinelyOver = dispatchDuration(wan(), 30, { withReferences: false });
    if (genuinelyOver.kind === "over-cap") assert.equal(genuinelyOver.becauseReferences, false);
  });

  it("prices what will be dispatched, on the route it will be dispatched to", () => {
    // The estimate and the dispatch read one function so they cannot disagree about the length.
    assert.equal(pricedDuration(wan(), 9, { withReferences: true }), 9);
    assert.equal(dispatchDuration(wan(), 9, { withReferences: true }).kind, "asked");
  });

  it("states a shorter reference ceiling only where the row has a reference route to shorten", () => {
    for (const m of FAL_MODELS) {
      const ceiling = m.limits.maxReferenceDurationSec;
      if (ceiling === undefined) continue;
      assert.ok(FAL_EDIT_ENDPOINTS[m.id], `${m.id} has the reference route this ceiling describes`);
      const longest = durationOptions(m).at(-1);
      assert.ok(longest !== undefined && ceiling < longest, `${m.id}'s reference ceiling is the shorter of the two`);
    }
  });
});

describe("a direct provider's row IS its own id (ElevenLabs 400, 2026-08-17)", () => {
  /**
   * ElevenLabs answered `An invalid ID has been received: 'eleven-v3'` to every synthesis this
   * app has ever sent, because the row's id travelled as `model_id`. Only fal needs a route
   * map — openai and elevenlabs send `request.model` straight through, so for them the
   * catalogue id and the provider's id are the same string or nothing works.
   */
  it("names ElevenLabs models the way ElevenLabs names them", () => {
    for (const m of SHIPPED_MANIFEST.models.filter((x) => x.provider === "elevenlabs")) {
      assert.match(m.id, /^eleven_[a-z0-9_]+$/, `${m.id} is spelled the way the provider spells it`);
      assert.doesNotMatch(m.id, /-/, "hyphens are this catalogue's house style, not ElevenLabs'");
    }
  });

  it("still prices the row in the unit it is billed in", () => {
    assert.equal(estimateMicroUsd(model("eleven_multilingual_v2"), { characters: 1000 }), 300000);
  });
});
