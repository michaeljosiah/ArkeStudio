import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BREEZE_DELIVERY } from "@arke-studio/contracts";
import { BreezeBlueClient, BREEZE_MODEL } from "../src/clients/breezeblue.js";
import { MistralClient, VOXTRAL_MODEL, VOXTRAL_PRESETS } from "../src/clients/mistral.js";
import { SHIPPED_MANIFEST } from "../src/manifest-data.js";
import { createProviderClients, PROVIDER_DECLARATIONS } from "../src/registry.js";
import { ProviderAuthError, ProviderBusyError, ProviderRequestRejectedError, type FetchLike, type ProviderTransportScope, type VoiceSlotClient } from "../src/types.js";

/**
 * The two hosted readers of the world's cloned voices (SPEC-046 issues 1144/1145), against a
 * fake fetch that records what was sent. Every row of the spec's §2.2 refusal line is here,
 * because the two classes that matter most are the ones a status code alone gets wrong: Mistral's
 * 403 is a rejection, never a bad key; Breeze's 429 is a full pool, never a failure.
 */

/** RIFF header plus silence: enough for the WAV check, nothing that needs decoding. */
const WAV = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 36, 0, 0, 0, 0x57, 0x41, 0x56, 0x45, ...Array.from({ length: 40 }, () => 0)]);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

/** A fetch that answers one way and remembers the request it saw. */
function recording(respond: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  return { fetchImpl, calls, body: () => JSON.parse(String(calls.at(-1)?.init?.body ?? "null")) as Record<string, unknown> };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("Mistral · Voxtral TTS as a hosted reader (SPEC-046 §2.3)", () => {
  it("validates by listing models and reports both capabilities from that one answer (R-2)", async () => {
    const ok = new MistralClient(async () => json(200, { data: [{ id: "voxtral-mini-tts-2603" }] }));
    assert.deepEqual(await ok.validateKey("k"), [
      { capability: "voice-tts", available: true },
      { capability: "voice-clone", available: true },
    ]);
    const bad = new MistralClient(async () => json(401, { message: "Unauthorized" }));
    const probes = await bad.validateKey("k");
    assert.equal(probes[0]?.available, false);
    assert.match(probes[0]!.reason!, /rejected this key/);
    const down = new MistralClient(async () => { throw new Error("ECONNREFUSED"); });
    assert.match((await down.validateKey("k"))[1]!.reason!, /could not be reached/);
  });

  it("reads a preset by id: the pinned version, WAV, and JSON carrying base64 decoded to bytes (§2.2)", async () => {
    const r = recording(() => json(200, { audio_data: b64(WAV) }));
    const client = new MistralClient(r.fetchImpl);
    const result = await client.submit("k", { model: VOXTRAL_MODEL, capability: "voice-tts", params: { text: "Bell Watch is not a town.", voiceId: "gb_jane_sad" } });
    assert.equal(r.calls[0]?.url, "https://api.mistral.ai/v1/audio/speech");
    assert.equal((r.calls[0]!.init!.headers as Record<string, string>)["Authorization"], "Bearer k");
    const body = r.body();
    assert.equal(body["model"], "voxtral-mini-tts-2603");
    assert.equal(body["voice_id"], "gb_jane_sad");
    assert.equal(body["response_format"], "wav");
    assert.equal(body["ref_audio"], undefined);
    assert.deepEqual(result.artifacts, [{ name: "speech.wav", contentType: "audio/wav", data: WAV }]);
    assert.match((await client.poll("k", result.remoteId)).error ?? "", /returned by submit/);
  });

  it("reads a cloned voice by sending its clip with the call, and never a voice id beside it (D2)", async () => {
    const r = recording(() => json(200, { audio_data: b64(WAV) }));
    const clip = Uint8Array.from([1, 2, 3, 4]);
    await new MistralClient(r.fetchImpl).submit("k", {
      model: VOXTRAL_MODEL, capability: "voice-tts", params: { text: "Her mother's hour.", voiceId: "cv_01" },
      voiceReference: { name: "a.wav", contentType: "audio/wav", data: clip },
    });
    const body = r.body();
    assert.equal(body["ref_audio"], b64(clip));
    assert.equal(body["voice_id"], undefined);
    assert.equal(body["input"], "Her mother's hour.");
  });

  it("classes a 403 as a rejection naming the line — moderation or plan — never as a bad key (R-24)", async () => {
    const client = new MistralClient(async () => json(403, { message: "Forbidden" }));
    await assert.rejects(
      client.submit("k", { model: VOXTRAL_MODEL, capability: "voice-tts", params: { text: "The forty-first name is not on the register tonight.", voiceId: "en_paul_neutral" } }),
      (err: unknown) => err instanceof ProviderRequestRejectedError && !(err instanceof ProviderAuthError)
        && /moderation, or a plan/.test(err.message) && /The forty-first name is not on …/.test(err.message),
    );
  });

  it("keeps 401 a credential fault, 422 a rejection with the body's detail, 429 a transient (R-25, R-28)", async () => {
    const line = { model: VOXTRAL_MODEL, capability: "voice-tts" as const, params: { text: "x", voiceId: "en_paul_neutral" } };
    await assert.rejects(new MistralClient(async () => json(401, {})).submit("k", line), ProviderAuthError);
    await assert.rejects(new MistralClient(async () => json(422, { detail: [{ msg: "input too long" }] })).submit("k", line),
      (err: unknown) => err instanceof ProviderRequestRejectedError && /input too long/.test(err.message));
    await assert.rejects(new MistralClient(async () => json(429, {})).submit("k", line), ProviderBusyError);
    await assert.rejects(new MistralClient(async () => json(200, { audio_data: b64(Uint8Array.from([1, 2, 3])) })).submit("k", line), /not a WAV file/);
    await assert.rejects(new MistralClient(async () => json(200, {})).submit("k", line), /no audio_data/);
  });

  it("refuses a read with neither a preset nor a clip before touching the wire", async () => {
    let called = false;
    const client = new MistralClient(async () => { called = true; return json(200, {}); });
    await assert.rejects(client.submit("k", { model: VOXTRAL_MODEL, capability: "voice-tts", params: { text: "x" } }), ProviderRequestRejectedError);
    assert.equal(called, false);
  });

  it("offers the thirty hosted presets as ranked candidates with no network (R-32)", async () => {
    const voices = await new MistralClient(async () => { throw new Error("no network"); }).listVoicesCatalog();
    assert.equal(voices.length, 30);
    assert.equal(VOXTRAL_PRESETS.length, 30);
    const jane = voices.find((v) => v.voiceId === "gb_jane_jealousy")!;
    assert.deepEqual(jane.attributes, ["female", "british", "jealousy", "english"]);
    assert.equal(jane.label, "Jane · jealousy");
    assert.ok(voices.every((v) => v.provider === "mistral" && v.model === VOXTRAL_MODEL && !v.local && !v.canClone));
  });
});

describe("BreezeBlue · Breeze TTS 2 as a hosted reader (SPEC-046 §2.4)", () => {
  it("validates by reading the balance: authenticates-and-can-pay, in credits (R-2)", async () => {
    const r = recording(() => json(200, { balance: 1400, balance_millicredits: 1400000, scale: 1000, topups: [], charges: [] }));
    assert.ok((await new BreezeBlueClient(r.fetchImpl).validateKey("k")).every((p) => p.available));
    assert.equal(r.calls[0]?.url, "https://api.breeze.blue/v1/balance");
    const empty = new BreezeBlueClient(async () => json(200, { balance: 0 }));
    const probes = await empty.validateKey("k");
    assert.equal(probes[0]?.available, false);
    assert.match(probes[0]!.reason!, /authenticates but the balance is 0 credits/);
    const bad = new BreezeBlueClient(async () => json(401, { ok: false, code: "AUTH_REQUIRED", detail: "Authentication required." }));
    assert.match((await bad.validateKey("k"))[0]!.reason!, /rejected this key/);
  });

  it("sends the key in the header, never the query string, and asks for WAV", async () => {
    const r = recording(() => new Response(WAV, { status: 200 }));
    await new BreezeBlueClient(r.fetchImpl).submit("k", { model: BREEZE_MODEL, capability: "voice-tts", params: { text: "Bell Watch.", voiceId: "voc_8rsb3nhb7645" } });
    assert.equal(r.calls[0]?.url, "https://api.breeze.blue/v1/text-to-speech/voc_8rsb3nhb7645?output_format=wav");
    assert.equal((r.calls[0]!.init!.headers as Record<string, string>)["xi-api-key"], "k");
    assert.ok(!r.calls[0]!.url.includes("k="));
  });

  it("places a delivery as its words: a tag in the text where Breeze has one, a sentence beside it where it does not (R-22)", async () => {
    const r = recording(() => new Response(WAV, { status: 200 }));
    const client = new BreezeBlueClient(r.fetchImpl);
    await client.submit("k", { model: BREEZE_MODEL, capability: "voice-tts",
      params: { text: "Do not open it.", voiceId: "voc_1", delivery: "whispered", voiceSettings: { guidance_scale: 4 } } });
    let body = r.body();
    assert.equal(body["text"], "(whispers) Do not open it.");
    assert.equal(body["instructions"], undefined);
    assert.deepEqual(body["voice_settings"], { guidance_scale: 4 });
    await client.submit("k", { model: BREEZE_MODEL, capability: "voice-tts",
      params: { text: "Do not open it.", voiceId: "voc_1", delivery: "cold", voiceSettings: BREEZE_DELIVERY.cold.settings } });
    body = r.body();
    assert.equal(body["text"], "Do not open it.");
    assert.equal(body["instructions"], BREEZE_DELIVERY.cold.instruction);
  });

  it("keeps an English tag out of a non-English line and sends the language code instead (R-23)", async () => {
    const r = recording(() => new Response(WAV, { status: 200 }));
    await new BreezeBlueClient(r.fetchImpl).submit("k", { model: BREEZE_MODEL, capability: "voice-tts",
      params: { text: "N'ouvre pas.", voiceId: "voc_1", delivery: "whispered", language: "fr" } });
    const body = r.body();
    assert.equal(body["text"], "N'ouvre pas.");
    assert.equal(body["language_code"], "fr");
  });

  it("passes the audio bytes through and takes the history id as the remote id", async () => {
    const client = new BreezeBlueClient(async () => new Response(WAV, { status: 200, headers: { "history-item-id": "hist_9" } }));
    const result = await client.submit("k", { model: BREEZE_MODEL, capability: "voice-tts", params: { text: "x", voiceId: "voc_1" } });
    assert.equal(result.remoteId, "hist_9");
    assert.deepEqual(result.artifacts, [{ name: "speech.wav", contentType: "audio/wav", data: WAV }]);
  });

  it("classes every envelope code the way the spec says (R-26, R-27)", async () => {
    const line = { model: BREEZE_MODEL, capability: "voice-tts" as const, params: { text: "x", voiceId: "voc_1" } };
    const at = (status: number, code: string, detail: string, headers: Record<string, string> = {}) =>
      new BreezeBlueClient(async () => json(status, { ok: false, code, detail, error: detail }, headers)).submit("k", line);
    await assert.rejects(at(429, "GENERATION_CONCURRENCY_EXCEEDED", "Your plan's concurrent generation limit was reached.", { "retry-after": "3" }),
      (err: unknown) => err instanceof ProviderBusyError && /retry after 3s/.test(err.message));
    await assert.rejects(at(503, "GENERATION_CAPACITY_EXCEEDED", "Generation capacity is currently exhausted."), ProviderBusyError);
    await assert.rejects(at(402, "BILLING_INSUFFICIENT_CREDITS", "Insufficient credits."),
      (err: unknown) => err instanceof ProviderRequestRejectedError && /cannot pay/.test(err.message) && /top up/.test(err.message));
    await assert.rejects(at(401, "AUTH_REQUIRED", "Authentication required."), ProviderAuthError);
    await assert.rejects(at(422, "VALIDATION_ERROR", "text: too long"),
      (err: unknown) => err instanceof ProviderRequestRejectedError && /text: too long/.test(err.message));
    await assert.rejects(at(500, "UPSTREAM_GENERATION_SERVICE_ERROR", "Generation service request failed."),
      (err: unknown) => err instanceof Error && !(err instanceof ProviderBusyError) && !(err instanceof ProviderRequestRejectedError));
  });

  it("refuses a bare clip: a cloned voice reads from a slot the library saved, not from bytes in the call (R-13)", async () => {
    let called = false;
    const client = new BreezeBlueClient(async () => { called = true; return new Response(WAV, { status: 200 }); });
    await assert.rejects(
      client.submit("k", { model: BREEZE_MODEL, capability: "voice-tts", params: { text: "x" }, voiceReference: { name: "a.wav", contentType: "audio/wav", data: WAV } }),
      (err: unknown) => err instanceof ProviderRequestRejectedError && /voice slot/.test(err.message),
    );
    assert.equal(called, false);
  });

  it("reads a cloned voice from the slot the host ensured, never from the clip in the call (R-13)", async () => {
    const r = recording(() => new Response(WAV, { status: 200 }));
    await new BreezeBlueClient(r.fetchImpl).submit("k", {
      model: BREEZE_MODEL, capability: "voice-tts", params: { text: "Bell Watch.", voiceId: "harbour-glass" },
      voiceReference: { name: "a.wav", contentType: "audio/wav", data: WAV, remoteVoiceId: "voc_slot_7" },
    });
    // The library id rides in params for every other reader; here the slot id is the address.
    assert.equal(r.calls[0]?.url, "https://api.breeze.blue/v1/text-to-speech/voc_slot_7?output_format=wav");
    assert.equal(r.calls.length, 1);
  });

  it("saves a clip as a voice in two steps — preview from the file, then save — and returns the slot (§2.4)", async () => {
    const r = recording((url) =>
      url.endsWith("/v1/voice-previews/clone")
        ? json(200, { generated_voice_id: "gen_1", transcript: "…" })
        : json(200, { voice_id: "voc_new", name: "Harbour glass" }),
    );
    const saved = await new BreezeBlueClient(r.fetchImpl).saveVoice("k", { name: "Harbour glass", clip: WAV, contentType: "audio/wav", language: "en" });
    assert.deepEqual(saved, { voiceId: "voc_new" });
    assert.equal(r.calls[0]?.url, "https://api.breeze.blue/v1/voice-previews/clone");
    const form = r.calls[0]!.init!.body;
    assert.ok(form instanceof FormData, "the preview is multipart: the file goes as bytes, not base64 in JSON");
    assert.equal(form.get("name"), "Harbour glass");
    assert.equal(form.get("language_code"), "en");
    const file = form.get("files");
    assert.ok(file instanceof Blob && file.size === WAV.length && file.type === "audio/wav");
    assert.equal((r.calls[0]!.init!.headers as Record<string, string>)["xi-api-key"], "k");
    assert.equal(r.calls[1]?.url, "https://api.breeze.blue/v1/voice-previews/gen_1/save");
    assert.deepEqual(r.body(), { voice_name: "Harbour glass", language_code: "en" });
  });

  it("a refused save is classed by Breeze's code, not its status (R-26)", async () => {
    const save = (client: BreezeBlueClient) => client.saveVoice("k", { name: "x", clip: WAV, contentType: "audio/wav" });
    // What the live service answered on 2026-09-13, for every clip: its own transcription failing.
    await assert.rejects(save(new BreezeBlueClient(async () => json(429, { ok: false, code: "UPSTREAM_GENERATION_ERROR", detail: "Request to /internal/llm/voice-clone/transcribe failed." }))), ProviderBusyError);
    await assert.rejects(save(new BreezeBlueClient(async () => json(502, { ok: false, code: "VOICE_CLONE_FAILED", detail: "Voice clone failed." }))), ProviderBusyError);
    // A bare FORBIDDEN is a refusal of this request; only an AUTH_ code is the key's fault (R-24).
    await assert.rejects(save(new BreezeBlueClient(async () => json(403, { ok: false, code: "FORBIDDEN", detail: "Forbidden." }))),
      (err: unknown) => err instanceof ProviderRequestRejectedError && !(err instanceof ProviderAuthError) && /Forbidden/.test(err.message));
    await assert.rejects(save(new BreezeBlueClient(async () => json(403, { ok: false, code: "AUTH_ADMIN_ACCESS_DENIED", detail: "Admin console access denied." }))), ProviderAuthError);
    await assert.rejects(save(new BreezeBlueClient(async () => json(200, {}))), /no generated_voice_id/);
  });

  it("removes a saved voice, and treats one already gone as removed (R-15)", async () => {
    const r = recording(() => new Response(null, { status: 204 }));
    await new BreezeBlueClient(r.fetchImpl).deleteVoice("k", "voc_old");
    assert.equal(r.calls[0]?.url, "https://api.breeze.blue/v1/voices/voc_old");
    assert.equal(r.calls[0]?.init?.method, "DELETE");
    await new BreezeBlueClient(async () => json(404, { ok: false, code: "NOT_FOUND", detail: "Voice not found." })).deleteVoice("k", "voc_gone");
    await assert.rejects(new BreezeBlueClient(async () => json(500, { ok: false, code: "INTERNAL", detail: "x" })).deleteVoice("k", "voc_1"));
    await assert.rejects(new BreezeBlueClient(async () => new Response(null, { status: 204 })).deleteVoice("k", "../voices"), ProviderRequestRejectedError);
  });

  it("lists the public catalogue with its metadata as attributes and leaves saved voices out (R-32)", async () => {
    const r = recording(() => json(200, { voices: [
      { voice_id: "voc_a", name: "Ada", origin: "designed", voice_type: "default", visibility: "public", language_code: "en", accent: "british",
        gender: "female", age: "middle_aged", tone: ["calm", "warm"], primary_category_code: "narration", tags: ["Narration"] },
      { voice_id: "voc_b", name: "Mine", origin: "cloned", voice_type: "custom", visibility: "private", language_code: "en" },
    ], has_more: true, total: 6898, page: 1, page_size: 100 }));
    const voices = await new BreezeBlueClient(r.fetchImpl).listVoicesCatalog("k");
    assert.equal(r.calls[0]?.url, "https://api.breeze.blue/v1/voices?page_size=100");
    assert.deepEqual(voices, [{ provider: "breezeblue", model: BREEZE_MODEL, voiceId: "voc_a", label: "Ada",
      attributes: ["en", "british", "female", "middle_aged", "narration", "calm", "warm", "narration"], local: false, canClone: false }]);
  });
});

describe("the rows and the registry (SPEC-046 R-6..R-8, R-28)", () => {
  it("both clients are registered with every declaration false", () => {
    for (const id of ["mistral", "breezeblue"] as const) {
      assert.deepEqual(PROVIDER_DECLARATIONS[id], { supportsIdempotencyKey: false, supportsLookupByKey: false, supportsListRecent: false, reportsCost: false });
    }
  });

  it("the registry's Breeze client still saves and removes voices through the capture wrapper (R-13, R-15)", async () => {
    // The wrapper rebuilds the client from the ProviderClient interface, so a method only the
    // concrete class has is silently absent from what the host holds — a cast hid exactly that.
    const scopes: ProviderTransportScope[] = [];
    const answer: FetchLike = async (url) =>
      url.endsWith("/clone") ? json(200, { generated_voice_id: "gen_1" })
        : url.endsWith("/save") ? json(200, { voice_id: "voc_wrapped" })
        : new Response(null, { status: 204 });
    const clients = createProviderClients({
      fetch: answer,
      transport: { run: (scope, operation) => { scopes.push(scope); return operation(answer); } },
    });
    const breeze = clients.breezeblue as VoiceSlotClient;
    assert.equal(typeof breeze.saveVoice, "function");
    assert.deepEqual(await breeze.saveVoice("k", { name: "Harbour", clip: WAV, contentType: "audio/wav" }), { voiceId: "voc_wrapped" });
    await breeze.deleteVoice("k", "voc_wrapped");
    assert.deepEqual(scopes.map((scope) => scope.operation), ["save-voice", "delete-voice"], "and each is a named operation on the host's transport");
    assert.equal(typeof (clients.mistral as Partial<VoiceSlotClient>).saveVoice, "undefined", "Mistral keeps no slots and gets no method");
  });

  it("the Voxtral row is honest: one delivery, WAV, our own cap, sixteen micro-dollars a character", () => {
    const row = SHIPPED_MANIFEST.models.find((m) => m.id === VOXTRAL_MODEL)!;
    assert.equal(row.providerModelId, "voxtral-mini-tts-2603");
    assert.deepEqual(row.limits.deliveries, ["measured"]);
    assert.equal(row.limits.audioFormat, "wav");
    assert.equal(row.limits.maxPromptChars, 2000);
    assert.deepEqual(row.pricing, { kind: "perCharacter", microUsdPerCharacter: 16 });
    assert.equal(row.cadence?.speed, null);
    assert.equal(row.cadence?.pause, "unsupported");
  });

  it("the Breeze row carries the free-plan rate, the vendor's 1,000-character cap, and the one delivery table", () => {
    const row = SHIPPED_MANIFEST.models.find((m) => m.id === BREEZE_MODEL)!;
    assert.equal(row.providerModelId, undefined);
    assert.deepEqual(row.pricing, { kind: "perCharacter", microUsdPerCharacter: 40 });
    assert.equal(row.limits.maxPromptChars, 1000);
    assert.equal(row.cadence?.tagSyntax, "paren");
    assert.deepEqual(row.cadence?.deliveryMappings, BREEZE_DELIVERY);
    assert.equal(row.cadence?.emphasis, "unsupported");
  });
});
