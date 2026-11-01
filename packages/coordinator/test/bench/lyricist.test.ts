import assert from "node:assert/strict";
import { it } from "node:test";
import { draftLyrics } from "../../src/bench/lyricist.js";

it("reports model readiness failures with the Lyricist setting and no automatic retry (#2238)", async () => {
  let calls = 0;
  const result = await draftLyrics(async () => {
    calls++;
    throw new Error("GitHub Copilot model unavailable-model is not ready in this session. No prompt was sent.");
  }, { description: "A farewell" });
  assert.equal(calls, 1);
  assert.equal(result.lyrics, null);
  assert.match(result.reason!, /GitHub Copilot model unavailable-model.*No prompt was sent/);
  assert.match(result.reason!, /Settings > Harness > Advanced > Lyricist/);
});

it("distinguishes an unusable reply from a failure and preserves a valid draft", async () => {
  assert.match((await draftLyrics(async () => null, { description: "A farewell" })).reason!, /no usable lyrics/);
  assert.deepEqual(await draftLyrics(async brief => {
    assert.match(brief, /A farewell/); assert.match(brief, /Slow sea shanty/);
    return "[verse]\nFarewell";
  }, { description: "A farewell", style: "Slow sea shanty" }), { lyrics: "[verse]\nFarewell" });
  const privateError = await draftLyrics(async () => { throw new Error("Could not read C:/private/settings.json"); }, { description: "A farewell" });
  assert.doesNotMatch(privateError.reason!, /private|settings.json/);
});
