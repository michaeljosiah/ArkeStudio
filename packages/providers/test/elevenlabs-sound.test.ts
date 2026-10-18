import assert from "node:assert/strict";
import { it } from "node:test";
import { ElevenLabsClient } from "../src/clients/elevenlabs.js";
import type { SubmitRequest } from "../src/types.js";

/** ElevenLabs sound effects and Eleven Music (SPEC-057 R-39, R-40): what is sent, and what is refused here. */
const mp3 = new Uint8Array([73, 68, 51, 4]);

it("sends a sound effect's words, set length, loop and influence to text-to-sound v2", async () => {
  let sent: { url: string; body: unknown } | null = null;
  const client = new ElevenLabsClient(async (url, init) => {
    sent = { url, body: JSON.parse(String(init?.body)) };
    return new Response(mp3, { headers: { "request-id": "sfx-1" } });
  });
  const result = await client.submit("key", { capability: "sound-effect", model: "eleven_text_to_sound_v2",
    params: { text: "One deep stroke of a harbour bell, close and dry", durationSeconds: 4, loop: false, promptInfluence: 0.5 } } as SubmitRequest);
  assert.match(sent!.url, /\/v1\/sound-generation\?output_format=mp3_44100_128$/);
  assert.deepEqual(sent!.body, { text: "One deep stroke of a harbour bell, close and dry", model_id: "eleven_text_to_sound_v2", duration_seconds: 4, prompt_influence: 0.5 });
  assert.equal(result.remoteId, "sfx-1");
  assert.equal(result.artifacts?.[0]?.contentType, "audio/mpeg");
});

it("leaves the length to the model when none is set, asks for a loop, and refuses over 30 s before sending", async () => {
  const bodies: unknown[] = [];
  const client = new ElevenLabsClient(async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return new Response(mp3); });
  await client.submit("key", { capability: "sound-effect", model: "eleven_text_to_sound_v2", params: { text: "Rain on glass", loop: true } } as SubmitRequest);
  assert.deepEqual(bodies[0], { text: "Rain on glass", model_id: "eleven_text_to_sound_v2", loop: true });
  for (const durationSeconds of [31, 0.2]) {
    await assert.rejects(client.submit("key", { capability: "sound-effect", model: "eleven_text_to_sound_v2", params: { text: "x", durationSeconds } } as SubmitRequest), /0\.5 to 30 seconds/);
  }
  assert.equal(bodies.length, 1, "a refused length never reaches ElevenLabs");
});

it("composes instrumental music of the asked length with Eleven Music", async () => {
  let sent: { url: string; body: unknown } | null = null;
  const client = new ElevenLabsClient(async (url, init) => { sent = { url, body: JSON.parse(String(init?.body)) }; return new Response(mp3); });
  await client.submit("key", { capability: "music", model: "music_v1", params: { prompt: "A cello, solo, slow", durationSeconds: 45 } } as SubmitRequest);
  assert.match(sent!.url, /\/v1\/music\?output_format=mp3_44100_128$/);
  assert.deepEqual(sent!.body, { prompt: "A cello, solo, slow", model_id: "music_v1", force_instrumental: true, music_length_ms: 45_000 });
});

it("reads the shared durationSec, and sings the Bench's lyrics rather than dropping them (codex on PR 1872)", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const client = new ElevenLabsClient(async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return new Response(mp3); });
  await client.submit("key", { capability: "music", model: "music_v1", params: { prompt: "Lagos highlife, brass", durationSec: 60 } } as SubmitRequest);
  assert.equal(bodies[0]!["music_length_ms"], 60_000, "the priced length is the length sent");
  await client.submit("key", { capability: "music", model: "music_v1", params: { prompt: "Lagos highlife", lyrics: "Water rise, water fall", durationSec: 30 } } as SubmitRequest);
  assert.equal(bodies[1]!["force_instrumental"], false);
  assert.equal(bodies[1]!["prompt"], "Lagos highlife\n\nLyrics:\nWater rise, water fall");
  await client.submit("key", { capability: "sound-effect", model: "eleven_text_to_sound_v2", params: { text: "Rain", durationSec: 3 } } as SubmitRequest);
  assert.equal(bodies[2]!["duration_seconds"], 3);
});

it("refuses style and lyrics past Eleven Music's 2,000 characters before sending (codex on PR 1872)", async () => {
  let calls = 0;
  const client = new ElevenLabsClient(async () => { calls++; return new Response(mp3); });
  await assert.rejects(client.submit("key", { capability: "music", model: "music_v1", params: { prompt: "Highlife", lyrics: "la ".repeat(700) } } as SubmitRequest), /2,000 characters/);
  assert.equal(calls, 0);
});
