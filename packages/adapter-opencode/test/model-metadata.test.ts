import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { harnessModelMissingInput } from "@arke-studio/contracts";
import { modelMetadata, providerNameOf, type WireModel } from "../src/model-metadata.js";

describe("OpenCode input capability metadata", () => {
  const cases: { name: string; input: NonNullable<WireModel["capabilities"]>["input"]; expected: ("text" | "image")[] | undefined; missing: "text" | "image" | undefined }[] = [
    { name: "sparse text support", input: { text: true }, expected: ["text"], missing: "image" },
    { name: "sparse image support", input: { image: true }, expected: ["image"], missing: "text" },
    { name: "explicit lack of text support", input: { text: false }, expected: [], missing: "text" },
    { name: "explicit lack of image support", input: { image: false }, expected: [], missing: "text" },
    { name: "both inputs disabled", input: { text: false, image: false }, expected: [], missing: "text" },
    { name: "audio-only object metadata", input: { audio: true }, expected: [], missing: "text" },
    { name: "audio-only array metadata", input: ["audio"], expected: [], missing: "text" },
    { name: "an unsupported modality explicitly disabled", input: { audio: false }, expected: [], missing: "text" },
    { name: "complete text-only metadata", input: { text: true, image: false }, expected: ["text"], missing: "image" },
    { name: "complete multimodal metadata", input: { text: true, image: true }, expected: ["text", "image"], missing: undefined },
    { name: "an empty object", input: {}, expected: undefined, missing: undefined },
    { name: "an absent input field", input: undefined, expected: undefined, missing: undefined },
    { name: "an explicit empty array", input: [], expected: [], missing: "text" },
    { name: "an array of supported modalities", input: ["text", "image", "audio"], expected: ["text", "image"], missing: undefined },
  ];
  for (const { name, input, expected, missing } of cases) {
    it(`preserves ${name} through Stage capability admission`, () => {
      const metadata = modelMetadata({ capabilities: { input } });
      assert.deepEqual(metadata.inputModalities, expected);
      assert.equal(Object.hasOwn(metadata, "inputModalities"), expected !== undefined);
      assert.equal(harnessModelMissingInput(metadata, true), missing);
    });
  }

  it("does not infer modality from a model name or missing capabilities", () => {
    assert.deepEqual(modelMetadata({ name: "Vision model" }), { displayName: "Vision model" });
    assert.deepEqual(modelMetadata({ capabilities: {} }), {});
  });
});

describe("OpenCode picker metadata (design turn 195)", () => {
  it("reads the shape OpenCode 1.18.34 measured: variants keyed in order, cost per million, reasoning on capabilities", () => {
    assert.deepEqual(
      modelMetadata({
        name: "Fledge Alpha Free",
        capabilities: { reasoning: true, tools: true, input: { text: true, image: true } },
        cost: { input: 0, output: 0 },
        variants: { low: { reasoningEffort: "low" }, high: { reasoningEffort: "high" }, max: { reasoningEffort: "max" } },
      }),
      {
        displayName: "Fledge Alpha Free", inputModalities: ["text", "image"], tools: true, reasoning: true,
        cost: { inputPerMTok: 0, outputPerMTok: 0 }, variants: { names: ["low", "high", "max"] },
      },
    );
  });

  it("states nothing the harness did not: no reasoning, variants or cost keys when absent", () => {
    const metadata = modelMetadata({ name: "Plain" });
    assert.deepEqual(metadata, { displayName: "Plain" });
    for (const key of ["reasoning", "variants", "cost"]) assert.equal(Object.hasOwn(metadata, key), false);
  });

  it("keeps an explicit false reasoning, and a model's own flag over its capabilities", () => {
    assert.equal(modelMetadata({ capabilities: { reasoning: false } }).reasoning, false);
    assert.equal(modelMetadata({ reasoning: true, capabilities: { reasoning: false } }).reasoning, true);
  });

  it("drops a variant a configuration switched off, and offers none when none are left", () => {
    assert.deepEqual(modelMetadata({ variants: { low: {}, high: { disabled: true }, max: {} } }).variants, { names: ["low", "max"] });
    assert.equal(modelMetadata({ variants: { high: { disabled: true } } }).variants, undefined);
    assert.equal(modelMetadata({ variants: {} }).variants, undefined);
  });

  it("reads a catalogue that lists variants as names or rows, once each", () => {
    assert.deepEqual(modelMetadata({ variants: ["low", { id: "high" }, { name: "max" }, "low"] }).variants, { names: ["low", "high", "max"] });
  });

  it("takes a priced row's first tier and refuses a half-stated or negative price", () => {
    assert.deepEqual(modelMetadata({ cost: [{ input: 1.25, output: 10 }, { input: 2.5, output: 15 }] }).cost, { inputPerMTok: 1.25, outputPerMTok: 10 });
    assert.equal(modelMetadata({ cost: { input: 1 } }).cost, undefined);
    assert.equal(modelMetadata({ cost: { input: -1, output: 2 } }).cost, undefined);
    assert.equal(modelMetadata({ cost: { input: Number.NaN, output: 2 } }).cost, undefined);
  });

  it("names the provider where the row carries a name", () => {
    assert.equal(providerNameOf({ providerName: "OpenAI" }), "OpenAI");
    assert.equal(providerNameOf({ provider: { name: "Anthropic" } }), "Anthropic");
    assert.equal(providerNameOf({}), undefined);
    assert.equal(providerNameOf({ providerName: "" }), undefined);
  });
});
