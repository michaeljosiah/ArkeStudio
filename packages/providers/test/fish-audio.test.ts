import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { billableCharacters, estimateMicroUsd, FISH_DELIVERY, modelPriceCopy } from "@arke-studio/contracts";
import { FishAudioClient, FISH_CATALOGUE_PAGES, FISH_MODEL, FISH_TEXT_CAP } from "../src/clients/fishaudio.js";
import { SHIPPED_MANIFEST } from "../src/manifest-data.js";
import { createProviderClients, PROVIDER_DECLARATIONS } from "../src/registry.js";
import { ProviderAuthError, ProviderBusyError, ProviderRequestRejectedError, type FetchLike, type ProviderTransportScope, type VoiceSlotClient } from "../src/types.js";

/**
 * Fish Audio as the third hosted reader of the world's cloned voices (SPEC-046 §2.9), against a
 * fake fetch that records what was sent. The shape is Breeze's — a copy on the account, read by
 * id — with Fish's own wire: a `model` header, a `[bracket]` phrase for the delivery, audio bytes
 * back, and `{status, message}` on every refusal.
 */

const WAV = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 36, 0, 0, 0, 0x57, 0x41, 0x56, 0x45, ...Array.from({ length: 40 }, () => 0)]);

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
const line = (params: Record<string, unknown>, voiceReference?: { name: string; contentType: "audio/wav"; data: Uint8Array; remoteVoiceId?: string }) =>
  ({ model: FISH_MODEL, capability: "voice-tts" as const, params, ...(voiceReference ? { voiceReference } : {}) });

describe("Fish Audio · S2.1-Pro as a hosted reader (SPEC-046 §2.9)", () => {
  it("validates by reading the wallet's API credit, free grant included, in dollars as the wallet states them (R-2)", async () => {
    const r = recording(() => json(200, { _id: "w", user_id: "u", credit: "3.50", cumulative_top_up: 0, has_free_credit: true }));
    assert.ok((await new FishAudioClient(r.fetchImpl).validateKey("k")).every((p) => p.available));
    assert.equal(r.calls[0]?.url, "https://api.fish.audio/wallet/self/api-credit?check_free_credit=true");
    assert.equal((r.calls[0]!.init!.headers as Record<string, string>)["Authorization"], "Bearer k");
    const empty = await new FishAudioClient(async () => json(200, { credit: 0 })).validateKey("k");
    assert.equal(empty[0]?.available, false);
    assert.match(empty[0]!.reason!, /balance is \$0\.00/);
    const bad = await new FishAudioClient(async () => json(401, { status: 401, message: "Invalid Token" })).validateKey("k");
    assert.match(bad[1]!.reason!, /rejected this key/);
    const down = await new FishAudioClient(async () => { throw new Error("ECONNRESET"); }).validateKey("k");
    assert.match(down[0]!.reason!, /could not be reached/);
  });

  it("reads a library voice by id: the model header, the bearer, WAV, the phrase in front of the line, speed as prosody", async () => {
    const r = recording(() => new Response(WAV, { status: 200 }));
    const client = new FishAudioClient(r.fetchImpl);
    const result = await client.submit("k", line({ text: "Do not open it.", voiceId: "7f92f8afb8ec43bf81429cc1c9199cb1", delivery: "whispered", voiceSettings: { speed: 0.9 } }));
    assert.equal(r.calls[0]?.url, "https://api.fish.audio/v1/tts");
    const headers = r.calls[0]!.init!.headers as Record<string, string>;
    assert.equal(headers["Authorization"], "Bearer k");
    assert.equal(headers["model"], "s2.1-pro", "the row's stable id maps to the model Fish serves");
    const body = r.body();
    assert.equal(body["text"], `[${FISH_DELIVERY.whispered.tag}] Do not open it.`);
    assert.equal(body["reference_id"], "7f92f8afb8ec43bf81429cc1c9199cb1");
    assert.equal(body["format"], "wav");
    assert.deepEqual(body["prosody"], { speed: 0.9 });
    assert.equal(body["references"], undefined, "no inline reference: a cloned voice is a model on the account");
    assert.deepEqual(result.artifacts, [{ name: "speech.wav", contentType: "audio/wav", data: WAV }]);
    assert.match((await client.poll("k", result.remoteId)).error ?? "", /returned by submit/);
    // No delivery, no phrase; no speed, no prosody.
    await client.submit("k", line({ text: "Plain.", voiceId: "voc" }));
    assert.equal(r.body()["text"], "Plain.");
    assert.equal(r.body()["prosody"], undefined);
  });

  it("reads a cloned voice from the model the host ensured, and refuses a bare clip (R-13)", async () => {
    const r = recording(() => new Response(WAV, { status: 200 }));
    await new FishAudioClient(r.fetchImpl).submit("k", line({ text: "x", voiceId: "harbour-glass" }, { name: "a.wav", contentType: "audio/wav", data: WAV, remoteVoiceId: "model_7" }));
    assert.equal(r.body()["reference_id"], "model_7");
    let called = false;
    const bare = new FishAudioClient(async () => { called = true; return new Response(WAV, { status: 200 }); });
    await assert.rejects(bare.submit("k", line({ text: "x" }, { name: "a.wav", contentType: "audio/wav", data: WAV })),
      (err: unknown) => err instanceof ProviderRequestRejectedError && /voice model/.test(err.message));
    assert.equal(called, false);
  });

  it("classes every status the way its Errors page reads: 401 the key, 402 the balance, 403 a refusal, 404 a gone model, 429 witnessed busy, 5xx a failure", async () => {
    const at = (status: number, message: string) => new FishAudioClient(async () => json(status, { status, message })).submit("k", line({ text: "x", voiceId: "m" }));
    await assert.rejects(at(401, "Invalid Token"), ProviderAuthError);
    await assert.rejects(at(402, "Insufficient credits"), (err: unknown) => err instanceof ProviderRequestRejectedError && /cannot pay/.test(err.message) && /top up/.test(err.message));
    // "Not permitted for this key/resource" is the key's scope or someone else's model — never a paused lane.
    await assert.rejects(at(403, "Forbidden"), (err: unknown) => err instanceof ProviderRequestRejectedError && !(err instanceof ProviderAuthError) && /scope/.test(err.message));
    await assert.rejects(at(404, "Model not found"), (err: unknown) => err instanceof ProviderRequestRejectedError && /re-clone/.test(err.message));
    await assert.rejects(at(400, "reference_id does not exist"), (err: unknown) => err instanceof ProviderRequestRejectedError && /re-clone/.test(err.message));
    await assert.rejects(at(400, "text is required"), (err: unknown) => err instanceof ProviderRequestRejectedError && /synthesis failed/.test(err.message));
    await assert.rejects(at(429, "Rate limit exceeded"), (err: unknown) => err instanceof ProviderBusyError && err.submissionRejected === true);
    await assert.rejects(at(503, "high load"), (err: unknown) => err instanceof Error && !(err instanceof ProviderBusyError) && !(err instanceof ProviderRequestRejectedError));
    await assert.rejects(new FishAudioClient(async () => new Response(Uint8Array.from([1, 2, 3]), { status: 200 })).submit("k", line({ text: "x", voiceId: "m" })), /not a WAV file/);
    await assert.rejects(new FishAudioClient(async () => new Response(WAV, { status: 200 })).submit("k", line({ text: "x".repeat(FISH_TEXT_CAP + 1), voiceId: "m" })), /1 characters over/);
    // The delivery phrase counts: a line exactly at the cap goes over once `[whispering] ` is in front of it.
    await assert.rejects(new FishAudioClient(async () => new Response(WAV, { status: 200 })).submit("k", line({ text: "x".repeat(FISH_TEXT_CAP), voiceId: "m", delivery: "whispered" })),
      (err: unknown) => err instanceof ProviderRequestRejectedError && /over the 2000 .* once the delivery phrase is counted/.test(err.message));
  });

  it("saves a clip as a private voice model in one multipart call, transcribed by the service, and reads the id back (§2.9)", async () => {
    const r = recording(() => json(201, { _id: "model_new", type: "tts", title: "Harbour glass", state: "trained", train_mode: "fast" }));
    const saved = await new FishAudioClient(r.fetchImpl).saveVoice("k", { name: "Harbour glass", clip: WAV, contentType: "audio/wav" });
    assert.deepEqual(saved, { voiceId: "model_new" });
    assert.equal(r.calls[0]?.url, "https://api.fish.audio/model");
    const form = r.calls[0]!.init!.body;
    assert.ok(form instanceof FormData);
    assert.equal(form.get("type"), "tts");
    assert.equal(form.get("title"), "Harbour glass");
    assert.equal(form.get("train_mode"), "fast");
    assert.equal(form.get("visibility"), "private");
    assert.equal(form.get("texts"), null, "no transcript: the library holds none, and Fish transcribes for itself");
    const file = form.get("voices");
    assert.ok(file instanceof Blob && file.size === WAV.length && file.type === "audio/wav");
    // A model that failed to train is removed before the refusal, so no later lookup adopts it.
    const failed = recording((url, init) => init?.method === "DELETE" ? new Response(null, { status: 200 }) : json(201, { _id: "m_failed", state: "failed" }));
    await assert.rejects(new FishAudioClient(failed.fetchImpl).saveVoice("k", { name: "x", clip: WAV, contentType: "audio/wav" }), ProviderRequestRejectedError);
    assert.deepEqual(failed.calls.map((c) => `${c.init?.method ?? "GET"} ${c.url.replace("https://api.fish.audio", "")}`), ["POST /model", "DELETE /model/m_failed"]);
    await assert.rejects(new FishAudioClient(async () => json(201, {})).saveVoice("k", { name: "x", clip: WAV, contentType: "audio/wav" }), /no id/);
    await assert.rejects(new FishAudioClient(async () => json(402, { status: 402, message: "Insufficient credits" })).saveVoice("k", { name: "x", clip: WAV, contentType: "audio/wav" }), /cannot pay/);
  });

  it("removes a voice model, and treats one already gone as removed (R-15)", async () => {
    const r = recording(() => new Response(null, { status: 200 }));
    await new FishAudioClient(r.fetchImpl).deleteVoice("k", "model_old");
    assert.equal(r.calls[0]?.url, "https://api.fish.audio/model/model_old");
    assert.equal(r.calls[0]?.init?.method, "DELETE");
    await new FishAudioClient(async () => json(404, { status: 404, message: "Not found" })).deleteVoice("k", "model_gone");
    await assert.rejects(new FishAudioClient(async () => json(500, { status: 500, message: "x" })).deleteVoice("k", "m"));
    await assert.rejects(new FishAudioClient(async () => new Response(null, { status: 200 })).deleteVoice("k", "../model"), ProviderRequestRejectedError);
  });

  it("finds the account's own model by its exact hash-named title, and reads whether a model is still held (R-13)", async () => {
    const r = recording(() => json(200, { items: [
      { _id: "m_near", title: "Harbour glass · 0123456789ab (old)", type: "tts", state: "trained" },
      { _id: "m_dead", title: "Harbour glass · 0123456789ab", type: "tts", state: "failed" },
      { _id: "m_exact", title: "Harbour glass · 0123456789ab", type: "tts", state: "trained" },
    ], has_more: false }));
    assert.equal(await new FishAudioClient(r.fetchImpl).findVoice("k", "Harbour glass · 0123456789ab"), "m_exact", "a failed model under the title is not the slot");
    assert.equal(r.calls[0]?.url, "https://api.fish.audio/model?self=true&title=Harbour%20glass%20%C2%B7%200123456789ab&page_size=100");
    assert.equal(await new FishAudioClient(async () => json(200, { items: [] })).findVoice("k", "x"), null);
    await assert.rejects(new FishAudioClient(async () => json(429, { status: 429, message: "Rate limit exceeded" })).findVoice("k", "x"), ProviderBusyError, "a failed listing is not none");
    await assert.rejects(new FishAudioClient(async () => json(200, { total: 0 })).findVoice("k", "x"), /not a list/, "nor is a 2xx that is not a list");
    const held = recording((url) => url.endsWith("/model/m_1") ? json(200, { _id: "m_1", state: "trained" }) : url.endsWith("/model/m_dead") ? json(200, { _id: "m_dead", state: "failed" }) : json(404, { status: 404, message: "Model not found" }));
    assert.equal(await new FishAudioClient(held.fetchImpl).hasVoice("k", "m_1"), true);
    assert.equal(await new FishAudioClient(held.fetchImpl).hasVoice("k", "m_dead"), false, "held but failed is not a model to read from");
    assert.equal(await new FishAudioClient(held.fetchImpl).hasVoice("k", "m_gone"), false);
    assert.equal(await new FishAudioClient(async () => json(403, { status: 403, message: "Forbidden" })).hasVoice("k", "m_theirs"), false, "another account's model is not held");
    await assert.rejects(new FishAudioClient(async () => json(500, { status: 500, message: "x" })).hasVoice("k", "m_1"));
  });

  it("lists the licensed public library, most used first, page after page to a bound, with languages and tags as attributes (R-32)", async () => {
    const page = (n: number, hasMore: boolean) => json(200, { items: [
      { _id: `m${n}`, type: "tts", title: `Narrator ${n}`, languages: ["en"], tags: ["Narration", "Calm"], licensed: true, task_count: 1000 - n },
      { _id: `svc${n}`, type: "svc", title: "not a voice", languages: [], tags: [] },
    ], total: 900, has_more: hasMore });
    const r = recording((url) => page(Number(/page_number=(\d+)/.exec(url)?.[1]), url.includes("page_number=1")));
    const voices = await new FishAudioClient(r.fetchImpl).listVoicesCatalog("k");
    assert.deepEqual(r.calls.map((call) => call.url), [
      "https://api.fish.audio/model?licensed=true&sort_by=task_count&page_size=100&page_number=1",
      "https://api.fish.audio/model?licensed=true&sort_by=task_count&page_size=100&page_number=2",
    ]);
    assert.deepEqual(voices, [1, 2].map((n) => ({ provider: "fishaudio", model: FISH_MODEL, voiceId: `m${n}`, label: `Narrator ${n}`, attributes: ["en", "narration", "calm"], local: false, canClone: false })));
    const endless = recording((url) => page(Number(/page_number=(\d+)/.exec(url)?.[1]), true));
    assert.equal((await new FishAudioClient(endless.fetchImpl).listVoicesCatalog("k")).length, FISH_CATALOGUE_PAGES);
    const refused = await new FishAudioClient(async () => json(401, { status: 401, message: "Invalid Token" })).listVoicesCatalog("k");
    assert.deepEqual(refused, [], "a refused listing is an empty catalogue, not a crash");
  });

  it("is registered with every declaration false, and the wrapper carries its slot calls as named operations", async () => {
    assert.deepEqual(PROVIDER_DECLARATIONS["fishaudio"], { supportsIdempotencyKey: false, supportsLookupByKey: false, supportsListRecent: false, reportsCost: false });
    const scopes: ProviderTransportScope[] = [];
    const answer: FetchLike = async (url, init) =>
      init?.method === "DELETE" ? new Response(null, { status: 200 })
        : url.endsWith("/model") ? json(201, { _id: "m_wrapped", state: "trained" })
        : url.endsWith("/model/m_wrapped") ? json(200, { _id: "m_wrapped", state: "trained" })
        : new Response(WAV, { status: 200 });
    const clients = createProviderClients({ fetch: answer, transport: { run: (scope, operation) => { scopes.push(scope); return operation(answer); } } });
    const fish = clients.fishaudio as VoiceSlotClient;
    assert.deepEqual(await fish.saveVoice("k", { name: "x", clip: WAV, contentType: "audio/wav" }), { voiceId: "m_wrapped" });
    assert.equal(await fish.hasVoice("k", "m_wrapped"), true);
    await fish.deleteVoice("k", "m_wrapped");
    assert.deepEqual(scopes.map((scope) => scope.operation), ["save-voice", "lookup-voice", "delete-voice"]);
  });

  it("the row is honest: the vendor's model behind a stable id, fifteen micro-dollars a character, our own cap, every delivery as a phrase", () => {
    const row = SHIPPED_MANIFEST.models.find((m) => m.id === FISH_MODEL)!;
    assert.equal(row.provider, "fishaudio");
    assert.equal(row.providerModelId, "s2.1-pro");
    assert.deepEqual(row.pricing, { kind: "perCharacter", microUsdPerCharacter: 15, unit: "utf8-byte" });
    assert.equal(modelPriceCopy(row), "$15.00 / M bytes", "the catalogue quotes the unit the estimate counts");
    assert.equal(row.limits.maxPromptChars, FISH_TEXT_CAP);
    // Bytes, as the bill is: a CJK line costs three times its length, an accented word one more.
    assert.equal(billableCharacters(row, "Bell Watch."), 11);
    assert.equal(billableCharacters(row, "鐘の見張り"), 15);
    assert.equal(estimateMicroUsd(row, { characters: billableCharacters(row, "naïve") }), 90);
    // The delivery's phrase is text Fish bills: a directed line is priced with it (codex on PR 1156).
    assert.equal(billableCharacters(row, "Wait here.", "breaking"), `[${FISH_DELIVERY.breaking.tag}] Wait here.`.length);
    assert.equal(row.limits.audioFormat, "wav");
    assert.equal(row.limits.maxPromptChars, 2000);
    assert.deepEqual(row.limits.deliveries, ["measured", "whispered", "breaking", "cold", "warm", "urgent"]);
    assert.equal(row.cadence?.tagSyntax, undefined, "Fish's cues are bracketed, the default ink");
    assert.deepEqual(row.cadence?.deliveryMappings, FISH_DELIVERY);
    assert.equal(row.cadence?.emphasis, "unsupported");
    assert.deepEqual(row.cadence?.speed, { min: 0.7, max: 1.3 });
  });
});
