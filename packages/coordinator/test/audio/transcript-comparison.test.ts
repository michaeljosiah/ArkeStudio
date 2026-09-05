import assert from "node:assert/strict";
import { it } from "node:test";
import { compareAudioTranscript, transcriptCacheKey } from "../../src/audio/transcript-comparison.js";
const hash = `sha256:${"a".repeat(64)}`;
const transcriber = { id: "local", version: "1" };
it("normalizes whitespace and NFKC while retaining wording changes without timestamps", () => {
  const exact = compareAudioTranscript({ audioHash: hash, authoredText: "Hello  world", observedText: "Hello\nworld", transcriber });
  assert.equal(exact.status, "compared");
  if (exact.status === "compared") { assert.equal(exact.result, "exact"); assert.equal(exact.boundaryAlignment, "unavailable"); }
  const mismatch = compareAudioTranscript({ audioHash: hash, authoredText: "Hello old world", observedText: "Hello new world!", transcriber });
  if (mismatch.status === "compared") assert.deepEqual(mismatch.differences, [{ kind: "changed", authored: "old world", observed: "new world!" }]);
});
it("represents unavailable STT honestly and keys caches by all comparison inputs", () => {
  const missing = compareAudioTranscript({ audioHash: hash, authoredText: "Hello", transcriber });
  assert.equal(missing.status, "unavailable");
  assert.notEqual(transcriptCacheKey(hash, "Hello", transcriber), transcriptCacheKey(hash, "hello", transcriber));
  assert.notEqual(transcriptCacheKey(hash, "Hello", transcriber), transcriptCacheKey(hash, "Hello", { ...transcriber, version: "2" }));
});
