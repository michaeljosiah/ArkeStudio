import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { arkeEmptyLine } from "../src/screens/cut.js";

describe("the Cut's Arke dock before any message (issue 3036)", () => {
  it("says nothing was written only while Arke has staged nothing for the cut", () => {
    assert.match(arkeEmptyLine(0), /^Nothing written with Arke about this cut yet/);
    assert.equal(arkeEmptyLine(2), "Ask Arke for another change to the cut.");
  });
});
