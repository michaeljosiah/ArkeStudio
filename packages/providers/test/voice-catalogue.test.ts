import assert from "node:assert/strict";
import { it } from "node:test";
import { ElevenLabsClient } from "../src/clients/elevenlabs.js";

it("loads all 358 voices across pages and preserves labelled facets and the provider sample", async () => {
  const calls: string[] = [];
  const client = new ElevenLabsClient(async (url) => {
    calls.push(url);
    const page = Number(new URL(url).searchParams.get("next_page_token") ?? 0);
    return new Response(JSON.stringify({ voices: Array.from({ length: page === 3 ? 58 : 100 }, (_, i) => ({
      voice_id: String(page * 100 + i), name: "George", labels: { accent: "British", gender: "Male", language: "English", use_case: "Narration" },
      description: "Warm and clear", preview_url: "https://storage.googleapis.com/eleven-public-prod/sample.mp3",
    })), has_more: page < 3, next_page_token: String(page + 1) }));
  });
  const voices = await client.listVoicesCatalog("test-key");
  assert.equal(calls.length, 4); assert.equal(voices.length, 358);
  assert.deepEqual(voices[357]?.facets, { language: "english", accent: "british", gender: "male", style: "narration" });
  assert.match(voices[357]!.previewUrl!, /sample.mp3$/);
});
it("rejects an incomplete catalogue instead of presenting a successful empty or partial result", async () => {
  const failed = new ElevenLabsClient(async () => new Response("{}", { status: 500 }));
  await assert.rejects(failed.listVoicesCatalog("key"), /could not be loaded/);
  const repeated = new ElevenLabsClient(async () => new Response(JSON.stringify({ voices: [], has_more: true, next_page_token: "same" })));
  await assert.rejects(repeated.listVoicesCatalog("key"), /incomplete/);
});
