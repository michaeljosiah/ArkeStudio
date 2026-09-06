import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";
import { frameDispatchFor, providerFaultCategory, PROVIDERS, type ProviderId } from "@arke-studio/contracts";
import { AnthropicClient } from "../src/clients/anthropic.js";
import { ElevenLabsClient } from "../src/clients/elevenlabs.js";
import { SHIPPED_MANIFEST } from "../src/manifest-data.js";
import { FalClient } from "../src/clients/fal.js";
import { HiggsfieldClient } from "../src/clients/higgsfield.js";
import { OllamaClient } from "../src/clients/ollama.js";
import { OpenAiClient } from "../src/clients/openai.js";
import { higgsfieldSelectWorkspace, higgsfieldWorkspaces, lazyHiggsfieldRunner } from "../src/higgsfield-cli.js";
import { ProviderAuthError, type CommandRunner, type FetchLike, type ProviderTransportScope } from "../src/types.js";
import { KokoroClient } from "../src/clients/kokoro.js";
import { WhisperCppClient } from "../src/clients/whispercpp.js";
import { createProviderClients, PROVIDER_DECLARATIONS } from "../src/registry.js";
import { jsonRequest } from "../src/clients/http.js";

/** A fetch fake: route → {status, body}. Anything unrouted throws (network unreachable). */
function fakeFetch(routes: Array<{ match: RegExp; status: number; body?: unknown }>): FetchLike {
  return async (url) => {
    const hit = routes.find((r) => r.match.test(url));
    if (!hit) throw new Error(`ECONNREFUSED ${url}`);
    return new Response(hit.body !== undefined ? JSON.stringify(hit.body) : "", { status: hit.status });
  };
}

describe("provider HTTP failures preserve the provider's reason", () => {
  it("reads a 403 JSON detail before raising the provider fault", async () => {
    const detail = "User is locked. Reason: Exhausted balance. Top up at fal.ai/dashboard/billing.";
    await assert.rejects(
      jsonRequest(
        fakeFetch([{ match: /queue\.fal\.run/, status: 403, body: { detail } }]),
        "fal",
        "https://queue.fal.run/test",
        {},
      ),
      (error: unknown) => {
        assert.ok(error instanceof ProviderAuthError);
        assert.equal(error.message, `fal: ${detail} (HTTP 403)`);
        assert.equal(providerFaultCategory(error.message), "billing");
        return true;
      },
    );
  });
});

describe("key validation probes what the key unlocks (R-3, D5, §3.2)", () => {
  it("fal: one key probe answers every gateway capability (R-1)", async () => {
    const ok = new FalClient(fakeFetch([{ match: /queue\.fal\.run/, status: 404, body: { detail: "not found" } }]));
    assert.deepEqual(await ok.validateKey("good"), [
      { capability: "image", available: true },
      { capability: "video", available: true },
      { capability: "music", available: true },
    ]);

    // The probe set has to be the provider table's own list, not a subset of it. A capability fal
    // serves but never probes reads as *locked* with a valid key in the box, because
    // deriveCapabilityAvailability treats an absent probe as unavailable — a silent failure, and
    // the reason this asserts the relationship rather than only the literal list above.
    assert.deepEqual(
      (await ok.validateKey("good")).map((p) => p.capability),
      [...PROVIDERS.fal.capabilities],
    );

    const bad = new FalClient(fakeFetch([{ match: /queue\.fal\.run/, status: 401 }]));
    const probes = await bad.validateKey("bad");
    assert.equal(probes.length, PROVIDERS.fal.capabilities.length);
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
        { match: /\/v1\/models$/, status: 200, body: [{ model_id: "eleven_multilingual_sts_v2", can_do_voice_conversion: true }] },
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

describe("synchronous speech returns artifacts to the durable queue path", () => {
  it("ElevenLabs returns paid MP3 bytes inline and keeps no poll-cache dependency", async () => {
    const mp3 = Uint8Array.from([0xff, 0xfb, 0x90, 0, ...Array.from({ length: 413 }, () => 0)]);
    const client = new ElevenLabsClient(async () => new Response(mp3, { status: 200 }));
    const submitted = await client.submit("xi-key", {
      model: "eleven_multilingual_v2",
      capability: "voice-tts",
      params: { voiceId: "v1", text: "The harbour remembers." },
    });
    assert.deepEqual(submitted.artifacts, [{ name: "speech.mp3", contentType: "audio/mpeg", data: mp3 }]);
    assert.match((await client.poll("xi-key", submitted.remoteId)).error ?? "", /returned by submit/);
  });

  it("passes queue cancellation into an in-flight ElevenLabs request", async () => {
    let signal: AbortSignal | undefined;
    const client = new ElevenLabsClient(async (_url, init) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    const controller = new AbortController();
    const submitting = client.submit("xi-key", {
      model: "eleven_multilingual_v2",
      capability: "voice-tts",
      signal: controller.signal,
      params: { voiceId: "v1", text: "The harbour remembers." },
    });
    await Promise.resolve();
    assert.equal(signal, controller.signal);
    controller.abort();
    await assert.rejects(submitting, /aborted/);
  });
});

describe("queue cancellation reaches the synchronous paid submits (issue 95)", () => {
  /**
   * `SubmitRequest.signal` was declared and threaded all the way from the dispatcher, and only
   * ElevenLabs ever handed it to `fetch` — so cancelling an in-flight OpenAI image submit left the
   * local wait running to whatever deadline the runtime happened to inherit. The dispatcher-side
   * test cannot see which client drops it: the abort is fired against a client that never asked to
   * hear about it, and the queue looks correct while nothing happens. Assert it per path instead.
   *
   * These are the *synchronous* paid paths, where submit itself is the long wait and the provider
   * has no remote job to call off afterwards — their `cancel()` is a documented no-op, so there is
   * nothing an abort can lose. The queue-backed providers are a different case entirely; see the
   * fal test below. The local runtimes carry their own deadlines (their `AbortSignal.timeout`).
   */
  const paths: Array<{ name: string; submit: (fetchImpl: FetchLike, signal: AbortSignal) => Promise<unknown> }> = [
    {
      name: "openai llm",
      submit: (fetchImpl, signal) =>
        new OpenAiClient(fetchImpl).submit("k", {
          model: "gpt-5.2",
          capability: "llm",
          signal,
          params: { messages: [{ role: "user", content: "x" }] },
        }),
    },
    {
      name: "openai image, no references",
      submit: (fetchImpl, signal) =>
        new OpenAiClient(fetchImpl).submit("k", {
          model: "gpt-image-2",
          capability: "image",
          signal,
          params: { prompt: "a drowned harbour" },
        }),
    },
    {
      // A separate fetch call site: references go out as multipart to /v1/images/edits, bypassing
      // jsonRequest entirely, so forwarding on the JSON path proves nothing about this one.
      name: "openai image, with references",
      submit: (fetchImpl, signal) =>
        new OpenAiClient(fetchImpl).submit("k", {
          model: "gpt-image-2",
          capability: "image",
          signal,
          params: { prompt: "a drowned harbour", references: ["references/maren-kest/main.png"] },
          imageReferences: [{ name: "main.png", contentType: "image/png", data: new Uint8Array([1, 2, 3]) }],
        }),
    },
    {
      name: "anthropic",
      submit: (fetchImpl, signal) =>
        new AnthropicClient(fetchImpl).submit("k", {
          model: "claude-opus-5",
          capability: "llm",
          signal,
          params: { messages: [{ role: "user", content: "x" }] },
        }),
    },
  ];

  for (const path of paths) {
    it(`${path.name}: the abort ends the local wait`, async () => {
      let seen: AbortSignal | undefined;
      // Settles only when the signal fires. A client that drops the signal hangs this test rather
      // than passing it quietly — the failure mode being tested for is silence.
      const fetchImpl: FetchLike = async (_url, init) => {
        seen = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          seen?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      };
      const controller = new AbortController();
      const submitting = path.submit(fetchImpl, controller.signal);
      await Promise.resolve();
      assert.equal(seen, controller.signal, "the client never handed the caller's signal to fetch");
      controller.abort();
      await assert.rejects(submitting, /aborted/);
    });
  }

  it("fal's queue submission is deliberately left un-abortable", async () => {
    // The opposite of the rule above, and the reason it is not "forward it everywhere". fal's
    // submit is an *enqueue*: the POST returns the `request_id` that cancel() needs to call the
    // work off. Aborting it discards that id while the remote job carries on — the request was
    // accepted, we simply threw away the handle, and a cancelled paid generation would run to
    // completion and charge. There is no long local wait here to save; the wait worth aborting is
    // a synchronous generation, not a sub-second enqueue. The queue cancels this one properly by
    // letting the id come back (dispatcher.ts:701).
    let init: RequestInit | undefined;
    const fetchImpl: FetchLike = async (_url, seen) => {
      init = seen;
      return new Response(JSON.stringify({ request_id: "req-2" }), { status: 200 });
    };
    const controller = new AbortController();
    const submitted = await new FalClient(fetchImpl).submit("k", {
      model: "nano-banana-2",
      capability: "image",
      signal: controller.signal,
      params: { prompt: "x", output: { width: 1024, height: 1024 } },
    });
    assert.ok(init !== undefined);
    assert.ok(!("signal" in init), "aborting the enqueue would discard the id needed to cancel it");
    // The id the remote cancel is reached through still comes back.
    assert.equal(submitted.remoteId, "fal-ai/nano-banana-2::req-2");
  });

  it("omits the field entirely when the caller passed no signal", async () => {
    // `exactOptionalPropertyTypes` is on and the clients spread-guard the field. An explicit
    // `signal: undefined` is not the same as an absent one to every fetch implementation.
    let init: RequestInit | undefined;
    const fetchImpl: FetchLike = async (_url, seen) => {
      init = seen;
      return new Response(JSON.stringify({ request_id: "req-1" }), { status: 200 });
    };
    await new FalClient(fetchImpl).submit("k", { model: "nano-banana-2", capability: "image", params: { prompt: "x" } });
    assert.ok(init !== undefined);
    assert.ok(!("signal" in init));
  });
});

describe("witnessed paid submission responses stay distinct from transport failures (issue 95)", () => {
  const rejected = async (submit: (fetchImpl: FetchLike) => Promise<unknown>, status: number, marked: boolean) => {
    await assert.rejects(
      submit(async () => new Response(JSON.stringify({ error: "rejected" }), { status })),
      (error: Error & { submissionRejected?: boolean }) => {
        assert.equal(error.submissionRejected === true, marked);
        return true;
      },
    );
  };

  const submissions = [
    (fetchImpl: FetchLike) =>
      new OpenAiClient(fetchImpl).submit("k", {
        model: "gpt-5.2",
        capability: "llm",
        params: { messages: [{ role: "user", content: "x" }] },
      }),
    (fetchImpl: FetchLike) =>
      new AnthropicClient(fetchImpl).submit("k", {
        model: "claude-opus-5",
        capability: "llm",
        params: { messages: [{ role: "user", content: "x" }] },
      }),
    (fetchImpl: FetchLike) =>
      new ElevenLabsClient(fetchImpl).submit("k", {
        model: "eleven_multilingual_v2",
        capability: "voice-tts",
        params: { voiceId: "v1", text: "x" },
      }),
    (fetchImpl: FetchLike) =>
      new FalClient(fetchImpl).submit("k", {
        model: "nano-banana-2",
        capability: "image",
        params: { prompt: "x", output: { width: 1024, height: 1024 } },
      }),
  ];

  it("marks 4xx responses as rejections and leaves 5xx outcomes ambiguous", async () => {
    for (const submit of submissions) {
      await rejected(submit, 400, true);
      await rejected(submit, 503, false);
    }
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
        continuedFrom: "tk_01J8F0000000000000000000B2",
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
    assert.ok(!argv.includes("--continuedFrom"));
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

describe("fal continuation dispatch (SPEC-019 R-50, issues 461 and 629)", () => {
  const submit = async (over: Partial<Parameters<FalClient["submit"]>[1]> = {}, durationSec = 7) => {
    let sent: Record<string, unknown> = {};
    let endpoint = "";
    const fetchImpl: FetchLike = async (url, init) => {
      endpoint = url;
      sent = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify({ request_id: "req-1" }), { status: 200 });
    };
    await new FalClient(fetchImpl).submit("k", {
      model: "veo-3.1",
      capability: "video",
      params: {
        prompt: "the tide turns",
        references: [],
        taskMode: "continue",
        route: "fal-ai/veo3.1/extend-video",
        continuedFrom: "tk_01J8F0000000000000000000B2",
        durationSec,
      },
      videoSource: { contentType: "video/mp4", data: new Uint8Array([0, 1, 2, 3]) },
      ...over,
    });
    return { sent, endpoint };
  };

  it("sends the footage as video_url, on the sibling route, and nothing of ours beside it", async () => {
    const { sent, endpoint } = await submit();
    assert.match(endpoint, /fal-ai\/veo3\.1\/extend-video$/, "the mode is a route, not a field (T-1)");
    assert.equal(sent["video_url"], "data:video/mp4;base64,AAECAw==");
    // The sibling route accepts exactly seven seconds, independently of generation's 4s/6s/8s.
    assert.equal(sent["duration"], "7s");
    // Ours, not fal's: the edge is recorded on the take, and the footage already travelled above.
    assert.ok(!("continuedFrom" in sent), "the predecessor id is never sent to a provider");
    assert.ok(!("taskMode" in sent));
    assert.ok(!("route" in sent));
    assert.ok(!("references" in sent));
  });

  it("refuses without the footage rather than extending nothing", async () => {
    // Silently dropping it would submit a paid text-to-video request under a continuation's name,
    // which is the failure the whole capability is built to avoid.
    await assert.rejects(() => submit({ videoSource: undefined }), /needs the footage being extended/);
  });

  it("refuses a generation-only duration before enqueueing the continuation", async () => {
    await assert.rejects(() => submit({}, 6), /cannot be asked for 6s.*offers 7s/);
  });

  it("refuses a clip over the inline ceiling, early and by name", async () => {
    await assert.rejects(
      () => submit({ videoSource: { contentType: "video/mp4", data: new Uint8Array(49 * 1024 * 1024) } }),
      /over the inline limit/,
    );
  });
});

describe("fal motion references ride in the field the row names (issue 852)", () => {
  const clip = { contentType: "video/mp4" as const, data: new Uint8Array([0, 1, 2, 3]) };
  const submit = async (over: Partial<Parameters<FalClient["submit"]>[1]> = {}) => {
    let sent: Record<string, unknown> = {};
    let endpoint = "";
    const fetchImpl: FetchLike = async (url, init) => {
      endpoint = url;
      sent = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify({ request_id: "req-2" }), { status: 200 });
    };
    await new FalClient(fetchImpl).submit("k", {
      model: "minimax-h3",
      capability: "video",
      params: { prompt: "the tide turns", references: [], continuedFrom: "tk_01J8F0000000000000000000B2", durationSec: 6 },
      videoReferences: [clip],
      ...over,
    });
    return { sent, endpoint };
  };

  it("lands a clip alone on the reference route, in reference_video_urls, with nothing of ours beside it", async () => {
    const { sent, endpoint } = await submit();
    assert.match(endpoint, /minimax\/h3\/reference-to-video$/, "a clip alone is still a reference dispatch");
    assert.deepEqual(sent["reference_video_urls"], ["data:video/mp4;base64,AAECAw=="]);
    assert.ok(!("video_url" in sent), "not the extend route's field — H3 has no such route");
    assert.ok(!("reference_image_urls" in sent), "no pictures were sent, so no picture array");
    assert.ok(!("continuedFrom" in sent) && !("videoReferences" in sent), "the edge and the paths are ours");
    assert.equal(sent["duration"], 6);
  });

  it("keeps the pictures in their own array beside the clip", async () => {
    const { sent } = await submit({
      params: { prompt: "x", references: ["a.png"], continuedFrom: "tk_01J8F0000000000000000000B2", durationSec: 6 },
      imageReferences: [{ name: "a.png", contentType: "image/png", data: new Uint8Array([9]) }],
    });
    assert.deepEqual(sent["reference_image_urls"], ["data:image/png;base64,CQ=="]);
    assert.deepEqual(sent["reference_video_urls"], ["data:video/mp4;base64,AAECAw=="]);
  });

  it("refuses a row that names no video field, and a frame route, rather than dropping the clip", async () => {
    // Seedance has a reference route and publishes video seconds, but names no field for the
    // clip — the exact row the budget's field gate exists for.
    await assert.rejects(
      () => submit({ model: "seedance-2.0", params: { prompt: "x", references: [], durationSec: 5 } }),
      /names no field for a video reference/,
    );
    await assert.rejects(
      () =>
        submit({
          params: { prompt: "x", references: ["a.png"], taskMode: "first-frame", route: "minimax/h3/image-to-video", durationSec: 6 },
          imageReferences: [{ name: "a.png", contentType: "image/png", data: new Uint8Array([9]) }],
        }),
      /rides on the reference route, not first-frame/,
    );
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
        continuedFrom: "tk_01J8F0000000000000000000B2",
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
    assert.ok(!("continuedFrom" in sent));
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

  it("dispatches a music job to its own route, carrying the lyrics the route requires", async () => {
    // The first capability here that is neither image nor video, so it is worth proving the
    // whole path rather than assuming it: the route id has no `fal-ai/` prefix, `lyrics` is a
    // required field with no analogue in any earlier dispatch, and the length is a number in a
    // continuous range rather than a member of a published enum.
    let url = "";
    let sent: Record<string, unknown> = {};
    const client = new FalClient(async (requested, init) => {
      url = requested;
      sent = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify({ request_id: "req-music" }), { status: 200 });
    });
    const submitted = await client.submit("k", {
      model: "minimax-music-3",
      capability: "music",
      params: {
        prompt: "slow gospel soul, 68 bpm, Rhodes and brushed drums",
        lyrics: "[verse]\nthe harbour keeps what the tide forgets",
        durationSec: 180,
        references: [],
      },
    });

    assert.match(url, /minimax\/music-3$/, "the route carries no fal-ai prefix");
    assert.equal(sent["prompt"], "slow gospel soul, 68 bpm, Rhodes and brushed drums");
    // Required by Music3Input. A pass-through field, but the one whose absence 422s the job.
    assert.equal(sent["lyrics"], "[verse]\nthe harbour keeps what the tide forgets");
    // A number, not "180": the schema types `duration` as a number.
    assert.equal(sent["duration"], 180);
    assert.equal(typeof sent["duration"], "number");
    assert.ok(!("durationSec" in sent), "our own field name never reaches the wire");
    assert.ok(!("references" in sent), "an empty reference list is ours, not fal's");
    // The remote id carries the endpoint so polling knows where to look.
    assert.match(submitted.remoteId, /minimax\/music-3/);
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

describe("which account the provider bills (issue 137)", () => {
  /** The shape `workspace list --json` really returns, taken from a live account. */
  const LIVE = JSON.stringify([
    {
      id: "92d16af0-3eee-4d61-9632-8ef1f2ab9771",
      name: null,
      plan_type: "ultimate",
      credits: 0.5,
      is_selected: true,
      user_role: "owner",
    },
  ]);

  it("maps the CLI's field names, and keeps a personal account's null name", async () => {
    const rows = await higgsfieldWorkspaces("hf", async () => ({ code: 0, stdout: LIVE, stderr: "" }));
    assert.deepEqual(rows, [
      {
        id: "92d16af0-3eee-4d61-9632-8ef1f2ab9771",
        // Null, not the id: a personal context has no name, and printing a UUID at somebody
        // is not a better answer than saying so.
        name: null,
        plan: "ultimate",
        credits: 0.5,
        role: "owner",
        selected: true,
      },
    ]);
  });

  it("treats an unreadable listing as no picker, never as a fault", async () => {
    const failed = await higgsfieldWorkspaces("hf", async () => ({ code: 1, stdout: "", stderr: "nope" }));
    assert.deepEqual(failed, []);
    const garbage = await higgsfieldWorkspaces("hf", async () => ({ code: 0, stdout: "not json", stderr: "" }));
    assert.deepEqual(garbage, []);
    const wrongShape = await higgsfieldWorkspaces("hf", async () => ({ code: 0, stdout: '{"a":1}', stderr: "" }));
    assert.deepEqual(wrongShape, []);
    // A row with no id cannot be selected, so it is dropped rather than shown unusable.
    const noId = await higgsfieldWorkspaces("hf", async () => ({ code: 0, stdout: '[{"name":"x"}]', stderr: "" }));
    assert.deepEqual(noId, []);
  });

  it("unset is its own verb — clearing is not setting an empty id", async () => {
    const seen: string[][] = [];
    const run = async (_c: string, args: readonly string[]) => {
      seen.push([...args]);
      return { code: 0, stdout: "", stderr: "" };
    };
    await higgsfieldSelectWorkspace("hf", "ws-1", run);
    await higgsfieldSelectWorkspace("hf", null, run);
    assert.deepEqual(seen[0]?.slice(0, 3), ["workspace", "set", "ws-1"]);
    assert.deepEqual(seen[1]?.slice(0, 2), ["workspace", "unset"]);
  });

  it("a refused change says what the tool said", async () => {
    await assert.rejects(
      () =>
        higgsfieldSelectWorkspace("hf", "ws-1", async () => ({
          code: 1,
          stdout: "",
          stderr: "you are not a member of that workspace",
        })),
      /not a member/,
    );
  });
});

describe("fal frame task modes (issue 305 §3; SPEC-019 T-1)", () => {
  const frame = (name: string) => ({ name, contentType: "image/png" as const, data: new Uint8Array([1, 2, 3]) });

  it("dispatches to the mode's own route and names the frames the route's way", async () => {
    // Field names read from the route's published schema: image-to-video takes `image_url`
    // (start, required) and `end_image_url` — never the edit siblings' `image_urls`.
    let url = "";
    let sent: Record<string, unknown> = {};
    const fetchImpl: FetchLike = async (u, init) => {
      url = String(u);
      sent = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify({ request_id: "req-1" }), { status: 200 });
    };
    const client = new FalClient(fetchImpl);
    const result = await client.submit("k", {
      model: "seedance-2.0",
      capability: "video",
      params: {
        prompt: "the tide going still",
        references: ["a.png", "b.png"],
        taskMode: "first-and-last-frame",
        route: "bytedance/seedance-2.0/image-to-video",
      },
      imageReferences: [frame("a.png"), frame("b.png")],
    });
    assert.ok(url.endsWith("/bytedance/seedance-2.0/image-to-video"), url);
    assert.ok(String(sent["image_url"]).startsWith("data:image/png"));
    assert.ok(String(sent["end_image_url"]).startsWith("data:image/png"));
    assert.ok(!("image_urls" in sent), "frame modes never send the edit siblings' field");
    assert.ok(!("taskMode" in sent) && !("route" in sent), "ours, not fal's");
    assert.equal(result.remoteId, "bytedance/seedance-2.0/image-to-video::req-1");
  });

  it("a first-frame dispatch with the wrong image count refuses before fetch", async () => {
    const client = new FalClient(fakeFetch([]));
    await assert.rejects(
      () =>
        client.submit("k", {
          model: "seedance-2.0",
          capability: "video",
          params: {
            prompt: "x",
            references: ["a.png", "b.png"],
            taskMode: "first-frame",
            route: "bytedance/seedance-2.0/image-to-video",
          },
          imageReferences: [frame("a.png"), frame("b.png")],
        }),
      /first-frame needs 1 frame image/,
    );
  });

  it("a video dispatch speaks the routes' own word for the shape, for every family that offers one (issue 389)", async () => {
    // The failure this ends: the studio's `aspect` key passed through verbatim, a field no fal
    // route ever declared, so the chosen ratio never reached the model at all.
    const families = SHIPPED_MANIFEST.models.filter(
      (m) => m.capability === "video" && m.provider === "fal" && (m.limits.aspects?.length ?? 0) > 0,
    );
    assert.ok(families.length >= 6, "seedance ×3, veo ×2, minimax, wan, kling ×2 curate shapes");
    for (const row of families) {
      let sent: Record<string, unknown> = {};
      const client = new FalClient(async (_u, init) => {
        sent = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return new Response(JSON.stringify({ request_id: "req-1" }), { status: 200 });
      });
      const aspect = row.limits.aspects!.includes("9:16") ? "9:16" : row.limits.aspects![0]!;
      await client.submit("k", { model: row.id, capability: "video", params: { prompt: "x", aspect } });
      assert.equal(sent["aspect_ratio"], aspect, `${row.id} receives the shape as aspect_ratio`);
      assert.ok(!("aspect" in sent), `${row.id}: our key never rides the wire`);

      // And a dispatch that chose no shape sends none — the route's own default runs.
      await client.submit("k", { model: row.id, capability: "video", params: { prompt: "x" } });
      assert.ok(!("aspect_ratio" in sent) && !("aspect" in sent), `${row.id} sends no shape unasked`);
    }
  });

  it("every shipped frame family dispatches no-frame, first-frame and first-and-last on its own routes (issue 154)", async () => {
    // Driven from the manifest itself, so a family the sync adds is covered the day it lands and
    // a family it drops fails here by name rather than silently losing coverage.
    const families = SHIPPED_MANIFEST.models.filter(
      (m) => m.capability === "video" && m.provider === "fal" && m.modes?.["first-frame"] !== undefined,
    );
    assert.ok(families.length >= 4, "seedance ×3, minimax, wan are curated today");
    for (const row of families) {
      let url = "";
      let sent: Record<string, unknown> = {};
      const client = new FalClient(async (u, init) => {
        url = String(u);
        sent = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return new Response(JSON.stringify({ request_id: "req-1" }), { status: 200 });
      });

      // No frame: the default text route, no image field of any kind.
      await client.submit("k", { model: row.id, capability: "video", params: { prompt: "x" } });
      assert.ok(!("image_url" in sent) && !("image_urls" in sent), `${row.id} text route carries no image`);

      // First frame: the mode's own route, the route's own field, and our bookkeeping stripped.
      const one = frameDispatchFor(row, 1)!;
      await client.submit("k", {
        model: row.id,
        capability: "video",
        params: {
          prompt: "x",
          references: ["artifacts/boundary.png"],
          taskMode: one.mode,
          ...(one.route !== null ? { route: one.route } : {}),
          startFrame: "artifacts/boundary.png",
          frameArtifact: { id: "ar_x", hash: "sha256:0011223344556677" },
        },
        imageReferences: [frame("boundary.png")],
      });
      assert.ok(url.endsWith(`/${one.route}`), `${row.id} lands on ${one.route}`);
      assert.ok(String(sent[one.fields.start]).startsWith("data:image/png"), `${row.id} sends ${one.fields.start}`);
      assert.ok(!("startFrame" in sent) && !("frameArtifact" in sent), `${row.id}: ours, not fal's`);

      // First and last, where the family declares it.
      const two = frameDispatchFor(row, 2);
      if (two !== null) {
        await client.submit("k", {
          model: row.id,
          capability: "video",
          params: {
            prompt: "x",
            references: ["a.png", "b.png"],
            taskMode: two.mode,
            ...(two.route !== null ? { route: two.route } : {}),
          },
          imageReferences: [frame("a.png"), frame("b.png")],
        });
        assert.ok(String(sent[two.fields.start]).startsWith("data:image/png"), `${row.id} sends the start`);
        assert.ok(String(sent[two.fields.end!]).startsWith("data:image/png"), `${row.id} sends the end`);
      }
    }
  });
});

describe("fal's queue is keyed on the app, not the route", () => {
  /**
   * Submit takes the full path; status, result and cancel take the first two segments alone.
   * fal's per-endpoint OpenAPI templates the full path for all four and the server answers 405
   * to it — which stayed invisible while every shipped route had exactly two segments. Every
   * video route has more, so every video job submitted, was charged, and then failed on its
   * first status read with the result still sitting in the queue.
   */
  const seen: string[] = [];
  const recording: FetchLike = async (url) => {
    seen.push(String(url));
    return new Response(JSON.stringify({ status: "COMPLETED", request_id: "r1" }), { status: 200 });
  };

  it("submits to the route and polls the app", async () => {
    seen.length = 0;
    const client = new FalClient(recording);
    await client.poll("k", "fal-ai/wan/v2.7/text-to-video::abc");
    assert.equal(seen[0], "https://queue.fal.run/fal-ai/wan/requests/abc/status");
  });

  it("fetches results and cancels under the same app path", async () => {
    seen.length = 0;
    const client = new FalClient(async (url) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ video: {} }), { status: 200 });
    });
    await client.fetchArtifacts("k", "bytedance/seedance-2.0/text-to-video::xyz").catch(() => {});
    assert.equal(seen[0], "https://queue.fal.run/bytedance/seedance-2.0/requests/xyz/status".replace("/status", ""));
    seen.length = 0;
    await client.cancel("k", "minimax/h3/image-to-video::q9").catch(() => {});
    assert.equal(seen[0], "https://queue.fal.run/minimax/h3/requests/q9/cancel");
  });

  it("leaves a two-segment route exactly as it was", async () => {
    seen.length = 0;
    const client = new FalClient(recording);
    await client.poll("k", "fal-ai/flux-2-pro::abc");
    assert.equal(seen[0], "https://queue.fal.run/fal-ai/flux-2-pro/requests/abc/status");
  });
});

describe("local speech rides the same queue as the cloud (design 70)", () => {
  const WAV = (() => {
    const out = Buffer.alloc(52);
    out.write("RIFF", 0); out.writeUInt32LE(44, 4); out.write("WAVE", 8);
    out.write("fmt ", 12); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
    out.writeUInt32LE(8000, 24); out.writeUInt32LE(16000, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
    out.write("data", 36); out.writeUInt32LE(8, 40);
    return new Uint8Array(out);
  })();
  const okFetch = (seen: { url?: string; body?: string }) =>
    (async (url: string, init?: { body?: string }) => {
      seen.url = String(url);
      seen.body = init?.body;
      return {
        status: 200,
        arrayBuffer: async () => WAV.buffer.slice(WAV.byteOffset, WAV.byteOffset + WAV.byteLength),
      } as unknown as Response;
    }) as unknown as FetchLike;

  it("synthesises through the sidecar and hands back a WAV take", async () => {
    const seen: { url?: string; body?: string } = {};
    const client = new KokoroClient(okFetch(seen), () => "http://127.0.0.1:7777");
    const submitted = await client.submit("", {
      model: "kokoro-82m",
      params: { voiceId: "af_heart", text: "the tide-clock", voiceSettings: { speed: 0.92 } },
    } as never);
    assert.equal(seen.url, "http://127.0.0.1:7777/tts");
    // The sidecar's own vocabulary: `voice`, and the shaping flattened alongside it.
    assert.deepEqual(JSON.parse(seen.body ?? "{}"), { voice: "af_heart", text: "the tide-clock", speed: 0.92 });
    // Synchronous bytes go inline to the queue's durable landing path; no process-memory id is
    // presented as recoverable work.
    const artifacts = submitted.artifacts!;
    assert.equal(artifacts[0]?.name, "speech.wav");
    assert.equal(artifacts[0]?.contentType, "audio/wav");
    assert.match((await client.poll("", submitted.remoteId)).error ?? "", /returned by submit/);
  });

  it("refuses with the remedy when local voice is not running", async () => {
    const client = new KokoroClient(okFetch({}), () => null);
    await assert.rejects(
      () => client.submit("", { model: "kokoro-82m", params: { voiceId: "af_heart", text: "x" } } as never),
      /local voice is not running/,
    );
    // And says so as availability rather than as a failed generation.
    assert.deepEqual(await client.validateKey(), [
      { capability: "voice-tts", available: false, reason: "the Voxa sidecar is not running" },
    ]);
  });

  it("probes Kokoro engine readiness rather than treating HTTP 200 as availability", async () => {
    const client = new KokoroClient(
      async () => new Response(JSON.stringify({
        ok: true,
        engineStatus: { kokoro: { ready: false, reason: "Kokoro weights failed to load" } },
      }), { status: 200 }),
      () => "http://127.0.0.1:7777",
    );
    assert.deepEqual(await client.validateKey(), [
      { capability: "voice-tts", available: false, reason: "Kokoro weights failed to load" },
    ]);
  });

  it("accepts Kokoro readiness even when another engine makes aggregate health false", async () => {
    const client = new KokoroClient(
      async () => new Response(JSON.stringify({
        ok: false,
        engineStatus: { kokoro: { ready: true }, whisper: { ready: false } },
      }), { status: 200 }),
      () => "http://127.0.0.1:7777",
    );
    assert.deepEqual(await client.validateKey(), [{ capability: "voice-tts", available: true }]);
  });

  it("can route queue-backed synthesis through the host's shared Voxa scheduler", async () => {
    let rawFetches = 0;
    const spoken: Array<{ voiceId: string; text: string; params?: Record<string, number> }> = [];
    const client = new KokoroClient(
      async () => {
        rawFetches += 1;
        throw new Error("the provider fetch should not own synthesis when the host adapter is present");
      },
      () => "http://127.0.0.1:7777",
      async (input) => {
        spoken.push(input);
        return WAV;
      },
    );

    await client.submit("", {
      model: "kokoro-82m",
      params: { voiceId: "af_bella", text: "under the harbour", voiceSettings: { speed: 0.9 } },
    } as never);
    assert.equal(rawFetches, 0);
    assert.deepEqual(spoken, [{ voiceId: "af_bella", text: "under the harbour", params: { speed: 0.9 } }]);
  });

  it("passes queue cancellation to the host's shared Voxa scheduler", async () => {
    let signal: AbortSignal | undefined;
    const client = new KokoroClient(
      async () => { throw new Error("raw fetch must not run"); },
      () => "http://127.0.0.1:7777",
      async (_input, options) => {
        signal = options?.signal;
        return new Promise<Uint8Array>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        });
      },
    );
    const controller = new AbortController();
    const pending = client.submit("", {
      model: "kokoro-82m",
      capability: "voice-tts",
      signal: controller.signal,
      params: { voiceId: "af_bella", text: "under the harbour" },
    });
    controller.abort();
    await assert.rejects(pending, /cancelled/);
    assert.equal(signal, controller.signal);
  });

  it("will not file bytes that are not a WAV", async () => {
    // A port that belongs to something other than Voxa answers 200 with anything at all; the
    // bytes would otherwise be filed as a take and played as silence.
    const notWav = (async () => ({
      status: 200,
      arrayBuffer: async () => new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]).buffer,
    })) as unknown as FetchLike;
    const client = new KokoroClient(notWav, () => "http://127.0.0.1:7777");
    await assert.rejects(
      () => client.submit("", { model: "kokoro-82m", params: { voiceId: "af_heart", text: "x" } } as never),
      /did not answer with a WAV/,
    );
  });
});

describe("a song reaches the route, and comes back (design turn 73)", () => {
  it("sends prompt and lyrics as the route's own fields, and the length as `duration`", async () => {
    // minimax/music-3's schema requires both `prompt` and `lyrics`, and declares `duration` a
    // number rather than the string enum every video route uses. Our `durationSec` is ours, not
    // fal's, and must not reach the wire under that name.
    let sent: Record<string, unknown> = {};
    const client = new FalClient(async (_url, init) => {
      sent = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify({ request_id: "req-song" }), { status: 200 });
    });
    const submitted = await client.submit("k", {
      model: "minimax-music-3",
      capability: "music",
      params: { prompt: "Slow sea shanty, close harmony", lyrics: "[verse]\nSalt in the rope", durationSec: 60 },
    });
    assert.equal(submitted.remoteId, "minimax/music-3::req-song");
    assert.equal(sent["prompt"], "Slow sea shanty, close harmony");
    assert.equal(sent["lyrics"], "[verse]\nSalt in the rope");
    assert.equal(sent["duration"], 60, "the route's own word, as a number");
    assert.ok(!("durationSec" in sent), "our field name never reaches the wire");
  });

  it("refuses a length the route does not offer rather than running at another one", async () => {
    const client = new FalClient(async () => new Response(JSON.stringify({ request_id: "r" }), { status: 200 }));
    await assert.rejects(
      client.submit("k", {
        model: "minimax-music-3",
        capability: "music",
        params: { prompt: "p", lyrics: "l", durationSec: 45 },
      }),
      /cannot be asked for 45s/,
    );
  });

  it("fetches the audio result — the payload names it `audio`, not `images` or `video`", async () => {
    // Before this, fetchArtifacts read only `images` and `video`. A music job submitted, was
    // charged, polled COMPLETED and handed back nothing at all.
    const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x01, 0x02]);
    const client = new FalClient(async (url) => {
      if (String(url).includes("fal.media")) return new Response(wav, { status: 200 });
      return new Response(
        JSON.stringify({ audio: { url: "https://fal.media/files/song.wav", content_type: "audio/wav" } }),
        { status: 200 },
      );
    });
    const artifacts = await client.fetchArtifacts("k", "minimax/music-3::req-song");
    assert.equal(artifacts.length, 1, "the song came back");
    assert.equal(artifacts[0]!.contentType, "audio/wav");
    assert.equal(artifacts[0]!.name, "output-1.wav", "named wav, not bin — the extension is read from the type");
    assert.deepEqual([...artifacts[0]!.data], [...wav]);
  });

  it("falls back to wav when the payload declares no content type, rather than to bytes-with-no-name", async () => {
    const client = new FalClient(async (url) => {
      if (String(url).includes("fal.media")) return new Response(new Uint8Array([1]), { status: 200 });
      return new Response(JSON.stringify({ audio: { url: "https://fal.media/files/song" } }), { status: 200 });
    });
    const artifacts = await client.fetchArtifacts("k", "minimax/music-3::req");
    assert.equal(artifacts[0]!.name, "output-1.wav");
  });
});

describe("local transcription rides the same queue as the cloud (issue 462)", () => {
  const RECORDING = { contentType: "audio/webm", data: new Uint8Array([1, 2, 3, 4]) };
  const sttFetch = (seen: { url?: string; contentType?: string; body?: unknown }, text = "the tide-clock") =>
    (async (url: string, init?: { headers?: Record<string, string>; body?: unknown }) => {
      seen.url = String(url);
      seen.contentType = init?.headers?.["Content-Type"];
      seen.body = init?.body;
      return new Response(JSON.stringify({ text }), { status: 200 });
    }) as unknown as FetchLike;

  it("transcribes through the sidecar and hands back a transcript artifact", async () => {
    const seen: { url?: string; contentType?: string; body?: unknown } = {};
    const client = new WhisperCppClient(sttFetch(seen), () => "http://127.0.0.1:7777");
    const submitted = await client.submit("", {
      model: "whisper-large-v3",
      capability: "voice-stt",
      params: {},
      audioSource: RECORDING,
    });
    assert.equal(seen.url, "http://127.0.0.1:7777/stt");
    // The recording's own type is what the engine is told; the bytes go up raw, not JSON-wrapped.
    assert.equal(seen.contentType, "audio/webm");
    assert.deepEqual([...(seen.body as Uint8Array)], [...RECORDING.data]);
    // Synchronous text goes inline to the queue's durable landing path; no process-memory id is
    // presented as recoverable work.
    const artifacts = submitted.artifacts!;
    assert.equal(artifacts[0]?.name, "transcript.txt");
    assert.match(artifacts[0]?.contentType ?? "", /^text\/plain/);
    assert.equal(new TextDecoder().decode(artifacts[0]!.data), "the tide-clock");
    assert.match((await client.poll("", submitted.remoteId)).error ?? "", /returned by submit/);
  });

  it("refuses with the remedy when local transcription is not running", async () => {
    const client = new WhisperCppClient(sttFetch({}), () => null);
    await assert.rejects(
      () =>
        client.submit("", {
          model: "whisper-large-v3",
          capability: "voice-stt",
          params: {},
          audioSource: RECORDING,
        }),
      /local transcription is not running/,
    );
    // And says so as availability rather than as a failed transcription.
    assert.deepEqual(await client.validateKey(), [
      { capability: "voice-stt", available: false, reason: "the Voxa sidecar is not running" },
    ]);
  });

  /**
   * The whole of issue 462. `whispercpp` takes no credential, so its status is `configured` at
   * birth and stays `untested` — which deriveCapabilityAvailability reads as *available*. Before
   * this client, nothing could ever move it off that, and voice-stt was offered by a table row
   * with no runtime behind it.
   */
  it("probes Whisper engine readiness rather than treating HTTP 200 as availability", async () => {
    const client = new WhisperCppClient(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            engineStatus: {
              kokoro: { ready: true },
              whisper: { ready: false, reason: "the dictation model has not been downloaded yet" },
            },
          }),
          { status: 200 },
        ),
      () => "http://127.0.0.1:7777",
    );
    assert.deepEqual(await client.validateKey(), [
      { capability: "voice-stt", available: false, reason: "the dictation model has not been downloaded yet" },
    ]);
  });

  it("accepts Whisper readiness even when another engine makes aggregate health false", async () => {
    const client = new WhisperCppClient(
      async () =>
        new Response(
          JSON.stringify({ ok: false, engineStatus: { kokoro: { ready: false }, whisper: { ready: true } } }),
          { status: 200 },
        ),
      () => "http://127.0.0.1:7777",
    );
    assert.deepEqual(await client.validateKey(), [{ capability: "voice-stt", available: true }]);

    // The probe set has to be the provider table's own list: a capability the table declares but
    // the client never probes reads as locked, because an absent probe is read as unavailable.
    assert.deepEqual(
      (await client.validateKey()).map((p) => p.capability),
      [...PROVIDERS.whispercpp.capabilities],
    );
  });

  it("keeps the recording off `params`, so nothing journals what must not persist", async () => {
    // SPEC-018 R-13: the transcript is the artefact, the audio is a buffer. `params` is written
    // verbatim into the durable job row, so audio there would outlive the transcript.
    const client = new WhisperCppClient(sttFetch({}), () => "http://127.0.0.1:7777");
    await assert.rejects(
      () =>
        client.submit("", {
          model: "whisper-large-v3",
          capability: "voice-stt",
          params: { audioBase64: Buffer.from(RECORDING.data).toString("base64") },
        }),
      /audioSource is required/,
    );
  });

  it("can route queue-backed transcription through the host's shared Voxa client", async () => {
    let rawFetches = 0;
    const heard: Array<{ audio: Uint8Array; contentType: string }> = [];
    const client = new WhisperCppClient(
      async () => {
        rawFetches += 1;
        throw new Error("the provider fetch should not own transcription when the host adapter is present");
      },
      () => "http://127.0.0.1:7777",
      async (input) => {
        heard.push(input);
        return "under the harbour";
      },
    );
    await client.submit("", {
      model: "whisper-large-v3",
      capability: "voice-stt",
      params: {},
      audioSource: RECORDING,
    });
    assert.equal(rawFetches, 0);
    assert.deepEqual(heard, [{ audio: RECORDING.data, contentType: "audio/webm" }]);
  });

  it("passes queue cancellation to the host's shared Voxa client", async () => {
    let signal: AbortSignal | undefined;
    const client = new WhisperCppClient(
      async () => {
        throw new Error("raw fetch must not run");
      },
      () => "http://127.0.0.1:7777",
      async (_input, options) => {
        signal = options?.signal;
        return new Promise<string>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        });
      },
    );
    const controller = new AbortController();
    const pending = client.submit("", {
      model: "whisper-large-v3",
      capability: "voice-stt",
      signal: controller.signal,
      params: {},
      audioSource: RECORDING,
    });
    controller.abort();
    await assert.rejects(pending, /cancelled/);
    assert.equal(signal, controller.signal);
  });

  it("will not file a transcript that is not one", async () => {
    // A port that belongs to something other than Voxa answers 200 with anything at all; the
    // body would otherwise be filed as the transcript of a recording it never heard.
    const client = new WhisperCppClient(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      () => "http://127.0.0.1:7777",
    );
    await assert.rejects(
      () =>
        client.submit("", {
          model: "whisper-large-v3",
          capability: "voice-stt",
          params: {},
          audioSource: RECORDING,
        }),
      /did not answer with a transcript/,
    );
  });

  it("names silence rather than landing an artifact the verifier calls an empty download", async () => {
    const client = new WhisperCppClient(sttFetch({}, "   "), () => "http://127.0.0.1:7777");
    await assert.rejects(
      () =>
        client.submit("", {
          model: "whisper-large-v3",
          capability: "voice-stt",
          params: {},
          audioSource: RECORDING,
        }),
      /no speech was detected/,
    );
  });
});

/**
 * The invariant issue 462 asks for: the provider table and the client registry cannot disagree
 * silently. A row carrying a capability with no client behind it is a capability the app can
 * offer and then fail — and for a keyless provider it is worse than that, because
 * `deriveCapabilityAvailability` reads `configured` + `untested` as *available*, so nothing ever
 * finds out. Asserted over the fullest wiring, since sidecar- and engine-backed clients are
 * legitimately absent when their runtime is not wired.
 */
describe("the provider table and the registry cannot drift apart (issue 462)", () => {
  const unreachable = () => Promise.reject(new Error("no call is made while building the registry"));
  const fullyWired = () =>
    createProviderClients({
      fetch: unreachable as unknown as FetchLike,
      higgsfield: unreachable as unknown as CommandRunner,
      voxa: () => null,
      comfyui: { baseUrl: () => null, preflight: unreachable as unknown as () => Promise<never> },
    });

  it("builds a client for every capability-carrying entry in PROVIDERS", () => {
    const clients = fullyWired();
    const missing = (Object.keys(PROVIDERS) as ProviderId[]).filter(
      (id) => PROVIDERS[id].capabilities.length > 0 && clients[id] === undefined,
    );
    assert.deepEqual(missing, [], "every capability the table offers must resolve to a client under some wiring");
  });

  it("builds no client the table does not list, and each answers to its own id", () => {
    for (const [id, client] of Object.entries(fullyWired())) {
      assert.ok(id in PROVIDERS, `${id} is built but is not in the provider table`);
      assert.equal(client!.id, id, `${id} was registered under another provider's id`);
    }
  });

  it("declares every provider in the declarations table too", () => {
    const missing = (Object.keys(PROVIDERS) as ProviderId[]).filter((id) => PROVIDER_DECLARATIONS[id] === undefined);
    assert.deepEqual(missing, [], "reconciliation strategy is chosen from declarations; an absent row has none");
  });

  it("uses the engine-specific fetch for ComfyUI without changing cloud transports", async () => {
    let sharedCalls = 0;
    let comfyCalls = 0;
    const clients = createProviderClients({
      fetch: async () => {
        sharedCalls += 1;
        return new Response("{}", { status: 200 });
      },
      comfyui: {
        fetch: async () => {
          comfyCalls += 1;
          return new Response(JSON.stringify({ system: { comfyui_version: "0.33.1" } }), { status: 200 });
        },
        baseUrl: () => "http://127.0.0.1:8188",
        preflight: async () => ({ ok: true }),
      },
    });

    await clients.comfyui!.validateKey("");

    assert.equal(comfyCalls, 1);
    assert.equal(sharedCalls, 0);
  });

  it("applies host transport only to cloud clients, never Ollama or another local engine", async () => {
    const scopes: ProviderTransportScope[] = [];
    let localCalls = 0;
    const clients = createProviderClients({
      fetch: async () => {
        localCalls += 1;
        return new Response(JSON.stringify({ models: [{ name: "llama3.1" }] }), { status: 200 });
      },
      transport: {
        run(scope, operation) {
          scopes.push(scope);
          return operation(async () =>
            new Response(JSON.stringify({ data: [{ id: "gpt-5.2" }, { id: "gpt-image-2" }] }), { status: 200 }),
          );
        },
      },
    });
    await clients.openai!.validateKey("k");
    await clients.ollama!.validateKey("");
    assert.deepEqual(scopes, [{ provider: "openai", operation: "validate" }]);
    assert.equal(localCalls, 1);
  });

  it("applies the HTTP transport to Higgsfield downloads, never its CLI calls", async () => {
    const scopes: ProviderTransportScope[] = [];
    const clients = createProviderClients({
      fetch: async () => {
        throw new Error("Higgsfield's download bypassed the host transport");
      },
      higgsfield: async (args) => ({
        code: 0,
        stdout: JSON.stringify(args[0] === "account" ? { credits: 1 } : { result_url: "https://result.example/out.png" }),
        stderr: "",
      }),
      transport: {
        run(scope, operation) {
          scopes.push(scope);
          return operation(async () =>
            new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/png" } }),
          );
        },
      },
    });

    await clients.higgsfield!.validateKey("");
    assert.deepEqual(scopes, []);
    const artifacts = await clients.higgsfield!.fetchArtifacts("", "job-1");
    assert.equal(artifacts[0]?.contentType, "image/png");
    assert.deepEqual(scopes, [{ provider: "higgsfield", operation: "fetch-artifacts" }]);
  });
});
