import assert from "node:assert/strict";
import { it } from "node:test";
import { CapabilitySchema } from "@arke-studio/contracts";
import { CAPABILITY_LABEL } from "../src/screens/settings-parts.js";

it("names every capability a probe can report, drawn as a kind or not", () => {
  // A capability without a word printed "undefined" on the provider pane (voice-conversion, 2026-10-07).
  for (const capability of CapabilitySchema.options) {
    assert.equal(typeof CAPABILITY_LABEL[capability], "string", `${capability} has a label`);
    assert.ok(CAPABILITY_LABEL[capability].length > 0);
  }
});
