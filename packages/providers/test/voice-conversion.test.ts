import assert from "node:assert/strict";
import { it } from "node:test";
import { createHash } from "node:crypto";
import { ElevenLabsClient } from "../src/clients/elevenlabs.js";
import type { SubmitRequest } from "../src/types.js";
const bytes = new Uint8Array([82, 73, 70, 70, 1, 2, 3]);
const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const request: SubmitRequest = { capability: "voice-conversion", model: "eleven_multilingual_sts_v2",
  params: { voiceId: "voice_1", retention: "provider-history" },
  audioInputs: [{ data: bytes, contentType: "audio/wav", hash, durationSec: 2, name: "hash.wav" }] };

it("uploads only exact verified multipart audio and declared STS parameters", async () => {
  let posts = 0;
  const client = new ElevenLabsClient(async (url, init) => {
    if (url.endsWith("/v1/models")) return Response.json([{ model_id: request.model, can_do_voice_conversion: true }]);
    posts++;
    assert.match(url, /speech-to-speech\/voice_1\?output_format=mp3_44100_128&enable_logging=true$/);
    assert.equal(init?.method, "POST"); assert.ok(init?.body instanceof FormData);
    assert.deepEqual([...init.body.keys()], ["audio", "model_id", "file_format"]);
    const audio = init.body.get("audio") as File;
    assert.equal(audio.name, "hash.wav"); assert.equal(audio.type, "audio/wav");
    assert.deepEqual(new Uint8Array(await audio.arrayBuffer()), bytes);
    assert.equal(init.body.get("model_id"), request.model);
    return new Response(new Uint8Array([73, 68, 51, 0]), { headers: { "request-id": "remote-1" } });
  });
  const result = await client.submit("key", request);
  assert.equal(posts, 1); assert.equal(result.remoteId, "remote-1");
  assert.equal(result.artifacts?.[0]?.contentType, "audio/mpeg");
});
it("refuses invalid source or capability before network and unverified retention before paid upload", async () => {
  let calls = 0, posts = 0;
  const client = new ElevenLabsClient(async (url, init) => { calls++; if (init?.method === "POST") posts++;
    return Response.json(url.endsWith("/models") ? [{ model_id: request.model, can_do_voice_conversion: true }] : { tier: "creator" }); });
  const input = request.audioInputs![0]!;
  for (const bad of [ { ...request, capability: "voice-clone" }, { ...request, audioInputs: [] },
    { ...request, audioInputs: [input, input] }, { ...request, audioInputs: [{ ...input, hash: "changed" }] },
    { ...request, audioInputs: [{ ...input, durationSec: 301 }] }, { ...request, audioInputs: [{ ...input, contentType: "video/mp4" }] } ]) {
    await assert.rejects(client.submit("key", bad as SubmitRequest));
  }
  assert.equal(calls, 0);
  await assert.rejects(client.submit("key", { ...request, params: { ...request.params, retention: "zero-retention" } }), /enterprise/);
  assert.equal(posts, 0);
});
it("probes conversion independently and reports zero retention only for verified enterprise", async () => {
  for (const tier of ["creator", "enterprise"]) {
    const client = new ElevenLabsClient(async url => Response.json(url.endsWith("/models") ?
      [{ model_id: request.model, can_do_voice_conversion: true }] : { tier, can_use_instant_voice_cloning: false }));
    const probes = await client.validateKey("key");
    assert.equal(probes.find(p => p.capability === "voice-clone")?.available, false);
    assert.equal(probes.find(p => p.capability === "voice-conversion")?.available, true);
    assert.equal(probes.find(p => p.capability === "voice-conversion")?.zeroRetention, tier === "enterprise");
  }
});

it("maps the explicit Eleven v3 app alias to its wire id for TTS", async () => {
  const client = new ElevenLabsClient(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model_id, "eleven_v3"); assert.equal(body.text, "[whispers] Hello");
    return new Response(new Uint8Array([73, 68, 51]));
  });
  await client.submit("key", { capability: "voice-tts", model: "eleven-v3", params: { voiceId: "voice_1", text: "[whispers] Hello" } });
});
