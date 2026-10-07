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
  const v2 = voices.filter((voice) => voice.model === "eleven_multilingual_v2");
  assert.equal(calls.length, 4); assert.equal(v2.length, 358);
  assert.deepEqual(v2[357]?.facets, { language: "english", accent: "british", gender: "male", style: "narration" });
  assert.match(v2[357]!.previewUrl!, /sample.mp3$/);
});

it("lists every voice under each ElevenLabs reader, so a v3 or v4 narrator can be found", async () => {
  // A narrator is matched by provider, model and voice together: listed under v2 alone, a voice
  // chosen for v3 never matched and the book fell back to the default reader.
  const client = new ElevenLabsClient(async () => new Response(JSON.stringify({ voices: [
    { voice_id: "ife", name: "Ife", category: "cloned" },
    { voice_id: "pvc-old", name: "Trained on v2", category: "professional", high_quality_base_model_ids: ["eleven_multilingual_v2"] },
    { voice_id: "pvc-new", name: "Trained on v4", category: "professional", high_quality_base_model_ids: ["eleven_multilingual_v2", "eleven_v4"] },
  ], has_more: false })));
  const voices = await client.listVoicesCatalog("key");
  const under = (id: string) => voices.filter((voice) => voice.voiceId === id).map((voice) => voice.model).sort();
  assert.deepEqual(under("ife"), ["eleven-v3", "eleven_multilingual_v2", "eleven_v4"]);
  assert.deepEqual(under("pvc-old"), ["eleven-v3", "eleven_multilingual_v2"], "a professional clone waits for its v4 training");
  assert.deepEqual(under("pvc-new"), ["eleven-v3", "eleven_multilingual_v2", "eleven_v4"]);
});
it("rejects an incomplete catalogue instead of presenting a successful empty or partial result", async () => {
  const failed = new ElevenLabsClient(async () => new Response("{}", { status: 500 }));
  await assert.rejects(failed.listVoicesCatalog("key"), /could not be loaded/);
  const repeated = new ElevenLabsClient(async () => new Response(JSON.stringify({ voices: [], has_more: true, next_page_token: "same" })));
  await assert.rejects(repeated.listVoicesCatalog("key"), /incomplete/);
});
