import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ManifestModel, WorldBundle } from "@arke-studio/contracts";
import { enhancerBrief } from "../../src/bench/enhancer.js";

/**
 * The enhancer's brief (issue 305 §3, asked for 2026-08-16): only what the world itself says,
 * the model's own name and cap, and the author's ask verbatim — no invented context.
 */
describe("the enhancer's brief", () => {
  const model: ManifestModel = {
    id: "seedance-2.0",
    provider: "fal",
    capability: "video",
    displayName: "Seedance 2.0",
    family: "seedance",
    accepts: { referenceImages: 0, startFrame: false, endFrame: false },
    limits: { maxPromptChars: 3500 },
    pricing: { kind: "perSecond", microUsdPerSecond: 1 },
  };
  const bundle = {
    meta: { name: "Embers of the Fallen", logline: "A drowned god still sings.", tone: "elegiac", genre: "myth" },
    artDirection: { description: "Ash-light and verdigris; nothing gleams." },
    canon: [
      { id: "CANON-001", title: "The god sleeps under the harbour", status: "settled" },
      { id: "CANON-002", title: "Unproven rumour", status: "open" },
    ],
  } as unknown as WorldBundle;

  it("grounds in the world's own words, names the model and its cap, and keeps the ask verbatim", () => {
    const brief = enhancerBrief(bundle, model, "the god surfacing at dusk, citing Image 1");
    assert.match(brief, /Embers of the Fallen/);
    assert.match(brief, /A drowned god still sings\./);
    assert.match(brief, /Ash-light and verdigris/);
    assert.match(brief, /The god sleeps under the harbour/);
    assert.doesNotMatch(brief, /Unproven rumour/); // open canon is not binding
    assert.match(brief, /Seedance 2\.0 \(the seedance family\)/);
    assert.match(brief, /at most 3500 characters/);
    assert.match(brief, /the god surfacing at dusk, citing Image 1/);
    assert.match(brief, /keep any the ask uses, verbatim/);
    assert.match(brief, /JSON only/);
  });

  it("a model with no published cap gets no cap line — never a house number", () => {
    const capless = { ...model, limits: {} };
    assert.doesNotMatch(enhancerBrief(bundle, capless, "x"), /at most \d+ characters/);
  });
});
