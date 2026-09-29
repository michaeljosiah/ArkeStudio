import assert from "node:assert/strict";
import { it } from "node:test";
import { quoteSpeech, PricingSchema } from "@arke-studio/contracts";
import { geminiSpeechPricing } from "../src/gemini-tts-pricing.js";
import { requireModel, SHIPPED_MANIFEST } from "../src/manifest-data.js";

it("prices Flash and Lite at dated standard rates without assuming a discount", () => {
  for (const [variant, intro, standard] of [["flash", 151552, 303104], ["lite", 102400, 204800]] as const) {
    const pricing = geminiSpeechPricing(variant);
    assert.deepEqual(PricingSchema.parse(pricing), pricing);
    const found = requireModel(SHIPPED_MANIFEST, "eleven-v3");
    assert.equal(found.ok, true);
    if (!found.ok) throw new Error(found.reason);
    const model = { ...found.model, pricing };
    assert.equal(quoteSpeech(model, "Hello", { at: "2026-12-31T23:59:59.999Z" }).authorisedMicroUsd, intro);
    assert.equal(quoteSpeech(model, "Hello", { at: "2027-01-01T00:00:00.000Z" }).authorisedMicroUsd, standard);
  }
});
