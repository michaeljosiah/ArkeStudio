import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EFFORT_WORDS, harnessEffortLabel, harnessEffortLabels, ModelInfoSchema, titleCaseVariant, type ModelInfo,
} from "../src/index.js";

const sonnet: ModelInfo = { id: "claude-other", provider: "anthropic", aliases: ["sonnet"] };

describe("the picker's catalogue fields (design turn 195)", () => {
  it("leaves all four absent when the harness states none, and keeps them when it does", () => {
    const bare = ModelInfoSchema.parse(sonnet);
    for (const key of ["providerName", "reasoning", "variants", "cost"]) assert.equal(Object.hasOwn(bare, key), false);
    const stated = ModelInfoSchema.parse({
      ...sonnet, providerName: "Anthropic", reasoning: false,
      variants: { names: ["low", "high"], default: "low" }, cost: { inputPerMTok: 3, outputPerMTok: 15 },
    });
    assert.equal(stated.providerName, "Anthropic");
    assert.equal(stated.reasoning, false, "a stated false is not an absence");
    assert.deepEqual(stated.variants, { names: ["low", "high"], default: "low" });
    assert.deepEqual(stated.cost, { inputPerMTok: 3, outputPerMTok: 15 });
  });

  it("refuses what cannot be drawn: an empty variant list, a negative price, an unnamed provider", () => {
    assert.equal(ModelInfoSchema.safeParse({ ...sonnet, variants: { names: [] } }).success, false);
    assert.equal(ModelInfoSchema.safeParse({ ...sonnet, cost: { inputPerMTok: -1, outputPerMTok: 1 } }).success, false);
    assert.equal(ModelInfoSchema.safeParse({ ...sonnet, providerName: "" }).success, false);
    assert.equal(ModelInfoSchema.safeParse({ ...sonnet, cost: { inputPerMTok: 0, outputPerMTok: 0 } }).success, true, "free is a stated price");
  });
});

describe("effort in plain words (design turn 195)", () => {
  it("maps each harness variant to the nearest of the five", () => {
    assert.deepEqual(harnessEffortLabels(["none", "low", "medium", "high", "xhigh"]), ["Minimal", "Low", "Medium", "High", "Highest"]);
    assert.deepEqual(harnessEffortLabels(["minimal", "default", "max"]), ["Minimal", "Medium", "Highest"]);
    assert.deepEqual(harnessEffortLabels(["LOW", "Highest"]), ["Low", "Highest"], "case does not matter");
    assert.deepEqual(harnessEffortLabels(["x-high"]), ["Highest"]);
  });

  it("keeps the harness's order and title-cases the second of two names that would take one word", () => {
    assert.deepEqual(harnessEffortLabels(["low", "high", "xhigh", "max"]), ["Low", "High", "Highest", "Max"]);
    assert.deepEqual(harnessEffortLabels(["medium", "default"]), ["Medium", "Default"]);
  });

  it("shows a name Arke has no word for title-cased as it comes", () => {
    assert.deepEqual(harnessEffortLabels(["low", "turbo", "deep_think", "extra-deep"]), ["Low", "Turbo", "Deep Think", "Extra Deep"]);
    assert.equal(titleCaseVariant("xhigh-plus"), "Xhigh Plus");
  });

  it("names one variant in the context of its model's whole list", () => {
    const variants = { names: ["low", "high", "xhigh", "max"] };
    assert.equal(harnessEffortLabel(variants, "xhigh"), "Highest");
    assert.equal(harnessEffortLabel(variants, "max"), "Max");
    assert.equal(harnessEffortLabel(variants, "medium"), undefined, "a variant the model does not list has no name");
    assert.deepEqual([...EFFORT_WORDS], ["Minimal", "Low", "Medium", "High", "Highest"]);
  });
});
