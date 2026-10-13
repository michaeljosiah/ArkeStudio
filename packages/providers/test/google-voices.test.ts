import assert from "node:assert/strict";
import { it } from "node:test";
import { GoogleClient, GEMINI_TTS_MODELS } from "../src/clients/google.js";
import { GEMINI_VOICE_DESIGN_AVAILABILITY } from "../src/clients/google-voices.js";
import { ProviderBusyError, ProviderRequestRejectedError, type VoiceDesignInput } from "../src/types.js";

const input: VoiceDesignInput = { model: GEMINI_TTS_MODELS[0], name: "Quiet astronomer", description: "Warm, thoughtful British voice with a dry wit.", language: "en-GB" };
function wav() {
  const data = Buffer.alloc(48);
  data.write("RIFF"); data.writeUInt32LE(40, 4); data.write("WAVEfmt ", 8); data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(24000, 24); data.writeUInt32LE(48000, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write("data", 36); data.writeUInt32LE(4, 40);
  return data;
}
function voice() {
  return { id: "voice_abc123", type: "prompted", model: input.model, display_name: input.name,
    prompted: { input: input.description }, language_code: input.language, expire_time: "2027-09-28T00:00:00Z",
    sample_audio: { mime_type: "audio/wav", data: wav().toString("base64") },
    usage: { input_tokens_by_modality: [{ modality: "text", tokens: 20 }], output_tokens_by_modality: [{ modality: "audio", tokens: 100 }] } };
}

it("the durable submit path creates one candidate and preserves witnessed identity on an invalid preview", async () => {
  let calls = 0;
  const client = new GoogleClient(async () => { calls++; return Response.json({ ...voice(), sample_audio: undefined }); });
  const result = await client.submit("key", { voiceDesign: true, model: input.model, capability: "voice-tts",
    params: { name: input.name, text: input.description, language: input.language } });
  assert.equal(calls, 1);
  assert.equal(result.remoteId, "voice_abc123");
  assert.ok(result.error);
  assert.deepEqual(result.speechUsage, { inputTextTokens: 20, outputAudioTokens: 100 });
});

it("requires a host binding and the current project's exact stored voice before synthesis", async () => {
  const requests: string[] = [];
  const target = "designed:dv_01J8F3K2QW9VZX4N7M0RTYB6HC:1";
  const client = new GoogleClient(async (url, init) => {
    requests.push(String(url));
    assert.equal(new Headers(init?.headers).get("x-goog-api-key"), "current-key");
    if (String(url).includes("/voices/")) return new Response(null, { status: 404 });
    assert.fail("a missing identity must not reach paid synthesis");
  });
  const request = { model: input.model, capability: "voice-tts" as const, params: { text: "Hello", voiceId: target } };
  await assert.rejects(client.submit("current-key", request), /verified binding/);
  assert.equal(requests.length, 0);
  await assert.rejects(client.submit("current-key", { ...request, designedVoice: { target, remoteId: "voice_abc123" } }), /unavailable/);
  assert.equal(requests.length, 1);
});

it("declares the published-rate estimate basis and does no work when a client is constructed", () => {
  const client = new GoogleClient(async () => { assert.fail("construction must be free of I/O"); });
  assert.equal(client.id, "google");
  assert.equal(GEMINI_VOICE_DESIGN_AVAILABILITY.available, true);
  assert.equal(GEMINI_VOICE_DESIGN_AVAILABILITY.pricingBasis, "published-model-rate-estimate");
});

it("creates one stored prompted identity with either pinned model and returns its kept sample and usage", async () => {
  for (const model of GEMINI_TTS_MODELS) {
    const controller = new AbortController();
    let calls = 0;
    const client = new GoogleClient(async (url, init) => {
      calls++;
      assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/voices");
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "error");
      assert.equal(init?.signal, controller.signal);
      assert.equal(new Headers(init?.headers).get("x-goog-api-key"), "test-key");
      assert.deepEqual(JSON.parse(String(init?.body)), { store: true, voice: { model, type: "prompted",
        display_name: input.name, language_code: input.language, gender: "neutral", prompted: { input: input.description } } });
      return Response.json({ ...voice(), model });
    });
    const result = await client.createDesignedVoice("test-key", { ...input, model, gender: "neutral" }, controller.signal);
    assert.equal(calls, 1);
    assert.equal(result.problem, undefined);
    assert.equal(result.voice?.remoteId, "voice_abc123");
    assert.equal(result.voice?.expiresAt, "2027-09-28T00:00:00Z");
    assert.equal(result.voice?.model, model);
    assert.deepEqual(result.sample?.data, wav());
    assert.deepEqual(result.speechUsage, { inputTextTokens: 20, outputAudioTokens: 100 });
  }
});

it("rejects invalid input before network work and never accepts stateless keys or path fragments", async () => {
  const client = new GoogleClient(async () => { assert.fail("invalid input must not leave the host"); });
  for (const patch of [{ model: "invented" }, { name: " " }, { description: "x".repeat(4001) }, { language: "../en" }, { gender: "bad" }]) {
    await assert.rejects(client.createDesignedVoice("key", { ...input, ...patch } as VoiceDesignInput), ProviderRequestRejectedError);
  }
  for (const id of ["voicekey_secret", "../voice_abc", "voice_abc?key=secret", "voice_abc/else", "Charon", "voice_"]) {
    await assert.rejects(client.getDesignedVoice("key", id), ProviderRequestRejectedError);
  }
});

it("retains identity and usage when creation succeeds but the audition is unusable", async () => {
  for (const sample_audio of [undefined, { mime_type: "audio/mpeg", data: "aaaa" },
    { mime_type: "audio/wav", data: wav().subarray(0, 45).toString("base64") },
    { mime_type: "audio/wav", data: `${wav().toString("base64")}!` }]) {
    const result = await new GoogleClient(async () => Response.json({ ...voice(), sample_audio })).createDesignedVoice("key", input);
    assert.equal(result.remoteId, "voice_abc123");
    assert.equal(result.voice?.remoteId, "voice_abc123");
    assert.deepEqual(result.speechUsage, { inputTextTokens: 20, outputAudioTokens: 100 });
    assert.equal(result.sample, undefined);
    assert.ok(result.problem);
  }
});

it("reads the live service's models/ resource name as the pinned model it was asked for", async () => {
  // The shape Google returned on 2026-10-01 for a voice it had created and billed.
  for (const model of GEMINI_TTS_MODELS) {
    const result = await new GoogleClient(async () => Response.json({ ...voice(), model: `models/${model}` }))
      .createDesignedVoice("key", { ...input, model });
    assert.equal(result.problem, undefined);
    assert.equal(result.voice?.model, model);
    assert.deepEqual(result.sample?.data, wav());
  }
  for (const model of ["models/invented", "tunedModels/gemini-3.8-flash-tts", "models/models/gemini-3.8-flash-tts"]) {
    const result = await new GoogleClient(async () => Response.json({ ...voice(), model })).createDesignedVoice("key", input);
    assert.ok(result.problem, model);
    assert.equal(result.voice, undefined, model);
  }
});

it("imports a voice designed in AI Studio without a language as undetermined, and still refuses a malformed one", async () => {
  // The shape Google returned on 2026-10-08 for "Nigerian Woman 2": no language_code at all.
  const { language_code: _none, ...bare } = voice();
  const imported = await new GoogleClient(async () => Response.json(bare)).getDesignedVoice("key", "voice_abc123");
  assert.equal(imported?.problem, undefined);
  assert.equal(imported?.voice?.language, "und");
  assert.equal(imported?.voice?.name, input.name);
  assert.deepEqual(imported?.sample?.data, wav());
  for (const language_code of ["", "not a tag!", 7]) {
    const refused = await new GoogleClient(async () => Response.json({ ...voice(), language_code })).getDesignedVoice("key", "voice_abc123");
    assert.ok(refused?.problem, String(language_code));
    assert.equal(refused?.voice, undefined, String(language_code));
  }
});

it("keeps witnessed evidence without making invalid metadata into a usable binding", async () => {
  for (const patch of [{ model: "unknown" }, { type: "replicated" }, { expire_time: undefined }, { key: "voicekey_secret" }]) {
    const result = await new GoogleClient(async () => Response.json({ ...voice(), ...patch })).createDesignedVoice("key", input);
    assert.equal(result.remoteId, "voice_abc123");
    assert.ok(result.speechUsage);
    assert.ok(result.problem);
    assert.equal(result.voice, undefined);
    assert.equal(result.sample, undefined);
    assert.equal(JSON.stringify(result).includes("voicekey_"), false);
  }
});

it("does not repeat uncertain creates, including malformed success bodies, network loss and 5xx", async () => {
  for (const answer of [async () => new Response("broken"), async () => Response.json({}),
    async () => { throw new Error("network lost"); }, async () => new Response("", { status: 503 })]) {
    let calls = 0;
    const client = new GoogleClient(async () => { calls++; return answer(); });
    await client.createDesignedVoice("key", input).then(
      result => { assert.ok(result.problem); },
      error => { assert.equal((error as { submissionRejected?: boolean }).submissionRejected, undefined); },
    );
    assert.equal(calls, 1);
    assert.equal(client.declarations.supportsIdempotencyKey, false);
    assert.equal(client.declarations.supportsLookupByKey, false);
  }
});

it("reports quota rejection without deleting a voice or resubmitting", async () => {
  let calls = 0;
  const client = new GoogleClient(async () => { calls++; return new Response("", { status: 429 }); });
  await assert.rejects(client.createDesignedVoice("key", input), ProviderBusyError);
  assert.equal(calls, 1);
});

it("retrieves only the exact stored id with the active key; disappearance is distinct from access refusal", async () => {
  const keys: string[] = [];
  const client = new GoogleClient(async (url, init) => {
    assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/voices/voice_abc123");
    assert.equal(init?.method, undefined);
    assert.equal(init?.redirect, "error");
    const key = new Headers(init?.headers).get("x-goog-api-key")!;
    keys.push(key);
    return key === "first" ? Response.json(voice()) : new Response("", { status: 404 });
  });
  assert.ok((await client.getDesignedVoice("first", "voice_abc123"))?.sample);
  assert.equal(await client.getDesignedVoice("second", "voice_abc123"), null);
  assert.deepEqual(keys, ["first", "second"]);
  await assert.rejects(new GoogleClient(async () => new Response("", { status: 403 })).getDesignedVoice("key", "voice_abc123"), /refused access/);
  const mismatch = await new GoogleClient(async () => Response.json({ ...voice(), id: "voice_other" })).getDesignedVoice("key", "voice_abc123");
  assert.ok(mismatch?.problem);
  assert.equal(mismatch?.voice, undefined);
});

it("lists a single filtered page, preserves its cursor and refuses partial or repeated pages", async () => {
  let calls = 0;
  const client = new GoogleClient(async (url, init) => {
    calls++;
    const parsed = new URL(String(url));
    assert.equal(parsed.searchParams.get("type"), "prompted");
    assert.equal(parsed.searchParams.get("page_size"), "50");
    assert.equal(parsed.searchParams.get("page_token"), "cursor & one");
    assert.equal(init?.redirect, "error");
    return Response.json({ voices: [{ ...voice(), sample_audio: undefined, usage: undefined }], next_page_token: "next" });
  });
  const result = await client.listDesignedVoices("key", "cursor & one");
  assert.equal(calls, 1);
  assert.equal(result.nextPageToken, "next");
  assert.equal(result.voices[0]?.remoteId, "voice_abc123");
  assert.equal(JSON.stringify(result).includes("sample"), false);
  for (const response of [{ voices: [voice(), {}] }, { voices: [voice(), voice()] }, { next_page_token: "repeat" }, { voices: "bad" }]) {
    await assert.rejects(new GoogleClient(async () => Response.json(response)).listDesignedVoices("key", "repeat"), /invalid/);
  }
  assert.deepEqual(await new GoogleClient(async () => Response.json({})).listDesignedVoices("key"), { voices: [] });
});
