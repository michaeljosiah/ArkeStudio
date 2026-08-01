import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ElevenLabsClient } from "../src/clients/elevenlabs.js";
import { FalClient } from "../src/clients/fal.js";
import { OllamaClient } from "../src/clients/ollama.js";
import { OpenAiClient } from "../src/clients/openai.js";
import type { FetchLike } from "../src/types.js";

/** A fetch fake: route → {status, body}. Anything unrouted throws (network unreachable). */
function fakeFetch(routes: Array<{ match: RegExp; status: number; body?: unknown }>): FetchLike {
  return async (url) => {
    const hit = routes.find((r) => r.match.test(url));
    if (!hit) throw new Error(`ECONNREFUSED ${url}`);
    return new Response(hit.body !== undefined ? JSON.stringify(hit.body) : "", { status: hit.status });
  };
}

describe("key validation probes what the key unlocks (R-3, D5, §3.2)", () => {
  it("fal: one key probe answers both gateway capabilities (R-1)", async () => {
    const ok = new FalClient(fakeFetch([{ match: /queue\.fal\.run/, status: 404, body: { detail: "not found" } }]));
    assert.deepEqual(await ok.validateKey("good"), [
      { capability: "image", available: true },
      { capability: "video", available: true },
    ]);

    const bad = new FalClient(fakeFetch([{ match: /queue\.fal\.run/, status: 401 }]));
    const probes = await bad.validateKey("bad");
    assert.equal(probes.length, 2);
    assert.ok(probes.every((p) => !p.available && /rejected/.test(p.reason ?? "")));
  });

  it("openai: authenticates but lacks image access → image unavailable, llm available", async () => {
    const client = new OpenAiClient(
      fakeFetch([{ match: /\/v1\/models/, status: 200, body: { data: [{ id: "gpt-5.2" }, { id: "o4-mini" }] } }]),
    );
    const probes = await client.validateKey("sk-x");
    assert.deepEqual(probes[0], { capability: "llm", available: true });
    assert.equal(probes[1]?.capability, "image");
    assert.equal(probes[1]?.available, false);
    assert.match(probes[1]!.reason!, /no image model/);
  });

  it("openai: out of credit is distinguished from an invalid key", async () => {
    const broke = new OpenAiClient(fakeFetch([{ match: /\/v1\/models/, status: 429, body: {} }]));
    const brokeProbes = await broke.validateKey("sk-poor");
    assert.match(brokeProbes[0]!.reason!, /out of credit/);

    const invalid = new OpenAiClient(fakeFetch([{ match: /\/v1\/models/, status: 401 }]));
    const invalidProbes = await invalid.validateKey("sk-bad");
    assert.match(invalidProbes[0]!.reason!, /rejected/);
  });

  it("elevenlabs: quota exhaustion and plan limits are named per capability", async () => {
    const overQuota = new ElevenLabsClient(
      fakeFetch([
        {
          match: /\/v1\/user\/subscription/,
          status: 200,
          body: { character_count: 10000, character_limit: 10000, can_use_instant_voice_cloning: false },
        },
      ]),
    );
    const probes = await overQuota.validateKey("xi-x");
    assert.equal(probes[0]?.available, false);
    assert.match(probes[0]!.reason!, /quota is exhausted \(10,000\/10,000 used\)/);
    assert.equal(probes[1]?.available, false);
    assert.match(probes[1]!.reason!, /plan does not include voice cloning/);

    const fine = new ElevenLabsClient(
      fakeFetch([
        {
          match: /\/v1\/user\/subscription/,
          status: 200,
          body: { character_count: 10, character_limit: 10000, can_use_instant_voice_cloning: true },
        },
      ]),
    );
    assert.ok((await fine.validateKey("xi-y")).every((p) => p.available));
  });

  it("ollama: unreachable means not running, never an invalid key", async () => {
    const down = new OllamaClient(fakeFetch([]));
    const probes = await down.validateKey();
    assert.equal(probes[0]?.available, false);
    assert.match(probes[0]!.reason!, /not running/);

    const empty = new OllamaClient(fakeFetch([{ match: /\/api\/tags/, status: 200, body: { models: [] } }]));
    assert.match((await empty.validateKey())[0]!.reason!, /no models pulled/);
  });
});

describe("declarations are honest per provider (T-9)", () => {
  it("elevenlabs can list recent work; fal and higgsfield cannot; nobody reports cost", async () => {
    const eleven = new ElevenLabsClient(fakeFetch([]));
    assert.equal(eleven.declarations.supportsListRecent, true);
    assert.equal(eleven.declarations.reportsCost, false);
    const fal = new FalClient(fakeFetch([]));
    assert.deepEqual(fal.declarations, {
      supportsIdempotencyKey: false,
      supportsLookupByKey: false,
      supportsListRecent: false,
      reportsCost: false,
    });
  });
});

describe("fal submit/poll round-trip carries the endpoint in the remote id", () => {
  it("polls the endpoint-scoped status url", async () => {
    const seen: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      seen.push(url);
      if (/\/status$/.test(url)) return new Response(JSON.stringify({ status: "IN_PROGRESS" }), { status: 200 });
      return new Response(JSON.stringify({ request_id: "req-9" }), { status: 200 });
    };
    const client = new FalClient(fetchImpl);
    const submitted = await client.submit("k", { model: "flux-pro-1.1", capability: "image", params: { prompt: "x" } });
    assert.equal(submitted.remoteId, "fal-ai/flux-pro/v1.1::req-9");
    const poll = await client.poll("k", submitted.remoteId);
    assert.equal(poll.state, "running");
    assert.match(seen[1]!, /fal-ai\/flux-pro\/v1\.1\/requests\/req-9\/status/);
  });
});
