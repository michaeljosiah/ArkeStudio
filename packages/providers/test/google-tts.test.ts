import assert from "node:assert/strict";
import { it } from "node:test";
import { GoogleClient, GEMINI_TTS_MODELS, geminiSpeechUsage, geminiWav } from "../src/clients/google.js";
import { ProviderAuthError, ProviderBusyError, ProviderRequestRejectedError, type SubmitRequest } from "../src/types.js";
import { ManifestModelSchema, mapCadence } from "@arke-studio/contracts";
import { geminiSpeechModel } from "../src/gemini-tts-models.js";
import { SHIPPED_MANIFEST } from "../src/manifest-data.js";

const request: SubmitRequest = { model: GEMINI_TTS_MODELS[0], capability: "voice-tts", params: { text: "Keep these exact words.", voiceId: "Kore", instructions: "Whisper urgently" } };
function wav() {
  const bytes = Buffer.alloc(48);
  bytes.write("RIFF"); bytes.writeUInt32LE(40, 4); bytes.write("WAVEfmt ", 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(4, 40);
  return bytes;
}
const responseBody = () => ({ id: "interaction-1", model: request.model, status: "completed",
  usage: { total_input_tokens: 8, output_tokens_by_modality: [{ modality: "audio", tokens: 50 }] },
  steps: [{ type: "model_output", content: [{ type: "audio", mime_type: "audio/wav", data: wav().toString("base64") }] }] });

it("shipped rows compile all six deliveries into structured style", async () => {
  for (const variant of ["flash", "lite"] as const) {
    const row = ManifestModelSchema.parse(geminiSpeechModel(variant));
    assert.deepEqual(SHIPPED_MANIFEST.models.find(model => model.id === row.id), row);
    for (const delivery of row.cadence!.deliveries) {
      const hash = `sha256:${"a".repeat(64)}`;
      const mapped = mapCadence("Keep these exact words.", hash, { schemaVersion: 1, sourceTextHash: hash, delivery, speed: 1, note: "quietly confident", cues: [] }, row);
      const client = new GoogleClient(async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        const content = body.input[0].content[0];
        assert.equal(content.text, "Keep these exact words.");
        assert.equal(content.annotations[0].style, mapped.instructions);
        assert.ok(mapped.instructions?.endsWith("Quietly confident."), "the note as a sentence after the delivery's");
        return Response.json({ ...responseBody(), model: row.id });
      });
      const result = await client.submit("test", { ...request, model: row.id, params: { text: mapped.providerText, voiceId: "Charon", voiceSettings: mapped.voiceSettings, instructions: mapped.instructions } });
      assert.ok(result.artifacts?.length);
    }
  }
});

it("carries Bench and line delivery through structured style, while an explicit compiled style wins", async () => {
  for (const delivery of ["measured", "whispered", "breaking", "cold", "warm", "urgent"] as const) {
    const client = new GoogleClient(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.input[0].content[0].text, "Keep these exact words.");
      assert.equal(body.input[0].content[0].annotations[0].style, geminiSpeechModel("flash").cadence!.deliveryMappings[delivery]!.instruction);
      return Response.json(responseBody());
    });
    await client.submit("test", { ...request, params: { text: request.params.text, voiceId: "Charon", delivery, voiceSettings: {} } });
  }
  const client = new GoogleClient(async (_url, init) => {
    assert.equal(JSON.parse(String(init?.body)).input[0].content[0].annotations[0].style, "Act this particular span.");
    return Response.json(responseBody());
  });
  await client.submit("test", { ...request, params: { ...request.params, delivery: "warm", instructions: "Act this particular span." } });
});

it("uses exact pinned model ids, separate style metadata, stateless unary WAV and the full output ceiling", async () => {
  for (const model of GEMINI_TTS_MODELS) {
    const client = new GoogleClient(async (url, init) => {
      assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/interactions");
      assert.equal(new Headers(init?.headers).get("x-goog-api-key"), "secret-test-key");
      assert.equal(init?.redirect, "error", "the custom key header must not follow redirects");
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body, { model, store: false, input: [{ type: "user_input", content: [{ type: "text", text: request.params.text,
        annotations: [{ type: "speech_metadata", style: request.params.instructions }] }] }],
        response_format: { type: "audio", mime_type: "audio/wav", sample_rate: 24000 },
        generation_config: { max_output_tokens: 16384, speech_config: [{ voice: "Kore" }] } });
      return Response.json({ ...responseBody(), model });
    });
    const made = await client.submit("secret-test-key", { ...request, model });
    assert.deepEqual(made.artifacts?.[0]?.data, wav());
    assert.deepEqual(made.speechUsage, { inputTextTokens: 8, outputAudioTokens: 50 });
    assert.equal(client.declarations.supportsIdempotencyKey, false);
    assert.equal(client.declarations.reportsCost, false);
  }
});

it("accepts witnessed stateless interactions without a server id and keeps their usage", async () => {
  const body = { ...responseBody(), id: undefined, object: "interaction" };
  const client = new GoogleClient(async () => Response.json(body));
  const first = await client.submit("test", request);
  const second = await client.submit("test", request);
  assert.match(first.remoteId, /^google-inline:[0-9a-f-]{36}$/);
  assert.notEqual(first.remoteId, second.remoteId);
  assert.deepEqual(first.artifacts?.[0]?.data, wav());
  assert.deepEqual(first.speechUsage, { inputTextTokens: 8, outputAudioTokens: 50 });
  const incomplete = await new GoogleClient(async () => Response.json({ ...body, status: "incomplete" })).submit("test", request);
  assert.ok(incomplete.error);
  assert.equal(incomplete.artifacts, undefined);
  assert.deepEqual(incomplete.speechUsage, first.speechUsage);
  await assert.rejects(new GoogleClient(async () => Response.json({ ...body, object: "unexpected" })).submit("test", request), /outcome is uncertain/);
});

it("reads a models/ resource name as the pinned model, and nothing else", async () => {
  const named = await new GoogleClient(async () => Response.json({ ...responseBody(), model: `models/${request.model}` })).submit("test", request);
  assert.equal(named.error, undefined);
  assert.deepEqual(named.artifacts?.[0]?.data, wav());
  for (const model of [`tunedModels/${request.model}`, "models/gemini-invented-tts"]) {
    const other = await new GoogleClient(async () => Response.json({ ...responseBody(), model })).submit("test", request);
    assert.ok(other.error, model);
    assert.equal(other.artifacts, undefined, model);
  }
});

it("keeps reported usage on incomplete, missing, duplicate and malformed audio without returning an artifact", async () => {
  const complete = responseBody();
  for (const body of [
    { ...complete, status: "incomplete" }, { ...complete, steps: [] },
    { ...complete, model: "gemini-something-else" },
    { ...complete, steps: [...complete.steps, ...complete.steps] },
    { ...complete, steps: [{ type: "model_output", content: [{ type: "audio", mime_type: "audio/wav", data: wav().subarray(0, 45).toString("base64") }] }] },
  ]) {
    const made = await new GoogleClient(async () => Response.json(body)).submit("test", request);
    assert.ok(made.error);
    assert.equal(made.artifacts, undefined);
    assert.deepEqual(made.speechUsage, { inputTextTokens: 8, outputAudioTokens: 50 });
  }
});

it("refuses unsupported models, unbound custom voices, reference bytes, numeric controls and oversized compiled input before I/O", async () => {
  let calls = 0;
  const client = new GoogleClient(async () => { calls++; throw new Error("must not call"); });
  for (const invalid of [
    { ...request, model: "gemini-latest" }, { ...request, params: { ...request.params, voiceId: "voicekey_secret" } },
    { ...request, params: { ...request.params, voiceId: "voice_custom" } },
    { ...request, params: { ...request.params, voiceSettings: { speed: 1.1 } } },
    { ...request, voiceReference: { name: "clip", contentType: "audio/wav" as const, data: wav() } },
    { ...request, params: { ...request.params, instructions: "漢".repeat(2400) } },
  ]) await assert.rejects(client.submit("test", invalid), ProviderRequestRejectedError);
  assert.equal(calls, 0);
});

it("models and presets are read-only, paginate, and offer only models the account listed", async () => {
  const urls: string[] = [];
  const client = new GoogleClient(async (url, init) => {
    urls.push(url);
    assert.equal(init?.method, undefined);
    assert.equal(init?.redirect, "error");
    if (url.includes("/voices?")) return Response.json({ voices: [{ id: "Kore", type: "prebuilt", persona: "Firm" }] });
    return Response.json(url.includes("pageToken=") ? { models: [{ name: `models/${GEMINI_TTS_MODELS[1]}` }] }
      : { models: [{ name: "models/another-model" }], nextPageToken: "next page" });
  });
  const voices = await client.listVoicesCatalog("test");
  assert.equal(voices.length, 1);
  assert.ok(voices.every(voice => voice.model === GEMINI_TTS_MODELS[1]));
  assert.equal(urls.length, 3);
  assert.ok(urls[1]!.includes("pageToken=next%20page"));
  const missing = await new GoogleClient(async () => Response.json({ models: [] })).validateKey("test");
  assert.equal(missing[0]!.available, false);
  assert.equal(missing[0]!.authenticated, true);
});

it("separates witnessed auth/permission/quota rejection from an uncertain server failure", async () => {
  for (const [status, klass] of [[401, ProviderAuthError], [403, ProviderRequestRejectedError], [429, ProviderBusyError]] as const) {
    const client = new GoogleClient(async () => new Response("", { status }));
    await assert.rejects(client.submit("test", request), error => error instanceof klass && error.submissionRejected === true);
  }
  await assert.rejects(new GoogleClient(async () => new Response("", { status: 503 })).submit("test", request), error =>
    error instanceof Error && !("submissionRejected" in error));
  await assert.rejects(new GoogleClient(async () => Response.json({ error: { details: [{ reason: "API_KEY_INVALID" }] } }, { status: 400 })).submit("test", request), ProviderAuthError);
});

it("passes cancellation through without promising a refund", async () => {
  const controller = new AbortController();
  const client = new GoogleClient(async (_url, init) => {
    assert.equal(init?.signal, controller.signal);
    controller.abort();
    throw new DOMException("Aborted", "AbortError");
  });
  await assert.rejects(client.submit("test", { ...request, signal: controller.signal }), /Aborted/);
});

it("does not turn missing usage into zero or WAV duration into token usage", () => {
  assert.deepEqual(geminiSpeechUsage(undefined), {});
  assert.deepEqual(geminiSpeechUsage({ total_input_tokens: -1, total_output_tokens: NaN }), {});
  assert.deepEqual(geminiSpeechUsage({ total_output_tokens: 0 }), { outputAudioTokens: 0 });
  const incompatible = wav(); incompatible.writeUInt32LE(44100, 24);
  assert.equal(geminiWav(incompatible), false);
  assert.equal(geminiWav(wav()), true);
});

it("synthesizes a discovered extended preset but refuses a removed voice before a paid request", async () => {
  const requests: string[] = [];
  const client = new GoogleClient(async (url, init) => {
    requests.push(url);
    if (url.includes("/voices?")) return Response.json({ voices: [{ id: "ExtendedNarrator", type: "prebuilt", gender: "female" }] });
    assert.equal(JSON.parse(String(init?.body)).generation_config.speech_config[0].voice, "ExtendedNarrator");
    return Response.json(responseBody());
  });
  const result = await client.submit("test", { ...request, params: { ...request.params, voiceId: "ExtendedNarrator" } });
  assert.equal(result.artifacts?.[0]?.contentType, "audio/wav");
  assert.equal(requests.filter(url => url.endsWith("/interactions")).length, 1);
  await assert.rejects(client.submit("test", { ...request, params: { ...request.params, voiceId: "RemovedNarrator" } }), /no longer/);
  assert.equal(requests.filter(url => url.endsWith("/interactions")).length, 1);
});
