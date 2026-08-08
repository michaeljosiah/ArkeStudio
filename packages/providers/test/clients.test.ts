import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";
import { ElevenLabsClient } from "../src/clients/elevenlabs.js";
import { FalClient } from "../src/clients/fal.js";
import { HiggsfieldClient } from "../src/clients/higgsfield.js";
import { OllamaClient } from "../src/clients/ollama.js";
import { OpenAiClient } from "../src/clients/openai.js";
import { lazyHiggsfieldRunner } from "../src/higgsfield-cli.js";
import { ProviderAuthError, type CommandRunner, type FetchLike } from "../src/types.js";

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
      params: {
        prompt: "a drowned harbour",
        references: [],
        output: { width: 1024, height: 1536, aspect: "2:3", resolution: "1024" },
      },
    });
    assert.equal(sent["prompt"], "a drowned harbour");
    assert.equal(sent["size"], "1024x1536");
    assert.equal(sent["model"], "gpt-image-2");
    assert.ok(!("references" in sent), "the field OpenAI has never heard of does not go");
  });

  it("uses the edits endpoint with ordered binary references and no internal paths", async () => {
    let url = "";
    let form: FormData | null = null;
    const client = new OpenAiClient(async (requestUrl, init) => {
      url = requestUrl;
      form = init?.body as FormData;
      return new Response(
        JSON.stringify({
          output_format: "webp",
          data: [{ b64_json: Buffer.from("webp-result").toString("base64") }],
        }),
        { status: 200 },
      );
    });
    const result = await client.submit("k", {
      model: "gpt-image-2",
      capability: "image",
      params: {
        prompt: "preserve this identity",
        references: ["references/a.png", "references/b.jpg"],
        provenance: { canonRevision: 4 },
        output: { width: 1024, height: 1536 },
      },
      imageReferences: [
        { name: "reference-01.png", contentType: "image/png", data: Uint8Array.from([1, 2, 3]) },
        { name: "reference-02.jpg", contentType: "image/jpeg", data: Uint8Array.from([4, 5]) },
      ],
    });
    assert.match(url, /\/v1\/images\/edits$/);
    assert.ok(form);
    assert.equal(form.get("model"), "gpt-image-2");
    assert.equal(form.get("quality"), "medium");
    assert.equal(form.get("size"), "1024x1536");
    assert.equal(form.get("input_fidelity"), null);
    const images = form.getAll("image[]") as File[];
    assert.deepEqual(images.map((image) => [image.name, image.type]), [
      ["reference-01.png", "image/png"],
      ["reference-02.jpg", "image/jpeg"],
    ]);
    assert.deepEqual([...new Uint8Array(await images[0]!.arrayBuffer())], [1, 2, 3]);
    const formText = [...form.entries()].filter(([, value]) => typeof value === "string").map(([, value]) => value).join(" ");
    assert.ok(!formText.includes("references/"));
    assert.ok(!formText.includes("canonRevision"));
    assert.equal(result.artifacts?.[0]?.name, "image-1.webp");
    assert.equal(result.artifacts?.[0]?.contentType, "image/webp");
  });

  it("accepts sixteen references and rejects seventeen before fetch", async () => {
    let fetches = 0;
    const client = new OpenAiClient(async () => {
      fetches += 1;
      return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("png").toString("base64") }] }), {
        status: 200,
      });
    });
    const reference = { name: "reference.png", contentType: "image/png" as const, data: Uint8Array.from([1]) };
    await client.submit("k", {
      model: "gpt-image-2",
      capability: "image",
      params: { prompt: "x" },
      imageReferences: Array.from({ length: 16 }, (_, index) => ({ ...reference, name: `reference-${index}.png` })),
    });
    assert.equal(fetches, 1);
    await assert.rejects(
      client.submit("k", {
        model: "gpt-image-2",
        capability: "image",
        params: { prompt: "x" },
        imageReferences: Array.from({ length: 17 }, () => reference),
      }),
      /at most 16/,
    );
    assert.equal(fetches, 1);
  });
});

/**
 * Higgsfield is driven as a subprocess, so its seam is a command runner rather than a fetch
 * (issue #137). Same idea as `fakeFetch`: route on the argument list, and anything unrouted is
 * a command that does not exist.
 */
function fakeExec(routes: Array<{ match: RegExp; code?: number; stdout?: string; stderr?: string }>) {
  const calls: string[][] = [];
  const run: CommandRunner = async (args) => {
    calls.push([...args]);
    const line = args.join(" ");
    const hit = routes.find((r) => r.match.test(line));
    if (!hit) return { code: 127, stdout: "", stderr: `higgsfield: unroutable "${line}"` };
    return { code: hit.code ?? 0, stdout: hit.stdout ?? "", stderr: hit.stderr ?? "" };
  };
  return { run, calls };
}

const unreachableFetch: FetchLike = async () => {
  throw new Error("no HTTP call expected");
};

/** The argument that follows `flag`, or undefined when it was never passed. */
function flagValue(argv: string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  return at === -1 ? undefined : argv[at + 1];
}

describe("higgsfield drives the CLI (issue #137)", () => {
  it("dispatches to the job_type and translates neutral output intent", async () => {
    const { run, calls } = fakeExec([{ match: /generate create/, stdout: JSON.stringify({ id: "job-1" }) }]);
    const accepted = await new HiggsfieldClient(run, unreachableFetch).submit("", {
      model: "text2image_soul_v2",
      capability: "image",
      params: {
        prompt: "x",
        references: [],
        provenance: { canonRevision: 1 },
        output: { width: 1024, height: 1024, aspect: "1:1", resolution: "2k" },
      },
    });
    assert.equal(accepted.remoteId, "job-1");
    const argv = calls[0]!;
    assert.deepEqual(argv.slice(0, 3), ["generate", "create", "text2image_soul_v2"]);
    assert.equal(flagValue(argv, "--prompt"), "x");
    assert.equal(flagValue(argv, "--aspect_ratio"), "1:1");
    // Soul calls the size tier `quality`; sending `--resolution` would be a flag it rejects.
    assert.equal(flagValue(argv, "--quality"), "2k");
    assert.equal(flagValue(argv, "--resolution"), undefined);
    // Coordinator bookkeeping is not Higgsfield's, and the CLI errors on an undeclared flag.
    assert.ok(!argv.includes("--output"));
    assert.ok(!argv.includes("--references"));
    assert.ok(!argv.includes("--provenance"));
    // Machine-readable and unstyled, or the parse eats ANSI escapes.
    assert.ok(argv.includes("--json") && argv.includes("--no-color"));
  });

  it("passes references as files the CLI uploads, then removes them", async () => {
    const { run, calls } = fakeExec([{ match: /generate create/, stdout: JSON.stringify({ id: "job-2" }) }]);
    await new HiggsfieldClient(run, unreachableFetch).submit("", {
      model: "text2image_soul_v2",
      capability: "image",
      params: { prompt: "x", references: ["references/maren-kest/main.png"] },
      imageReferences: [{ name: "main.png", contentType: "image/png", data: new Uint8Array([1, 2, 3]) }],
    });
    const file = flagValue(calls[0]!, "--image-references");
    assert.ok(file !== undefined, "the reference went as a path");
    assert.match(file, /reference-1\.png$/);
    // Ephemeral verified bytes: the temp copy does not outlive the submission.
    assert.equal(existsSync(file), false);
  });

  it("refuses a submission whose references did not all resolve to bytes", async () => {
    const { run, calls } = fakeExec([{ match: /generate create/, stdout: JSON.stringify({ id: "job-3" }) }]);
    await assert.rejects(
      new HiggsfieldClient(run, unreachableFetch).submit("", {
        model: "text2image_soul_v2",
        capability: "image",
        params: { prompt: "x", references: ["a.png", "b.png"] },
        imageReferences: [{ name: "a.png", contentType: "image/png", data: new Uint8Array([1]) }],
      }),
      /not every image reference was prepared/,
    );
    assert.equal(calls.length, 0, "nothing was spent proving it");
  });

  it("maps job status onto the queue's states, and names one it does not know", async () => {
    const states = async (status: string) => {
      const { run } = fakeExec([{ match: /generate get/, stdout: JSON.stringify({ id: "j", status }) }]);
      return new HiggsfieldClient(run, unreachableFetch).poll("", "j");
    };
    assert.deepEqual(await states("completed"), { state: "succeeded" });
    assert.deepEqual(await states("queued"), { state: "queued" });
    assert.deepEqual(await states("in_progress"), { state: "running" });
    assert.deepEqual(await states("canceled"), { state: "cancelled" });
    assert.equal((await states("failed")).state, "failed");
    // Loud, like fal's: only "completed" has been seen against a live account, so an
    // unrecognised value must surface with the provider's own word rather than poll forever.
    const surprise = await states("marinating");
    assert.equal(surprise.state, "failed");
    assert.match(surprise.error!, /unexpected status "marinating"/);
  });

  it("downloads the result url and ignores the thumbnail beside it", async () => {
    const { run } = fakeExec([
      {
        match: /generate get/,
        stdout: JSON.stringify({
          id: "j",
          status: "completed",
          result_url: "https://assets.test/full.png",
          min_result_url: "https://assets.test/thumb.webp",
        }),
      },
    ]);
    const fetched: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      fetched.push(url);
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/png" } });
    };
    const artifacts = await new HiggsfieldClient(run, fetchImpl).fetchArtifacts("", "j");
    assert.deepEqual(fetched, ["https://assets.test/full.png"]);
    assert.deepEqual(
      artifacts.map((a) => a.name),
      ["output-1.png"],
    );
  });

  it("reports a signed-out CLI as a provider fault, not a work failure (R-4)", async () => {
    const { run } = fakeExec([{ match: /generate get/, code: 1, stderr: "Session expired" }]);
    await assert.rejects(new HiggsfieldClient(run, unreachableFetch).poll("", "j"), (err: unknown) => {
      assert.ok(err instanceof ProviderAuthError);
      return true;
    });
  });

  it("validates on the free account probe, and says so when the account cannot pay", async () => {
    const ok = fakeExec([
      { match: /account status/, stdout: JSON.stringify({ credits: 12.5, email: "someone@example.test" }) },
    ]);
    assert.deepEqual(await new HiggsfieldClient(ok.run, unreachableFetch).validateKey(""), [
      { capability: "image", available: true },
      { capability: "video", available: true },
    ]);
    // Never a real generation (§2.4): the probe reads the balance and nothing else.
    assert.deepEqual(ok.calls[0]!.slice(0, 2), ["account", "status"]);

    const broke = fakeExec([{ match: /account status/, stdout: JSON.stringify({ credits: 0 }) }]);
    const probes = await new HiggsfieldClient(broke.run, unreachableFetch).validateKey("");
    assert.equal(probes[0]!.available, false);
    assert.match(probes[0]!.reason!, /no credit/);

    const out = fakeExec([{ match: /account status/, code: 1, stderr: "Not authenticated" }]);
    const signedOut = await new HiggsfieldClient(out.run, unreachableFetch).validateKey("");
    assert.equal(signedOut[0]!.available, false);
    assert.match(signedOut[0]!.reason!, /auth login/);
  });

  it("cancel spends nothing, because the CLI has no cancel verb", async () => {
    const { run, calls } = fakeExec([]);
    await new HiggsfieldClient(run, unreachableFetch).cancel("", "j");
    assert.deepEqual(calls, []);
  });

  it("declares nothing it cannot honour — a listing without our key cannot reconcile", async () => {
    const { run } = fakeExec([]);
    assert.deepEqual(new HiggsfieldClient(run, unreachableFetch).declarations, {
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
    let sent: Record<string, unknown> = {};
    const fetchImpl: FetchLike = async (url, init) => {
      seen.push(url);
      if (url.endsWith("/status")) return new Response(JSON.stringify({ status: "IN_PROGRESS" }), { status: 200 });
      sent = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify({ request_id: "req-9" }), { status: 200 });
    };
    const client = new FalClient(fetchImpl);
    const submitted = await client.submit("k", {
      model: "flux-2-pro",
      capability: "image",
      params: {
        prompt: "x",
        references: [],
        referenceRoles: [],
        artDirection: { version: 1 },
        output: { width: 1024, height: 1280, aspect: "4:5", resolution: "1MP" },
      },
    });
    assert.equal(submitted.remoteId, "fal-ai/flux-2-pro::req-9");
    assert.deepEqual(sent["image_size"], { width: 1024, height: 1280 });
    assert.ok(!("aspect_ratio" in sent));
    assert.ok(!("resolution" in sent));
    assert.ok(!("output" in sent));
    assert.ok(!("references" in sent));
    assert.ok(!("referenceRoles" in sent));
    assert.ok(!("artDirection" in sent));
    const poll = await client.poll("k", submitted.remoteId);
    assert.equal(poll.state, "running");
    assert.match(seen[1]!, /fal-ai\/flux-2-pro\/requests\/req-9\/status/);
  });

  it("asks for a video length in the route's own word, never our field name", async () => {
    // Read from the schemas: every fal video route declares `duration` as a string out of a
    // fixed list, and the lists disagree. We sent `durationSec` as a number, a field none of
    // them declares — so every video dispatch ran at the provider's default length while the
    // estimate had been computed from the seconds the scene planned.
    const bodyFor = async (model: string, durationSec: number): Promise<Record<string, unknown>> => {
      let sent: Record<string, unknown> = {};
      const client = new FalClient(async (_url, init) => {
        sent = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return new Response(JSON.stringify({ request_id: "req-1" }), { status: 200 });
      });
      await client.submit("k", {
        model,
        capability: "video",
        params: { prompt: "the harbour at dusk", references: [], durationSec },
      });
      return sent;
    };

    const seedance = await bodyFor("seedance-2.0", 6);
    assert.equal(seedance["duration"], "6", "seedance counts in bare seconds");
    assert.ok(!("durationSec" in seedance), "our own field name never reaches the wire");

    const veo = await bodyFor("veo-3.1", 8);
    assert.equal(veo["duration"], "8s", "veo wants the s");

    const kling = await bodyFor("kling-3-pro", 5);
    assert.equal(kling["duration"], "5");
  });

  it("refuses a length the route does not offer, rather than dropping it", async () => {
    // Sending nothing is the bug this replaced: the provider's default length runs while the
    // estimate was computed from the seconds the job carries. The reachable case is a job
    // journalled before an upgrade, still holding an unsnapped 6.5s.
    let fetches = 0;
    const client = new FalClient(async () => {
      fetches += 1;
      return new Response(JSON.stringify({ request_id: "req" }), { status: 200 });
    });
    await assert.rejects(
      client.submit("k", {
        model: "veo-3.1",
        capability: "video",
        params: { prompt: "x", references: [], durationSec: 6.5 },
      }),
      /veo-3\.1 cannot be asked for 6\.5s/,
    );
    assert.equal(fetches, 0, "refused before the money moves");
  });

  it("refuses references for a model with no edit route, before any network call", async () => {
    let fetches = 0;
    const client = new FalClient(async () => {
      fetches += 1;
      return new Response(JSON.stringify({ request_id: "req" }), { status: 200 });
    });
    await assert.rejects(
      client.submit("k", {
        model: "flux-2-pro",
        capability: "image",
        params: { prompt: "x", references: ["references/maren-kest/main.png"] },
      }),
      /flux-2-pro has no reference-image route/,
    );
    assert.equal(fetches, 0);
  });

  it("a job carrying references lands on the edit route, inlined as data URIs", async () => {
    const seen: string[] = [];
    let sent: Record<string, unknown> = {};
    const fetchImpl: FetchLike = async (url, init) => {
      seen.push(url);
      sent = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify({ request_id: "req-4" }), { status: 200 });
    };
    const submitted = await new FalClient(fetchImpl).submit("k", {
      model: "nano-banana-2",
      capability: "image",
      params: {
        prompt: "x",
        references: ["references/maren-kest/main.png"],
        output: { width: 1024, height: 1280, aspect: "4:5", resolution: "2K" },
      },
      imageReferences: [{ name: "main.png", contentType: "image/png", data: new Uint8Array([1, 2, 3]) }],
    });
    assert.match(seen[0]!, /fal-ai\/nano-banana-2\/edit$/);
    assert.deepEqual(sent["image_urls"], ["data:image/png;base64,AQID"]);
    assert.equal(sent["resolution"], "2K");
    // The remote id carries the edit route, so polling and cancelling stay endpoint-scoped.
    assert.equal(submitted.remoteId, "fal-ai/nano-banana-2/edit::req-4");
    assert.ok(!("references" in sent));
  });

  it("the same model with no references stays on the text route", async () => {
    const seen: string[] = [];
    let sent: Record<string, unknown> = {};
    const fetchImpl: FetchLike = async (url, init) => {
      seen.push(url);
      sent = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify({ request_id: "req-5" }), { status: 200 });
    };
    await new FalClient(fetchImpl).submit("k", {
      model: "nano-banana-2",
      capability: "image",
      params: { prompt: "x", references: [], output: { width: 1024, height: 1280, aspect: "4:5", resolution: "1K" } },
    });
    assert.match(seen[0]!, /fal-ai\/nano-banana-2$/);
    assert.ok(!("image_urls" in sent));
  });

  it("refuses to submit when a promised reference did not resolve to bytes", async () => {
    let fetches = 0;
    const client = new FalClient(async () => {
      fetches += 1;
      return new Response(JSON.stringify({ request_id: "req" }), { status: 200 });
    });
    await assert.rejects(
      client.submit("k", {
        model: "nano-banana-2",
        capability: "image",
        params: { prompt: "x", references: ["a.png", "b.png"] },
        imageReferences: [{ name: "a.png", contentType: "image/png", data: new Uint8Array([1]) }],
      }),
      /not every image reference was prepared/,
    );
    assert.equal(fetches, 0);
  });

  it("refuses an inline payload too large to be a reference", async () => {
    let fetches = 0;
    const client = new FalClient(async () => {
      fetches += 1;
      return new Response(JSON.stringify({ request_id: "req" }), { status: 200 });
    });
    await assert.rejects(
      client.submit("k", {
        model: "nano-banana-2",
        capability: "image",
        params: { prompt: "x", references: ["huge.png"] },
        imageReferences: [
          { name: "huge.png", contentType: "image/png", data: new Uint8Array(9 * 1024 * 1024) },
        ],
      }),
      /over the inline limit/,
    );
    assert.equal(fetches, 0);
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

  it("higgsfield names the file from the served content type, not the url", async () => {
    // The result url carries no extension we can trust, so the download's own content type is
    // what decides — a webp landing as ".png" is a file nothing downstream opens.
    const { run } = fakeExec([
      { match: /generate get/, stdout: JSON.stringify({ id: "j", result_url: "https://assets.test/a" }) },
    ]);
    const fetchImpl: FetchLike = async () =>
      new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/webp" } });
    const artifacts = await new HiggsfieldClient(run, fetchImpl).fetchArtifacts("", "j");
    assert.deepEqual(artifacts.map((artifact) => artifact.name), ["output-1.webp"]);
  });
});

describe("the CLI can arrive after the app has started (issue 137)", () => {
  it("binds on first use, not at launch, so an install does not need a restart", async () => {
    let installed = false;
    let probes = 0;
    const runner = lazyHiggsfieldRunner(
      async () => {
        probes += 1;
        return installed ? { command: "C:/app/hf.exe", source: "bundled" as const, version: "1.1.22" } : null;
      },
      () => async () => ({ code: 0, stdout: "{}", stderr: "" }),
    );

    // Before: the remedy, not an ENOENT — an absent CLI is not the shot having failed (R-4).
    const missing = await runner(["account", "status"]);
    assert.equal(missing.code, null);
    assert.match(missing.stderr, /not installed/);

    installed = true;
    assert.equal((await runner(["account", "status"])).code, 0);
    // And once bound it stays bound: discovery is not re-run on every call.
    await runner(["account", "status"]);
    assert.equal(probes, 2);
  });
});
