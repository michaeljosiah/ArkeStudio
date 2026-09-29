import assert from "node:assert/strict";
import { it } from "node:test";
import { filterVoices, VoiceCandidateSchema } from "@arke-studio/contracts";
import { GoogleClient, GEMINI_TTS_MODELS } from "../src/clients/google.js";

it("loads every Gemini library page and filters provider metadata across both enabled models", async () => {
  const rows = Array.from({ length: 358 }, (_, i) => ({ id: `Speaker${i}`, type: "prebuilt", display_name: `Reader ${i}`,
    description: "Clear storytelling", language_code: i % 2 ? "fr-FR" : "en-GB", accent: i % 2 ? "Parisian" : "British",
    gender: i % 3 ? "female" : "male", persona: "Warm, Friendly", context: "Audiobook", pitch: "medium" }));
  const urls: URL[] = [];
  const client = new GoogleClient(async (url, init) => {
    assert.equal(init?.method ?? "GET", "GET"); assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("x-goog-api-key"), "test-key");
    const parsed = new URL(url); urls.push(parsed);
    if (parsed.pathname.endsWith("/models")) return Response.json({ models: GEMINI_TTS_MODELS.map(name => ({ name })) });
    assert.equal(parsed.searchParams.get("type"), "prebuilt");
    const offset = Number(parsed.searchParams.get("page_token") ?? 0);
    return Response.json({ voices: rows.slice(offset, offset + 100), ...(offset + 100 < rows.length ? { next_page_token: String(offset + 100) } : {}) });
  });
  const catalogue = await client.listVoicesCatalog("test-key");
  assert.equal(catalogue.length, 716); assert.equal(urls.length, 5);
  assert.ok(catalogue.every(v => VoiceCandidateSchema.safeParse(v).success));
  const found = filterVoices(catalogue, "Gemini storytelling", { provider: "google", language: "english", accent: "british", gender: "female", style: "warm, friendly" });
  assert.equal(found.length, 238);
  assert.ok(found.every(v => v.facets?.language === "en-GB" && v.facets.gender === "female"));
  assert.equal(filterVoices(catalogue, "Reader 357", {}).length, 2);
});

it("keeps absent Gemini metadata unspecified and deduplicates page boundaries", async () => {
  let page = 0;
  const client = new GoogleClient(async url => url.includes("/models") ? Response.json({ models: [{ name: GEMINI_TTS_MODELS[0] }] })
    : Response.json({ voices: [{ id: "Kore", type: "prebuilt" }], ...(page++ === 0 ? { next_page_token: "next" } : {}) }));
  const rows = await client.listVoicesCatalog("key");
  assert.equal(rows.length, 1); assert.deepEqual(rows[0]?.facets, { style: "firm" });
  assert.equal(filterVoices(rows, "", { gender: "female" }).length, 0);
  assert.equal(filterVoices(rows, "", { gender: "__unspecified__" }).length, 1);
});

it("surfaces incomplete or invalid Gemini catalogues instead of reporting partial success", async () => {
  for (const body of [{ voices: "wrong" }, { voices: [{ id: "voice_private", type: "prompted" }] },
    { voices: [{ id: "Kore", type: "prebuilt" }], next_page_token: "repeat" }]) {
    const client = new GoogleClient(async url => Response.json(url.includes("/models") ? { models: [{ name: GEMINI_TTS_MODELS[0] }] } : body));
    await assert.rejects(client.listVoicesCatalog("key"), /Google/);
  }
  let calls = 0;
  const client = new GoogleClient(async url => {
    if (url.includes("/models")) return Response.json({ models: [{ name: GEMINI_TTS_MODELS[0] }] });
    if (calls++) return new Response("unavailable", { status: 503 });
    return Response.json({ voices: [{ id: "Kore", type: "prebuilt" }], next_page_token: "second" });
  });
  await assert.rejects(client.listVoicesCatalog("key"));
});
