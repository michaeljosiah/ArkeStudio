import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { harnessModelMissingInput } from "@arke-studio/contracts";
import { modelMetadata, type WireModel } from "../src/model-metadata.js";

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
