import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ElevenLabsClient } from "../src/clients/elevenlabs.js";
import { FalClient } from "../src/clients/fal.js";
import { HiggsfieldClient } from "../src/clients/higgsfield.js";
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

describe("openai image submission", () => {
  it("sends only fields the endpoint takes, so a neutral param cannot 400 the job", async () => {
    // Read from a real failure: params carried `references: []` — a FAL concept — and OpenAI
    // answered 400. To the user that read as "the image failed", not "we sent a word it does
    // not know", and nothing in the app said either.
    let sent: Record<string, unknown> = {};
    const fetchImpl: FetchLike = async (_url, init) => {
      sent = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("png").toString("base64") }] }), { status: 200 });
    };
    const client = new OpenAiClient(fetchImpl);
    await client.submit("k", {
      model: "gpt-image-2",
      capability: "image",
      params: { prompt: "a drowned harbour", references: [], size: "1024x1024" },
    });
    assert.equal(sent["prompt"], "a drowned harbour");
    assert.equal(sent["size"], "1024x1024");
    assert.equal(sent["model"], "gpt-image-2");
    assert.ok(!("references" in sent), "the field OpenAI has never heard of does not go");
  });
});

describe("fal submit/poll round-trip carries the endpoint in the remote id", () => {
  it("polls the endpoint-scoped status url", async () => {
    const seen: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      seen.push(url);
      if (url.endsWith("/status")) return new Response(JSON.stringify({ status: "IN_PROGRESS" }), { status: 200 });
      return new Response(JSON.stringify({ request_id: "req-9" }), { status: 200 });
    };
    const client = new FalClient(fetchImpl);
    const submitted = await client.submit("k", { model: "flux-2-pro", capability: "image", params: { prompt: "x" } });
    assert.equal(submitted.remoteId, "fal-ai/flux-2-pro::req-9");
    const poll = await client.poll("k", submitted.remoteId);
    assert.equal(poll.state, "running");
    assert.match(seen[1]!, /fal-ai\/flux-2-pro\/requests\/req-9\/status/);
  });
});

describe("provider artifact filenames match their declared image format", () => {
  it("fal preserves JPEG and WebP extensions", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const fetchImpl: FetchLike = async (url) => {
      if (url.endsWith("/requests/req-1")) {
        return new Response(JSON.stringify({
          images: [
            { url: "https://assets.test/a", content_type: "image/jpeg" },
            { url: "https://assets.test/b", content_type: "image/webp" },
          ],
        }), { status: 200 });
      }
      return new Response(bytes, { status: 200 });
    };
    const artifacts = await new FalClient(fetchImpl).fetchArtifacts("k", "fal-ai/flux-2-pro::req-1");
    assert.deepEqual(artifacts.map((artifact) => artifact.name), ["output-1.jpg", "output-2.webp"]);
  });

  it("higgsfield preserves JPEG and WebP extensions", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const fetchImpl: FetchLike = async (url) => {
      if (url.endsWith("/v1/jobs/job-1")) {
        return new Response(JSON.stringify({
          outputs: [
            { url: "https://assets.test/a", content_type: "image/jpeg" },
            { url: "https://assets.test/b", content_type: "image/webp" },
          ],
        }), { status: 200 });
      }
      return new Response(bytes, { status: 200 });
    };
    const artifacts = await new HiggsfieldClient(fetchImpl).fetchArtifacts("k", "job-1");
    assert.deepEqual(artifacts.map((artifact) => artifact.name), ["output-1.jpg", "output-2.webp"]);
  });
});
