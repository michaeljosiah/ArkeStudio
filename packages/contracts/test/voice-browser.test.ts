import assert from "node:assert/strict";
import { it } from "node:test";
import { filterVoices, voiceFacet, UNSPECIFIED_VOICE_FACET, type VoiceCandidate } from "../src/voice.js";
import { jobOrigin } from "../src/activity.js";
import type { Job } from "../src/job.js";

const voices: VoiceCandidate[] = Array.from({ length: 358 }, (_, i) => ({ provider: "elevenlabs", model: "v2", voiceId: String(i),
  label: `Voice ${String(i).padStart(3, "0")}`, attributes: [], description: i % 2 ? "Warm and measured" : "Bright and clear",
  facets: i === 357 ? undefined : { language: i % 3 ? "English" : "French", gender: i % 2 ? "Male" : "Female", accent: "British" },
  local: false, canClone: true }));
it("searches the entire catalogue, intersects facets and matches every term without case sensitivity", () => {
  assert.equal(filterVoices(voices, "357 WARM", {})[0]?.voiceId, "357");
  const found = filterVoices(voices, "warm measured", { language: "english", gender: "male" });
  assert.ok(found.length > 50);
  assert.ok(found.every(v => Number(v.voiceId) % 2 && Number(v.voiceId) % 3));
  assert.equal(filterVoices(voices, "warm bright", {}).length, 0);
});
it("keeps missing metadata in unfiltered results and offers Not specified explicitly", () => {
  assert.equal(filterVoices(voices, "", {}).length, 358);
  assert.equal(voiceFacet(voices[357]!, "language"), UNSPECIFIED_VOICE_FACET);
  assert.deepEqual(filterVoices(voices, "", { language: UNSPECIFIED_VOICE_FACET }).map(v => v.voiceId), ["357"]);
});

it("groups explicit language tags with language names without inventing an accent", () => {
  const local = { ...voices[0]!, facets: { language: "en-GB" } };
  assert.equal(voiceFacet(local, "language"), "english");
  assert.equal(voiceFacet(local, "accent"), UNSPECIFIED_VOICE_FACET);
});

it("sends failed app previews back to Settings rather than to a nonexistent character sheet", () => {
  const job = { worldId: "app:voice-previews", target: { kind: "voice-preview", id: "cache-hash" }, params: {} } as Job;
  assert.equal(jobOrigin(job)?.path, "/settings/appearance");
});
