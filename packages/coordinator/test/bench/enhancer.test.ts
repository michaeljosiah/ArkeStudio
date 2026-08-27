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
    artDirection: {
      description: "Ash-light and verdigris; nothing gleams.",
      failureModes: ["Hands stay whole", "No lens flare"],
    },
    bible: {
      version: 3,
      updated: "2026-08-20",
      present: true,
      text: "# The argument\n\nThe harbour drowned itself on purpose. Everyone alive is a descendant of that vote.",
    },
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
    // The citations the ask makes are the one thing a rewrite may not lose (issue 476).
    assert.match(brief, /keep every one the ask uses, verbatim, at-sign and all/);
    assert.match(brief, /"@Image 1"/);
    assert.match(brief, /JSON only/);
  });

  it("a model with no published cap gets no cap line — never a house number", () => {
    const capless = { ...model, limits: {} };
    assert.doesNotMatch(enhancerBrief(bundle, capless, "x"), /at most \d+ characters/);
  });

  /**
   * The Bible is the author's thinking, not canon (master §4.5). It reaches a prompt the way key art
   * lets it (SPEC-031 R-58) — as intent, named as intent — so a rewrite sounds like this world
   * rather than like its genre. What it must never do is arrive wearing canon's word.
   */
  it("carries the bible as intent, never as binding", () => {
    const brief = enhancerBrief(bundle, model, "the harbour at dusk");
    assert.match(brief, /The harbour drowned itself on purpose/);
    assert.match(brief, /intent and mood, not settled fact/);
    // Headings are a document's furniture, not the argument.
    assert.doesNotMatch(brief, /# The argument/);
    const bibleLine = brief.split("\n").find((l) => l.includes("The harbour drowned itself"))!;
    assert.doesNotMatch(bibleLine, /binding/);
  });

  it("a world with no bible yet says nothing about one", () => {
    const noBible = { ...bundle, bible: { ...bundle.bible, present: false } } as WorldBundle;
    const brief = enhancerBrief(noBible, model, "the harbour at dusk");
    assert.doesNotMatch(brief, /The harbour drowned itself/);
    assert.doesNotMatch(brief, /not settled fact/);
  });

  /** The rewrite is the only place these can be said: the bench sends the brief as it stands. */
  it("passes on the look's standing failures, and omits the rule when there are none", () => {
    const brief = enhancerBrief(bundle, model, "the harbour at dusk");
    assert.match(brief, /standing failures/);
    assert.match(brief, /- Hands stay whole/);
    assert.match(brief, /- No lens flare/);
    const none = {
      ...bundle,
      artDirection: { ...bundle.artDirection, failureModes: [] },
    } as WorldBundle;
    assert.doesNotMatch(enhancerBrief(none, model, "x"), /standing failures/);
  });
});
