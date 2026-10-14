import assert from "node:assert/strict";
import { test } from "node:test";
import { AnalyzeAudioArgsSchema, ReviewAudioContentArgsSchema } from "../src/agent-media.js";
import { AgentTranscriptTextSchema } from "../src/agent-audio.js";

test("speech references are explicit bounded text, never file paths or arbitrary extras", () => {
  const args = { source: { kind: "artifact", id: "ar-one" }, range: { startSec: 0, endSec: 60 }, expectedText: "Do not leave." };
  assert.ok(ReviewAudioContentArgsSchema.safeParse(args).success);
  for (const invalid of [{ ...args, expectedText: " " }, { ...args, expectedText: undefined },
    { ...args, expectedText: "a".repeat(12001) }, { ...args, expectedText: "word ".repeat(1001) },
    { ...args, source: { kind: "path", path: "C:/private.wav" } }, { ...args, language: "auto" },
    { ...args, range: { startSec: 0, endSec: 61 } }]) assert.equal(ReviewAudioContentArgsSchema.safeParse(invalid).success, false);
  assert.equal(AnalyzeAudioArgsSchema.safeParse(args).success, false, "transcription cannot silently accept a review script");
  assert.equal(AgentTranscriptTextSchema.parse("  Stay here  "), "Stay here");
});
